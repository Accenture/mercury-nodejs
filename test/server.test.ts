/** Event API host tests: engine-mirrored semantics over real HTTP. */
import { encode } from '@msgpack/msgpack';
import assert from 'node:assert/strict';
import type * as http from 'node:http';
import { after, before, test } from 'node:test';
import { EventEnvelope } from '../src/envelope.js';
import { AppException } from '../src/exceptions.js';
import { FunctionRegistry } from '../src/registry.js';
import { EventApiServer } from '../src/server.js';
import { annotateTrace, getTrace } from '../src/trace.js';

const OCTET = 'application/octet-stream';

function buildRegistry(): FunctionRegistry {
  const registry = new FunctionRegistry();
  registry.register('unit.echo', async (headers, body) => ({ headers, body }));
  registry.register('unit.upper', (headers, body) => {
    const info = getTrace();
    const text = (body as Record<string, unknown>)?.text ?? '';
    return { text: String(text).toUpperCase(), trace_id: info?.traceId ?? null, cid: info?.cid ?? null };
  });
  registry.register('unit.annotated', async () => {
    annotateTrace('checked', 'yes');
    return { ok: true };
  });
  registry.register('unit.app.error', async () => {
    throw new AppException(400, "missing 'text'");
  });
  registry.register('unit.boom', async () => {
    throw new Error('kaboom');
  });
  registry.register('unit.slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5000).unref());
    return { late: true };
  });
  registry.register('unit.secret', async () => ({ secret: true }), { isPrivate: true });
  return registry;
}

let server: http.Server;
let base: string;

before(async () => {
  server = new EventApiServer(buildRegistry()).createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function postEvent(event: EventEnvelope, ttl = '10000',
                         extra: Record<string, string> = {}) {
  const response = await fetch(`${base}/api/event`, {
    method: 'POST',
    headers: { 'content-type': OCTET, 'x-ttl': ttl, ...extra },
    body: event.toBytes()
  });
  const reply = EventEnvelope.fromBytes(new Uint8Array(await response.arrayBuffer()));
  return { status: response.status, reply };
}

test('rpc success with exec_time', async () => {
  const { status, reply } = await postEvent(new EventEnvelope('unit.echo', { a: 1 }));
  assert.equal(status, 200);
  assert.equal(reply.getStatus(), 200);
  assert.deepEqual((reply.body as Record<string, unknown>).body, { a: 1 });
  assert.equal(reply.sender, 'unit.echo');
  assert.ok(typeof reply.execTime === 'number' && reply.execTime >= 0);
});

test('sync handler sees trace context', async () => {
  const event = new EventEnvelope('unit.upper', { text: 'hello' })
    .setTrace('trace-100', 'TEST /upper').setCorrelationId('cid-9');
  const { status, reply } = await postEvent(event);
  assert.equal(status, 200);
  assert.deepEqual(reply.body, { text: 'HELLO', trace_id: 'trace-100', cid: 'cid-9' });
});

test('reserved header hygiene and my_cid injection', async () => {
  const event = new EventEnvelope('unit.echo', {})
    .setHeader('x-event-api', 'callback')
    .setHeader('my_secret', 'x')
    .setHeader('content-type', 'application/json');
  event.tags['my_cid'] = 'biz-123';
  const { reply } = await postEvent(event);
  const delivered = (reply.body as Record<string, unknown>).headers as Record<string, string>;
  assert.ok(!('x-event-api' in delivered));
  assert.ok(!('my_secret' in delivered));
  assert.equal(delivered['my_correlation_id'], 'biz-123');
  assert.equal(delivered['content-type'], 'application/json');
});

test('annotations ride the reply', async () => {
  const { reply } = await postEvent(new EventEnvelope('unit.annotated', {}));
  assert.deepEqual(reply.annotations, { checked: 'yes' });
});

test('AppException is the portable error on HTTP 200', async () => {
  const { status, reply } = await postEvent(new EventEnvelope('unit.app.error', {}));
  assert.equal(status, 200); // handler-level errors ride HTTP 200, engine-style
  assert.equal(reply.getStatus(), 400);
  assert.equal(reply.body, "missing 'text'");
  assert.equal(reply.stack, undefined);
});

test('unexpected exception maps to 500 with stack', async () => {
  const { status, reply } = await postEvent(new EventEnvelope('unit.boom', {}));
  assert.equal(status, 200);
  assert.equal(reply.getStatus(), 500);
  assert.equal(reply.body, 'kaboom');
  assert.ok(reply.stack && reply.stack.includes('Error'));
});

test('unknown route 404 with engine message', async () => {
  const { status, reply } = await postEvent(new EventEnvelope('no.where', {}));
  assert.equal(status, 404);
  assert.equal(reply.getStatus(), 404);
  assert.equal(reply.body, 'Route no.where not found');
});

test('private route 403', async () => {
  const { status, reply } = await postEvent(new EventEnvelope('unit.secret', {}));
  assert.equal(status, 403);
  assert.equal(reply.body, 'unit.secret is private');
});

test('missing routing path 400', async () => {
  const { status, reply } = await postEvent(new EventEnvelope(undefined, { x: 1 }));
  assert.equal(status, 400);
  assert.equal(reply.body, 'Missing routing path');
});

test('compact request rejected 400', async () => {
  const response = await fetch(`${base}/api/event`, {
    method: 'POST',
    headers: { 'content-type': OCTET, 'x-ttl': '5000' },
    body: encode({ '0': 'e1', T: 'unit.echo' })
  });
  assert.equal(response.status, 400);
  const reply = EventEnvelope.fromBytes(new Uint8Array(await response.arrayBuffer()));
  assert.ok(String(reply.body).includes('standard'));
});

test('timeout 408 mirrors engine message', async () => {
  const { status, reply } = await postEvent(new EventEnvelope('unit.slow', {}), '1000');
  assert.equal(status, 408);
  assert.equal(reply.getStatus(), 408);
  assert.equal(reply.body, 'Timeout for 1000 ms');
});

test('async drop-n-forget 202 ack', async () => {
  const { status, reply } = await postEvent(new EventEnvelope('unit.echo', {}), '10000',
    { 'x-async': 'true' });
  assert.equal(status, 202);
  assert.equal(reply.getStatus(), 202);
  const ack = reply.body as Record<string, unknown>;
  assert.equal(ack.type, 'async');
  assert.equal(ack.delivered, true);
  assert.ok('time' in ack);
});

test('health endpoint', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'OK');
});
