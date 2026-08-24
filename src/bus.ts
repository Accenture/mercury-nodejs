/**
 * The primitive in-process event bus - the single dispatch pipeline.
 *
 * Every invocation reaches a function the same way: through a per-route FIFO
 * mailbox consumed by `instances` worker loops (the engines' semantics - the
 * parameter is faithful). The HTTP host and the local side of PostOffice are
 * thin ingress adapters over this bus; neither has its own invocation path.
 *
 * Deliberately primitive, riding the runtime's native event loop:
 * - Two operations only: deliver (RPC - ttl-bounded, with a dead-work skip
 *   for queued calls whose caller already timed out) and publish
 *   (drop-n-forget - returns the 202-shape acknowledgement).
 * - No spill tier and no queue cap: back-pressure belongs to the tier that
 *   owns recovery - the engines' flows and graphs. A leaf host fails fast by
 *   deadline (the 408 envelope) instead of hoarding work.
 * - In-memory only; no orchestration, no flows, no persistence, no broadcast.
 *
 * Why a hand-built Mailbox instead of Node's EventEmitter: this contract is
 * an ANYCAST WORK QUEUE - each delivery goes to exactly one of N workers and
 * waits its FIFO turn while all are busy. EventEmitter is a broadcast
 * notifier - emit() invokes every listener synchronously and buffers
 * nothing - so a bounded-concurrency bus would still need this queue in
 * front of it (the emitter demoted to a wake-up bell), and once()-based
 * bridging re-registers a listener per iteration, can drop emissions
 * between iterations, and trips MaxListenersExceededWarning right at the
 * default instances=10. Bare promise waiters also hold no event-loop
 * handles, which is what makes the lifecycle contract exactly true (an idle
 * bus lets the process exit; only an in-flight RPC's deadline timer holds
 * it). The Mailbox is node's missing asyncio.Queue, keeping the python and
 * node twins structurally identical.
 *
 * The bus is internal: application code uses preload() and PostOffice, never
 * this module - the same way engine developers never touch the engine bus.
 */
import { EventEnvelope, isoUtc } from './envelope.js';
import { AppException } from './exceptions.js';
import { getLogger } from './log.js';
import type { ServiceDef } from './registry.js';
import { runWithTrace, TraceInfo } from './trace.js';

const log = getLogger('mercury.bus');

/** An RPC delivery missed its deadline; adapters shape the 408 for their protocol. */
export class DeliveryTimeout extends Error {
  readonly ttlMs: number;

  constructor(ttlMs: number) {
    super(`Timeout for ${ttlMs} ms`);
    this.name = 'DeliveryTimeout';
    this.ttlMs = ttlMs;
  }
}

/** The 202 drop-n-forget acknowledgement (EventApiService shape). */
export function asyncAck(): EventEnvelope {
  return new EventEnvelope().setStatus(202)
    .setBody({ type: 'async', delivered: true, time: isoUtc() });
}

interface TraceFields {
  traceId?: string;
  tracePath?: string;
  cid?: string;
}

interface Delivery extends TraceFields {
  service: ServiceDef;
  headers: Record<string, string>;
  body: unknown;
  settled: boolean;
  resolve?: (reply: EventEnvelope) => void; // drop-n-forget deliveries carry no resolver
}

const CLOSED: unique symbol = Symbol('bus-closed');

/** Unbounded FIFO handing items to awaiting workers. */
class Mailbox {
  private readonly items: Array<Delivery | typeof CLOSED> = [];
  private readonly waiters: Array<(item: Delivery | typeof CLOSED) => void> = [];

  push(item: Delivery | typeof CLOSED): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  next(): Promise<Delivery | typeof CLOSED> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve(item);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/** Per-registry bus: one FIFO mailbox and N workers per registered route. */
export class EventBus {
  private readonly mailboxes = new Map<string, Mailbox>();

  private mailbox(service: ServiceDef): Mailbox {
    let mailbox = this.mailboxes.get(service.route);
    if (!mailbox) {
      // lazy: the mailbox and its workers start on first use
      mailbox = new Mailbox();
      this.mailboxes.set(service.route, mailbox);
      for (let n = 0; n < service.instances; n++) {
        void this.runWorker(mailbox);
      }
    }
    return mailbox;
  }

  /** RPC: enqueue and await the reply envelope within the ttl. */
  deliver(service: ServiceDef, headers: Record<string, string>, body: unknown,
          ttlMs: number, trace: TraceFields = {}): Promise<EventEnvelope> {
    const delivery: Delivery = { service, headers, body, settled: false, ...trace };
    this.mailbox(service).push(delivery);
    return new Promise<EventEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!delivery.settled) {
          // dead-work mark: a worker reaching this delivery later will skip it
          delivery.settled = true;
          reject(new DeliveryTimeout(ttlMs));
        }
      }, Math.max(100, ttlMs));
      // deliberately referenced: an in-flight RPC is pending work and holds the
      // process open (at most until its deadline); an idle bus holds nothing
      delivery.resolve = (reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
    });
  }

  /** Drop-n-forget: enqueue and return the 202-shape acknowledgement. */
  publish(service: ServiceDef, headers: Record<string, string>, body: unknown,
          trace: TraceFields = {}): EventEnvelope {
    this.mailbox(service).push({ service, headers, body, settled: false, ...trace });
    return asyncAck();
  }

  /** Stop all workers (orderly shutdown; worker promises hold no OS handle). */
  close(): void {
    for (const mailbox of this.mailboxes.values()) {
      mailbox.push(CLOSED);
    }
    this.mailboxes.clear();
  }

  private async runWorker(mailbox: Mailbox): Promise<void> {
    for (;;) {
      const delivery = await mailbox.next();
      if (delivery === CLOSED) {
        mailbox.push(CLOSED); // release the next worker on the same mailbox
        return;
      }
      // dead-work check: the caller of a queued RPC already gave up (408 sent)
      if (delivery.settled) {
        continue;
      }
      const reply = await EventBus.execute(delivery);
      if (delivery.resolve) {
        if (!delivery.settled) {
          delivery.settled = true;
          delivery.resolve(reply);
        }
      } else if (reply.hasError()) {
        log.warn(`Async event ${delivery.service.route} ended with status ` +
          `${reply.getStatus()} - ${reply.body}`);
      }
    }
  }

  /** Run the handler under its trace context and shape the outcome as a reply. */
  private static async execute(delivery: Delivery): Promise<EventEnvelope> {
    const info: TraceInfo = {
      traceId: delivery.traceId,
      tracePath: delivery.tracePath,
      cid: delivery.cid,
      annotations: {}
    };
    const start = process.hrtime.bigint();
    let reply: EventEnvelope;
    try {
      const result = await runWithTrace(info, async () =>
        delivery.service.handler(delivery.headers, delivery.body));
      reply = result instanceof EventEnvelope ? result : new EventEnvelope(undefined, result);
    } catch (e) {
      if (e instanceof AppException) {
        reply = new EventEnvelope().setStatus(e.status).setBody(e.message);
      } else {
        // any handler failure becomes the portable error contract
        // (status 500 + message + stack), mirroring the engines
        const error = e as Error;
        reply = new EventEnvelope().setStatus(500).setBody(error.message ?? String(e));
        if (error.stack) {
          reply.stack = error.stack;
        }
      }
    }
    reply.sender = reply.sender ?? delivery.service.route;
    reply.execTime = Math.round(Number(process.hrtime.bigint() - start) / 1000) / 1000;
    if (Object.keys(info.annotations).length) {
      reply.annotations = { ...info.annotations, ...reply.annotations };
    }
    return reply;
  }
}
