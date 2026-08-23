/** Primitive event bus pins: local RPC (public+private), FIFO, workers, deadlines. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostOffice } from '../src/client.js';
import { EventEnvelope } from '../src/envelope.js';
import { FunctionRegistry } from '../src/registry.js';
import { getTrace, runWithTrace } from '../src/trace.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('local rpc to public route (headers verbatim)', async () => {
  const registry = new FunctionRegistry();
  registry.register('bus.echo', async (headers, body) => ({ headers, body }));
  const po = new PostOffice(undefined, {}, registry);
  const reply = await po.request('bus.echo', { a: 1 },
    { headers: { h1: 'v1' }, timeoutMs: 5000 });
  assert.equal(reply.getStatus(), 200);
  const result = reply.body as Record<string, unknown>;
  assert.deepEqual(result.body, { a: 1 });
  // local delivery passes headers verbatim (hygiene is a wire-ingress concern)
  assert.deepEqual(result.headers, { h1: 'v1' });
  assert.equal(reply.sender, 'bus.echo');
  assert.ok(typeof reply.execTime === 'number');
});

test('local rpc reaches a private route (engine semantics)', async () => {
  const registry = new FunctionRegistry();
  registry.register('bus.secret', async () => ({ secret: 'ok' }), { isPrivate: true });
  const po = new PostOffice(undefined, {}, registry);
  const reply = await po.request('bus.secret', {}, { timeoutMs: 5000 });
  assert.equal(reply.getStatus(), 200);
  assert.deepEqual(reply.body, { secret: 'ok' });
});

test('unregistered local route answers 404', async () => {
  const po = new PostOffice(undefined, {}, new FunctionRegistry());
  const reply = await po.request('bus.no.where', {}, { timeoutMs: 5000 });
  assert.equal(reply.getStatus(), 404);
  assert.equal(reply.body, 'Route bus.no.where not found');
});

test('fifo ordering with one worker', async () => {
  const registry = new FunctionRegistry();
  const processed: number[] = [];
  let done: () => void = () => {};
  const allDone = new Promise<void>((resolve) => { done = resolve; });
  registry.register('bus.fifo', async (_headers, body) => {
    processed.push(Number((body as Record<string, unknown>).n));
    if (processed.length === 3) done();
  }, { instances: 1 });
  const po = new PostOffice(undefined, {}, registry);
  for (const n of [1, 2, 3]) {
    const ack = await po.send('bus.fifo', { n }, { timeoutMs: 5000 });
    assert.equal(ack.getStatus(), 202);
    assert.equal((ack.body as Record<string, unknown>).delivered, true);
  }
  await allDone;
  assert.deepEqual(processed, [1, 2, 3]);
});

test('instances bounds concurrency faithfully', async () => {
  const registry = new FunctionRegistry();
  let active = 0;
  let peak = 0;
  registry.register('bus.slow', async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(150);
    active--;
    return { ok: true };
  }, { instances: 2 });
  const po = new PostOffice(undefined, {}, registry);
  const replies = await Promise.all(
    Array.from({ length: 4 }, () => po.request('bus.slow', {}, { timeoutMs: 5000 })));
  assert.ok(replies.every((r) => r.getStatus() === 200));
  assert.equal(peak, 2); // instances = the number of concurrent workers
});

test('local timeout 408 and dead-work skip', async () => {
  const registry = new FunctionRegistry();
  const executed: string[] = [];
  let release: () => void = () => {};
  const gateOpen = new Promise<void>((resolve) => { release = resolve; });
  registry.register('bus.gate', async (_headers, body) => {
    executed.push(String((body as Record<string, unknown>).id));
    await gateOpen;
    return { ok: true };
  }, { instances: 1 });
  const po = new PostOffice(undefined, {}, registry);
  const first = po.request('bus.gate', { id: 'first' }, { timeoutMs: 5000 });
  await sleep(50); // the single worker is now blocked inside 'first'
  // the second RPC waits in the mailbox and times out before a worker frees up
  const reply = await po.request('bus.gate', { id: 'second' }, { timeoutMs: 200 });
  assert.equal(reply.getStatus(), 408);
  assert.equal(reply.body, 'Timeout for 200 ms');
  release();
  assert.equal((await first).getStatus(), 200);
  await sleep(50); // give the worker a chance to reach the dead delivery
  // dead-work check: the timed-out delivery was skipped, never executed
  assert.deepEqual(executed, ['first']);
});

test('trace chains through a local private sibling', async () => {
  const registry = new FunctionRegistry();
  registry.register('bus.helper', async () => {
    const info = getTrace();
    assert.ok(info);
    return { helper_trace: info.traceId, helper_cid: info.cid };
  }, { isPrivate: true });
  registry.register('bus.entry', async () => {
    const info = getTrace();
    assert.ok(info);
    const po = new PostOffice(undefined, {}, registry);
    const inner = await po.request('bus.helper', {}, { timeoutMs: 5000 });
    return { entry_trace: info.traceId, ...(inner.body as Record<string, unknown>) };
  });
  const po = new PostOffice(undefined, {}, registry);
  const reply = await runWithTrace(
    { traceId: 'trace-bus-1', tracePath: 'TEST /bus', cid: 'cid-bus-1', annotations: {} },
    () => po.request('bus.entry', {}, { timeoutMs: 5000 }));
  assert.equal(reply.getStatus(), 200);
  // one trace id flows: caller context -> entry handler -> private helper
  assert.deepEqual(reply.body, {
    entry_trace: 'trace-bus-1',
    helper_trace: 'trace-bus-1',
    helper_cid: 'cid-bus-1'
  });
});

test('local send returns the 202 ack envelope and delivers', async () => {
  const registry = new FunctionRegistry();
  let seen: () => void = () => {};
  const delivered = new Promise<void>((resolve) => { seen = resolve; });
  registry.register('bus.sink', async () => { seen(); });
  const po = new PostOffice(undefined, {}, registry);
  const ack = await po.send('bus.sink', { fire: 'forget' }, { timeoutMs: 5000 });
  assert.ok(ack instanceof EventEnvelope);
  assert.equal(ack.getStatus(), 202);
  assert.equal((ack.body as Record<string, unknown>).type, 'async');
  await delivered;
});
