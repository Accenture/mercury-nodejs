/**
 * The MCP recipes (extensions/mcp-binding/resources/mcp-recipes.yml) and the digests they pin.
 *
 * The engines' page "Tools from MCP servers" (RFC-0013, step 5) gives a recipe for each of seven
 * MCP servers - the server-file entry, the bind lines and the catalog rows. The entries live in
 * mcp-recipes.yml, which the binding does not load by default, and the input-schema digests of the
 * six servers that list their tools without a credential are pinned in test/vectors/mcp-recipes.json,
 * shared byte for byte with the Python twin. The tests here load the recipes file on every run
 * and, when MCP_RECIPES_LIVE is set, start each server with uvx or npx through the binding's own
 * client and compare the digests, so a recipe that rots is caught at the digest, as the binding's
 * boot would catch it.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectClient, loadServers, schemaDigest, toolAsPlain } from '../extensions/mcp-binding/mcp-binding.mjs';

const RECIPES = fileURLToPath(new URL('../extensions/mcp-binding/resources/mcp-recipes.yml', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const DIGESTS_FILE = new URL('./vectors/mcp-recipes.json', import.meta.url);
// the Python twin pins the same digest: change the file in both packs or in neither
const DIGESTS_SHA256 = '10c70fe179d315cb0932d56cf0bc1e11290eb7c922ff439e5b9e7944df437d53';
const DIGESTS = JSON.parse(readFileSync(DIGESTS_FILE, 'utf8'));
const LIVE = Boolean(process.env.MCP_RECIPES_LIVE);
const RECIPE_SERVERS = ['fetch', 'filesystem', 'git', 'github', 'neo4j', 'playwright', 'time'];
// the servers that list their tools without a credential - the ones the page pins
const CREDENTIAL_FREE = ['git', 'time', 'fetch', 'filesystem', 'playwright'];
// a credential the file references but these tests never send gets a placeholder, so the file
// loads; a real value already in the environment (the Neo4j run) is kept
const PLACEHOLDERS = { GITHUB_MCP_TOKEN: 'not-used-by-this-test', NEO4J_PASSWORD: 'not-used-by-this-test' };

function recipes() {
  for (const [name, placeholder] of Object.entries(PLACEHOLDERS)) {
    if (!process.env[name]) process.env[name] = placeholder;
  }
  process.env.MCP_GIT_REPOSITORY = REPOSITORY;
  process.env.MCP_FILESYSTEM_ROOT = mkdtempSync(join(tmpdir(), 'mcp-recipes-'));
  return new Map(loadServers(RECIPES).map((spec) => [spec.name, spec]));
}

/** The pinned tools a server no longer offers, and the ones whose schema changed. */
export function rot(actual, pinned) {
  const missing = Object.keys(pinned).filter((name) => !(name in actual)).sort();
  const changed = Object.keys(pinned).filter((name) => name in actual && actual[name] !== pinned[name]).sort();
  return { missing, changed };
}

async function offeredDigests(spec) {
  const client = await connectClient(spec);
  try {
    const digests = {};
    let cursor;
    for (;;) {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of page.tools.map(toolAsPlain)) digests[tool.name] = schemaDigest(tool.input_schema);
      cursor = page.nextCursor;
      if (!cursor) return digests;
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

// --- the files, on every run ---------------------------------------------------------------------

test('the digest file is the one the Python twin runs', () => {
  const digest = createHash('sha256').update(readFileSync(DIGESTS_FILE)).digest('hex');
  assert.equal(digest, DIGESTS_SHA256, "update both packs' pins when the shared file changes");
});

test('the recipes file names the seven servers', () => {
  const specs = recipes();
  assert.deepEqual([...specs.keys()].sort(), RECIPE_SERVERS);
  for (const name of ['git', 'time', 'fetch', 'neo4j']) {
    assert.equal(specs.get(name).transport, 'stdio', name);
    assert.equal(specs.get(name).command, 'uvx', name);
  }
  for (const name of ['filesystem', 'playwright']) {
    assert.equal(specs.get(name).transport, 'stdio', name);
    assert.equal(specs.get(name).command, 'npx', name);
  }
  const github = specs.get('github');
  assert.equal(github.transport, 'http');
  assert.ok(github.url.startsWith('https://'));
  assert.ok(github.headers.Authorization.startsWith('Bearer '));
  assert.equal(github.headers['X-MCP-Readonly'], 'true');
});

test('the references resolve from the environment', () => {
  const specs = recipes();
  assert.ok(specs.get('git').args.includes(REPOSITORY));
  assert.ok(specs.get('filesystem').args.includes('--read-only'));
  assert.equal(specs.get('time').args.at(-1), 'UTC');
  assert.equal(specs.get('neo4j').env.NEO4J_URI, process.env.NEO4J_URI ?? 'bolt://127.0.0.1:7687');
  assert.equal(specs.get('neo4j').env.NEO4J_USERNAME, process.env.NEO4J_USERNAME ?? 'neo4j');
});

test('every pinned server has a recipe and tools', () => {
  const specs = recipes();
  const pinned = DIGESTS.servers;
  assert.deepEqual(Object.keys(pinned).sort(), [...CREDENTIAL_FREE, 'neo4j'].sort());
  for (const [name, server] of Object.entries(pinned)) {
    assert.ok(specs.has(name), name);
    assert.ok(Object.keys(server.tools).length > 0, name);
    for (const [tool, digest] of Object.entries(server.tools)) assert.match(digest, /^[0-9a-f]{64}$/, `${name}.${tool}`);
  }
});

test('rot names what is missing and what changed', () => {
  const pinned = { a: '1', b: '2', c: '3' };
  assert.deepEqual(rot({ a: '1', b: '9', d: '4' }, pinned), { missing: ['c'], changed: ['b'] });
  assert.deepEqual(rot({ ...pinned }, pinned), { missing: [], changed: [] });
});

// --- the servers, live (gated) ------------------------------------------------------------------

const LIVE_SKIP = LIVE ? false : 'set MCP_RECIPES_LIVE=1 to start the recipe servers with uvx and npx and check their digests';

for (const name of CREDENTIAL_FREE) {
  test(`live digests of the ${name} recipe`, { skip: LIVE_SKIP }, async () => {
    const actual = await offeredDigests(recipes().get(name));
    const { missing, changed } = rot(actual, DIGESTS.servers[name].tools);
    assert.ok(missing.length === 0 && changed.length === 0,
      `the ${name} recipe rotted - missing ${JSON.stringify(missing)}, changed ${JSON.stringify(changed)}: run describe `
      + "on it, review the schema, then re-pin the digest in both packs' vector file and on the page");
  });
}

test('live digests of the neo4j recipe', {
  skip: LIVE && process.env.NEO4J_PASSWORD ? false
    : 'set MCP_RECIPES_LIVE=1 and NEO4J_PASSWORD, with a database at NEO4J_URI (e.g. the one extensions/agent-tools/dev/graph-up.sh starts)'
}, async () => {
  const actual = await offeredDigests(recipes().get('neo4j'));
  const { missing, changed } = rot(actual, DIGESTS.servers.neo4j.tools);
  assert.ok(missing.length === 0 && changed.length === 0,
    `the neo4j recipe rotted - missing ${JSON.stringify(missing)}, changed ${JSON.stringify(changed)}`);
});
