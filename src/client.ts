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
import { EventEnvelope } from './envelope.js';
import { AppException } from './exceptions.js';
import { getTrace } from './trace.js';

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
              private readonly securityHeaders: Record<string, string> = {}) {}

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
    if (info?.traceId) event.setTrace(info.traceId, info.tracePath ?? route);
    const cid = options.cid ?? info?.cid;
    if (cid) event.setCorrelationId(cid);
    return event;
  }

  private async call(route: string, body: unknown, options: CallOptions,
                     isAsync: boolean): Promise<EventEnvelope> {
    const url = options.endpoint ?? this.endpoint;
    if (!url) {
      throw new Error("Missing event endpoint - " +
        "e.g. new PostOffice('http://peer:8085/api/event')");
    }
    const timeoutMs = options.timeoutMs ?? 30000;
    const event = this.buildEvent(route, body, options);
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
}
