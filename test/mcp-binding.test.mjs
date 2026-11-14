/**
 * The MCP binding (extensions/mcp-binding/mcp-binding.mjs).
 *
 * The shared contract file test/vectors/mcp-binding-vectors.json (byte-identical in mercury-python)
 * pins the pure half: the input-schema digest, the allowlist verification and the result mapping.
 * The tests after the vector runs drive the real transports against the fixture server of
 * test/fixtures (a small MCP server on the official SDK, over stdio and over streamable HTTP): the
 * boot that registers one route per allowlisted tool and fails fast by name, the calls through the
 * bound routes (local RPC through the bus, as the host dispatches them: every route is an alias of
 * the one preload function), the credential references that reach the subprocess and never a log,
 * the health route, the describe output, and the platform's startup hook that runs the boot before
 * the host listens.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { AppException, appConfig, defaultRegistry, FunctionRegistry, Platform, PostOffice } from 'mercury-composable';
import {
  BindingError, connectClient, createBinding, DEFAULT_SERVERS_FILE, loadServers, schemaDigest, Server,
  toolResult, verify
} from '../extensions/mcp-binding/mcp-binding.mjs';

const VECTORS_FILE = new URL('./vectors/mcp-binding-vectors.json', import.meta.url);
// the Python twin pins the same digest: change the file in both packs or in neither
const VECTORS_SHA256 = '4bacc319859847ff82e5d169ad9c0dea4ffdd6fe06883537ebf5ee66bdba907a';
const VECTORS = JSON.parse(readFileSync(VECTORS_FILE, 'utf8'));
const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-test-server.mjs', import.meta.url));
const FIXTURE_TOOLS = ['add', 'echo', 'env_present', 'fail', 'slow'];

function specOf(caseServer) {
  const tools = Object.entries(caseServer.tools).map(([name, t]) => ({ name, route: t.route, schema_sha256: t.schema_sha256 }));
  return { name: caseServer.name, transport: 'stdio', tools, command: 'x', args: [], env: {}, headers: {}, timeout_ms: 30000, instances: 10 };
}

// --- the shared vectors -------------------------------------------------------------------

test('the vector file is the one the Python twin runs', () => {
  const digest = createHash('sha256').update(readFileSync(VECTORS_FILE)).digest('hex');
  assert.equal(digest, VECTORS_SHA256, "update both packs' pins when the shared file changes");
});

for (const c of VECTORS.digest_cases) {
  test(`digest: ${c.name}`, () => {
    assert.equal(schemaDigest(c.schema), c.sha256);
  });
}

for (const c of VECTORS.verify_cases) {
  test(c.name, () => {
    const spec = specOf(c.server);
    if (c.expect.error) {
      assert.throws(() => verify(spec, c.offered), (e) => e instanceof BindingError && e.message === c.expect.error);
    } else {
      assert.deepEqual(verify(spec, c.offered).map((b) => b.binding.route), c.expect.bound);
    }
  });
}

for (const c of VECTORS.result_cases) {
  test(c.name, () => {
    if (c.expect.error) {
      assert.throws(() => toolResult(c.result),
        (e) => e instanceof AppException && e.status === c.expect.error.status && e.message === c.expect.error.message);
    } else {
      assert.deepEqual(toolResult(c.result), c.expect.reply);
    }
  });
}

// --- the fixture server over the real transports ------------------------------------------

/** A logger that keeps what it is told, so a test can assert what never reached a log. */
function ledger() {
  const lines = [];
  const log = {
    lines,
    text: () => lines.join('\n'),
    debug: (m) => lines.push(`DEBUG ${m}`),
    info: (m) => lines.push(`INFO ${m}`),
    warn: (m) => lines.push(`WARN ${m}`),
    error: (m) => lines.push(`ERROR ${m}`)
  };
  return log;
}

/** What the fixture server offers, as the binding reads it: the digests come from the server itself. */
let offered;
before(async () => {
  const probe = new Server({ name: 'probe', transport: 'stdio', tools: [], command: process.execPath, args: [FIXTURE],
    env: {}, headers: {}, timeout_ms: 30000, instances: 10 }, connectClient, ledger());
  const client = await connectClient(probe.spec);
  try {
    const page = await client.listTools();
    offered = Object.fromEntries(page.tools.map((t) => [t.name, { name: t.name, description: t.description ?? '', input_schema: t.inputSchema }]));
  } finally {
    await client.close();
  }
});

after(() => appConfig().set('mcp.servers', DEFAULT_SERVERS_FILE));

const scratch = mkdtempSync(join(tmpdir(), 'mcp-binding-'));
let fileCount = 0;

/** Point the binding at a temporary server file and give the test a fresh binding with its own registry and log. */
function servers(entries) {
  const path = join(scratch, `mcp-servers-${fileCount++}.yml`);
  writeFileSync(path, YAML.stringify({ servers: entries }), 'utf8');
  appConfig().set('mcp.servers', path);
  const registry = new FunctionRegistry();
  const log = ledger();
  const lines = [];
  const app = createBinding({ registry, log, out: (line) => lines.push(line) });
  return { app, registry, log, lines };
}

/** A stdio server entry for the fixture, every tool with the digest the server reports. */
function stdio(tools, extra = {}) {
  const entry = {
    transport: 'stdio', command: process.execPath, args: [FIXTURE],
    tools: Object.fromEntries(Object.entries(tools).map(([name, route]) => [name, { route, schema_sha256: schemaDigest(offered[name].input_schema) }]))
  };
  return { ...entry, ...extra };
}

/**
 * Local RPC through the registry's bus, the path a request takes behind the HTTP host: the bound
 * route's alias dispatches the binding's tool function with the route in its execution context.
 */
async function call(registry, route, body) {
  assert.ok(registry.get(route), `${route} is not registered`);
  return new PostOffice(undefined, {}, registry).request(route, body, { timeoutMs: 10000 });
}

/** The reply's body when the status is 200; an assertion naming the status and the body otherwise. */
function ok(reply) {
  assert.equal(reply.getStatus(), 200, `${reply.getStatus()}: ${reply.body}`);
  return reply.body;
}

function failed(reply, status, fragment) {
  assert.equal(reply.getStatus(), status, `${reply.getStatus()}: ${reply.body}`);
  assert.ok(String(reply.body).includes(fragment), String(reply.body));
}

async function rejects(promise, status, fragment) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof AppException, `expected AppException, got ${e?.constructor?.name}: ${e?.message}`);
    assert.equal(e.status, status, e.message);
    assert.ok(e.message.includes(fragment), e.message);
    return true;
  });
}

test('the fixture server has the tools the tests rely on', () => {
  assert.deepEqual(Object.keys(offered).sort(), FIXTURE_TOOLS);
});

test('boot registers one route per allowlisted tool and the routes call the server', async () => {
  const { app, registry } = servers({ fixture: stdio({ echo: 'fixture.echo', add: 'fixture.add', fail: 'fixture.fail' }, { instances: 3 }) });
  await app.boot();
  try {
    assert.deepEqual([...app.servers.keys()], ['fixture']);
    assert.deepEqual(app.servers.get('fixture').bound.map((b) => b.binding.route), ['fixture.echo', 'fixture.add', 'fixture.fail']);
    // the composable shape: one preload function, each bound route a public alias of it with the
    // server's instances; the declared route itself is private and bound to no tool
    for (const route of ['fixture.echo', 'fixture.add', 'fixture.fail']) {
      const service = registry.get(route);
      assert.ok(service.handler === app.tool && !service.isPrivate && service.instances === 3, route);
    }
    const declared = defaultRegistry.get('mcp.tool');
    assert.ok(declared && declared.isPrivate, 'mcp.tool is declared, private');
    await rejects(declared.handler({}, { text: 'no tool here' }), 404, 'No MCP tool is bound to the route (none)');
    assert.equal(ok(await call(registry, 'fixture.echo', { text: 'hello' })), 'hello');
    assert.deepEqual(ok(await call(registry, 'fixture.add', { a: 1, b: 2 })), { sum: 3 });
    failed(await call(registry, 'fixture.fail', { reason: 'the vault is closed' }), 400, 'the vault is closed');
    failed(await call(registry, 'fixture.echo', 'hello'), 400, 'must be a map');
    registry.register('mcp.tool', app.tool, { isPrivate: true });
    failed(await call(registry, 'mcp.tool', { text: 'no tool here' }), 404, 'No MCP tool is bound to the route mcp.tool');
  } finally {
    await app.shutdown();
  }
  assert.equal(app.servers.size, 0);
  assert.equal(app.routes.size, 0);
});

test("a slow tool is a 408 within the server's timeout", async () => {
  const { app, registry } = servers({ fixture: stdio({ slow: 'fixture.slow' }, { timeout_ms: 1000 }) });
  await app.boot();
  try {
    const started = Date.now();
    failed(await call(registry, 'fixture.slow', { seconds: 5 }), 408, 'within 1000 ms');
    assert.ok(Date.now() - started < 4000);
  } finally {
    await app.shutdown();
  }
});

test('a missing tool fails the boot by name', async () => {
  const entry = stdio({ echo: 'fixture.echo' });
  entry.tools.nope = { route: 'fixture.nope', schema_sha256: '0'.repeat(64) };
  const { app, log } = servers({ fixture: entry });
  await assert.rejects(app.boot(), (e) => e instanceof BindingError && e.message.includes('does not offer the tool nope'));
  assert.ok(log.text().includes('does not offer the tool nope'));
  assert.equal(app.servers.size, 0, 'a failed boot leaves no connection behind');
});

test('a changed schema fails the boot by name', async () => {
  const entry = stdio({ echo: 'fixture.echo' });
  entry.tools.echo.schema_sha256 = 'f'.repeat(64);
  const { app, log } = servers({ fixture: entry });
  await assert.rejects(app.boot(), (e) => e instanceof BindingError && e.message.includes('changed the input schema of echo'));
  assert.ok(log.text().includes(schemaDigest(offered.echo.input_schema)), 'the current digest is shown');
});

test('credential references reach the subprocess and never a log', async () => {
  process.env.FIXTURE_TOKEN = 'a-value-that-must-not-appear';
  try {
    const { app, registry, log } = servers({ fixture: stdio({ env_present: 'fixture.env.present' }, { env: { FIXTURE_FORWARDED: '${FIXTURE_TOKEN}' } }) });
    await app.boot();
    try {
      assert.deepEqual(ok(await call(registry, 'fixture.env.present', { name: 'FIXTURE_FORWARDED' })), { present: true });
      assert.deepEqual(ok(await call(registry, 'fixture.env.present', { name: 'FIXTURE_TOKEN' })), { present: false },
        'only the listed variables reach the subprocess, not the whole environment');
    } finally {
      await app.shutdown();
    }
    assert.ok(!log.text().includes('a-value-that-must-not-appear'));
  } finally {
    delete process.env.FIXTURE_TOKEN;
  }
});

test('an unset credential reference is refused at load', () => {
  delete process.env.FIXTURE_MISSING_TOKEN;
  servers({ fixture: stdio({ echo: 'fixture.echo' }, { env: { TOKEN: '${FIXTURE_MISSING_TOKEN}' } }) });
  assert.throws(() => loadServers(), (e) => e instanceof BindingError && e.message.includes('env.TOKEN resolves to nothing'));
});

const tool = { echo: { route: 'a.b', schema_sha256: '0'.repeat(64) } };
for (const [entry, message] of [
  [{ transport: 'ftp', tools: tool }, 'transport must be stdio or http'],
  [{ transport: 'stdio', tools: tool }, 'a stdio server needs a command'],
  [{ transport: 'http', tools: tool }, 'an http server needs a url'],
  [{ transport: 'stdio', command: 'x', url: 'http://x', tools: tool }, 'url and headers belong to an http server'],
  [{ transport: 'stdio', command: 'x', colour: 'blue', tools: tool }, 'has unknown keys colour'],
  [{ transport: 'stdio', command: 'x', tools: {} }, 'tools must map at least one remote tool'],
  [{ transport: 'stdio', command: 'x', tools: { echo: { route: 'NoDots', schema_sha256: '0'.repeat(64) } } }, 'Invalid route name'],
  [{ transport: 'stdio', command: 'x', tools: { echo: { route: 'a.b', schema_sha256: 'short' } } }, 'needs schema_sha256'],
  [{ transport: 'stdio', command: 'x', tools: { echo: { route: 'a.b', schema_sha256: '0'.repeat(64), mode: 'x' } } }, 'has unknown keys mode'],
  [{ transport: 'stdio', command: 'x', timeout_ms: 10, tools: tool }, 'timeout_ms must be at least 1000'],
  [{ transport: 'stdio', command: 'x', tools: { echo: { route: 'a.b', schema_sha256: '0'.repeat(64) }, add: { route: 'a.b', schema_sha256: '0'.repeat(64) } } }, 'the route a.b is bound twice']
]) {
  test(`the server file is checked before any connection: ${message}`, () => {
    servers({ s: entry });
    assert.throws(() => loadServers(), (e) => e instanceof BindingError && e.message.includes(message));
  });
}

test('a route bound by two servers is refused', () => {
  const shared = { echo: { route: 'shared.route', schema_sha256: '0'.repeat(64) } };
  servers({ one: { transport: 'stdio', command: 'x', tools: shared }, two: { transport: 'stdio', command: 'y', tools: shared } });
  assert.throws(() => loadServers(), (e) => e.message.includes('bound by both one and two'));
});

test('an empty server map starts with no route', () => {
  const { log } = servers({});
  assert.deepEqual(loadServers(undefined, log), []);
  assert.ok(log.text().includes('No MCP server configured'));
});

function freePort() {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(port, child, seconds = 20) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the fixture server exited with ${child.exitCode}`);
    const open = await new Promise((resolve) => {
      const socket = new Socket();
      socket.setTimeout(200);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.connect(port, '127.0.0.1');
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the fixture server did not listen in time');
}

test('the http transport serves the same routes', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [FIXTURE, 'http', String(port)], { stdio: 'ignore' });
  try {
    await waitFor(port, child);
    process.env.FIXTURE_HTTP_TOKEN = 'bearer-value';
    const { app, registry } = servers({ remote: {
      transport: 'http', url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: 'Bearer ${FIXTURE_HTTP_TOKEN}' },
      tools: { echo: { route: 'remote.echo', schema_sha256: schemaDigest(offered.echo.input_schema) },
        add: { route: 'remote.add', schema_sha256: schemaDigest(offered.add.input_schema) } }
    } });
    await app.boot();
    try {
      assert.equal(ok(await call(registry, 'remote.echo', { text: 'over http' })), 'over http');
      assert.deepEqual(ok(await call(registry, 'remote.add', { a: 20, b: 22 })), { sum: 42 });
    } finally {
      await app.shutdown();
    }
  } finally {
    delete process.env.FIXTURE_HTTP_TOKEN;
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('health reports each server and its connection', async () => {
  const { app } = servers({ fixture: stdio({ echo: 'fixture.echo' }) });
  await app.boot();
  try {
    const info = await app.health({ type: 'info' }, {});
    assert.equal(info.service, 'mcp.binding');
    assert.deepEqual(info.servers, [{ name: 'fixture', transport: 'stdio', tools: 1, connected: true }]);
    assert.equal(await app.health({ type: 'health' }, {}), 'mcp.binding is running fine');
  } finally {
    await app.shutdown();
  }
  assert.deepEqual((await app.health({ type: 'info' }, {})).servers, []);
  const lost = new Server({ name: 'gone', transport: 'stdio', tools: [], command: 'x', args: [], env: {}, headers: {}, timeout_ms: 30000, instances: 10 });
  app.servers.set('gone', lost);
  try {
    await rejects(app.health({ type: 'health' }, {}), 503, 'gone');
  } finally {
    app.servers.clear();
  }
});

test('describe prints the digests and a catalog row', async () => {
  const { app, lines } = servers({ fixture: stdio({ echo: 'fixture.echo' }) });
  const errors = [];
  assert.equal(await app.describe(['fixture'], (line) => errors.push(line)), 0);
  const out = lines.join('\n');
  assert.ok(out.includes(`schema_sha256: ${schemaDigest(offered.echo.input_schema)}`));
  assert.ok(out.includes('## echo - bound as fixture.echo (digest ok)'));
  assert.ok(out.includes('## add - not allowlisted'));
  assert.ok(out.includes('"route": "fixture.echo"'));
  assert.ok(out.includes('"description": "Echo the text back."'));
  assert.equal(await app.describe(['unknown'], (line) => errors.push(line)), 1);
  assert.ok(errors.join('\n').includes('Unknown server(s): unknown'));
});

test('the platform runs startup and cleanup callbacks around the host', async () => {
  const events = [];
  const fresh = new Platform(new FunctionRegistry());
  fresh.onStartup(async () => { events.push('start'); });
  fresh.onCleanup(async () => { events.push('stop'); });
  const server = await fresh.run({ port: 0 });
  try {
    assert.deepEqual(events, ['start'], 'the startup callback runs before the host listens');
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  await fresh.shutdown();
  assert.deepEqual(events, ['start', 'stop']);
});

test('a failing startup callback stops the host before it listens', async () => {
  const fresh = new Platform(new FunctionRegistry());
  fresh.onStartup(async () => { throw new BindingError('no'); });
  await assert.rejects(fresh.run({ port: 0 }), (e) => e.message === 'no');
});
