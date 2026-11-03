/**
 * The LLM helper (extensions/llm-helper/llm-helper.mjs) - token-free.
 *
 * Two shared contract files, test/vectors/llm-helper-vectors.json and llm-loop-vectors.json
 * (byte-identical in mercury-python), drive every case below against a fake of the Anthropic
 * SDK: the exact SDK call, the reply map, the error contract, the streaming segments and the
 * loop's stored record are pinned without spending a token or needing a credential, and the
 * Python twin runs the same files, so the two helpers cannot drift apart. The tests after the
 * vector runs pin what a vector cannot: token batches are never held back, no prompt or tool
 * text reaches a log, the trace annotations, the health route, the backend seam and the Redis
 * store.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AnthropicBedrock, AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { AppException } from 'mercury-composable';
import {
  anthropicBackend, backendFor, blockOf, createLlmHelper, defaultBackend, defaultStore, failure,
  MemoryStore, recordFrom, REDIS_SAVE, RedisStore, redisStore, TRANSCRIPT_PREFIX
} from '../extensions/llm-helper/llm-helper.mjs';

const VECTORS_FILE = new URL('./vectors/llm-helper-vectors.json', import.meta.url);
// the Python twin pins the same digest: change the file in both packs or in neither
const VECTORS_SHA256 = '7bfffbf36c52488c246f250f36afc4e8012f119fd56c93e9de1cbe93bf5988b6';
const VECTORS = JSON.parse(readFileSync(VECTORS_FILE, 'utf8'));
const CHAT_CASES = VECTORS.cases.filter((c) => c.route === 'llm.chat');
const STREAM_CASES = VECTORS.cases.filter((c) => c.route === 'llm.stream');

const LOOP_VECTORS_FILE = new URL('./vectors/llm-loop-vectors.json', import.meta.url);
// the Python twin pins the same digest: change the file in both packs or in neither
const LOOP_VECTORS_SHA256 = '8b6644861643daf36ec7879b825dd6e0268a8bae53007c678043e31d9171f8aa';
const LOOP_VECTORS = JSON.parse(readFileSync(LOOP_VECTORS_FILE, 'utf8'));
const LOOP_CASES = LOOP_VECTORS.cases;
// the cases a Redis server can run as well: its clock is the wall clock, so none that moves time
const LOOP_CASES_ON_REDIS = LOOP_CASES.filter((c) => !c.steps.some((step) => 'advance_s' in step));
const LIVE_REDIS = process.env.LLM_TRANSCRIPT_REDIS_URL;

const NO_CREDENTIAL = 'Could not resolve authentication method. Expected one of apiKey, authToken, '
  + 'credentials, config, or profile to be set. Or for one of the "X-Api-Key" or "Authorization" '
  + 'headers to be explicitly omitted';

/** A real SDK error object, built the way the SDK builds one from a response. */
function statusError(spec) {
  const headers = new Headers(spec.request_id ? { 'request-id': spec.request_id } : {});
  const body = { type: 'error', error: { type: spec.type, message: spec.message } };
  return Anthropic.APIError.generate(spec.status, body, undefined, headers);
}

/** What client.messages.stream(...) returns: async-iterable events, finalMessage(), request_id. */
class FakeStream {
  constructor(provider, ledger, options) {
    this.provider = provider;
    this.ledger = ledger;
    this.options = options;
    this.request_id = undefined;
    this.opening = undefined;
  }

  /** Raises what the SDK raises on the first read, once. */
  ensureOpen() {
    this.opening ??= this.open();
    return this.opening;
  }

  async open() {
    const { kind } = this.provider;
    if (kind === 'hang') {
      await new Promise((resolve, reject) => {
        // AbortSignal.timeout() timers are unref'd, and a real server's listener keeps the
        // loop alive; this fake holds it open until the abort fires
        const keepAlive = setTimeout(() => {}, 10_000);
        const abort = () => {
          clearTimeout(keepAlive);
          this.ledger.cancelled = true;
          reject(new Anthropic.APIUserAbortError());
        };
        if (this.options.signal?.aborted) {
          abort();
        } else {
          this.options.signal?.addEventListener('abort', abort, { once: true });
        }
      });
    }
    if (kind === 'credential') {
      throw new Anthropic.AnthropicError(NO_CREDENTIAL);
    }
    if (kind === 'timeout') {
      throw new Anthropic.APIConnectionTimeoutError();
    }
    if (kind === 'connection') {
      throw new Anthropic.APIConnectionError({ message: 'Connection error.' });
    }
    if (kind === 'status' && !this.provider.after) {
      throw statusError(this.provider);
    }
    this.request_id = this.provider.request_id ?? null;
  }

  async* [Symbol.asyncIterator]() {
    await this.ensureOpen();
    const deltas = this.provider.deltas ?? [];
    const after = this.provider.after ?? 0;
    for (const [index, text] of deltas.entries()) {
      if (this.provider.kind === 'status' && index === after) {
        throw statusError(this.provider);
      }
      yield delta(text);
    }
    if (this.provider.kind === 'status' && after >= deltas.length) {
      throw statusError(this.provider);
    }
  }

  async finalMessage() {
    await this.ensureOpen();
    const { provider } = this;
    return {
      // a loop turn's blocks (thinking, text, tool_use), else the one text block
      content: provider.content ? structuredClone(provider.content)
        : [{ type: 'text', text: provider.text ?? (provider.deltas ?? []).join('') }],
      model: provider.model,
      stop_reason: provider.stop_reason,
      usage: provider.usage,
      stop_details: provider.stop_details ?? null
    };
  }
}

const delta = (text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });

/** The backend the helper holds: a client with two messages namespaces, and a ledger, under
 * the shape of the backend the case names (the Claude API by default). */
function fakeBackend(provider, { supportsFallbacks, apiKey = 'test-credential', make, name = 'anthropic', api = 'mantle' } = {}) {
  const ledger = { calls: [], cancelled: false };
  const namespace = (name) => ({
    stream(params, options) {
      ledger.calls.push({ namespace: name, params, options });
      return make ? make(provider, ledger, options) : new FakeStream(provider ?? {}, ledger, options);
    }
  });
  const client = {
    apiKey, authToken: null, credentials: null, messages: namespace('messages'),
    beta: { messages: namespace('beta.messages') }
  };
  const shape = backendFor(name, client, api);
  return { ledger, backend: supportsFallbacks === undefined ? shape : { ...shape, supportsFallbacks } };
}

class FakeWriter {
  head = null;
  segments = [];
  trailing = null;
  error = null;

  first(status, contentType) {
    this.head = [status, contentType];
  }

  write(segment) {
    this.segments.push(segment);
  }

  close(trailing) {
    this.trailing = trailing;
  }

  fail(error) {
    assert.ok(error instanceof AppException, String(error));
    this.error = error;
  }
}

const settings = (config = {}) => (key, fallback) => config[key] ?? fallback;
const silent = { info() {}, warn() {} };

function helperFor(c, extra = {}) {
  const { backend, ledger } = fakeBackend(c.provider,
    { name: c.config?.['llm.backend'] ?? 'anthropic', api: c.config?.['llm.aws.api'] ?? 'mantle', ...extra.backendOptions });
  const out = new FakeWriter();
  const helper = createLlmHelper({
    prop: settings(c.config), backend: () => backend, writer: () => out, log: silent,
    trace: () => {}, ...extra.deps
  });
  return { helper, ledger, out, backend };
}

function assertSdk(ledger, c) {
  const wanted = c.expect.sdk;
  if (wanted) {
    assert.equal(ledger.calls.length, 1);
    const [call] = ledger.calls;
    assert.equal(call.namespace, wanted.namespace);
    assert.deepEqual(call.params, wanted.params);
    assert.deepEqual({ timeout_ms: call.options.timeout, max_retries: call.options.maxRetries },
      wanted.options);
  } else if (c.provider === undefined) {
    assert.equal(ledger.calls.length, 0, 'a rejected request must not reach the provider');
  }
}

function assertError(error, wanted) {
  assert.ok(error instanceof AppException, 'an AppException was expected');
  assert.equal(error.status, wanted.status, error.message);
  for (const fragment of wanted.message_contains) {
    assert.ok(error.message.includes(fragment), `${JSON.stringify(fragment)} not in ${JSON.stringify(error.message)}`);
  }
}

// --- the shared contract: llm.chat -------------------------------------------------------

test('the vector file is the one the python twin runs', () => {
  const digest = createHash('sha256').update(readFileSync(VECTORS_FILE)).digest('hex');
  assert.equal(digest, VECTORS_SHA256, 'the shared vector file changed - update both packs');
  assert.equal(VECTORS.contract, 'llm-helper');
  assert.equal(VECTORS.version, 1);
  assert.equal(CHAT_CASES.length + STREAM_CASES.length, VECTORS.cases.length);
});

for (const c of CHAT_CASES) {
  test(`chat contract: ${c.name}`, async () => {
    const { helper, ledger } = helperFor(c);
    let result;
    let error;
    try {
      result = await helper.chat({}, c.body);
    } catch (e) {
      assert.ok(e instanceof AppException, String(e));
      error = e;
    }
    assertSdk(ledger, c);
    if (c.expect.error) {
      assertError(error, c.expect.error);
    } else {
      assert.equal(error, undefined, error?.message);
      assert.deepEqual(result, c.expect.result);
    }
  });
}

// --- the shared contract: llm.stream -----------------------------------------------------

for (const c of STREAM_CASES) {
  test(`stream contract: ${c.name}`, async () => {
    const { helper, ledger, out } = helperFor(c);
    await helper.stream(c.headers ?? {}, { body: c.body });
    const { expect } = c;
    assertSdk(ledger, c);
    assert.deepEqual(out.head, expect.head ?? null);
    assert.deepEqual(out.segments, expect.frames ?? []);
    if (expect.terminal) {
      assert.ok(out.trailing, 'the stream must close with trailing metadata');
      for (const [key, value] of Object.entries(expect.terminal)) {
        assert.deepEqual(out.trailing[key], value, key);
      }
      assert.equal(out.trailing.language, 'node.js');
    } else {
      assert.equal(out.trailing, null);
    }
    if (expect.error) {
      assertError(out.error, expect.error);
    } else {
      assert.equal(out.error, null, out.error?.message);
    }
  });
}

// --- the shared contract: a loop turn of llm.chat (RFC-0011) -----------------------------

/** A Redis of the store's own shape: hGet, the compare-and-set script, pTTL. It runs the
 * script's rule in JavaScript, so the cases below pin the store's calls; the live run further
 * down, and the Python twin's Lua-capable fake, run the script itself. */
class FakeRedis {
  hashes = new Map(); // key -> { turn, record, expiresAt }

  live(key) {
    const entry = this.hashes.get(key);
    if (entry !== undefined && entry.expiresAt <= Date.now()) {
      this.hashes.delete(key);
      return undefined;
    }
    return entry;
  }

  async hGet(key, field) {
    return this.live(key)?.[field] ?? null;
  }

  async eval(script, { keys: [key], arguments: [expected, turn, record, ttl] }) {
    assert.equal(script, REDIS_SAVE, 'the store sends its own script');
    const held = this.live(key)?.turn;
    if (expected === '0' ? held !== undefined : held !== expected) {
      return 0;
    }
    if (ttl === '0') {
      this.hashes.delete(key);
    } else {
      this.hashes.set(key, { turn, record, expiresAt: Date.now() + Number(ttl) * 1000 });
    }
    return 1;
  }

  async pTTL(key) {
    const entry = this.live(key);
    return entry === undefined ? -2 : entry.expiresAt - Date.now();
  }
}

/** The record a vector's store expectation describes, read from either store. */
async function stored(store, clock, conversation) {
  if (store === undefined || conversation === undefined) {
    return null;
  }
  let record;
  let ttlS;
  if (store instanceof MemoryStore) {
    const entry = store.records.get(conversation);
    if (entry === undefined || entry[0] <= clock.now) {
      return null;
    }
    record = recordFrom(entry[2]);
    ttlS = Math.round(entry[0] - clock.now);
  } else {
    const key = TRANSCRIPT_PREFIX + conversation;
    const text = await store.client.hGet(key, 'record');
    if (text === null || text === undefined) {
      return null;
    }
    record = recordFrom(text);
    ttlS = Math.round(Number(await store.client.pTTL(key)) / 1000);
  }
  return { turn: record.turn, closed: record.closed, pending: record.pending, ttl_s: ttlS,
    messages: record.messages.length };
}

/** Run a case's steps against the memory store, or a Redis store (a fake unless a client is
 * given) where the case configures the memory one. */
async function runLoopCase(c, kind, redisClient) {
  const clock = { now: 1000 };
  let store;
  if (c.config['llm.transcript.store'] === 'memory') {
    store = kind === 'memory' ? new MemoryStore({ clock: () => clock.now })
      : new RedisStore(redisClient ?? new FakeRedis());
  }
  const ids = c.conversation_ids[Symbol.iterator]();
  const first = c.conversation_ids[0];
  for (const [index, step] of c.steps.entries()) {
    clock.now += step.advance_s ?? 0;
    const { backend, ledger } = fakeBackend(step.provider,
      { name: c.config['llm.backend'] ?? 'anthropic', api: c.config['llm.aws.api'] ?? 'mantle' });
    const out = new FakeWriter();
    const helper = createLlmHelper({
      prop: settings(c.config), backend: () => backend,
      store: store === undefined ? defaultStore(settings(c.config)) : async () => store,
      newConversationId: () => ids.next().value, writer: () => out, log: silent, trace: () => {}
    });
    let result;
    let error;
    if (c.route === 'llm.stream') {
      await helper.stream({}, { body: step.body });
      error = out.error ?? undefined;
    } else {
      try {
        result = await helper.chat({}, step.body);
      } catch (e) {
        assert.ok(e instanceof AppException, String(e));
        error = e;
      }
    }
    const { expect } = step;
    assertSdk(ledger, { expect, provider: step.provider });
    if (expect.error) {
      assertError(error, expect.error);
    } else {
      assert.equal(error, undefined, error?.message);
      assert.deepEqual(result, expect.result, `step ${index}`);
    }
    const named = isObject(step.body) ? step.body.conversation : undefined;
    const conversation = step.conversation ?? named ?? first;
    assert.deepEqual(await stored(store, clock, conversation), expect.store, `step ${index}`);
  }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

test('the loop vector file is the one the python twin runs', () => {
  const digest = createHash('sha256').update(readFileSync(LOOP_VECTORS_FILE)).digest('hex');
  assert.equal(digest, LOOP_VECTORS_SHA256, 'the shared loop vector file changed - update both packs');
  assert.equal(LOOP_VECTORS.contract, 'llm-chat-loop');
  assert.equal(LOOP_VECTORS.version, 1);
  assert.equal(new Set(LOOP_CASES.map((c) => c.name)).size, LOOP_CASES.length, 'case names are unique');
});

for (const c of LOOP_CASES) {
  test(`loop contract: ${c.name}`, () => runLoopCase(c, 'memory'));
}

for (const c of LOOP_CASES_ON_REDIS) {
  test(`loop contract on the redis store: ${c.name}`, () => runLoopCase(c, 'redis'));
}

for (const c of LOOP_CASES_ON_REDIS) {
  // the same turns on a real server: the script Redis runs. Only the keys of the vectors' own
  // conversations are touched
  test(`loop contract on a live redis: ${c.name}`, { skip: !LIVE_REDIS && 'set LLM_TRANSCRIPT_REDIS_URL' },
    async () => {
      const { createClient } = await import('redis');
      const client = createClient({ url: LIVE_REDIS });
      await client.connect();
      const named = c.steps.map((step) => (isObject(step.body) ? step.body.conversation : undefined));
      const keys = [...new Set([...c.conversation_ids, ...named].filter(Boolean))]
        .map((id) => TRANSCRIPT_PREFIX + id);
      try {
        if (keys.length) {
          await client.del(keys);
        }
        await runLoopCase(c, 'redis', client);
      } finally {
        if (keys.length) {
          await client.del(keys);
        }
        await client.close();
      }
    });
}

// --- the loop turn: what a vector cannot pin -----------------------------------------------

test('a stored block is the JSON the SDK would send back', () => {
  // the SDK's stream keeps a tool call's raw input in a non-enumerable buffer and serves input
  // through a getter: the stored block holds the enumerable fields only
  const toolUse = { type: 'tool_use', id: 'toolu_01', name: 'credit_limit' };
  Object.defineProperty(toolUse, '__json_buf', { value: '{"id":"C-1"}', enumerable: false });
  Object.defineProperty(toolUse, 'input', { enumerable: true, get: () => ({ id: 'C-1' }) });
  const blocks = [
    { type: 'thinking', thinking: '', signature: 'sig-opaque' },
    { type: 'redacted_thinking', data: 'opaque' },
    { type: 'text', text: 'Checking the limit.' },
    toolUse
  ];
  assert.deepEqual(blocks.map(blockOf), [
    { type: 'thinking', thinking: '', signature: 'sig-opaque' },
    { type: 'redacted_thinking', data: 'opaque' },
    { type: 'text', text: 'Checking the limit.' },
    { type: 'tool_use', id: 'toolu_01', name: 'credit_limit', input: { id: 'C-1' } }
  ]);
  assert.equal(JSON.stringify(blockOf(toolUse)).includes('__json_buf'), false);
});

const TURN = {
  kind: 'message', model: 'claude-opus-5-5', stop_reason: 'tool_use',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig-1' },
    { type: 'tool_use', id: 'toolu_01', name: 'credit_limit', input: { id: 'INPUT-MARKER-1' } }
  ],
  usage: { input_tokens: 40, output_tokens: 9, cache_creation_input_tokens: 30, cache_read_input_tokens: 0 },
  request_id: 'req_loop_trace'
};
const TOOL = { name: 'credit_limit', description: "A customer's credit limit.", input_schema: { type: 'object' } };
const LOOP_CONFIG = { 'llm.transcript.store': 'memory' };

function loopHelper(provider, deps = {}) {
  const { backend, ledger } = fakeBackend(provider);
  const memory = new MemoryStore();
  const helper = createLlmHelper({
    prop: settings(LOOP_CONFIG), backend: () => backend, store: async () => memory,
    log: silent, trace: () => {}, ...deps
  });
  return { helper, ledger, memory };
}

test('a loop turn logs status and usage, never content', async () => {
  const lines = [];
  const log = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const memory = new MemoryStore();
  const first = loopHelper(TURN, { log, store: async () => memory });
  const reply = await first.helper.chat({}, { prompt: 'PROMPT-MARKER-2', system: 'SYSTEM-MARKER-3', tools: [TOOL] });
  const final = { ...TURN, stop_reason: 'end_turn', content: [{ type: 'text', text: 'REPLY-MARKER-4' }] };
  const second = loopHelper(final, { log, store: async () => memory });
  await second.helper.chat({}, { tools: [TOOL], conversation: reply.conversation, turn: 1,
    results: [{ id: 'toolu_01', output: 'RESULT-MARKER-5' }] });
  const text = lines.join('\n');
  assert.ok(text.includes('llm.chat model=claude-opus-5-5 status=tool_use turn=1'), text);
  assert.ok(text.includes('llm.chat model=claude-opus-5-5 status=done turn=2'), text);
  for (const marker of ['PROMPT', 'SYSTEM', 'INPUT', 'REPLY', 'RESULT']) {
    assert.equal(text.includes(`${marker}-MARKER`), false, marker);
  }
  assert.equal(text.includes(reply.conversation), false, 'the reference to the transcript stays off');
});

test('a loop turn annotates its status, turn and cache usage', async () => {
  const seen = {};
  const { helper } = loopHelper(TURN, { trace: (key, value) => { seen[key] = value; } });
  await helper.chat({}, { prompt: 'x', tools: [TOOL] });
  assert.deepEqual(seen, {
    llm_model: 'claude-opus-5-5',
    llm_stop_reason: 'tool_use',
    llm_input_tokens: '40',
    llm_output_tokens: '9',
    llm_request_id: 'req_loop_trace',
    llm_status: 'tool_use',
    llm_turn: '1',
    llm_cache_creation_input_tokens: '30',
    llm_cache_read_input_tokens: '0'
  });
});

const failing = (name, message) => Object.assign(new Error(message), { name });

test('a store that cannot be reached is a 503 by name', async () => {
  const refused = { name: 'broken', load: async () => undefined,
    save: async () => { throw failing('ConnectionError', 'Connection refused'); } };
  const { helper } = loopHelper(TURN, { store: async () => refused });
  await assert.rejects(helper.chat({}, { prompt: 'x', tools: [TOOL] }), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.message, 'transcript store unreachable - ConnectionError: Connection refused');
    return true;
  });
  const slow = { name: 'broken', load: async () => { throw failing('TimeoutError', 'Timeout reading'); },
    save: async () => true };
  const later = loopHelper(TURN, { store: async () => slow });
  await assert.rejects(later.helper.chat({}, { tools: [TOOL], conversation: '0'.repeat(32), turn: 1, results: [] }),
    (error) => error.status === 503 && error.message.includes('TimeoutError: Timeout reading'));
});

test('a turn that loses the compare-and-set is a 409', async () => {
  // two copies of one turn: both pass the read check, the second write is refused, so the
  // conversation never forks - the model was called, and the turn is reported as duplicated
  const lost = { name: 'lost', load: async () => undefined, save: async () => false };
  const { helper, ledger } = loopHelper(TURN, { store: async () => lost, newConversationId: () => '0'.repeat(32) });
  await assert.rejects(helper.chat({}, { prompt: 'x', tools: [TOOL] }), (error) => {
    assert.equal(error.status, 409);
    assert.ok(error.message.includes('moved on before turn 1 was saved - a duplicated turn'), error.message);
    return true;
  });
  assert.equal(ledger.calls.length, 1);
});

test('health reports the transcript store', async () => {
  const { backend } = fakeBackend(undefined);
  const helper = createLlmHelper({ prop: settings({ 'llm.transcript.store': 'redis' }), backend: () => backend });
  const info = await helper.health({ type: 'info' });
  assert.equal(info.transcript_store, 'redis');
});

test('the memory store is built once', async () => {
  const store = defaultStore(settings(LOOP_CONFIG));
  const built = await store();
  assert.ok(built instanceof MemoryStore);
  assert.equal(await store(), built);
});

// --- the Redis transcript store ------------------------------------------------------------

const record = (turn, closed = false) => ({
  model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }], turn, pending: [], closed
});

test('the redis store keeps one hash under the transcript prefix', async () => {
  // a Redis ACL can confine the helper's user to ~transcript:*, beside the graph's suspend store
  const client = new FakeRedis();
  const store = new RedisStore(client);
  assert.equal(await store.save('a'.repeat(32), 0, record(1), 1800), true);
  assert.deepEqual([...client.hashes.keys()], [`transcript:${'a'.repeat(32)}`]);
  assert.equal(await client.hGet(`transcript:${'a'.repeat(32)}`, 'turn'), '1');
  const ttl = Number(await client.pTTL(`transcript:${'a'.repeat(32)}`));
  assert.ok(ttl > 1799000 && ttl <= 1800000, String(ttl));
  assert.deepEqual(await store.load('a'.repeat(32)), record(1));
});

test('the redis store writes only over the turn it expects', async () => {
  const store = new RedisStore(new FakeRedis());
  const conversation = 'b'.repeat(32);
  assert.equal(await store.save(conversation, 0, record(1), 60), true);
  assert.equal(await store.save(conversation, 0, record(1), 60), false, 'a new record exists');
  assert.equal(await store.save(conversation, 2, record(3), 60), false, 'the record holds turn 1');
  assert.equal(await store.save(conversation, 1, record(2), 60), true);
  assert.deepEqual(await store.load(conversation), record(2));
  assert.equal(await store.save('c'.repeat(32), 1, record(2), 60), false, 'no record to append to');
});

test('the redis store deletes a record saved with no time to live', async () => {
  // retention 0: the run's end removes the record instead of writing it
  const client = new FakeRedis();
  const store = new RedisStore(client);
  const conversation = 'd'.repeat(32);
  assert.equal(await store.save(conversation, 0, record(1), 60), true);
  assert.equal(await store.save(conversation, 1, record(2, true), 0), true);
  assert.equal(client.hashes.size, 0);
  assert.equal(await store.load(conversation), undefined);
});

test('the redis store is built from its connection keys', async () => {
  const seen = {};
  const fakeModule = {
    createClient: (options) => {
      seen.options = options;
      return { isOpen: false, on: (event, listener) => { seen[event] = listener; } };
    }
  };
  const store = await defaultStore(settings({
    'llm.transcript.store': 'redis',
    'llm.transcript.redis.host': 'redis.internal',
    'llm.transcript.redis.port': '6380',
    'llm.transcript.redis.username': 'llm-helper',
    'llm.transcript.redis.password': 'test-only-password',
    'llm.transcript.redis.ssl': 'true',
    'llm.transcript.redis.database': '2',
    'llm.transcript.redis.timeout.ms': '1500'
  }), { importer: async () => fakeModule, log: silent })();
  assert.ok(store instanceof RedisStore);
  const { socket, ...rest } = seen.options;
  assert.deepEqual({ host: socket.host, port: socket.port, tls: socket.tls, connectTimeout: socket.connectTimeout },
    { host: 'redis.internal', port: 6380, tls: true, connectTimeout: 1500 });
  assert.equal(typeof socket.reconnectStrategy, 'function');
  assert.deepEqual(rest, { username: 'llm-helper', password: 'test-only-password', database: 2,
    commandOptions: { timeout: 1500 }, disableOfflineQueue: true });
  assert.equal(typeof seen.error, 'function', 'a lost connection must not stop the process');
});

test('the redis store without the redis package is a 503 that names it', async () => {
  const missing = Object.assign(new Error("Cannot find package 'redis'"), { code: 'ERR_MODULE_NOT_FOUND' });
  await assert.rejects(redisStore(settings(), { importer: async () => { throw missing; } }), (error) => {
    assert.equal(error.status, 503);
    assert.ok(error.message.includes('npm install redis'), error.message);
    return true;
  });
});

test('the redis store connects on the first command, within its timeout', async () => {
  let connects = 0;
  const waiting = { isOpen: false, connect: () => { connects += 1; return new Promise(() => {}); } };
  const store = new RedisStore(waiting, { timeoutMs: 30 });
  await assert.rejects(store.load('e'.repeat(32)), /no connection within 30 ms/);
  await assert.rejects(store.load('e'.repeat(32)), /no connection within 30 ms/);
  assert.equal(connects, 1, 'a pending connect is shared, not repeated');
});

test('a redis server that is not there is a 503 for the turn, and fast', async () => {
  // the real client against a closed local port: it gives up after its retries
  const unreachable = defaultStore(settings({ 'llm.transcript.store': 'redis', 'llm.transcript.redis.port': '1',
    'llm.transcript.redis.timeout.ms': '3000' }), { log: silent });
  const { backend } = fakeBackend(TURN);
  const helper = createLlmHelper({ prop: settings(LOOP_CONFIG), backend: () => backend, store: unreachable,
    newConversationId: () => 'f'.repeat(32), log: silent, trace: () => {} });
  const started = performance.now();
  await assert.rejects(helper.chat({}, { tools: [TOOL], conversation: 'f'.repeat(32), turn: 1, results: [] }),
    (error) => error.status === 503 && error.message.startsWith('transcript store unreachable - '));
  assert.ok(performance.now() - started < 3000, 'the turn fails within the store timeout');
});

// --- progressive rendering: a token batch is never held back -----------------------------

test('each token batch reaches the caller before the next is produced', async () => {
  // The point of the streaming route is to deliver batches continuously. The fake model
  // produces batch k only after asserting that the caller already holds batches 0 to k-1 - a
  // helper that gathered the batches and sent them once would fail this test.
  const batches = ['Event-', 'driven ', 'architecture ', 'decouples ', 'producers.'];
  const out = new FakeWriter();
  class Paced extends FakeStream {
    async* [Symbol.asyncIterator]() {
      for (const [index, text] of batches.entries()) {
        assert.deepEqual(out.segments, batches.slice(0, index), `batch ${index} was produced early`);
        assert.equal(out.head !== null, index > 0, 'the head rides the first batch');
        await new Promise((resolve) => { setImmediate(resolve); }); // a network read yields to the loop
        yield delta(text);
      }
    }
  }
  const provider = {
    kind: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn', deltas: batches,
    usage: { input_tokens: 9, output_tokens: 11 }
  };
  const { backend } = fakeBackend(provider, { make: (p, l, o) => new Paced(p, l, o) });
  const helper = createLlmHelper({
    prop: settings(), backend: () => backend, writer: () => out, log: silent, trace: () => {}
  });
  await helper.stream({}, { body: { prompt: 'describe it' } });
  assert.equal(out.error, null, out.error?.message);
  assert.deepEqual(out.segments, batches, 'every batch is its own segment');
  assert.deepEqual(out.head, [200, 'text/event-stream']);
  assert.deepEqual(out.trailing.usage, { input_tokens: 9, output_tokens: 11 });
});

test('the chat route sends nothing to a stream writer', async () => {
  const provider = {
    kind: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn', deltas: ['a', 'b'],
    usage: { input_tokens: 1, output_tokens: 2 }
  };
  const { helper, out } = helperFor({ provider });
  const result = await helper.chat({}, { prompt: 'x' });
  assert.equal(result.text, 'ab');
  assert.deepEqual(out.segments, []);
  assert.equal(out.head, null);
});

// --- what a vector cannot say -------------------------------------------------------------

test('llm.chat carries a deadline signal and llm.stream does not', async () => {
  const provider = {
    kind: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn', deltas: ['ok'],
    usage: { input_tokens: 1, output_tokens: 1 }
  };
  const chat = helperFor({ provider });
  await chat.helper.chat({}, { prompt: 'x' });
  assert.ok(chat.ledger.calls[0].options.signal instanceof AbortSignal);
  const streaming = helperFor({ provider });
  await streaming.helper.stream({}, { body: { prompt: 'x' } });
  assert.equal(streaming.ledger.calls[0].options.signal, undefined,
    'a stream runs as long as tokens flow: no total deadline');
});

test('the deadline cancels the provider call', async () => {
  const { helper, ledger } = helperFor({ provider: { kind: 'hang' } });
  await assert.rejects(helper.chat({}, { prompt: 'x', params: { timeout_ms: 30 } }),
    (error) => error instanceof AppException && error.status === 408);
  assert.ok(ledger.cancelled, 'the abandoned call must be cancelled, not left running');
});

test('neither the prompt nor the reply reaches a log', async () => {
  const lines = [];
  const log = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const provider = {
    kind: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn', deltas: ['REPLY-MARKER-9023'],
    usage: { input_tokens: 7, output_tokens: 5 }, request_id: 'req_log_001'
  };
  const { helper } = helperFor({ provider }, { deps: { log } });
  await helper.chat({}, { prompt: 'PROMPT-MARKER-4471', system: 'SYSTEM-MARKER-1188' });
  await helper.stream({}, { body: { prompt: 'PROMPT-MARKER-4471' } });
  const text = lines.join('\n');
  assert.ok(text.includes('llm.chat model=claude-opus-5-5'));
  assert.ok(text.includes('llm.stream model=claude-opus-5-5'));
  assert.ok(text.includes('request_id=req_log_001'));
  for (const marker of ['PROMPT-MARKER-4471', 'REPLY-MARKER-9023', 'SYSTEM-MARKER-1188']) {
    assert.ok(!text.includes(marker), `${marker} reached a log`);
  }
});

test('batch timing is logged when asked, and never the text', async () => {
  const lines = [];
  const log = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const provider = {
    kind: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn',
    deltas: ['alpha-MARKER-1', 'beta-MARKER-2', 'gamma'], usage: { input_tokens: 3, output_tokens: 9 }
  };
  const { helper } = helperFor({ provider, config: { 'llm.log.batches': 'true' } }, { deps: { log } });
  await helper.stream({}, { body: { prompt: 'x' } });
  const batches = lines.filter((line) => line.includes('llm.stream batch='));
  assert.equal(batches.length, 3, batches.join('\n'));
  assert.match(batches[0], /^llm\.stream batch=1 chars=14 t_ms=\d+$/);
  assert.match(batches[2], /^llm\.stream batch=3 chars=5 t_ms=\d+$/);
  assert.ok(!lines.join('\n').includes('MARKER'));
});

test('batch timing is off by default', async () => {
  const lines = [];
  const log = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const provider = {
    kind: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn', deltas: ['a', 'b'],
    usage: { input_tokens: 1, output_tokens: 2 }
  };
  const { helper } = helperFor({ provider }, { deps: { log } });
  await helper.stream({}, { body: { prompt: 'x' } });
  assert.ok(!lines.join('\n').includes('llm.stream batch='));
});

test('usage rides the trace annotations', async () => {
  const seen = {};
  const provider = {
    kind: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn', deltas: ['ok'],
    usage: { input_tokens: 20, output_tokens: 4 }, request_id: 'req_trace_001'
  };
  const { helper } = helperFor({ provider }, { deps: { trace: (key, value) => { seen[key] = value; } } });
  await helper.chat({}, { prompt: 'x' });
  assert.deepEqual(seen, {
    llm_model: 'claude-opus-5-5', llm_stop_reason: 'end_turn', llm_input_tokens: '20',
    llm_output_tokens: '4', llm_request_id: 'req_trace_001'
  });
});

for (const [model, getsFallbacks] of [
  ['claude-opus-5-5', true], ['claude-opus-5', true], ['claude-fable-5-1', true],
  ['claude-sonnet-5-5', true], ['claude-sonnet-5', false], ['claude-opus-4-8', false],
  ['claude-haiku-4-5', false]
]) {
  test(`refusal fallbacks for ${model}: ${getsFallbacks}`, () => {
    const { helper, backend } = helperFor({});
    const request = helper.prepare({ prompt: 'x', params: { model } }, { streaming: false });
    const { namespace, params } = helper.plan(request, backend, { deadline: false });
    assert.equal(namespace === 'beta.messages', getsFallbacks);
    assert.equal('fallbacks' in params, getsFallbacks);
    assert.equal('betas' in params, getsFallbacks);
  });
}

test('a route without server-side fallbacks never sends them', () => {
  const { helper, backend } = helperFor({}, { backendOptions: { supportsFallbacks: false } });
  const request = helper.prepare({ prompt: 'x' }, { streaming: false });
  const { namespace, params } = helper.plan(request, backend, { deadline: false });
  assert.equal(namespace, 'messages');
  assert.equal('fallbacks' in params, false);
});

test('a backend can spell the model id its own way', () => {
  // the seam for a second route to the models: its model ids may carry a prefix
  const { helper, backend } = helperFor({});
  const prefixed = { ...backend, providerModel: (model) => `anthropic.${model}` };
  const request = helper.prepare({ prompt: 'x' }, { streaming: false });
  const { params } = helper.plan(request, prefixed, { deadline: false });
  assert.equal(params.model, 'anthropic.claude-opus-5-5');
});

test('the SDK failures map to the portable error contract', () => {
  assert.equal(failure(new Anthropic.APIUserAbortError(), 25).status, 408);
  assert.equal(failure(new Anthropic.APIConnectionTimeoutError(), 25).status, 408);
  assert.equal(failure(statusError({ status: 429, type: 'rate_limit_error', message: 'x' }), 25).status, 429);
  assert.equal(failure(new Error('something else entirely'), 25), undefined);
});

// --- the health route and the backend seam -----------------------------------------------

test('health reports the backend and the model', async () => {
  const { helper } = helperFor({});
  const info = await helper.health({ type: 'info' });
  assert.equal(info.service, 'llm.helper');
  assert.equal(info.backend, 'anthropic');
  assert.equal(info.model, 'claude-opus-5-5');
});

test('health is up when a credential is present', async () => {
  const { helper } = helperFor({});
  assert.equal(await helper.health({ type: 'health' }), 'llm.helper is running fine');
});

test('health is down without a credential', async () => {
  const { helper } = helperFor({}, { backendOptions: { apiKey: null } });
  await assert.rejects(helper.health({ type: 'health' }),
    (error) => error instanceof AppException && error.status === 503
      && error.message.includes('credential missing'));
});

test('the real client reports a credential it was given', () => {
  const backend = anthropicBackend('anthropic', new Anthropic({ apiKey: 'test-credential' }));
  assert.equal(backend.credentialProblem(), undefined);
});

test('an unknown backend is a 501 that names what is served', async () => {
  const build = defaultBackend((key, fallback) => (key === 'llm.backend' ? 'vertex' : fallback));
  await assert.rejects(build(), (error) => error instanceof AppException && error.status === 501
    && error.message.includes("unknown LLM backend 'vertex'")
    && error.message.includes('this helper serves: anthropic, bedrock'));
});

test('the default backend is the Anthropic client, built once', async () => {
  const build = defaultBackend((key, fallback) => fallback);
  const backend = await build();
  assert.equal(backend.name, 'anthropic');
  assert.equal(backend.supportsFallbacks, true);
  assert.ok(backend.client instanceof Anthropic);
  assert.equal(await build(), backend, 'the client is built once');
});

// --- the Bedrock backend: the SDK's Mantle client, built without a credential or a token ----

const AWS_ENVIRONMENT = [
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE',
  'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_AWS_API_KEY', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_REGION',
  'AWS_DEFAULT_REGION', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL', 'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE', 'AWS_EC2_METADATA_DISABLED'
];

/** Runs fn in a process with no AWS environment at all: the shared credential and config files
 * pointed nowhere, the instance metadata lookup switched off, so every check stays local and
 * deterministic; the environment is restored afterwards. */
async function withoutAws(fn) {
  const saved = Object.fromEntries(AWS_ENVIRONMENT.map((name) => [name, process.env[name]]));
  for (const name of AWS_ENVIRONMENT) {
    delete process.env[name];
  }
  process.env.AWS_SHARED_CREDENTIALS_FILE = '/nonexistent/aws/credentials';
  process.env.AWS_CONFIG_FILE = '/nonexistent/aws/config';
  process.env.AWS_EC2_METADATA_DISABLED = 'true';
  try {
    await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

const bedrockSettings = (extra = {}) => settings({ 'llm.backend': 'bedrock', ...extra });

test('the bedrock backend is the SDK mantle client', () => withoutAws(async () => {
  // the region from llm.aws.region, the model prefix for a bare id (an id already spelled for
  // Bedrock is kept), no server-side fallbacks; built once
  const build = defaultBackend(bedrockSettings({ 'llm.aws.region': 'us-east-1' }));
  const backend = await build();
  assert.equal(backend.name, 'bedrock');
  assert.ok(backend.client instanceof AnthropicBedrockMantle);
  assert.equal(backend.client.awsRegion, 'us-east-1');
  assert.equal(backend.supportsFallbacks, false);
  assert.equal(backend.providerModel('claude-opus-5-5'), 'anthropic.claude-opus-5-5');
  assert.equal(backend.providerModel('us.anthropic.claude-opus-5-5'), 'us.anthropic.claude-opus-5-5');
  assert.equal(backend.api, 'mantle');
  assert.equal(await build(), backend, 'the client is built once');
}));

test('the bedrock backend takes the classic runtime surface', () => withoutAws(async () => {
  // llm.aws.api: runtime - the SDK's classic client, every model id sent as written (an inference
  // profile id as the account lists it), no server-side fallbacks; found necessary in the live
  // drive of 2026-10-14, where the account was enabled for the runtime and not for the other surface
  const build = defaultBackend(bedrockSettings({ 'llm.aws.region': 'us-east-1', 'llm.aws.api': 'runtime' }));
  const backend = await build();
  assert.ok(backend.client instanceof AnthropicBedrock);
  assert.equal(backend.client.awsRegion, 'us-east-1');
  assert.equal(backend.api, 'runtime');
  assert.equal(backend.supportsFallbacks, false);
  const profile = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
  assert.equal(backend.providerModel(profile), profile);
  assert.equal(backend.providerModel('claude-opus-5-5'), 'claude-opus-5-5');
}));

test('bedrock health names the surface, and a bearer token counts on the runtime surface', () => withoutAws(async () => {
  const prop = bedrockSettings({ 'llm.aws.region': 'us-east-1', 'llm.aws.api': 'runtime' });
  const helper = createLlmHelper({ prop, backend: defaultBackend(prop), log: silent, trace: () => {} });
  const info = await helper.health({ type: 'info' });
  assert.equal(info.backend, 'bedrock');
  assert.equal(info.api, 'runtime');
  assert.equal(info.region, 'us-east-1');
  await assert.rejects(helper.health({ type: 'health' }),
    (error) => error instanceof AppException && error.status === 503);
  process.env.AWS_BEARER_TOKEN_BEDROCK = 'test-only-token';
  const keyed = createLlmHelper({ prop, backend: defaultBackend(prop), log: silent, trace: () => {} });
  assert.equal(await keyed.health({ type: 'health' }), 'llm.helper is running fine');
}));

test('the runtime surface without a region is a 503 that names the setting', () => withoutAws(async () => {
  // the classic client would quietly fall back to us-east-1; the helper names the gap instead
  await assert.rejects(defaultBackend(bedrockSettings({ 'llm.aws.api': 'runtime' }))(),
    (error) => error instanceof AppException && error.status === 503 && error.message.includes('AWS region missing'));
}));

test('a bad llm.aws.api value is a 500 by name', () => withoutAws(async () => {
  await assert.rejects(defaultBackend(bedrockSettings({ 'llm.aws.region': 'us-east-1', 'llm.aws.api': 'console' }))(),
    (error) => error instanceof AppException && error.status === 500
      && error.message.includes('llm.aws.api must be one of: mantle, runtime'));
}));

test('the bedrock backend reads the region from the AWS environment', () => withoutAws(async () => {
  process.env.AWS_REGION = 'eu-west-1';
  const backend = await defaultBackend(bedrockSettings())();
  assert.equal(backend.client.awsRegion, 'eu-west-1');
}));

test('the bedrock backend without a region is a 503 that names the setting', () => withoutAws(async () => {
  await assert.rejects(defaultBackend(bedrockSettings())(),
    (error) => error instanceof AppException && error.status === 503
      && error.message.includes('AWS region missing') && error.message.includes('llm.aws.region'));
}));

test('bedrock health reports the region and resolves the AWS chain', () => withoutAws(async () => {
  // the health route names the region a call is signed for, and its check resolves the AWS
  // credential chain the way a call would: nothing in the chain is a 503 by name, the AWS
  // environment is a credential, and so is a Bedrock API key
  const prop = bedrockSettings({ 'llm.aws.region': 'us-east-1' });
  const helper = createLlmHelper({ prop, backend: defaultBackend(prop), log: silent, trace: () => {} });
  const info = await helper.health({ type: 'info' });
  assert.equal(info.backend, 'bedrock');
  assert.equal(info.region, 'us-east-1');
  await assert.rejects(helper.health({ type: 'health' }),
    (error) => error instanceof AppException && error.status === 503
      && error.message.includes('AWS credential missing'));
  process.env.AWS_ACCESS_KEY_ID = 'AKIATESTONLY';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-only-secret';
  assert.equal(await helper.health({ type: 'health' }), 'llm.helper is running fine');
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_BEARER_TOKEN_BEDROCK = 'test-only-token';
  // the key is read when the client is built
  const keyed = createLlmHelper({ prop, backend: defaultBackend(prop), log: silent, trace: () => {} });
  assert.equal(await keyed.health({ type: 'health' }), 'llm.helper is running fine');
}));

test('a missing AWS credential at call time is a 503 by name', () => {
  // the Bedrock SDK signs each call with the AWS chain, whose error names itself - as thrown,
  // or as the cause of the SDK's connection error
  const chain = Object.assign(new Error('Could not load credentials from any providers'),
    { name: 'CredentialsProviderError' });
  assert.equal(failure(chain, 25).status, 503);
  assert.ok(failure(chain, 25).message.includes('AWS credential missing'));
  const wrapped = new Anthropic.APIConnectionError({ cause: chain });
  assert.equal(failure(wrapped, 25).status, 503);
  assert.ok(failure(wrapped, 25).message.includes('AWS credential missing'));
  assert.equal(failure(new Anthropic.APIConnectionError({ cause: new Error('refused') }), 25).status, 503);
  assert.ok(failure(new Anthropic.APIConnectionError({ cause: new Error('refused') }), 25).message.includes('unreachable'));
});
