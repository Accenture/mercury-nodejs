/**
 * The MCP binding (extensions/mcp-binding/mcp-binding.mjs).
 *
 * The shared contract file test/vectors/mcp-binding-vectors.json (byte-identical in mercury-python)
 * pins the pure half: the input-schema digest, the verification of the tools the functions bind
 * against the tools a server offers, and the result mapping. The tests after the vector runs drive
 * the real transports against the fixture server of test/fixtures (a small MCP server on the
 * official SDK, over stdio and over streamable HTTP): the boot that verifies every binding and
 * fails fast by name, the calls through functions that bind the fixture's tools (local RPC through
 * the bus, as the host dispatches them), the credential references that reach the subprocess and
 * never a log, the health route, the describe output, and the platform's startup hook that runs
 * the boot before the host listens.
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
  BindingError, connectClient, createBinding, DEFAULT_SERVERS_FILE, loadServers, renderMermaid, schemaDigest, Server,
  toolResult, verify
} from '../extensions/mcp-binding/mcp-binding.mjs';

const VECTORS_FILE = new URL('./vectors/mcp-binding-vectors.json', import.meta.url);
// the Python twin pins the same digest: change the file in both packs or in neither
const VECTORS_SHA256 = 'b470762efe1d77145c430cb3f946956256126f3e4e53e8d001cfed35316ee6a2';
const VECTORS = JSON.parse(readFileSync(VECTORS_FILE, 'utf8'));
const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-test-server.mjs', import.meta.url));
const FIXTURE_TOOLS = ['add', 'echo', 'env_present', 'fail', 'slow'];

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
    const server = c.server.name;
    const bindings = c.bindings.map((b) => ({ server, tool: b.tool, schema_sha256: b.schema_sha256 }));
    if (c.expect.error) {
      assert.throws(() => verify(server, bindings, c.offered), (e) => e instanceof BindingError && e.message === c.expect.error);
    } else {
      assert.deepEqual(verify(server, bindings, c.offered).map((b) => b.binding.tool), c.expect.bound);
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
  return {
    lines,
    text: () => lines.join('\n'),
    debug: (m) => lines.push(`DEBUG ${m}`),
    info: (m) => lines.push(`INFO ${m}`),
    warn: (m) => lines.push(`WARN ${m}`),
    error: (m) => lines.push(`ERROR ${m}`)
  };
}

/** What the fixture server offers, as the binding reads it: the digests come from the server itself. */
let offered;
before(async () => {
  const client = await connectClient({ name: 'probe', transport: 'stdio', command: process.execPath, args: [FIXTURE],
    env: {}, headers: {}, timeout_ms: 30000 });
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

/** Point the binding at a temporary server file and give the test a fresh binding, a registry of its own and a log. */
function servers(entries) {
  const path = join(scratch, `mcp-servers-${fileCount++}.yml`);
  writeFileSync(path, YAML.stringify({ servers: entries }), 'utf8');
  appConfig().set('mcp.servers', path);
  const registry = new FunctionRegistry();
  const log = ledger();
  const lines = [];
  const app = createBinding({ log, out: (line) => lines.push(line) });
  return { app, registry, log, lines };
}

/** A stdio server entry for the fixture - the servers file names servers only; the tools are bound in code. */
function stdio(extra = {}) {
  return { transport: 'stdio', command: process.execPath, args: [FIXTURE], ...extra };
}

/**
 * The documented shape: bind a tool of a server with the digest the server reports (or the one
 * given), and register a function under the route that calls it - what preload does for an app.
 */
function serve(app, registry, route, server, tool, { instances = 10, digest } = {}) {
  const call = app.bind(server, tool, { schemaSha256: digest ?? schemaDigest(offered[tool].input_schema) });
  registry.register(route, async (_headers, body) => call(body), { instances });
  return call;
}

/** Local RPC through the registry's bus, the path a request takes behind the HTTP host. */
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

test('the example function binds the mermaid tool out of the box', () => {
  // the extension's own function: declared with preload like any route, public, bound in code
  const service = defaultRegistry.get('mermaid.render');
  assert.ok(service && !service.isPrivate && service.instances === 10);
  assert.deepEqual([renderMermaid.server, renderMermaid.tool], ['mermaid', 'validate_and_render_mermaid_diagram']);
  assert.match(renderMermaid.declared.schema_sha256, /^[0-9a-f]{64}$/);
  assert.equal(defaultRegistry.get('mcp.tool'), undefined, 'the generic route is gone - a tool is a function');
});

test('boot verifies every binding and the functions call their tools', async () => {
  const { app, registry } = servers({ fixture: stdio() });
  const echo = serve(app, registry, 'fixture.echo', 'fixture', 'echo', { instances: 3 });
  serve(app, registry, 'fixture.add', 'fixture', 'add');
  serve(app, registry, 'fixture.fail', 'fixture', 'fail');
  await app.boot();
  try {
    assert.deepEqual([...app.servers.keys()], ['fixture']);
    assert.deepEqual(app.servers.get('fixture').bound.map((b) => b.binding.tool), ['echo', 'add', 'fail']);
    const service = registry.get('fixture.echo');
    assert.ok(service && service.instances === 3 && !service.isPrivate);
    assert.equal(ok(await call(registry, 'fixture.echo', { text: 'hello' })), 'hello');
    assert.deepEqual(ok(await call(registry, 'fixture.add', { a: 1, b: 2 })), { sum: 3 });
    failed(await call(registry, 'fixture.fail', { reason: 'the vault is closed' }), 400, 'the vault is closed');
    failed(await call(registry, 'fixture.echo', 'hello'), 400, 'must be a map');
    assert.deepEqual([echo.server, echo.tool], ['fixture', 'echo']);
  } finally {
    await app.shutdown();
  }
  assert.equal(app.servers.size, 0);
  // the declarations are code and survive a shutdown; a call before the next boot is a 503 by name
  assert.deepEqual(app.declared.map((d) => d.tool), ['echo', 'add', 'fail']);
  failed(await call(registry, 'fixture.echo', { text: 'later' }), 503, 'MCP server fixture is not connected');
});

test('two functions may bind the same tool', async () => {
  const { app, registry } = servers({ fixture: stdio() });
  serve(app, registry, 'fixture.echo.one', 'fixture', 'echo');
  serve(app, registry, 'fixture.echo.two', 'fixture', 'echo');
  await app.boot();
  try {
    assert.equal(app.servers.get('fixture').bound.length, 2);
    assert.equal(ok(await call(registry, 'fixture.echo.one', { text: '1' })), '1');
    assert.equal(ok(await call(registry, 'fixture.echo.two', { text: '2' })), '2');
  } finally {
    await app.shutdown();
  }
});

test("a slow tool is a 408 within the server's timeout", async () => {
  const { app, registry } = servers({ fixture: stdio({ timeout_ms: 1000 }) });
  serve(app, registry, 'fixture.slow', 'fixture', 'slow');
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
  const { app, registry, log } = servers({ fixture: stdio() });
  serve(app, registry, 'fixture.echo', 'fixture', 'echo');
  serve(app, registry, 'fixture.nope', 'fixture', 'nope', { digest: '0'.repeat(64) });
  await assert.rejects(app.boot(), (e) => e instanceof BindingError && e.message.includes('does not offer the tool nope'));
  assert.ok(log.text().includes('does not offer the tool nope'));
  assert.equal(app.servers.size, 0, 'a failed boot leaves no connection behind');
});

test('a changed schema fails the boot by name', async () => {
  const { app, registry, log } = servers({ fixture: stdio() });
  serve(app, registry, 'fixture.echo', 'fixture', 'echo', { digest: 'f'.repeat(64) });
  await assert.rejects(app.boot(), (e) => e instanceof BindingError && e.message.includes('changed the input schema of echo'));
  assert.ok(log.text().includes(schemaDigest(offered.echo.input_schema)), 'the current digest is shown');
});

test('a binding to an unconfigured server fails the boot by name', async () => {
  const { app, registry, log } = servers({ fixture: stdio() });
  serve(app, registry, 'ghost.echo', 'ghost', 'echo');
  await assert.rejects(app.boot(), (e) => e instanceof BindingError
    && e.message.includes('No MCP server named ghost is configured - a function binds its tool echo'));
  assert.ok(log.text().includes('No MCP server named ghost is configured'));
  assert.equal(app.servers.size, 0);
});

test('a configured server nobody binds is not connected', async () => {
  // the spare server's command does not exist: it is never started, so the boot still succeeds
  const { app, registry, log } = servers({ fixture: stdio(), spare: { transport: 'stdio', command: 'no-such-mcp-server-command' } });
  serve(app, registry, 'fixture.echo', 'fixture', 'echo');
  await app.boot();
  try {
    assert.deepEqual([...app.servers.keys()], ['fixture']);
    assert.ok(log.text().includes('MCP server spare: no function binds a tool of it - not connected'));
  } finally {
    await app.shutdown();
  }
});

for (const [server, tool, digest, message] of [
  ['', 'echo', '0'.repeat(64), "needs the server's name"],
  ['fixture', 'bad name!', '0'.repeat(64), 'is not a tool name'],
  ['fixture', 'echo', 'short', 'needs schemaSha256']
]) {
  test(`bind refuses a bad declaration: ${message}`, () => {
    assert.throws(() => createBinding({ log: ledger() }).bind(server, tool, { schemaSha256: digest }),
      (e) => e instanceof BindingError && e.message.includes(message));
  });
}

test('credential references reach the subprocess and never a log', async () => {
  process.env.FIXTURE_TOKEN = 'a-value-that-must-not-appear';
  try {
    const { app, registry, log } = servers({ fixture: stdio({ env: { FIXTURE_FORWARDED: '${FIXTURE_TOKEN}' } }) });
    serve(app, registry, 'fixture.env.present', 'fixture', 'env_present');
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
  servers({ fixture: stdio({ env: { TOKEN: '${FIXTURE_MISSING_TOKEN}' } }) });
  assert.throws(() => loadServers(), (e) => e instanceof BindingError && e.message.includes('env.TOKEN resolves to nothing'));
});

for (const [entry, message] of [
  [{ transport: 'ftp' }, 'transport must be stdio or http'],
  [{ transport: 'stdio' }, 'a stdio server needs a command'],
  [{ transport: 'http' }, 'an http server needs a url'],
  [{ transport: 'stdio', command: 'x', url: 'http://x' }, 'url and headers belong to an http server'],
  [{ transport: 'stdio', command: 'x', colour: 'blue' }, 'has unknown keys colour'],
  [{ transport: 'stdio', command: 'x', timeout_ms: 10 }, 'timeout_ms must be at least 1000'],
  // the allowlist row of the first shape: the tools are bound in the code now, and the file says so
  [{ transport: 'stdio', command: 'x', tools: { echo: { route: 'a.b', schema_sha256: '0'.repeat(64) } } },
    'the tools are bound in the code, not in this file'],
  [{ transport: 'stdio', command: 'x', instances: 3 }, 'has unknown keys instances']
]) {
  test(`the server file is checked before any connection: ${message}`, () => {
    servers({ s: entry });
    assert.throws(() => loadServers(), (e) => e instanceof BindingError && e.message.includes(message));
  });
}

test('an empty server map loads no server', () => {
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

test('the http transport serves the same functions', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [FIXTURE, 'http', String(port)], { stdio: 'ignore' });
  try {
    await waitFor(port, child);
    process.env.FIXTURE_HTTP_TOKEN = 'bearer-value';
    const { app, registry } = servers({ remote: {
      transport: 'http', url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: 'Bearer ${FIXTURE_HTTP_TOKEN}' }
    } });
    serve(app, registry, 'remote.echo', 'remote', 'echo');
    serve(app, registry, 'remote.add', 'remote', 'add');
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
  const { app, registry } = servers({ fixture: stdio() });
  serve(app, registry, 'fixture.echo', 'fixture', 'echo');
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
  const lost = new Server({ name: 'gone', transport: 'stdio', command: 'x', args: [], env: {}, headers: {}, timeout_ms: 30000 });
  app.servers.set('gone', lost);
  try {
    await rejects(app.health({ type: 'health' }, {}), 503, 'gone');
  } finally {
    app.servers.clear();
  }
});

test('describe prints the digests, the bind lines and a catalog row', async () => {
  const { app, registry, lines } = servers({ fixture: stdio() });
  serve(app, registry, 'fixture.echo', 'fixture', 'echo');
  const errors = [];
  assert.equal(await app.describe(['fixture'], (line) => errors.push(line)), 0);
  const out = lines.join('\n');
  assert.ok(out.includes(`schema_sha256: ${schemaDigest(offered.echo.input_schema)}`));
  assert.ok(out.includes('## echo - bound (digest ok)'));
  assert.ok(out.includes('## add - not bound'));
  assert.ok(out.includes(`bind('fixture', 'add', { schemaSha256: '${schemaDigest(offered.add.input_schema)}' })`));
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
