/** PostOffice client tests against the in-process host (full wrapper loop). */
import assert from 'node:assert/strict';
import type * as http from 'node:http';
import { after, before, test } from 'node:test';
import { PostOffice } from '../src/client.js';
import { FunctionRegistry } from '../src/registry.js';
import { EventApiServer } from '../src/server.js';
import { getTrace, runWithTrace } from '../src/trace.js';

function buildRegistry(): FunctionRegistry {
  const registry = new FunctionRegistry();
  registry.register('client.echo', async (headers, body) => ({ headers, body }));
  registry.register('client.whoami', async () => {
    const info = getTrace();
    return {
      trace_id: info?.traceId ?? null,
      trace_path: info?.tracePath ?? null,
      cid: info?.cid ?? null
    };
  });
  return registry;
}

let server: http.Server;
let endpoint: string;

before(async () => {
  server = new EventApiServer(buildRegistry()).createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  endpoint = `http://127.0.0.1:${address.port}/api/event`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test('rpc round trip', async () => {
  const po = new PostOffice(endpoint);
  const reply = await po.request('client.echo', { hello: 'world' },
    { headers: { h1: 'v1' }, timeoutMs: 5000 });
  assert.equal(reply.getStatus(), 200);
  const body = reply.body as Record<string, unknown>;
  assert.deepEqual(body.body, { hello: 'world' });
  assert.equal((body.headers as Record<string, string>).h1, 'v1');
});

test('trace context propagates through the client', async () => {
  const po = new PostOffice(endpoint);
  const reply = await runWithTrace(
    { traceId: 'trace-777', tracePath: 'TEST /client', cid: 'cid-42', annotations: {} },
    () => po.request('client.whoami', {}, { timeoutMs: 5000 }));
  assert.deepEqual(reply.body,
    { trace_id: 'trace-777', trace_path: 'TEST /client', cid: 'cid-42' });
});

test('error reply is returned, not thrown', async () => {
  const po = new PostOffice(endpoint);
  const reply = await po.request('no.such.route', {}, { timeoutMs: 5000 });
  assert.equal(reply.getStatus(), 404);
  assert.equal(reply.body, 'Route no.such.route not found');
});

test('drop-n-forget ack', async () => {
  const po = new PostOffice(endpoint);
  const ack = await po.send('client.echo', { fire: 'forget' }, { timeoutMs: 5000 });
  assert.equal(ack.getStatus(), 202);
  assert.equal((ack.body as Record<string, unknown>).delivered, true);
});
