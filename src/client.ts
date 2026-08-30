/**
 * Thin Event-over-HTTP client — the PostOffice analog.
 *
 * Sends an event envelope to a peer's /api/event endpoint (a Java or Rust
 * engine application, or another polyglot function host) with the same HTTP
 * contract as the engines' relay: content-type application/octet-stream,
 * accept *&#47;*, x-no-stream, x-ttl (ms), x-async for drop-n-forget, optional
 * security headers, and trace headers (X-Trace-Id plus a W3C traceparent when
 * the trace id is W3C-shaped).
 *
 * The decoded reply envelope is authoritative: an error from the target rides
 * back as a normal envelope with status >= 400 — inspect reply.getStatus().
 */
import { asyncAck, DeliveryTimeout, raceMs } from './bus.js';
import { EventEnvelope } from './envelope.js';
import {
  DATA,
  ENVELOPE,
  EOF,
  errorText,
  EXCEPTION,
  exceptionEnvelope,
  SseParser,
  STREAM_CALLER_REQUIRED,
  streamSignal,
  TEXT_EVENT_STREAM,
  X_EVENT_NAME,
  X_EVENT_STREAM
} from './event-stream.js';
import { AppException } from './exceptions.js';
import { defaultRegistry, FunctionRegistry } from './registry.js';
import { getTrace, MY_CID_TAG, RPC_TAG } from './trace.js';

const W3C_TRACE_ID = /^[0-9a-f]{32}$/;
const W3C_SPAN_ID = /^[0-9a-f]{16}$/;

export interface CallOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  endpoint?: string;
  fromRoute?: string;
  cid?: string;
}

export class PostOffice {
  constructor(private readonly endpoint?: string,
              private readonly securityHeaders: Record<string, string> = {},
              private readonly registry: FunctionRegistry = defaultRegistry) {}

  /** In-app delivery through the primitive event bus (private OR public). */
  private async callLocal(route: string, body: unknown, options: CallOptions,
                          isAsync: boolean): Promise<EventEnvelope> {
    const service = this.registry.get(route);
    if (!service) {
      return new EventEnvelope().setStatus(404).setBody(`Route ${route} not found`);
    }
    const timeoutMs = options.timeoutMs ?? 30000;
    const event = this.buildEvent(route, body, options);
    if (!isAsync) {
      // the engines' RPC round-trip marker: an RPC leg emits no trace
      // dataset - its metrics fold into the caller's view
      event.tags[RPC_TAG] ??= String(timeoutMs);
    }
    const trace = {
      traceId: event.traceId, tracePath: event.tracePath, cid: event.cid,
      envelope: event
    };
    const bus = this.registry.bus;
    if (service.interceptor) {
      if (isAsync) {
        bus.publishEnvelope(service, event);
        return asyncAck();
      }
      // RPC to an interceptor: a per-request reply sink is the reply address;
      // the first envelope classifies exactly like the engines - unmarked =
      // the reply; marked = a streaming target refusing a single-shot caller
      const [sinkRoute, queue] = bus.openSink();
      try {
        bus.publishEnvelope(service, event.setReplyTo(sinkRoute));
        const first = await raceMs(queue.next(), Math.max(100, timeoutMs));
        if (!first) {
          return new EventEnvelope().setStatus(408).setBody(`Timeout for ${timeoutMs} ms`);
        }
        if (streamSignal(first) !== undefined) {
          return new EventEnvelope().setStatus(406).setBody(STREAM_CALLER_REQUIRED);
        }
        return first;
      } finally {
        bus.closeSink(sinkRoute);
      }
    }
    if (isAsync) {
      return bus.publish(service, event.headers, event.body, trace);
    }
    try {
      return await bus.deliver(service, event.headers, event.body, timeoutMs, trace);
    } catch (e) {
      if (e instanceof DeliveryTimeout) {
        return new EventEnvelope().setStatus(408).setBody(`Timeout for ${timeoutMs} ms`);
      }
      throw e;
    }
  }

  private httpHeaders(timeoutMs: number, isAsync: boolean,
                      event: EventEnvelope): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'accept': '*/*',
      'x-no-stream': 'true',
      'x-ttl': String(Math.max(100, timeoutMs))
    };
    if (isAsync) headers['x-async'] = 'true';
    for (const [key, value] of Object.entries(this.securityHeaders)) {
      if (key.toLowerCase() !== 'x-event-format') headers[key] = value;
    }
    if (event.traceId) {
      headers['X-Trace-Id'] = event.traceId;
      if (W3C_TRACE_ID.test(event.traceId) && event.spanId && W3C_SPAN_ID.test(event.spanId)) {
        headers['traceparent'] = `00-${event.traceId}-${event.spanId}-01`;
      }
    }
    return headers;
  }

  private buildEvent(route: string, body: unknown, options: CallOptions): EventEnvelope {
    const event = new EventEnvelope(route, body, options.headers);
    if (options.fromRoute) event.setFrom(options.fromRoute);
    const info = getTrace();
    // fill the sender with the executing function's route (touch parity)
    if (info?.route && !event.sender) {
      event.setFrom(info.route);
    }
    if (info?.traceId) event.setTrace(info.traceId, info.tracePath ?? route);
    const cid = options.cid ?? info?.cid;
    if (cid) event.setCorrelationId(cid);
    // propagate the business correlation-id to the next touch point as the
    // engine-managed my_cid tag (the engines' PostOffice.touch parity) - the
    // receiving host injects it as the read-only my_correlation_id header
    if (info?.myCorrelationId && !(MY_CID_TAG in event.tags)) {
      event.tags[MY_CID_TAG] = info.myCorrelationId;
    }
    // carry this execution's span so the receiver stores it as its
    // parent_span_id (touch parity) - also lights up the traceparent header
    if (info?.spanId) {
      event.setSpanId(info.spanId);
    }
    return event;
  }

  private async call(route: string, body: unknown, options: CallOptions,
                     isAsync: boolean): Promise<EventEnvelope> {
    const url = options.endpoint ?? this.endpoint;
    if (!url) {
      // no endpoint = local: the engines' semantics for an in-app po call
      return this.callLocal(route, body, options, isAsync);
    }
    const timeoutMs = options.timeoutMs ?? 30000;
    const event = this.buildEvent(route, body, options);
    if (!isAsync) {
      // the engines' RPC round-trip marker (see callLocal)
      event.tags[RPC_TAG] ??= String(timeoutMs);
    }
    // +100 ms cushion so the HTTP client does not time out before the target
    const response = await fetch(url, {
      method: 'POST',
      headers: this.httpHeaders(timeoutMs, isAsync, event),
      body: event.toBytes(),
      signal: AbortSignal.timeout(Math.max(100, timeoutMs) + 100)
    });
    const payload = new Uint8Array(await response.arrayBuffer());
    try {
      return EventEnvelope.fromBytes(payload);
    } catch (e) {
      throw new AppException(response.status,
        `Invalid event-over-http response - ${(e as Error).message}`);
    }
  }

  /** RPC call: returns the target function's reply envelope. */
  async request(route: string, body?: unknown, options: CallOptions = {}): Promise<EventEnvelope> {
    return this.call(route, body, options, false);
  }

  /** Drop-n-forget: returns the peer's 202 delivery acknowledgement envelope. */
  async send(route: string, body?: unknown, options: CallOptions = {}): Promise<EventEnvelope> {
    return this.call(route, body, options, true);
  }

  /**
   * Consume a streaming function progressively - the same decoded envelopes
   * an engine reply route receives: `data` segments, then the `eof` or
   * `exception` terminal. A non-streaming target yields its one classic reply
   * (opting in is always safe). `timeoutMs` is the idle allowance between
   * segments; expiry, a truncated stream and a malformed dialect yield the
   * in-band exception envelope, then end.
   *
   * Remote (an endpoint is given, or set on the constructor): the peer's
   * /api/event answers the one POST with the envelope-mode SSE dialect.
   * Local (no endpoint): the same first-envelope classification through a
   * per-request reply sink on the primitive bus.
   */
  async *stream(route: string, body?: unknown,
                options: CallOptions = {}): AsyncGenerator<EventEnvelope, void, void> {
    const url = options.endpoint ?? this.endpoint;
    const timeoutMs = options.timeoutMs ?? 30000;
    const event = this.buildEvent(route, body, options);
    if (!url) {
      yield* this.streamLocal(route, event, timeoutMs);
      return;
    }
    yield* this.streamRemote(url, event, timeoutMs);
  }

  /**
   * The relay form of stream() for composition: every decoded envelope
   * forwards verbatim to the LOCAL replyTo route (typically the caller's own
   * reply address, handed through by an interceptor), so segments flow
   * remote peer -> this application -> the original caller with no
   * buffering. Awaits and returns the last envelope (normally the terminal).
   */
  async streamTo(route: string, body: unknown, replyTo: string,
                 options: CallOptions = {}): Promise<EventEnvelope> {
    let last = new EventEnvelope().setStatus(500).setBody('Stream produced no events');
    for await (const segment of this.stream(route, body, options)) {
      last = segment;
      const forward = EventEnvelope.fromMap(segment.toMap()).setTo(replyTo);
      if (!this.registry.sendEvent(forward)) {
        // the local consumer is gone - late segments are no-op drops
        break;
      }
    }
    return last;
  }

  private async *streamLocal(route: string, event: EventEnvelope,
                             timeoutMs: number): AsyncGenerator<EventEnvelope, void, void> {
    const service = this.registry.get(route);
    if (!service) {
      yield new EventEnvelope().setStatus(404).setBody(`Route ${route} not found`);
      return;
    }
    if (!service.interceptor) {
      // a plain function cannot stream - its single reply is the stream
      yield await this.callLocal(route, event.body, {
        headers: event.headers, timeoutMs, fromRoute: event.sender, cid: event.cid
      }, false);
      return;
    }
    const bus = this.registry.bus;
    const [sinkRoute, queue] = bus.openSink();
    try {
      bus.publishEnvelope(service, event.setReplyTo(sinkRoute));
      const idleMs = Math.max(100, timeoutMs);
      let streaming = false;
      for (;;) {
        // a lost race terminates the wait, so a fresh next() per cycle is safe
        const reply = await raceMs(queue.next(), idleMs);
        if (!reply) {
          const seconds = Math.trunc(idleMs / 1000);
          yield exceptionEnvelope(408, `Timeout for ${seconds} seconds`);
          return;
        }
        const [out, done] = classifySinkReply(reply, streaming);
        streaming = true;
        yield out;
        if (done) {
          return;
        }
      }
    } finally {
      bus.closeSink(sinkRoute);
    }
  }

  private async *streamRemote(url: string, event: EventEnvelope,
                              timeoutMs: number): AsyncGenerator<EventEnvelope, void, void> {
    const effectiveCid = event.cid;
    const headers = this.httpHeaders(timeoutMs, false, event);
    headers['accept'] = TEXT_EVENT_STREAM;
    // no total limit - a healthy stream may outlive any fixed total; the
    // per-read race below is the idle allowance between segments
    const idleMs = Math.max(1000, timeoutMs);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: event.toBytes()
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith(TEXT_EVENT_STREAM)) {
      // the peer answered single-shot (a non-streaming target, or an edge
      // error) - the classic reply, decoded tolerantly
      const payload = new Uint8Array(await response.arrayBuffer());
      yield decodeSingleShot(payload, response.status);
      return;
    }
    const body = response.body;
    if (!body) {
      yield relayGuard(500, 'Event stream ended without eof', effectiveCid);
      return;
    }
    const reader = body.getReader();
    try {
      yield* relayFrames(reader, idleMs, effectiveCid);
    } catch (e) {
      yield relayGuard(500, (e as Error).message ?? String(e), effectiveCid);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}

/**
 * Pump the envelope-mode SSE frames of one response body: decoded envelopes
 * out, ending at the terminal (frames after it are discarded); idle expiry
 * and a transport end without a decoded terminal fail in-band.
 */
async function* relayFrames(reader: ReadableStreamDefaultReader<Uint8Array>,
                            idleMs: number,
                            cid: string | undefined): AsyncGenerator<EventEnvelope, void, void> {
  const parser = new SseParser();
  let headSeen = false;
  for (;;) {
    // a lost race terminates the stream, so a fresh read() per cycle is safe
    const result = await raceMs(reader.read(), idleMs);
    if (!result) {
      const seconds = Math.trunc(idleMs / 1000);
      yield relayGuard(408, `Timeout for ${seconds} seconds`, cid);
      return;
    }
    if (result.done) {
      // the dialect ends with a decoded terminal - a bare transport end is a
      // truncation
      yield relayGuard(500, 'Event stream ended without eof', cid);
      return;
    }
    for (const [name, text] of parser.feed(result.value)) {
      const [reply, terminal] = decodeFrame(name, text, headSeen, cid);
      if (!reply) {
        continue;
      }
      headSeen = true;
      yield reply;
      if (terminal) {
        return; // frames after the terminal are discarded
      }
    }
  }
}

/**
 * Classify one reply-sink envelope exactly like the engines: unmarked before
 * any segment = the classic single-shot answer; unmarked mid-stream = the
 * bus's error contract for an uncaught interceptor exception (fails
 * in-band); marked = a stream segment, terminal on eof/exception.
 */
function classifySinkReply(reply: EventEnvelope,
                           streaming: boolean): [EventEnvelope, boolean] {
  const marker = streamSignal(reply);
  if (marker === undefined) {
    if (streaming) {
      return [exceptionEnvelope(reply.getStatus(), errorText(reply.body)), true];
    }
    return [reply, true];
  }
  return [reply, marker === EOF || marker === EXCEPTION];
}

/** An in-band exception envelope synthesized by the consuming relay. */
function relayGuard(status: number, message: string,
                    cid: string | undefined): EventEnvelope {
  const event = exceptionEnvelope(status, message);
  if (cid) {
    event.setCorrelationId(cid);
  }
  return event;
}

/**
 * Decode one SSE frame of the envelope-mode dialect: an "envelope" frame is
 * one base64-encoded serialized envelope (the head, the terminals and
 * non-text segments); any other frame is a raw text segment. Returns
 * [envelope-or-null, terminal]. Dialect guards fail in-band: the first frame
 * must be an envelope frame, and a malformed frame ends the stream.
 */
function decodeFrame(name: string | undefined, text: string, headSeen: boolean,
                     cid: string | undefined): [EventEnvelope | null, boolean] {
  if (name === ENVELOPE) {
    return decodeEnvelopeFrame(text, cid);
  }
  if (!headSeen) {
    // the dialect guarantees an envelope frame first (conformance guard)
    return [relayGuard(500, 'Invalid event stream - missing envelope head', cid), true];
  }
  const segment = new EventEnvelope(undefined, text).setHeader(X_EVENT_STREAM, DATA);
  if (name) {
    segment.setHeader(X_EVENT_NAME, name);
  }
  if (cid) {
    segment.setCorrelationId(cid);
  }
  return [segment, false];
}

/**
 * One base64-encoded serialized envelope: the head, a terminal, or a
 * non-text segment - addressing restored to the original caller; a
 * malformed frame ends the stream in-band.
 */
function decodeEnvelopeFrame(text: string,
                             cid: string | undefined): [EventEnvelope, boolean] {
  let decoded: EventEnvelope;
  try {
    decoded = EventEnvelope.fromBytes(Buffer.from(text, 'base64'));
  } catch {
    return [relayGuard(500, 'Invalid event stream - malformed envelope frame', cid), true];
  }
  decoded.to = undefined;
  decoded.replyTo = undefined;
  if (cid) {
    decoded.setCorrelationId(cid);
  }
  const marker = streamSignal(decoded);
  return [decoded, marker === EOF || marker === EXCEPTION];
}

/**
 * Decode a single-shot Event-over-HTTP reply: a serialized envelope
 * normally, with the classic tolerant handling of an edge-level REST error
 * body ('{"type": "error", "status": n, "message": text}' JSON) and of a
 * payload that is not a serialized envelope at all.
 */
function decodeSingleShot(payload: Uint8Array, httpStatus: number): EventEnvelope {
  if (!payload.length) {
    return new EventEnvelope().setStatus(httpStatus);
  }
  try {
    const reply = EventEnvelope.fromBytes(payload);
    reply.replyTo = undefined;
    return reply;
  } catch (e) {
    const restError = restErrorReply(payload, httpStatus);
    return restError ?? new EventEnvelope().setStatus(400)
      .setBody(`Invalid event-over-http response - ${(e as Error).message}`);
  }
}

/**
 * An edge-level REST error arrives as JSON, not as a serialized envelope -
 * unwrap it exactly as the classic relay does; null when it is not one.
 */
function restErrorReply(payload: Uint8Array, httpStatus: number): EventEnvelope | null {
  if (httpStatus < 400) {
    return null;
  }
  try {
    const data: unknown = JSON.parse(Buffer.from(payload).toString('utf-8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      if (record['type'] === 'error' && typeof record['message'] === 'string') {
        return new EventEnvelope().setStatus(httpStatus).setBody(record['message']);
      }
    }
  } catch {
    // not a REST error body
  }
  return null;
}
