/** Registry pins: the PreLoad route list - one function under several routes (aliases). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostOffice } from '../src/client.js';
import { defaultRegistry, FunctionRegistry, preload, splitRoutes } from '../src/registry.js';
import { getTrace } from '../src/trace.js';

test('splitRoutes takes one name or a comma-separated list', () => {
  assert.deepEqual(splitRoutes('hello.node'), ['hello.node']);
  assert.deepEqual(splitRoutes('hello.declarative, hello.world'), ['hello.declarative', 'hello.world']);
  assert.deepEqual(splitRoutes('a.b,c.d'), ['a.b', 'c.d']);
  assert.deepEqual(splitRoutes(' a.b , c.d ,  e.f '), ['a.b', 'c.d', 'e.f']);
  // the Java engine splits on "[, ]": a space alone separates, empty segments are dropped
  assert.deepEqual(splitRoutes('a.b c.d'), ['a.b', 'c.d']);
  assert.deepEqual(splitRoutes('a.b,,c.d,'), ['a.b', 'c.d']);
  // a repeated name is one registration
  assert.deepEqual(splitRoutes('a.b, a.b'), ['a.b']);
});

test('splitRoutes refuses a list without a name', () => {
  for (const value of ['', '   ', ',', ' , ']) {
    assert.throws(() => splitRoutes(value), /missing service route/);
  }
});

test('splitRoutes validates every name', () => {
  assert.throws(() => splitRoutes('hello.world, HelloWorld'), /Invalid route name 'HelloWorld'/);
});

test('register takes one route - the list is preload\'s, as Platform.register takes one', () => {
  assert.throws(() => new FunctionRegistry().register('a.b, c.d', async () => null),
    /Invalid route name/);
});

test('preload registers every route as the same function', async () => {
  const handler = async (_headers: Record<string, string>, body: unknown) =>
    ({ body, route: getTrace()?.route ?? null });
  preload('alias.one, alias.two', { instances: 3, isPrivate: true }, handler);
  const one = defaultRegistry.get('alias.one');
  const two = defaultRegistry.get('alias.two');
  assert.ok(one && two);
  assert.equal(one.handler, handler);
  assert.equal(two.handler, handler);
  assert.deepEqual([one.instances, one.isPrivate], [3, true]);
  assert.deepEqual([two.instances, two.isPrivate], [3, true]);
  const po = new PostOffice(undefined, {}, defaultRegistry);
  try {
    for (const route of ['alias.one', 'alias.two']) {
      const reply = await po.request(route, { n: 1 }, { timeoutMs: 5000 });
      assert.equal(reply.getStatus(), 200);
      // the function sees the alias it was called as (the engines' my_route)
      assert.deepEqual(reply.body, { body: { n: 1 }, route });
      assert.equal(reply.sender, route);
    }
  } finally {
    defaultRegistry.bus.close();
  }
});

test('preload refuses an empty route list', () => {
  assert.throws(() => preload(' , ', {}, async () => null), /missing service route/);
});
