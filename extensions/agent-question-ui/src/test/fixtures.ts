// Rows as the backend's publicRow() serves them, and a fake fetch that answers the backend's endpoints.
import type { Row } from '../types';

export const CALLS = [
  { id: 'toolu_01A', name: 'graph.task.write', route: 'order.cancel', wait: true, input: { order: 'o-7' } },
  { id: 'toolu_01B', name: 'graph.task.ask', ask: true, input: { question: 'Refund as well?', options: ['yes', 'no'] } }
];

export function row(over: Partial<Row> & { id: number; seq: number }): Row {
  return {
    kind: 'approval',
    graph_id: 'order-assistant',
    correlation_id: 'c-1',
    turn: 3,
    ticket: 't-1',
    link: 'http://127.0.0.1:8086/ask/t-1',
    description: 'Order assistant',
    summary: 'The model wants to cancel order o-7',
    details: 'The customer asked twice.',
    calls: CALLS,
    state: 'open',
    requested_at: '2026-11-20T08:00:00.000Z',
    expires_at: '2026-11-21T08:00:00.000Z',
    updated_at: '2026-11-20T08:00:00.000Z',
    answered_at: null,
    answered_by: null,
    decisions: null,
    outcome: null,
    ...over
  };
}

export interface FakeResponseInit {
  status?: number;
  body?: unknown;
  stream?: ReadableStream<Uint8Array>;
  /** The body as text when it is not JSON (the liveness probe's OK), with its content type. */
  text?: string;
  contentType?: string;
}

/** The slice of Response the Api reads: ok, status, headers, json(), text() and body. */
export function fakeResponse({ status = 200, body = null, stream, text, contentType }: FakeResponseInit): Response {
  const type = contentType ?? (text !== undefined ? 'text/plain' : stream ? 'text/event-stream' : 'application/json');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? type : null) },
    body: stream ?? null,
    json: async () => body,
    text: async () => text ?? JSON.stringify(body)
  } as unknown as Response;
}

export interface Call {
  url: string;
  init: RequestInit | undefined;
}

export type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

/** A fetch that records every call and routes it by path to a handler. */
export function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(new URL(url, 'http://ui.test'), init);
  }) as typeof globalThis.fetch;
  return { fetch: impl, calls };
}

export const encoder = new TextEncoder();

export const frame = (r: Row): string => `id: ${r.seq}\nevent: question\ndata: ${JSON.stringify(r)}\n\n`;

/** A stream whose frames the test pushes; `close()` ends it and `cancelled` tells when the reader gave it up. */
export function pushStream(): { stream: ReadableStream<Uint8Array>; push: (text: string) => void; close: () => void; cancelled: () => boolean } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    }
  });
  return {
    stream,
    push: (text) => {
      if (!closed && !cancelled) controller.enqueue(encoder.encode(text));
    },
    close: () => {
      if (!closed && !cancelled) {
        closed = true;
        controller.close();
      }
    },
    cancelled: () => cancelled
  };
}

export const headerOf = (init: RequestInit | undefined, name: string): string | undefined => {
  const headers = init?.headers as Record<string, string> | undefined;
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
};
