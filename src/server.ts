/**
 * The Event API host: POST /api/event, exactly as the engines speak it.
 *
 * Mirrors the Java engine's EventApiService: request body = envelope bytes;
 * x-ttl (ms, floor 1000) bounds handler execution; x-async: true means
 * drop-n-forget (HTTP 202 with an ack envelope). Transport-level failures
 * (400 / 403 / 404 / 408) set the HTTP status; a handler's own outcome —
 * including AppException and unexpected errors — rides HTTP 200 with the
 * status inside the envelope, exactly like an engine function's reply.
 * Reserved header hygiene: x-event-api and transported my_* keys are removed
 * from the handler's header view; the my_cid tag is injected as the
 * read-only my_correlation_id header.
 * The host also serves the engines' actuator endpoints (/info, /info/routes,
 * /env, /health, /livenessprobe) for operations and Kubernetes probes - see
 * actuator.ts.
 */
import * as http from 'node:http';
import { Actuator, sendError } from './actuator.js';
import { DeliveryTimeout, Mailbox, raceMs } from './bus.js';
import { appConfig } from './config.js';
import { EventEnvelope } from './envelope.js';
import {
  DATA,
  dataFrame,
  envelopeFrame,
  EOF,
  errorText,
  EXCEPTION,
  exceptionEnvelope,
  keepAliveMs,
  STREAM_CALLER_REQUIRED,
  streamSignal,
  TEXT_EVENT_STREAM,
  X_TTL
} from './event-stream.js';
import { CompactFormatError } from './exceptions.js';
import { getLogger } from './log.js';
import { defaultRegistry, FunctionRegistry, ServiceDef } from './registry.js';
import { MY_CID_TAG, MY_CORRELATION_ID } from './trace.js';

const OCTET_STREAM = 'application/octet-stream';
// the engines' reserved route name for the Event-over-HTTP ingress
const EVENT_API_SERVICE = 'event.api.service';
const log = getLogger('mercury.server');

function transportError(res: http.ServerResponse, status: number, message: string): void {
  const reply = new EventEnvelope().setStatus(status).setBody(message);
  const bytes = reply.toBytes();
  res.writeHead(status, { 'content-type': OCTET_STREAM, 'content-length': bytes.length });
  res.end(bytes);
}

function handlerHeaders(event: EventEnvelope): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers)) {
    const key = k.toLowerCase();
    if (key !== 'x-event-api' && !key.startsWith('my_')) {
      headers[k] = v;
    }
  }
  const myCid = event.tags[MY_CID_TAG];
  if (myCid) {
    headers[MY_CORRELATION_ID] = myCid;
  }
  return headers;
}

export class EventApiServer {
  private readonly actuator: Actuator;

  /** Thin ingress: protocol guards + header hygiene, then the registry's bus. */
  constructor(readonly registry: FunctionRegistry = defaultRegistry) {
    this.actuator = new Actuator(registry);
  }

  private async handleEvent(req: http.IncomingMessage, res: http.ServerResponse,
                            raw: Buffer): Promise<void> {
    const ttl = Math.max(1000, Number.parseInt(String(req.headers['x-ttl'] ?? '0'), 10) || 0);
    const isAsync = req.headers['x-async'] === 'true';
    let event: EventEnvelope;
    try {
      event = EventEnvelope.fromBytes(raw);
    } catch (e) {
      if (e instanceof CompactFormatError || e instanceof Error) {
        transportError(res, 400, e.message);
        return;
      }
      transportError(res, 400, String(e));
      return;
    }
    if (!event.to) {
      transportError(res, 400, 'Missing routing path');
      return;
    }
    const service = this.registry.get(event.to);
    if (!service) {
      transportError(res, 404, `Route ${event.to} not found`);
      return;
    }
    if (service.isPrivate) {
      transportError(res, 403, `${event.to} is private`);
      return;
    }
    if (!event.sender) {
      // the engines' EventApiService parity: its PostOffice fills the sender
      // with its own route when the wire envelope carries none
      event.setFrom(EVENT_API_SERVICE);
    }
    const headers = handlerHeaders(event);
    const bus = this.registry.bus;
    const trace = {
      traceId: event.traceId, tracePath: event.tracePath, cid: event.cid,
      envelope: event
    };
    if (isAsync) {
      const ack = bus.publish(service, headers, event.body, trace);
      const bytes = ack.toBytes();
      res.writeHead(202, { 'content-type': OCTET_STREAM, 'content-length': bytes.length });
      res.end(bytes);
      return;
    }
    if (service.interceptor) {
      // interceptor dispatch (the reply_to mechanism): the handler receives
      // the raw envelope with a per-request reply sink as its reply address
      // and answers manually - single-shot or streaming
      const capable = String(req.headers['accept'] ?? '').includes(TEXT_EVENT_STREAM);
      await this.dispatchInterceptor(res, service, event, headers, ttl, capable);
      return;
    }
    try {
      const reply = await bus.deliver(service, headers, event.body, ttl, trace);
      log.info(`Handled ${event.to} status=${reply.getStatus()} ` +
        `exec_time=${reply.execTime}ms trace_id=${event.traceId ?? 'none'}`);
      const bytes = reply.toBytes();
      res.writeHead(200, { 'content-type': OCTET_STREAM, 'content-length': bytes.length });
      res.end(bytes);
    } catch (e) {
      if (e instanceof DeliveryTimeout) {
        log.warn(`Event ${event.to} timeout for ${ttl} ms (trace_id=${event.traceId ?? 'none'})`);
        transportError(res, 408, `Timeout for ${ttl} ms`);
      } else {
        transportError(res, 500, (e as Error).message ?? String(e));
      }
    }
  }

  /**
   * Dispatch to an interceptor and classify its first reply exactly like the
   * engines: unmarked = the classic single-shot response, byte-identical;
   * marked = the envelope-mode SSE dialect for a caller that accepts
   * text/event-stream, or the pinned 406 refusal for one that does not.
   */
  private async dispatchInterceptor(res: http.ServerResponse, service: ServiceDef,
                                    event: EventEnvelope, headers: Record<string, string>,
                                    ttl: number, capable: boolean): Promise<void> {
    const bus = this.registry.bus;
    const [sinkRoute, queue] = bus.openSink();
    try {
      const handlerEvent = new EventEnvelope(event.to, event.body, headers);
      handlerEvent.setReplyTo(sinkRoute);
      if (Object.keys(event.tags).length) {
        // engine-managed tags (e.g. the business correlation-id) ride the
        // delivered envelope verbatim, the engines' way
        handlerEvent.tags = { ...event.tags };
      }
      if (event.cid) {
        handlerEvent.setCorrelationId(event.cid);
      }
      if (event.traceId) {
        handlerEvent.setTrace(event.traceId, event.tracePath ?? service.route);
      }
      if (event.spanId) {
        // the caller's span - the handler's span parents onto it
        handlerEvent.setSpanId(event.spanId);
      }
      if (event.sender) {
        handlerEvent.setFrom(event.sender);
      }
      bus.publishEnvelope(service, handlerEvent);
      const first = await raceMs(queue.next(), Math.max(100, ttl));
      if (!first) {
        log.warn(`Event ${event.to} timeout for ${ttl} ms ` +
          `(trace_id=${event.traceId ?? 'none'})`);
        transportError(res, 408, `Timeout for ${ttl} ms`);
        return;
      }
      const marker = streamSignal(first);
      if (marker === undefined) {
        // the classic single-shot reply (a manual answer, or the bus's error
        // contract for an uncaught interceptor exception)
        log.info(`Handled ${event.to} status=${first.getStatus()} ` +
          `exec_time=${first.execTime ?? 0}ms trace_id=${event.traceId ?? 'none'}`);
        const bytes = first.toBytes();
        res.writeHead(200, { 'content-type': OCTET_STREAM, 'content-length': bytes.length });
        res.end(bytes);
        return;
      }
      if (!capable) {
        // a streaming reply cannot ride a single-shot response
        transportError(res, 406, STREAM_CALLER_REQUIRED);
        return;
      }
      await streamResponse(res, queue, first, marker, ttl);
    } finally {
      bus.closeSink(sinkRoute);
    }
  }

  createServer(): http.Server {
    return http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET') {
        this.actuator.handle(url.pathname, res).then((handled) => {
          if (!handled) {
            sendError(res, 404, 'Resource not found');
          }
        }).catch((e) => {
          sendError(res, 500, (e as Error).message ?? String(e));
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/event') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          this.handleEvent(req, res, Buffer.concat(chunks)).catch((e) => {
            transportError(res, 500, (e as Error).message ?? String(e));
          });
        });
        req.on('error', () => res.destroy());
        return;
      }
      sendError(res, 404, 'Resource not found');
    });
  }
}

/**
 * Render the envelope-mode SSE dialect: envelope frames for the head, the
 * terminals and non-text segments; raw frames for plain text. The x-ttl
 * allowance (overridable by the producer's head control, in seconds) is the
 * per-segment idle; expiry fails the stream in-band with the standard 408
 * error body. Keep-alive comments ride while the producer is quiet
 * (event.stream.keep.alive, the engines' key).
 */
async function streamResponse(res: http.ServerResponse, queue: Mailbox<EventEnvelope>,
                              first: EventEnvelope, firstMarker: string,
                              ttl: number): Promise<void> {
  let idleMs = ttl;
  for (const [key, value] of Object.entries(first.headers)) {
    if (key.toLowerCase() === X_TTL) {
      const seconds = Number.parseInt(String(value).trim(), 10);
      if (Number.isFinite(seconds) && seconds > 0) {
        idleMs = seconds * 1000;
      }
    }
  }
  res.writeHead(first.getStatus(), {
    'content-type': TEXT_EVENT_STREAM,
    'cache-control': 'no-cache'
  });
  res.write(envelopeFrame(first));
  if (firstMarker === DATA) {
    await streamSegments(res, queue, idleMs);
  }
  res.end();
}

async function streamSegments(res: http.ServerResponse, queue: Mailbox<EventEnvelope>,
                              idleMs: number): Promise<void> {
  const pingMs = keepAliveMs();
  // a disconnected client ends the stream; late segments are no-op drops
  for (;;) {
    if (res.writableEnded || res.destroyed) {
      log.debug('Client disconnected from event stream');
      return;
    }
    const event = await nextSegment(res, queue, idleMs, pingMs);
    if (!event) {
      // idle expiry - fail in-band (the engines' housekeeper parity)
      const seconds = Math.trunc(idleMs / 1000);
      res.write(envelopeFrame(exceptionEnvelope(408, `Timeout for ${seconds} seconds`)));
      return;
    }
    const action = classifySegment(event);
    if (action.warn) {
      log.warn('Dropping event - invalid x-event-stream signal');
    }
    if (action.frame?.length) {
      res.write(action.frame);
    }
    if (action.end) {
      return;
    }
  }
}

/**
 * The wire consequence of one sink envelope in envelope mode: a data frame
 * (raw or escape-hatch), a terminal envelope frame that ends the response
 * cleanly (no cosmetic frames on this wire), the in-band terminal for the
 * bus's uncaught-interceptor-exception contract, or a warned drop.
 */
function classifySegment(event: EventEnvelope): { frame?: Buffer; end: boolean; warn?: boolean } {
  const marker = streamSignal(event);
  if (marker === DATA) {
    return { frame: dataFrame(event, false), end: false };
  }
  if (marker === EOF || marker === EXCEPTION) {
    return { frame: envelopeFrame(event), end: true };
  }
  if (marker === undefined && event.hasError()) {
    // fail in-band with the exact status
    const frame = envelopeFrame(exceptionEnvelope(event.getStatus(), errorText(event.body)));
    return { frame, end: true };
  }
  return { end: false, warn: true };
}

/**
 * Wait for the next segment within the idle allowance, emitting SSE
 * keep-alive comments while the producer is quiet (best-effort; pings never
 * extend the idle allowance).
 */
async function nextSegment(res: http.ServerResponse, queue: Mailbox<EventEnvelope>,
                           idleMs: number, pingMs: number): Promise<EventEnvelope | null> {
  const deadline = Date.now() + idleMs;
  // ONE pending waiter reused across ping cycles (see raceMs)
  const pending = queue.next();
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return null;
    }
    const wait = pingMs > 0 ? Math.min(remaining, pingMs) : remaining;
    const event = await raceMs(pending, wait);
    if (event) {
      return event;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    if (!res.writableEnded && !res.destroyed) {
      res.write(': ping\n\n');
    }
  }
}

export class Platform {
  constructor(readonly registry: FunctionRegistry = defaultRegistry) {}

  /** Start the Event API host. Resolves once listening; runs until stopped. */
  async run(options: { port?: number; host?: string } = {}): Promise<http.Server> {
    const config = appConfig();
    const appName = config.getProperty('application.name', 'application');
    const port = options.port ?? Number(config.get('rest.server.port', 8085));
    const host = options.host ?? '127.0.0.1';
    for (const service of this.registry.routes()) {
      const visibility = service.isPrivate ? 'PRIVATE' : 'PUBLIC';
      log.info(`Loaded ${visibility} ${service.route}, instances=${service.instances}`);
    }
    const server = new EventApiServer(this.registry).createServer();
    await new Promise<void>((resolve) => server.listen(port, host, resolve));
    log.info(`${appName} - Event API service started on port ${port}`);
    return server;
  }
}

export const platform = new Platform();
