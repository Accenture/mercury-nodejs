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
import { randomBytes } from 'node:crypto';
import { appOrigin } from './actuator.js';
import { MY_CID_TAG, MY_CORRELATION_ID, RPC_TAG, runWithTrace, TraceInfo } from './trace.js';

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
  // the raw envelope: delivery context for engine-managed tags (e.g. the
  // business correlation-id), and the verbatim event an interceptor handler
  // receives - reply_to and correlation id travel the engines' way
  envelope?: EventEnvelope;
}

interface Delivery extends TraceFields {
  service: ServiceDef;
  headers: Record<string, string>;
  body: unknown;
  settled: boolean;
  resolve?: (reply: EventEnvelope) => void; // drop-n-forget deliveries carry no resolver
}

/**
 * The caller's business correlation-id at delivery: the engine-managed my_cid
 * envelope tag, else a my_correlation_id view already injected by an HTTP host
 * (the engines' WorkerHandler resolution order).
 */
function businessCid(delivery: Delivery): string | undefined {
  return delivery.envelope?.tags[MY_CID_TAG] ?? delivery.headers[MY_CORRELATION_ID];
}

/**
 * The handler's header view, with the read-only business correlation-id
 * injected at delivery (engine parity).
 */
function headersView(delivery: Delivery, myCid: string | undefined): Record<string, string> {
  if (myCid && !(MY_CORRELATION_ID in delivery.headers)) {
    return { ...delivery.headers, [MY_CORRELATION_ID]: myCid };
  }
  return delivery.headers;
}

// the engines' distributed-trace log stream (Java Telemetry parity)
const telemetryLog = getLogger('distributed.tracing');

/**
 * The execution's trace context. Under a trace, every execution mints its own
 * 16-hex span and records the caller's span (from the inbound envelope) as
 * its parent - the engines' WorkerHandler model.
 */
function traceInfoOf(delivery: Delivery, myCid: string | undefined): TraceInfo {
  return {
    route: delivery.service.route,
    traceId: delivery.traceId,
    tracePath: delivery.tracePath,
    cid: delivery.cid,
    myCorrelationId: myCid,
    spanId: delivery.traceId ? randomBytes(8).toString('hex') : undefined,
    parentSpanId: delivery.envelope?.spanId,
    annotations: {}
  };
}

/**
 * True for an RPC round-trip: a local reply resolver, or the engines' rpc
 * envelope tag transported over the wire. RPC legs emit no trace dataset
 * (engine parity) - their metrics fold into the caller's view.
 */
function isRpc(delivery: Delivery): boolean {
  return Boolean(delivery.resolve) || Boolean(delivery.envelope?.tags[RPC_TAG]);
}

/**
 * Emit the engines' distributed-trace dataset for a traced, non-RPC
 * execution - the same record shape the Java reference engine logs
 * (message = {"trace": {...}, "annotations": {...}}), so polyglot log
 * aggregation and stdout log-ingest agents stitch spans across runtimes.
 */
function emitTrace(delivery: Delivery, info: TraceInfo, start: string,
                   execTime: number, status: number, success: boolean,
                   exception: string | undefined): void {
  if (!info.traceId || isRpc(delivery)) {
    return;
  }
  const trace: Record<string, unknown> = {
    origin: appOrigin(),
    id: info.traceId,
    path: info.tracePath,
    service: delivery.service.route,
    start,
    success,
    from: delivery.envelope?.sender ?? 'unknown',
    exec_time: execTime,
    status
  };
  if (!success && exception) {
    trace.exception = exception;
  }
  if (info.spanId) {
    trace.span_id = info.spanId;
  }
  if (info.parentSpanId) {
    trace.parent_span_id = info.parentSpanId;
  }
  const dataset: Record<string, unknown> = { trace };
  if (Object.keys(info.annotations).length) {
    dataset.annotations = { ...info.annotations };
  }
  telemetryLog.info(dataset);
}

const CLOSED: unique symbol = Symbol('bus-closed');

/** Unbounded FIFO handing items to awaiting consumers (node's missing asyncio.Queue). */
export class Mailbox<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(item: T) => void> = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve(item);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * Race one PENDING promise against a timeout; null on expiry. The pending
 * promise survives a lost race (a bare promise cannot be cancelled), so a
 * caller that keeps waiting must keep reusing THE SAME promise until it
 * resolves - a fresh queue.next() per cycle would leave an abandoned waiter
 * in the mailbox that steals and drops the next item. A caller that
 * terminates on expiry may race a fresh promise each time.
 */
export async function raceMs<T>(pending: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([pending, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/** Route an envelope to a local target - wired by the registry (backref). */
export type EnvelopeRouter = (event: EventEnvelope) => boolean;

/** Per-registry bus: one FIFO mailbox and N workers per registered route. */
export class EventBus {
  private readonly mailboxes = new Map<string, Mailbox<Delivery | typeof CLOSED>>();
  // per-request reply sinks (the engines' inbox idea): generated local route
  // names backed by queues - the reply_to addressing of interceptor dispatch
  // and of streaming responses. Local-only by design.
  private readonly sinks = new Map<string, Mailbox<EventEnvelope>>();
  // reply routing for the interceptor error contract (registry owns this bus)
  private router: EnvelopeRouter | undefined;
  private sinkSequence = 0;

  bindRouter(router: EnvelopeRouter): void {
    this.router = router;
  }

  /** Open a per-request reply sink under a generated local route name. */
  openSink(): [string, Mailbox<EventEnvelope>] {
    const route = `inbox.${++this.sinkSequence}.${Date.now().toString(36)}`;
    const queue = new Mailbox<EventEnvelope>();
    this.sinks.set(route, queue);
    return [route, queue];
  }

  closeSink(route: string): void {
    this.sinks.delete(route);
  }

  /**
   * Deliver an envelope to a reply sink; false when the sink is gone (a
   * completed, timed-out or disconnected request) - late segments are no-op
   * drops, the engines' semantics.
   */
  offerSink(route: string, event: EventEnvelope): boolean {
    const queue = this.sinks.get(route);
    if (!queue) {
      return false;
    }
    queue.push(event);
    return true;
  }

  private mailbox(service: ServiceDef): Mailbox<Delivery | typeof CLOSED> {
    let mailbox = this.mailboxes.get(service.route);
    if (!mailbox) {
      // lazy: the mailbox and its workers start on first use
      const created = new Mailbox<Delivery | typeof CLOSED>();
      mailbox = created;
      this.mailboxes.set(service.route, created);
      for (let n = 0; n < service.instances; n++) {
        // workers are long-lived loops created lazily on first use, so they
        // would inherit the creating caller's trace store - detach so nothing
        // from an arbitrary first caller leaks into later executions' logs
        void runWithTrace(undefined, () => this.runWorker(created));
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

  /**
   * Route one envelope to a local function (the reply_to mechanism):
   * drop-n-forget delivery carrying the raw envelope, so an interceptor
   * handler receives reply_to and the correlation id the engines' way.
   */
  publishEnvelope(service: ServiceDef, event: EventEnvelope): void {
    this.mailbox(service).push({
      service, headers: { ...event.headers }, body: event.body, settled: false,
      traceId: event.traceId, tracePath: event.tracePath, cid: event.cid,
      envelope: event
    });
  }

  /** Stop all workers (orderly shutdown; worker promises hold no OS handle). */
  close(): void {
    for (const mailbox of this.mailboxes.values()) {
      mailbox.push(CLOSED);
    }
    this.mailboxes.clear();
  }

  private async runWorker(mailbox: Mailbox<Delivery | typeof CLOSED>): Promise<void> {
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
      const reply = delivery.service.interceptor
        ? await this.executeInterceptor(delivery)
        : await EventBus.execute(delivery);
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
    const myCid = businessCid(delivery);
    const headers = headersView(delivery, myCid);
    const info = traceInfoOf(delivery, myCid);
    const startIso = isoUtc();
    const start = process.hrtime.bigint();
    let reply: EventEnvelope;
    try {
      const result = await runWithTrace(info, async () =>
        delivery.service.handler(headers, delivery.body));
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
    emitTrace(delivery, info, startIso, reply.execTime, reply.getStatus(),
      !reply.hasError(), reply.hasError() ? String(reply.body) : undefined);
    return reply;
  }

  /**
   * Run an interceptor handler: it receives the raw envelope, replies
   * manually through reply_to (the engines' EventInterceptor contract), and
   * its return value is discarded. An uncaught exception becomes an error
   * envelope to the delivery's reply_to - so a caller waiting on a reply
   * sink sees it - and a streaming host renders it in-band.
   */
  private async executeInterceptor(delivery: Delivery): Promise<EventEnvelope> {
    const event = delivery.envelope ??
      new EventEnvelope(delivery.service.route, delivery.body, delivery.headers);
    const myCid = businessCid(delivery);
    const headers = headersView(delivery, myCid);
    const info = traceInfoOf(delivery, myCid);
    const startIso = isoUtc();
    const start = process.hrtime.bigint();
    let error: unknown;
    try {
      await runWithTrace(info, async () =>
        delivery.service.handler(headers, event));
    } catch (e) {
      error = e;
      this.replyInterceptorError(delivery.service.route, event, e);
    }
    const status = error instanceof AppException ? error.status : (error ? 500 : 200);
    const execTime = Math.round(Number(process.hrtime.bigint() - start) / 1000) / 1000;
    emitTrace(delivery, info, startIso, execTime, status, !error,
      error ? String((error as Error).message ?? error) : undefined);
    // an interceptor's own outcome is never auto-replied
    return new EventEnvelope();
  }

  private replyInterceptorError(route: string, event: EventEnvelope, e: unknown): void {
    let error: EventEnvelope;
    if (e instanceof AppException) {
      error = new EventEnvelope().setStatus(e.status).setBody(e.message);
    } else {
      const raw = e as Error;
      error = new EventEnvelope().setStatus(500).setBody(raw.message ?? String(e));
      if (raw.stack) {
        error.stack = raw.stack;
      }
    }
    error.sender = route;
    if (event.cid) {
      error.setCorrelationId(event.cid);
    }
    const delivered = Boolean(
      event.replyTo && this.router?.(error.setTo(event.replyTo)));
    if (!delivered) {
      log.warn(`Interceptor ${route} ended with status ` +
        `${error.getStatus()} - ${error.body}`);
    }
  }
}
