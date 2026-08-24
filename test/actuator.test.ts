/** Actuator endpoint pins: engine-parity operational surface for Kubernetes. */
import assert from 'node:assert/strict';
import type * as http from 'node:http';
import { afterEach, test } from 'node:test';
import { appOrigin, elapsedTime } from '../src/actuator.js';
import { AppException } from '../src/exceptions.js';
import { appConfig } from '../src/config.js';
import { FunctionRegistry } from '../src/registry.js';
import { EventApiServer } from '../src/server.js';
import { VERSION } from '../src/version.js';

const ORIGIN_SHAPE = /^\d{8}[0-9a-f]{32}$/; // UTC yyyyMMdd + 32-hex uuid (Java reference)

const CONFIG_KEYS = [
  'mandatory.health.dependencies', 'optional.health.dependencies',
  'show.env.variables', 'show.application.properties',
  'application.name', 'info.app.description', 'info.app.version'
];

afterEach(() => {
  const config = appConfig();
  for (const key of CONFIG_KEYS) {
    config.set(key, ''); // empty override = unset (the Actuator treats '' as absent)
  }
});

// the Actuator reads its configuration at construction (engine semantics),
// so each test sets config BEFORE calling start()
async function start(registry: FunctionRegistry): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: http.Server = new EventApiServer(registry).createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolve) => {
      registry.bus.close();
      server.close(() => resolve());
    })
  };
}

async function getJson(url: string): Promise<[number, Record<string, unknown>]> {
  const response = await fetch(url);
  return [response.status, await response.json() as Record<string, unknown>];
}

async function getText(url: string): Promise<[number, string]> {
  const response = await fetch(url);
  return [response.status, await response.text()];
}

/** A health check function speaking the engines' type=info/type=health contract. */
function engineContractRegistry(): FunctionRegistry {
  const registry = new FunctionRegistry();
  registry.register('demo.health', async (headers) => {
    if (headers.type === 'info') {
      return { service: 'demo.service', href: 'http://127.0.0.1' };
    }
    return 'demo.service is running fine';
  }, { isPrivate: true });
  return registry;
}

test('info reports identity, runtime and origin', async () => {
  const config = appConfig();
  config.set('application.name', 'unit-app');
  config.set('info.app.description', 'actuator test app');
  const { base, stop } = await start(new FunctionRegistry());
  try {
    const [status, info] = await getJson(`${base}/info`);
    assert.equal(status, 200);
    assert.deepEqual(info.app, { name: 'unit-app', version: VERSION,
      description: 'actuator test app' });
    const runtime = info.runtime as Record<string, unknown>;
    assert.equal(runtime.language, 'node.js');
    assert.equal(runtime.mercury_composable, VERSION);
    assert.match(String(info.origin), ORIGIN_SHAPE);
    const time = info.time as Record<string, string>;
    assert.ok(time.start <= time.current);
    assert.ok('up_time' in info);
  } finally {
    await stop();
  }
});

test('info/routes splits by visibility', async () => {
  const registry = new FunctionRegistry();
  registry.register('unit.public.route', async () => null, { instances: 8 });
  registry.register('unit.private.route', async () => null, { instances: 2, isPrivate: true });
  const { base, stop } = await start(registry);
  try {
    const [status, result] = await getJson(`${base}/info/routes`);
    assert.equal(status, 200);
    assert.deepEqual(result.routing, { public: { 'unit.public.route': 8 },
      private: { 'unit.private.route': 2 } });
    assert.equal((result.app as Record<string, unknown>).name, 'application');
  } finally {
    await stop();
  }
});

test('env shows only opted-in values', async () => {
  process.env.MERCURY_UNIT_ENV = 'unit-value';
  const config = appConfig();
  config.set('show.env.variables', 'MERCURY_UNIT_ENV, MERCURY_UNIT_ABSENT');
  config.set('show.application.properties', 'application.name');
  config.set('application.name', 'unit-app');
  const { base, stop } = await start(new FunctionRegistry());
  try {
    const [status, result] = await getJson(`${base}/env`);
    assert.equal(status, 200);
    // a missing environment variable renders as an empty string (engine parity)
    assert.deepEqual(result.env, {
      environment: { MERCURY_UNIT_ENV: 'unit-value', MERCURY_UNIT_ABSENT: '' },
      properties: { 'application.name': 'unit-app' }
    });
  } finally {
    delete process.env.MERCURY_UNIT_ENV;
    await stop();
  }
});

test('health up with the engine-contract dependency', async () => {
  appConfig().set('mandatory.health.dependencies', 'demo.health');
  const { base, stop } = await start(engineContractRegistry());
  try {
    const [status, health] = await getJson(`${base}/health`);
    assert.equal(status, 200);
    assert.equal(health.status, 'UP');
    assert.equal(health.name, 'application');
    assert.match(String(health.origin), ORIGIN_SHAPE);
    // the info map merges into the dependency entry; health decides the status
    assert.deepEqual(health.dependency, [{
      route: 'demo.health', required: true,
      service: 'demo.service', href: 'http://127.0.0.1',
      status_code: 200, message: 'demo.service is running fine'
    }]);
    assert.deepEqual(await getText(`${base}/livenessprobe`), [200, 'OK']);
  } finally {
    await stop();
  }
});

test('health down on a missing dependency drives liveness', async () => {
  appConfig().set('mandatory.health.dependencies', 'no.such.route');
  const { base, stop } = await start(new FunctionRegistry());
  try {
    // healthy until proven otherwise
    assert.deepEqual(await getText(`${base}/livenessprobe`), [200, 'OK']);
    const [status, health] = await getJson(`${base}/health`);
    assert.equal(status, 400);
    assert.equal(health.status, 'DOWN');
    assert.deepEqual(health.dependency, [{
      route: 'no.such.route', required: true,
      status_code: 404, message: 'Please check - Route no.such.route not found'
    }]);
    assert.deepEqual(await getText(`${base}/livenessprobe`),
      [400, "Unhealthy. Please check '/health' endpoint."]);
  } finally {
    await stop();
  }
});

test('optional failure never downs health', async () => {
  const registry = engineContractRegistry();
  registry.register('broken.health', async () => {
    throw new AppException(500, 'backend down');
  }, { isPrivate: true });
  const config = appConfig();
  config.set('mandatory.health.dependencies', 'demo.health');
  config.set('optional.health.dependencies', 'broken.health');
  const { base, stop } = await start(registry);
  try {
    const [status, health] = await getJson(`${base}/health`);
    assert.equal(status, 200);
    assert.equal(health.status, 'UP');
    const brokenDep = (health.dependency as Record<string, unknown>[])
      .find((d) => d.route === 'broken.health');
    assert.ok(brokenDep);
    assert.equal(brokenDep.required, false);
    assert.equal(brokenDep.status_code, 500);
    assert.equal(brokenDep.message, 'backend down');
  } finally {
    await stop();
  }
});

test('health without dependencies teaches the config keys', async () => {
  const { base, stop } = await start(new FunctionRegistry());
  try {
    const [status, health] = await getJson(`${base}/health`);
    assert.equal(status, 200);
    assert.equal(health.status, 'UP');
    assert.deepEqual(health.dependency, []);
    assert.ok(String(health.message).startsWith('Did you forget to define'));
  } finally {
    await stop();
  }
});

test('elapsedTime matches the engine rendering', () => {
  assert.equal(elapsedTime(0), '0 ms');
  assert.equal(elapsedTime(500), '500 ms');
  assert.equal(elapsedTime(1000), '1 second');
  assert.equal(elapsedTime(61_000), '1 minute 1 second');
  // the engines' strict boundary behavior, kept verbatim
  assert.equal(elapsedTime(60_000), '60 seconds');
  assert.equal(elapsedTime(3_600_000), '60 minutes');
  assert.equal(elapsedTime(86_400_000), '24 hours');
  assert.equal(elapsedTime(120_000), '2 minutes');
  assert.equal(elapsedTime(90_061_000), '1 day 1 hour 1 minute 1 second');
});

test('origin is stable and engine-shaped', () => {
  const minted = appOrigin();
  assert.equal(minted, appOrigin()); // minted once per process
  assert.match(minted, ORIGIN_SHAPE);
});

test('index page lists the actuator endpoints', async () => {
  const { base, stop } = await start(new FunctionRegistry());
  try {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const page = await response.text();
    for (const link of ['/info', '/info/routes', '/env', '/health', '/livenessprobe']) {
      assert.ok(page.includes(`href="${link}"`));
    }
  } finally {
    await stop();
  }
});

test('unknown path answers the engine error shape', async () => {
  const { base, stop } = await start(new FunctionRegistry());
  try {
    const [status, body] = await getJson(`${base}/no/such/page`);
    assert.equal(status, 404);
    assert.deepEqual(body, { status: 404, message: 'Resource not found', type: 'error' });
    // non-GET on a known path is equally not a resource (engine semantics)
    const post = await fetch(`${base}/info`, { method: 'POST' });
    assert.equal(post.status, 404);
    assert.deepEqual(await post.json(),
      { status: 404, message: 'Resource not found', type: 'error' });
  } finally {
    await stop();
  }
});

test('json responses are pretty-printed', async () => {
  // the engines' default serializer presentation (SimpleMapper pretty Gson)
  const { base, stop } = await start(new FunctionRegistry());
  try {
    const text = await (await fetch(`${base}/info`)).text();
    assert.ok(text.startsWith('{\n  "app": {\n'));
  } finally {
    await stop();
  }
});
