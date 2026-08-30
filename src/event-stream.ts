/**
 * Event streaming: the multi-shot reply contract and the envelope-mode SSE dialect.
 *
 * The platform's native streaming pattern (all four runtimes): the caller provides
 * a reply address; the callee streams events to it until a terminal signal. Each
 * segment is one event to the caller's reply_to, marked with the reserved envelope
 * header `x-event-stream: data | eof | exception`. On the Event-over-HTTP wire, the
 * peer answers the one POST with a Server-Sent Events response in a hybrid dialect:
 * envelope frames (the reserved SSE event name "envelope", one base64-encoded
 * serialized envelope per frame) wherever envelope semantics matter - the head, the
 * terminals and non-text segments - and raw SSE frames for plain text segments, so
 * token relays stay near-zero overhead.
 *
 * EventStreamWriter is the producer helper - the engines' exact API:
 *
 *   const out = EventStreamWriter.fromRequest(event);  // an interceptor's envelope
 *   out.first(200, 'text/event-stream');
 *   out.write('hello');                                // data segment
 *   out.writeNamed('tokens', { n: 2 });                // named (typed) SSE event
 *   out.close({ usage });                              // end of transmission
 *   // or out.fail(e);                                 // in-band failure
 *
 * Writes after close/fail are dropped (debug log), mirroring the engines. An
 * in-band failure body carries the standard error key-values
 * '{"type": "error", "status": n, "message": text}'.
 */
import { appConfig } from './config.js';
import { EventEnvelope } from './envelope.js';
import { AppException } from './exceptions.js';
import { getLogger } from './log.js';
import { getTrace } from './trace.js';
import { defaultRegistry, FunctionRegistry } from './registry.js';

/** reserved envelope header (internal protocol, never on the HTTP wire) */
export const X_EVENT_STREAM = 'x-event-stream';
/** optional companion on a data event: maps to the SSE "event:" field */
export const X_EVENT_NAME = 'x-event-name';
/** marker vocabulary - deliberately the engines' ObjectStream vocabulary */
export const DATA = 'data';
export const EOF = 'eof';
export const EXCEPTION = 'exception';
/**
 * reserved SSE event name of the envelope-mode wire dialect: a frame with
 * this name carries one base64-encoded serialized EventEnvelope
 */
export const ENVELOPE = 'envelope';

export const X_TTL = 'x-ttl';
export const TEXT_EVENT_STREAM = 'text/event-stream';
export const STREAM_CALLER_REQUIRED =
  'Streaming function requires a caller that accepts text/event-stream';

/** reserved envelope headers a raw SSE frame may carry without loss */
const RESERVED_HEADERS = new Set([X_EVENT_STREAM, X_EVENT_NAME, X_TTL]);

const log = getLogger('mercury.stream');

/** The x-event-stream marker (lowercased), or undefined for an unmarked envelope. */
export function streamSignal(event: EventEnvelope): string | undefined {
  for (const [key, value] of Object.entries(event.headers)) {
    if (key.toLowerCase() === X_EVENT_STREAM) {
      return value.toLowerCase();
    }
  }
  return undefined;
}

/** The x-event-name companion header (the SSE "event:" field), if any. */
export function streamEventName(event: EventEnvelope): string | undefined {
  for (const [key, value] of Object.entries(event.headers)) {
    if (key.toLowerCase() === X_EVENT_NAME) {
      return value;
    }
  }
  return undefined;
}

/** The message text of an unmarked error reply (objects render as JSON). */
export function errorText(body: unknown): string {
  if (body === undefined || body === null) {
    return 'Stream failed';
  }
  return typeof body === 'string' ? body : JSON.stringify(body);
}

/** The standard error key-values: '{"type": "error", "status": n, "message": text}' */
export function errorBody(status: number, message: string): Record<string, unknown> {
  return { type: 'error', status, message };
}

/** An in-band exception envelope with the standard error body. */
export function exceptionEnvelope(status: number, message: string): EventEnvelope {
  return new EventEnvelope()
    .setHeader(X_EVENT_STREAM, EXCEPTION)
    .setStatus(status)
    .setBody(errorBody(status, message));
}

/** One SSE frame: optional "event:" line, one "data:" line per text line. */
export function sseFrame(eventName: string | undefined, text: string): Buffer {
  const lines: string[] = [];
  if (eventName) {
    lines.push(`event: ${eventName}\n`);
  }
  for (const line of text.split('\n')) {
    lines.push(`data: ${line}\n`);
  }
  lines.push('\n');
  return Buffer.from(lines.join(''), 'utf-8');
}

/**
 * One envelope-mode wire frame: the envelope serialized verbatim - with the
 * host-internal addressing cleared, because the consuming relay rewrites
 * addressing to the original caller - as base64 under the reserved name.
 */
export function envelopeFrame(event: EventEnvelope): Buffer {
  const clone = EventEnvelope.fromMap(event.toMap());
  clone.to = undefined;
  clone.replyTo = undefined;
  const encoded = Buffer.from(clone.toBytes()).toString('base64');
  return sseFrame(ENVELOPE, encoded);
}

/**
 * A data segment may ride a raw SSE frame only when the frame carries it
 * losslessly: a 200 status, no custom envelope headers, a user event name
 * clear of the reserved word, and a text (or empty) body without a carriage
 * return - SSE normalizes line endings. Everything else takes the
 * envelope-frame escape hatch.
 */
export function rawStreamable(event: EventEnvelope): boolean {
  if (event.getStatus() !== 200) {
    return false;
  }
  for (const [key, value] of Object.entries(event.headers)) {
    const lowered = key.toLowerCase();
    if (!RESERVED_HEADERS.has(lowered)) {
      return false;
    }
    if (lowered === X_EVENT_NAME && value === ENVELOPE) {
      return false;
    }
  }
  const body = event.body;
  return body === undefined || body === null ||
    (typeof body === 'string' && !body.includes('\r'));
}

/**
 * One envelope-mode data frame: the first event always rides an envelope
 * frame (it carries the head control); a losslessly raw-able text segment
 * rides a raw frame; a bare no-op segment carries nothing.
 */
export function dataFrame(event: EventEnvelope, firstFrame: boolean): Buffer {
  if (firstFrame || !rawStreamable(event)) {
    return envelopeFrame(event);
  }
  if (event.body === undefined || event.body === null) {
    return Buffer.alloc(0);
  }
  return sseFrame(streamEventName(event), event.body as string);
}

/**
 * SSE keep-alive comment interval in ms (`event.stream.keep.alive`,
 * default 30s; 0 disables - the engines' config key).
 */
export function keepAliveMs(): number {
  const raw = String(appConfig().getProperty('event.stream.keep.alive', '30s') ?? '30s')
    .trim().toLowerCase();
  if (raw === '0' || raw === '0s' || raw === '0ms' || raw === '0m') {
    return 0;
  }
  const parse = (text: string): number => Number.parseInt(text, 10);
  let value: number;
  if (raw.endsWith('ms')) {
    value = parse(raw.slice(0, -2));
  } else if (raw.endsWith('s')) {
    value = parse(raw.slice(0, -1)) * 1000;
  } else if (raw.endsWith('m')) {
    value = parse(raw.slice(0, -1)) * 60_000;
  } else {
    value = parse(raw) * 1000;
  }
  return Number.isFinite(value) ? value : 30_000;
}

/**
 * Incremental SSE frame parser: byte-level line split (a newline is a single
 * byte, so this is UTF-8 safe), one-leading-space value strip, comment/id/
 * retry suppression, multi-line data joined per the SSE specification.
 * Mirrors the engines' parsers.
 */
export class SseParser {
  private pending: Buffer = Buffer.alloc(0);
  private dataLines: string[] = [];
  private eventName: string | undefined;

  /** Feed one body chunk; return the completed [event_name, data] events. */
  feed(chunk: Uint8Array): Array<[string | undefined, string]> {
    const buffer = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const events: Array<[string | undefined, string]> = [];
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== 0x0a) { // '\n'
        continue;
      }
      const end = i > start && buffer[i - 1] === 0x0d ? i - 1 : i;
      this.onLine(buffer.subarray(start, end).toString('utf-8'), events);
      start = i + 1;
    }
    this.pending = Buffer.from(buffer.subarray(start));
    return events;
  }

  /**
   * One SSE line: a blank line dispatches the pending event; a comment line
   * (leading colon) is consumed, never forwarded; id, retry and unknown
   * fields are ignored (SSE specification).
   */
  private onLine(line: string, events: Array<[string | undefined, string]>): void {
    if (!line) {
      if (this.dataLines.length) {
        events.push([this.eventName, this.dataLines.join('\n')]);
      }
      this.dataLines = [];
      this.eventName = undefined;
      return;
    }
    if (line.startsWith(':')) {
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'data') {
      this.dataLines.push(value);
    } else if (field === 'event') {
      this.eventName = value;
    }
  }
}

/**
 * Producer helper for a multi-shot reply - the engines' exact API.
 *
 * Only an interceptor function can stream: it receives the raw envelope, so
 * the caller-provided reply address travels the engines' way
 * (EventStreamWriter.fromRequest(event) reads reply_to and the correlation
 * id). Segments route to the LOCAL reply address through the primitive event
 * bus - simple routing to a local function or reply sink, never across the
 * wire (cross-wire replies ride the Event-over-HTTP SSE response, exactly as
 * on the engines).
 */
export class EventStreamWriter {
  private readonly registry: FunctionRegistry;
  private readonly replyTo: string;
  private readonly cid: string | undefined;
  private firstStatus = 200;
  private firstContentType: string | undefined;
  private firstTtlSeconds = 0;
  private headSent = false;
  private isClosed = false;

  constructor(replyTo: string | undefined, correlationId?: string,
              registry: FunctionRegistry = defaultRegistry) {
    if (!replyTo) {
      throw new AppException(400, 'Streaming producer requires a reply_to address');
    }
    this.registry = registry;
    this.replyTo = replyTo;
    this.cid = correlationId;
  }

  /**
   * Create a writer from the incoming request envelope (the usual form for
   * an interceptor function).
   */
  static fromRequest(event: EventEnvelope,
                     registry: FunctionRegistry = defaultRegistry): EventStreamWriter {
    return new EventStreamWriter(event.replyTo, event.cid, registry);
  }

  /**
   * Optional head control carried by the first outgoing event: response
   * status, content type, and an optional idle-allowance override in seconds
   * between segments.
   */
  first(status: number, contentType: string, ttlSeconds?: number): this {
    this.firstStatus = Math.trunc(status);
    this.firstContentType = contentType;
    if (ttlSeconds !== undefined) {
      this.firstTtlSeconds = Math.trunc(ttlSeconds);
    }
    return this;
  }

  /** Send one `data` segment (text, bytes, object, array - any payload). */
  write(segment: unknown): void {
    this.send(DATA, segment, undefined);
  }

  /** Send one named segment - the name maps to the SSE "event:" field. */
  writeNamed(eventName: string, segment: unknown): void {
    this.send(DATA, segment, eventName);
  }

  /** Declare end of transmission, with optional trailing metadata. */
  close(trailingMetadata?: unknown): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.emit(this.envelope(EOF, trailingMetadata, undefined));
  }

  /** Declare an in-band failure and end the stream. */
  fail(error: Error): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    let status = error instanceof AppException ? error.status : 500;
    status = status >= 400 ? status : 500;
    const message = error.message || error.name;
    const event = this.envelope(EXCEPTION, errorBody(status, message), undefined);
    event.setStatus(status);
    this.emit(event);
  }

  /** True when the stream has been closed or failed. */
  get closed(): boolean {
    return this.isClosed;
  }

  private send(marker: string, body: unknown, eventName: string | undefined): void {
    if (this.isClosed) {
      log.debug(`Segment to ${this.replyTo} dropped - stream already closed`);
      return;
    }
    this.emit(this.envelope(marker, body, eventName));
  }

  private envelope(marker: string, body: unknown, eventName: string | undefined): EventEnvelope {
    const event = new EventEnvelope(this.replyTo, body).setHeader(X_EVENT_STREAM, marker);
    if (this.cid) {
      event.setCorrelationId(this.cid);
    }
    if (eventName) {
      event.setHeader(X_EVENT_NAME, eventName);
    }
    if (!this.headSent) {
      this.headSent = true;
      event.setStatus(this.firstStatus);
      if (this.firstContentType) {
        event.setHeader('content-type', this.firstContentType);
      }
      if (this.firstTtlSeconds > 0) {
        event.setHeader(X_TTL, String(this.firstTtlSeconds));
      }
    }
    // segments inherit the producer's identity, trace and span, so a
    // consuming engine's per-segment delivery spans parent onto this
    // function (the engines' po.send/touch parity)
    const info = getTrace();
    if (info?.route) {
      event.setFrom(info.route);
    }
    if (info?.traceId) {
      event.setTrace(info.traceId, info.tracePath ?? this.replyTo);
      if (info.spanId) {
        event.setSpanId(info.spanId);
      }
    }
    return event;
  }

  private emit(event: EventEnvelope): void {
    if (!this.registry.sendEvent(event)) {
      log.warn(`Event dropped - route ${this.replyTo} not found`);
    }
  }
}
