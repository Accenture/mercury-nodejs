/**
 * Event streaming tests: the multi-shot reply contract and the envelope-mode
 * SSE dialect over real HTTP - the wrapper half of the engines' Phase 2/3
 * matrix (Java EventOverHttpStreamTest / python test_event_stream twins).
 */
import assert from 'node:assert/strict';
import type * as http from 'node:http';
import { after, before, test } from 'node:test';
import { PostOffice } from '../src/client.js';
import { EventEnvelope } from '../src/envelope.js';
import {
  EventStreamWriter,
  streamEventName,
  streamSignal
} from '../src/event-stream.js';
import { AppException } from '../src/exceptions.js';
import { FunctionRegistry } from '../src/registry.js';
import { EventApiServer } from '../src/server.js';
import { getTrace, runWithTrace } from '../src/trace.js';

const SSE = 'text/event-stream';
const OCTET = 'application/octet-stream';
const REFUSAL = 'Streaming function requires a caller that accepts text/event-stream';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref());

// the relay fixture learns its own host URL after the server binds
const relayTarget: { url?: string } = {};

function buildRegistry(): FunctionRegistry {
  const registry = new FunctionRegistry();

  registry.register('unit.tokens', async (headers, rawEvent) => {
    const event = rawEvent as EventEnvelope;
    const out = EventStreamWriter.fromRequest(event, registry);
    const mode = headers['mode'] ?? 'tokens';
    if (mode === 'tokens') {
      out.first(200, SSE);
      out.write('alpha');
      await sleep(250);
      out.write('beta');
      await sleep(250);
      out.close({ segments: 2 });
    } else if (mode === 'typed') {
      // every escape-hatch trigger: an object body, text with a carriage
      // return, a user event name colliding with the reserved word, a binary
      // body - plus one plain token that rides a raw frame
      out.first(200, SSE);
      out.write({ n: 1 });
      out.writeNamed('crlf', 'line1\r\nline2');
      out.writeNamed('envelope', 'reserved-name');
      out.write(new Uint8Array([1, 2, 3, 4]));
      out.write('plain token');
      out.close({ done: true });
    } else if (mode === 'error-mid') {
      out.first(200, SSE);
      out.write('partial');
      out.fail(new AppException(503, 'backend on fire'));
    } else if (mode === 'error-first') {
      out.fail(new AppException(503, 'no backend'));
    } else if (mode === 'stall') {
      // one-second declared idle allowance, then silence - the host must
      // fail the stream in-band
      out.first(200, SSE, 1);
      out.write('one');
    } else if (mode === 'crash-before') {
      throw new Error('kaboom before head');
    } else if (mode === 'crash-mid') {
      out.first(200, SSE);
      out.write('early');
      throw new Error('kaboom mid-stream');
    } else if (mode === 'manual') {
      // a single-shot manual answer from an interceptor
      const reply = new EventEnvelope(event.replyTo, { manual: true });
      if (event.cid) {
        reply.setCorrelationId(event.cid);
      }
      registry.sendEvent(reply);
    } else if (mode === 'biz') {
      // echo the injected business correlation-id view and the span lineage
      // of this execution (continuity proof)
      const info = getTrace();
      out.first(200, SSE);
      out.close({
        my_correlation_id: headers['my_correlation_id'] ?? null,
        span_id: info?.spanId ?? null,
        parent_span_id: info?.parentSpanId ?? null
      });
    }
  }, { interceptor: true });

  registry.register('unit.relay', async (_headers, rawEvent) => {
    // the composition: forward MY caller's reply address into a call against
    // a remote streaming function - segments flow through verbatim
    const event = rawEvent as EventEnvelope;
    const po = new PostOffice(undefined, {}, registry);
    await po.streamTo('unit.tokens', undefined, event.replyTo ?? '', {
      endpoint: relayTarget.url, timeoutMs: 10000, cid: event.cid
    });
  }, { interceptor: true });

  registry.register('unit.echo', async (_headers, body) => ({ echo: body ?? null }));
  registry.register('unit.biz', async (headers) =>
    ({ my_correlation_id: headers['my_correlation_id'] ?? null }));
  return registry;
}

let registry: FunctionRegistry;
let server: http.Server;
let url: string;

before(async () => {
  registry = buildRegistry();
  server = new EventApiServer(registry).createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  url = `http://127.0.0.1:${address.port}/api/event`;
  relayTarget.url = url;
});

after(() => {
  registry.bus.close();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

async function collect(po: PostOffice, route: string, target: string | undefined,
                       mode?: string, timeoutMs = 10000,
                       cid = 'cid-100'): Promise<EventEnvelope[]> {
  const events: EventEnvelope[] = [];
  const headers = mode ? { mode } : undefined;
  for await (const event of po.stream(route, undefined,
                                      { headers, timeoutMs, endpoint: target, cid })) {
    events.push(event);
  }
  return events;
}

// ---- the host produces the envelope-mode dialect ----

test('streaming target relays progressively to the consumer', async () => {
  const po = new PostOffice();
  const events = await collect(po, 'unit.tokens', url);
  assert.equal(events.length, 3, '2 data envelopes + eof');
  const head = events[0];
  assert.equal(streamSignal(head), 'data');
  assert.equal(head.getStatus(), 200);
  assert.equal(head.headers['content-type'], SSE);
  assert.equal(head.body, 'alpha');
  assert.equal(head.cid, 'cid-100', 'original correlation id restored');
  assert.equal(events[1].body, 'beta');
  const eof = events[2];
  assert.equal(streamSignal(eof), 'eof');
  assert.deepEqual(eof.body, { segments: 2 });
});

test('the wire is the hybrid dialect', async () => {
  // raw wire pin: the head and the terminal ride envelope frames; the plain
  // text token rides a raw frame
  const event = new EventEnvelope('unit.tokens').setHeader('mode', 'tokens');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': OCTET, 'x-ttl': '10000', 'accept': SSE },
    body: event.toBytes()
  });
  assert.equal(response.status, 200);
  assert.ok((response.headers.get('content-type') ?? '').startsWith(SSE));
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  const text = await response.text();
  const frames = text.split('\n\n').filter((f) => f.trim());
  assert.ok(frames[0].startsWith('event: envelope\n'), 'head control rides an envelope frame');
  assert.ok(frames.includes('data: beta'), 'a plain token rides a raw frame');
  assert.ok(frames[frames.length - 1].startsWith('event: envelope\n'),
    'the terminal is an envelope frame');
  // the terminal decodes to the eof envelope with its exact metadata
  const encoded = frames[frames.length - 1].split('data: ', 2)[1];
  const terminal = EventEnvelope.fromBytes(Buffer.from(encoded, 'base64'));
  assert.equal(streamSignal(terminal), 'eof');
  assert.deepEqual(terminal.body, { segments: 2 });
  // host-internal addressing never leaks to the wire
  assert.equal(terminal.to, undefined);
  assert.equal(terminal.replyTo, undefined);
});

test('typed segments round-trip exactly', async () => {
  const po = new PostOffice();
  const events = await collect(po, 'unit.tokens', url, 'typed');
  assert.equal(events.length, 6, '5 data envelopes + eof');
  assert.deepEqual(events[0].body, { n: 1 });
  const crlf = events[1];
  assert.equal(streamEventName(crlf), 'crlf');
  assert.equal(crlf.body, 'line1\r\nline2', 'carriage return preserved');
  const reserved = events[2];
  assert.equal(streamEventName(reserved), 'envelope',
    'a user event name colliding with the reserved word survives');
  assert.equal(reserved.body, 'reserved-name');
  assert.deepEqual(new Uint8Array(events[3].body as Uint8Array),
    new Uint8Array([1, 2, 3, 4]), 'binary body preserved');
  assert.equal(events[4].body, 'plain token');
  const eof = events[5];
  assert.equal(streamSignal(eof), 'eof');
  assert.deepEqual(eof.body, { done: true });
});

test('single-shot over the capable path is classic', async () => {
  const po = new PostOffice();
  // an interceptor's manual single-shot answer
  let events = await collect(po, 'unit.tokens', url, 'manual');
  assert.equal(events.length, 1);
  assert.equal(streamSignal(events[0]), undefined);
  assert.deepEqual(events[0].body, { manual: true });
  assert.equal(events[0].cid, 'cid-100');
  // a plain (non-interceptor) function - opting in is always safe
  events = await collect(po, 'unit.echo', url);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].body, { echo: null });
});

test('the business cid rides the streaming hop', async () => {
  // the caller's business correlation-id (the my_cid tag) crosses the HTTP
  // hop and is injected as the my_correlation_id header view at delivery
  const po = new PostOffice();
  const events = await runWithTrace(
    { traceId: 'biz-trace-1', tracePath: 'TEST /stream', myCorrelationId: 'biz-42', annotations: {} },
    () => collect(po, 'unit.tokens', url, 'biz'));
  assert.equal(streamSignal(events[events.length - 1]), 'eof');
  const body = events[events.length - 1].body as Record<string, unknown>;
  assert.equal(body.my_correlation_id, 'biz-42');
});

test('span lineage continues across the hop', async () => {
  // the engines' span model: the caller's span rides the outbound envelope;
  // the receiving execution mints its own span with the caller's as parent
  const callerSpan = 'ab'.repeat(8);
  const po = new PostOffice();
  const events = await runWithTrace(
    { traceId: '4bf92f3577b34da6a3ce929d0e0e4746', tracePath: 'TEST /lineage',
      spanId: callerSpan, annotations: {} },
    () => collect(po, 'unit.tokens', url, 'biz'));
  const body = events[events.length - 1].body as Record<string, unknown>;
  assert.equal(body.parent_span_id, callerSpan);
  assert.notEqual(body.span_id, callerSpan);
  assert.match(String(body.span_id), /^[0-9a-f]{16}$/, '16-hex W3C-shaped span');
});

test('trace datasets are emitted with the engine shape', async () => {
  // non-RPC executions emit the engines' distributed-trace dataset record;
  // RPC round-trips are suppressed (their metrics fold into the caller)
  const callerSpan = 'cd'.repeat(8);
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // tee, never swallow: the test runner's own completion records ride this
  // stream too - eating them silently drops tests from the run report
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    const po = new PostOffice();
    await runWithTrace(
      { traceId: '4bf92f3577b34da6a3ce929d0e0e4747', tracePath: 'TEST /telemetry',
        spanId: callerSpan, annotations: {} },
      async () => {
        await collect(po, 'unit.tokens', url, 'biz');
        const rpc = await new PostOffice(undefined, {}, registry)
          .request('unit.biz', undefined, { timeoutMs: 5000 });
        assert.equal(rpc.getStatus(), 200);
      });
  } finally {
    process.stdout.write = original;
  }
  // text mode renders a dataset as '... distributed.tracing - {json}'
  const datasets = lines
    .filter((line) => line.includes('distributed.tracing'))
    .map((line) => JSON.parse(line.slice(line.indexOf(' - ') + 3)) as
      { trace: Record<string, unknown>; annotations?: Record<string, unknown> });
  const services = datasets.map((d) => d.trace.service);
  assert.ok(!services.includes('unit.biz'), 'RPC legs emit no dataset (engine parity)');
  const tokens = datasets.filter((d) => d.trace.service === 'unit.tokens');
  assert.equal(tokens.length, 1);
  const trace = tokens[0].trace;
  assert.equal(trace.id, '4bf92f3577b34da6a3ce929d0e0e4747');
  assert.equal(trace.path, 'TEST /telemetry');
  assert.equal(trace.parent_span_id, callerSpan);
  assert.equal(trace.success, true);
  assert.equal(trace.status, 200);
  // an anonymous /api/event caller: the host fills the sender with its own
  // identity, the engines' EventApiService parity
  assert.equal(trace.from, 'event.api.service');
  for (const key of ['origin', 'start', 'exec_time', 'span_id']) {
    assert.ok(key in trace, `engine dataset key ${key}`);
  }
});

test('the business cid is injected on local delivery', async () => {
  // engine WorkerHandler parity: local bus deliveries inject the read-only
  // view too, and no context means no injection
  const po = new PostOffice(undefined, {}, registry);
  const reply = await runWithTrace(
    { traceId: 'biz-trace-2', tracePath: 'TEST /local', myCorrelationId: 'biz-7', annotations: {} },
    () => po.request('unit.biz', undefined, { timeoutMs: 5000 }));
  assert.deepEqual(reply.body, { my_correlation_id: 'biz-7' });
  const plain = await po.request('unit.biz', undefined, { timeoutMs: 5000 });
  assert.deepEqual(plain.body, { my_correlation_id: null });
});

test('streaming target without the opt-in is refused with 406', async () => {
  const po = new PostOffice();
  const reply = await po.request('unit.tokens', undefined,
    { headers: { mode: 'tokens' }, endpoint: url, timeoutMs: 5000 });
  assert.equal(reply.getStatus(), 406);
  assert.equal(reply.body, REFUSAL);
});

test('local RPC to a streaming target is refused with 406', async () => {
  const po = new PostOffice(undefined, {}, registry);
  const reply = await po.request('unit.tokens', undefined,
    { headers: { mode: 'tokens' }, timeoutMs: 5000 });
  assert.equal(reply.getStatus(), 406);
  assert.equal(reply.body, REFUSAL);
});

test('mid-stream failure propagates the exact status', async () => {
  const po = new PostOffice();
  const events = await collect(po, 'unit.tokens', url, 'error-mid');
  assert.equal(events[0].body, 'partial');
  const error = events[events.length - 1];
  assert.equal(streamSignal(error), 'exception');
  assert.equal(error.getStatus(), 503);
  // the standard error key-values: '{"type": "error", "status": n, "message": text}'
  assert.deepEqual(error.body, { type: 'error', status: 503, message: 'backend on fire' });
});

test('failure before the first segment arrives as an exception', async () => {
  const po = new PostOffice();
  const events = await collect(po, 'unit.tokens', url, 'error-first');
  assert.equal(events.length, 1);
  assert.equal(streamSignal(events[0]), 'exception');
  assert.equal(events[0].getStatus(), 503);
  assert.equal((events[0].body as Record<string, unknown>)['message'], 'no backend');
});

test('an interceptor crash before the head is the classic error', async () => {
  const po = new PostOffice();
  const events = await collect(po, 'unit.tokens', url, 'crash-before');
  assert.equal(events.length, 1);
  assert.equal(streamSignal(events[0]), undefined, 'an unstarted stream fails single-shot');
  assert.equal(events[0].getStatus(), 500);
  assert.equal(events[0].body, 'kaboom before head');
});

test('an interceptor crash mid-stream fails in-band', async () => {
  const po = new PostOffice();
  const events = await collect(po, 'unit.tokens', url, 'crash-mid');
  assert.equal(events[0].body, 'early');
  const error = events[events.length - 1];
  assert.equal(streamSignal(error), 'exception');
  assert.equal(error.getStatus(), 500);
  assert.equal((error.body as Record<string, unknown>)['message'], 'kaboom mid-stream');
});

test('an idle stall fails in-band with 408', async () => {
  const started = Date.now();
  const po = new PostOffice();
  const events = await collect(po, 'unit.tokens', url, 'stall', 10000);
  const elapsed = Date.now() - started;
  assert.equal(events[0].body, 'one');
  const error = events[events.length - 1];
  assert.equal(streamSignal(error), 'exception');
  assert.equal(error.getStatus(), 408);
  const body = error.body as Record<string, unknown>;
  assert.equal(body['type'], 'error');
  assert.equal(body['message'], 'Timeout for 1 seconds');
  assert.ok(elapsed < 8000, `the producer's 1s idle allowance governs, took ${elapsed}ms`);
});

test('the relay composition streams through', async () => {
  // the flagship: unit.relay forwards its caller's reply address into a call
  // against the remote streaming function - engine-parity composition
  const po = new PostOffice();
  const events = await collect(po, 'unit.relay', url, undefined, 10000, 'cid-relay');
  assert.deepEqual(events.map((e) => e.body), ['alpha', 'beta', { segments: 2 }]);
  assert.equal(streamSignal(events[events.length - 1]), 'eof');
  assert.equal(events[0].cid, 'cid-relay', 'the original correlation id rides the chain');
});

test('a local stream uses the same contract', async () => {
  const po = new PostOffice(undefined, {}, registry);
  const events: EventEnvelope[] = [];
  for await (const event of po.stream('unit.tokens', undefined,
                                      { timeoutMs: 10000, cid: 'cid-local' })) {
    events.push(event);
  }
  assert.deepEqual(events.map((e) => e.body), ['alpha', 'beta', { segments: 2 }]);
  assert.equal(streamSignal(events[0]), 'data');
  assert.equal(streamSignal(events[events.length - 1]), 'eof');
});

// ---- the client guards the dialect against a misbehaving peer ----

import { createServer as createHttpServer } from 'node:http';

function envelopeFrameText(event: EventEnvelope): string {
  const encoded = Buffer.from(event.toBytes()).toString('base64');
  return `event: envelope\ndata: ${encoded}\n\n`;
}

const mockHead = () => envelopeFrameText(
  new EventEnvelope(undefined, 'mock-head')
    .setHeader('x-event-stream', 'data').setHeader('content-type', SSE).setStatus(200));
const mockEof = () => envelopeFrameText(
  new EventEnvelope(undefined, { done: true }).setHeader('x-event-stream', 'eof'));

let mockPeer: http.Server;
let mockBase: string;

before(async () => {
  mockPeer = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': SSE });
    if (req.url === '/mock/raw-first') {
      res.write('data: hello\n\n');
      res.end();
    } else if (req.url === '/mock/no-terminal') {
      res.write(mockHead());
      res.end();
    } else if (req.url === '/mock/foreign-dialect') {
      res.write(mockHead() + 'data: mock-token\n\n' + mockEof() + 'data: trailing-noise\n\n');
      res.end();
    } else if (req.url === '/mock/silent') {
      res.write(mockHead());
      setTimeout(() => res.end(), 5000).unref();
    } else {
      res.end();
    }
  });
  await new Promise<void>((resolve) => mockPeer.listen(0, '127.0.0.1', resolve));
  const address = mockPeer.address() as { port: number };
  mockBase = `http://127.0.0.1:${address.port}`;
});

after(() => new Promise<void>((resolve) => {
  mockPeer.closeAllConnections();
  mockPeer.close(() => resolve());
}));

test('a raw first frame from a foreign server is rejected', async () => {
  const po = new PostOffice();
  const events = await collect(po, 'any.route', `${mockBase}/mock/raw-first`);
  assert.equal(events.length, 1);
  assert.equal(streamSignal(events[0]), 'exception');
  assert.equal(events[0].getStatus(), 500);
  assert.equal((events[0].body as Record<string, unknown>)['message'],
    'Invalid event stream - missing envelope head');
});

test('a transport end without a terminal is a truncation', async () => {
  const po = new PostOffice();
  const events = await collect(po, 'any.route', `${mockBase}/mock/no-terminal`);
  assert.equal(events[0].body, 'mock-head');
  const error = events[events.length - 1];
  assert.equal(streamSignal(error), 'exception');
  assert.equal(error.getStatus(), 500);
  assert.equal((error.body as Record<string, unknown>)['message'],
    'Event stream ended without eof');
});

test('a foreign-dialect peer works and trailing frames drop', async () => {
  const po = new PostOffice();
  const events = await collect(po, 'any.route', `${mockBase}/mock/foreign-dialect`);
  assert.deepEqual(events.map((e) => e.body), ['mock-head', 'mock-token', { done: true }]);
  assert.equal(streamSignal(events[1]), 'data', 'a raw token after the head is a data segment');
  assert.equal(streamSignal(events[2]), 'eof');
});

test('the client idle guard fails in-band', async () => {
  const po = new PostOffice();
  const events = await collect(po, 'any.route', `${mockBase}/mock/silent`, undefined, 2000);
  assert.equal(events[0].body, 'mock-head');
  const error = events[events.length - 1];
  assert.equal(streamSignal(error), 'exception');
  assert.equal(error.getStatus(), 408);
  assert.equal((error.body as Record<string, unknown>)['message'], 'Timeout for 2 seconds');
});
