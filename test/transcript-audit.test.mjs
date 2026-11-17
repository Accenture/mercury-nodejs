/**
 * The transcript audit store (RFC-0012) in the LLM helper - token-free, the twin of the Python
 * pack's tests/test_transcript_audit.py.
 *
 * Record version 2 and the facts a turn saves inside its compare-and-set, the two events a turn
 * sends to transcript.audit and the grace a closed record waits with, the function driven through
 * its mailbox (a write that fails and the check that repairs it before the release, an open record
 * only filled, the mark left to the check), the sweep, the audited mark in the memory and Redis
 * working stores, and the PostgreSQL store on a recording fake of the connection pool that pins
 * every statement and its parameters. The live test runs on a real PostgreSQL when
 * LLM_TRANSCRIPT_AUDIT_TEST_URL is set. The shared loop vector file gains no case: the audit is a
 * side effect of a turn, not part of the loop contract the twins repeat.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AppException, FunctionRegistry, PostOffice, runWithTrace } from 'mercury-composable';
import {
  AUDIT_ROUTE, AUDIT_SWEEP_LOCK, auditFailure, createLlmHelper, defaultAudit, MemoryAuditStore, MemoryStore,
  plusSeconds, PostgresAuditStore, recordFrom, recordJson, REDIS_MARK_AUDITED, REDIS_SAVE, RedisStore,
  SQL_INSERT_TURN, SQL_TOTALS, SQL_TURNS, SQL_UPSERT_CONVERSATION, transcript
} from '../extensions/llm-helper/llm-helper.mjs';
import { fakeBackend, settings, silent } from './fixtures/llm-helper-fakes.mjs';

const SCHEMA = new URL('../extensions/llm-helper/schema/', import.meta.url);
const CONFIG = { 'llm.transcript.store': 'memory', 'llm.transcript.audit': 'postgres' };
const HEADERS = { 'x-graph-id': 'order-assistant', 'x-node': 'assistant', my_correlation_id: 'corr-1' };
const TRACE_ID = '3e9a'.repeat(8);
const TRACE_PATH = 'POST /api/graph/order-assistant';
const LIVE_POSTGRES = process.env.LLM_TRANSCRIPT_AUDIT_TEST_URL;

const TURN = {
  kind: 'message', model: 'claude-opus-5-5', stop_reason: 'tool_use',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig-1' },
    { type: 'tool_use', id: 'toolu_01', name: 'credit_limit', input: { id: 'INPUT-MARKER-1' } }
  ],
  usage: { input_tokens: 40, output_tokens: 9, cache_creation_input_tokens: 30, cache_read_input_tokens: 0 },
  request_id: 'req_loop_trace'
};
// the model's answer to the tool result: the closing turn of a two-turn conversation
const DONE = {
  ...TURN,
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'The limit is 500.' }],
  usage: { input_tokens: 60, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 30 },
  request_id: 'req_done'
};
const TOOL = { name: 'credit_limit', description: "A customer's credit limit.", input_schema: { type: 'object' } };
const PROMPT = { role: 'user', content: 'What is the limit of C-1?' };
const PROMPT_BODY = { prompt: PROMPT.content, system: 'Be brief.', tools: [TOOL] };
const RESULTS = [{ id: 'toolu_01', output: { limit: 500 } }];
const RESULT_MESSAGE = {
  role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '{"limit":500}' }]
};
const CALLS = [{ id: 'toolu_01', name: 'credit_limit', input: { id: 'INPUT-MARKER-1' } }];

const accepted = { hasError: () => false, getStatus: () => 202 };
const lines = () => { const seen = []; return { seen, info: (m) => seen.push(m), warn: (m) => seen.push(m), error: (m) => seen.push(m) }; };
const record = (fields) => transcript({ model: 'claude-opus-5-5', messages: [PROMPT], turn: 1, pending: ['toolu_01'], ...fields });

/** A helper on a memory working store with an audit store, the events captured unless a send is given. */
function auditHelper({ store = new MemoryStore(), audit = new MemoryAuditStore(), config = CONFIG, send, registry, log = silent } = {}) {
  const sent = [];
  let current = fakeBackend(TURN).backend;
  const helper = createLlmHelper({
    prop: settings(config), backend: () => current, store: async () => store, audit: async () => audit,
    send: send ?? (async (_route, event) => { sent.push(event); return accepted; }),
    registry, log, trace: () => {}
  });
  return { helper, store, audit, sent, answer: (provider) => { current = fakeBackend(provider).backend; } };
}

/** The first turn: the model asks for the tool. The conversation reference. */
async function firstTurn(h, headers = HEADERS) {
  h.answer(TURN);
  const reply = await h.helper.chat(headers, { ...PROMPT_BODY });
  return reply.conversation;
}

/** The second turn: the tool's result goes back and the model answers, closing the run. */
async function closingTurn(h, conversation, fields = {}) {
  h.answer(DONE);
  return h.helper.chat(HEADERS, { tools: [TOOL], conversation, turn: 1, results: RESULTS, ...fields });
}

const withTrace = (fn) => runWithTrace({ traceId: TRACE_ID, tracePath: TRACE_PATH, myCorrelationId: 'corr-1' }, fn);
const ttlOf = (store, conversation, clock) => store.records.get(conversation)[0] - clock.now;
const expires = (startedAt) => plusSeconds(startedAt, 365 * 86400);

// --- the record: version 2 and its facts ---------------------------------------------------

test('a version 2 record round-trips and a version 1 record still loads', () => {
  const full = transcript({ model: 'claude-haiku-4-5', messages: [PROMPT], turn: 1, pending: [], closed: true, retention: 60,
    correlation_id: 'c', graph_id: 'g', node: 'n', system: 's', tools: [TOOL], turns: [{ turn: 1 }] });
  const data = JSON.parse(recordJson(full));
  assert.equal(data.v, 2);
  assert.deepEqual(Object.keys(data), ['v', 'model', 'turn', 'pending', 'closed', 'retention', 'correlation_id',
    'graph_id', 'node', 'system', 'tools', 'turns', 'messages']);
  assert.deepEqual(recordFrom(recordJson(full)), full);
  // a conversation that was open when the helper was upgraded: no facts, the defaults
  const version1 = JSON.stringify({ v: 1, model: 'm', turn: 1, pending: [], closed: false, messages: [PROMPT] });
  const loaded = recordFrom(version1);
  assert.deepEqual(loaded, transcript({ model: 'm', messages: [PROMPT], turn: 1, pending: [] }));
  assert.deepEqual([loaded.retention, loaded.turns, loaded.tools, loaded.system], [0, [], null, null]);
  assert.deepEqual([loaded.correlation_id, loaded.graph_id, loaded.node], [null, null, null]);
});

test('a turn saves its facts inside the compare-and-set', async () => {
  // every fact an audit row needs is in the record as the turn happens: identity from the trace
  // context and the loop's headers, the call's UTC bounds, the outcome, the usage, the indexes
  const h = auditHelper({ config: { 'llm.transcript.store': 'memory' } });
  const conversation = await withTrace(async () => {
    const started = await firstTurn(h, { 'x-graph-id': 'order-assistant', 'x-node': 'assistant' });
    await closingTurn(h, started, { retention: '1h' });
    return started;
  });
  const saved = await h.store.load(conversation);
  assert.ok(saved.closed && saved.retention === 3600);
  assert.deepEqual([saved.correlation_id, saved.graph_id, saved.node], ['corr-1', 'order-assistant', 'assistant']);
  assert.deepEqual([saved.system, saved.tools], ['Be brief.', [TOOL]]);
  const [first, second] = saved.turns;
  assert.deepEqual(first, {
    turn: 1, trace_id: TRACE_ID, trace_path: TRACE_PATH, correlation_id: 'corr-1',
    started_at: first.started_at, ended_at: first.ended_at, status: 'tool_use', stop_reason: 'tool_use',
    request_id: 'req_loop_trace',
    usage: { input_tokens: 40, output_tokens: 9, cache_creation_input_tokens: 30, cache_read_input_tokens: 0 },
    messages: [0, 1]
  });
  assert.deepEqual([second.turn, second.status, second.stop_reason], [2, 'done', 'end_turn']);
  assert.deepEqual([second.request_id, second.messages], ['req_done', [2, 3]]);
  assert.equal(second.usage.cache_read_input_tokens, 30);
  for (const stamp of [first.started_at, first.ended_at, second.started_at]) {
    assert.ok(stamp.length === 24 && stamp.endsWith('Z'), stamp); // ISO-8601 UTC, milliseconds
  }
  assert.ok(first.started_at <= first.ended_at && first.ended_at <= second.started_at && second.started_at <= second.ended_at);
  // the messages the indexes point at: the prompt and the answer, the results and the answer
  assert.deepEqual(saved.messages[0], PROMPT);
  assert.equal(saved.messages[1].role, 'assistant');
  assert.deepEqual(saved.messages[2], RESULT_MESSAGE);
  assert.equal(saved.messages[3].role, 'assistant');
});

test('a direct call records the header view and no trace', async () => {
  // without a trace context the correlation id comes from the read-only header view, the trace
  // fields stay null, and a first turn that carried a conversation history points at all of it
  const h = auditHelper({ config: { 'llm.transcript.store': 'memory' } });
  const history = [PROMPT, { role: 'assistant', content: 'Which customer?' }, { role: 'user', content: 'C-1' }];
  const reply = await h.helper.chat({ my_correlation_id: 'corr-2' }, { messages: history, tools: [TOOL] });
  const saved = await h.store.load(reply.conversation);
  assert.deepEqual([saved.correlation_id, saved.graph_id, saved.node, saved.system], ['corr-2', null, null, null]);
  const [fact] = saved.turns;
  assert.deepEqual([fact.trace_id, fact.trace_path, fact.correlation_id], [null, null, 'corr-2']);
  assert.deepEqual(fact.messages, [0, 3], 'the request of the first turn is every message it sent');
});

// --- the events behind a turn, and the grace -------------------------------------------------

test('a turn sends its write and a closing turn the check behind it', async () => {
  // after the compare-and-set accepted the turn: one write event; a closing turn adds the check,
  // and the closed record waits for the check with the audit's grace, not the retention
  const clock = { now: 1000 };
  const h = auditHelper({ store: new MemoryStore({ clock: () => clock.now }) });
  const conversation = await firstTurn(h);
  assert.deepEqual(h.sent, [{ conversation, turn: 1 }]);
  assert.equal(ttlOf(h.store, conversation, clock), 604800, 'an open record keeps its ttl');
  await closingTurn(h, conversation);
  assert.deepEqual(h.sent.slice(1), [{ conversation, turn: 2 }, { conversation, check: true }]);
  assert.equal(ttlOf(h.store, conversation, clock), 86400, 'the grace (1d), not retention 0');
  const saved = await h.store.load(conversation);
  assert.ok(saved.closed && saved.retention === 0);
});

test('the grace is configurable and a cut-off turn waits for its check too', async () => {
  const clock = { now: 1000 };
  const h = auditHelper({ store: new MemoryStore({ clock: () => clock.now }),
    config: { ...CONFIG, 'llm.transcript.audit.grace': '2h' } });
  h.answer({ ...TURN, stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Th' }] });
  const reply = await h.helper.chat(HEADERS, { ...PROMPT_BODY });
  assert.deepEqual([reply.status, reply.cap], ['cap', 'max_tokens']);
  assert.deepEqual(h.sent, [{ conversation: reply.conversation, turn: 1 }, { conversation: reply.conversation, check: true }]);
  assert.equal(ttlOf(h.store, reply.conversation, clock), 7200);
});

test('without an audit store a turn sends nothing and the retention applies', async () => {
  const h = auditHelper({ config: { 'llm.transcript.store': 'memory' } });
  const conversation = await firstTurn(h);
  await closingTurn(h, conversation);
  assert.deepEqual(h.sent, []);
  assert.equal(await h.store.load(conversation), undefined, 'retention 0 deletes the record at the close');
});

test('a send that fails is logged and never refuses the turn', async () => {
  // the route is not registered (the boot did not run): the bus answers 404, the turn is still
  // answered, and the sweep's job is noted in the log
  const log = lines();
  const postOffice = new PostOffice(undefined, {}, new FunctionRegistry());
  const h = auditHelper({ send: (route, body) => postOffice.send(route, body), log });
  const conversation = await firstTurn(h);
  assert.notEqual(await h.store.load(conversation), undefined);
  assert.ok(log.seen.some((line) => line === 'transcript.audit event not accepted - status=404'), log.seen.join('\n'));
});

// --- the function, driven through its mailbox ------------------------------------------------

/** A database error whose message details the failing row, as a constraint violation does. */
class DatabaseError extends Error {
  constructor() {
    super('new row for relation "transcript_turn" violates check constraint\nDETAIL: Failing row contains (SECRET-MARKER-ROW).');
    this.name = 'error';
    this.code = '23514';
    this.severity = 'ERROR';
  }
}

/** An audit store whose first writes fail. */
class FlakyAudit extends MemoryAuditStore {
  constructor(failures) {
    super();
    this.failures = failures;
  }

  async write(conversation, turns) {
    if (this.failures) {
      this.failures -= 1;
      throw new DatabaseError();
    }
    await super.write(conversation, turns);
  }
}

test('a write event persists the turn row and the conversation row', async () => {
  // the write of turn N builds its row from the record - the facts, the messages the turn sent
  // and the blocks it got back - upserts the conversation row and marks the record audited
  const h = auditHelper();
  const conversation = await withTrace(() => firstTurn(h));
  const fact = (await h.store.load(conversation)).turns[0];
  await h.helper.transcriptAudit({}, { conversation, turn: 1 });
  const row = h.audit.conversations.get(conversation);
  assert.deepEqual(row, {
    conversation, correlation_id: 'corr-1', graph_id: 'order-assistant', node: 'assistant', model: 'claude-opus-5-5',
    status: 'open', turns: 1, started_at: fact.started_at, updated_at: row.updated_at, ended_at: null,
    expires_at: expires(fact.started_at), system: 'Be brief.', tools: [TOOL],
    input_tokens: 40, output_tokens: 9, cache_creation_input_tokens: 30, cache_read_input_tokens: 0
  });
  assert.ok(row.updated_at >= fact.ended_at);
  assert.deepEqual([...h.audit.turnRows.get(conversation).entries()], [[1, {
    conversation, turn: 1, trace_id: TRACE_ID, trace_path: TRACE_PATH, correlation_id: 'corr-1',
    started_at: fact.started_at, ended_at: fact.ended_at, stop_reason: 'tool_use', status: 'tool_use',
    request_id: 'req_loop_trace', input_tokens: 40, output_tokens: 9, cache_creation_input_tokens: 30,
    cache_read_input_tokens: 0, request: [PROMPT], response: TURN.content, calls: CALLS
  }]]);
  assert.equal(await h.store.audited(conversation), 1);
  // the closing turn: its write leaves the mark to the check behind it, and sets the status
  await closingTurn(h, conversation);
  const second = (await h.store.load(conversation)).turns[1];
  await h.helper.transcriptAudit({}, { conversation, turn: 2 });
  const updated = h.audit.conversations.get(conversation);
  assert.deepEqual([updated.status, updated.turns, updated.ended_at], ['done', 2, second.ended_at]);
  assert.deepEqual([updated.input_tokens, updated.output_tokens, updated.cache_creation_input_tokens,
    updated.cache_read_input_tokens], [100, 21, 30, 30]);
  assert.deepEqual([updated.started_at, updated.expires_at], [fact.started_at, expires(fact.started_at)]);
  const turn2 = h.audit.turnRows.get(conversation).get(2);
  assert.deepEqual([turn2.status, turn2.stop_reason, turn2.request_id], ['done', 'end_turn', 'req_done']);
  assert.deepEqual(turn2.request, [RESULT_MESSAGE]);
  assert.deepEqual(turn2.response, [{ type: 'text', text: 'The limit is 500.' }]);
  assert.equal(turn2.calls, null);
  assert.equal(await h.store.audited(conversation), 1, 'a closing write leaves the mark to the check');
  assert.notEqual(await h.store.load(conversation), undefined);
});

test('a failed write is logged by type and the check repairs it before the release', async () => {
  // Eric's integrity step: the check counts the turns the record holds against the rows the store
  // holds, writes the missing ones, and only then releases the working record. A failure reaches
  // the log as a type and a SQLSTATE, never as the row the database quotes
  const log = lines();
  const h = auditHelper({ audit: new FlakyAudit(1), log });
  const conversation = await firstTurn(h);
  await h.helper.transcriptAudit({}, { conversation, turn: 1 });
  assert.equal(h.audit.turnRows.size, 0, 'the first write failed');
  assert.ok(log.seen.includes(`transcript.audit conversation=${conversation} write failed - DatabaseError sqlstate=23514`),
    log.seen.join('\n'));
  const text = log.seen.join('\n');
  assert.ok(!text.includes('SECRET-MARKER') && !text.includes('Failing row'));
  assert.equal(await h.store.audited(conversation), 0);
  await closingTurn(h, conversation);
  await h.helper.transcriptAudit({}, { conversation, turn: 2 });
  assert.deepEqual([...h.audit.turnRows.get(conversation).keys()], [1, 2], 'a write fills every turn the store lacks');
  assert.notEqual(await h.store.load(conversation), undefined, 'a write never releases');
  await h.helper.transcriptAudit({}, { conversation, check: true });
  assert.equal(h.audit.conversations.get(conversation).status, 'done');
  assert.equal(await h.store.load(conversation), undefined, 'released: retention 0 deletes the record');
  assert.ok(log.seen.includes(`transcript.audit conversation=${conversation} turn=2 written=0 check=true released=true`),
    log.seen.join('\n'));
  for (const marker of ['PROMPT', 'INPUT-MARKER', 'Be brief', 'The limit is', 'limit']) {
    assert.ok(!log.seen.join('\n').includes(marker), marker);
  }
});

test('the check releases a closed record to its retention and marks it', async () => {
  const clock = { now: 1000 };
  const h = auditHelper({ store: new MemoryStore({ clock: () => clock.now }) });
  const conversation = await firstTurn(h);
  await closingTurn(h, conversation, { retention: '30m' });
  assert.equal(ttlOf(h.store, conversation, clock), 86400);
  await h.helper.transcriptAudit({}, { conversation, check: true });
  assert.deepEqual([...h.audit.turnRows.get(conversation).keys()], [1, 2]);
  assert.equal(ttlOf(h.store, conversation, clock), 1800, 'the retention the turn carried');
  assert.equal(await h.store.audited(conversation), 2, 'the mark says the check is done');
});

test('a check never releases an open record', async () => {
  // a run waiting for a tool result, a person or the loop's next turn is filled, never released -
  // it may resume; the sweep sends such checks for records whose audit lags
  const clock = { now: 1000 };
  const h = auditHelper({ store: new MemoryStore({ clock: () => clock.now }) });
  const conversation = await firstTurn(h);
  await h.helper.transcriptAudit({}, { conversation, check: true });
  assert.deepEqual([...h.audit.turnRows.get(conversation).keys()], [1]);
  assert.equal(h.audit.conversations.get(conversation).status, 'open');
  assert.equal(ttlOf(h.store, conversation, clock), 604800, 'its time to live stays');
  assert.equal(await h.store.audited(conversation), 1);
  // the run goes on: the later turn is accepted over the audited record
  await closingTurn(h, conversation);
  assert.equal((await h.store.load(conversation)).turn, 2);
});

test('a record that is gone or from before version 2 is handled by name', async () => {
  const log = lines();
  const h = auditHelper({ log });
  const gone = 'e'.repeat(32);
  await h.helper.transcriptAudit({}, { conversation: gone, turn: 1 });
  assert.ok(log.seen.includes(`transcript.audit conversation=${gone} no working record - expired or released`));
  await h.helper.transcriptAudit({}, { conversation: 'not-a-reference', turn: 1 });
  assert.ok(log.seen.includes('transcript.audit event without a conversation reference ignored'));
  // a version 1 record, open when the helper was upgraded: its turns carry no facts
  const old = 'f'.repeat(32);
  const version1 = { model: 'claude-opus-5-5', messages: [PROMPT, { role: 'assistant', content: TURN.content }],
    turn: 1, pending: ['toolu_01'], closed: false };
  assert.equal(await h.store.save(old, 0, version1, 600), true);
  await h.helper.transcriptAudit({}, { conversation: old, check: true });
  assert.ok(log.seen.includes(`transcript.audit conversation=${old} turn(s) 1 carry no facts - unaudited`), log.seen.join('\n'));
  assert.equal(h.audit.conversations.get(old).status, 'open');
  assert.equal(h.audit.turnRows.get(old).size, 0);
  assert.equal(await h.store.audited(old), 1, 'nothing more can be done for it');
  assert.ok(!log.seen.join('\n').includes('INPUT-MARKER'));
});

test('the mailbox runs the write and the check in order', async () => {
  // the real path: llm.chat sends the events over the in-process bus to the function with one
  // instance; the check behind the closing write finds every turn and releases the record
  const registry = new FunctionRegistry();
  const postOffice = new PostOffice(undefined, {}, registry);
  const h = auditHelper({ send: (route, body) => postOffice.send(route, body), registry });
  registry.register(AUDIT_ROUTE, h.helper.transcriptAudit, { instances: 1, isPrivate: true });
  const conversation = await firstTurn(h);
  await closingTurn(h, conversation);
  for (let i = 0; i < 200 && h.store.records.has(conversation); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(h.store.records.has(conversation), false, 'the check released the record');
  assert.deepEqual([...h.audit.turnRows.get(conversation).keys()], [1, 2]);
  assert.deepEqual([h.audit.conversations.get(conversation).status, h.audit.conversations.get(conversation).turns], ['done', 2]);
});

// --- the sweep -------------------------------------------------------------------------------

test('the sweep sends a check for every record whose audit lags', async () => {
  const h = auditHelper();
  const [behind, current] = ['a'.repeat(32), 'b'.repeat(32)];
  for (const conversation of [behind, current]) {
    assert.equal(await h.store.save(conversation, 0, record({}), 600), true);
  }
  await h.store.markAudited(current, 1);
  assert.equal(await h.helper.auditSweep(), 1);
  assert.deepEqual(h.sent, [{ conversation: behind, check: true }]);
  await h.store.markAudited(behind, 1);
  assert.equal(await h.helper.auditSweep(), 0);
  assert.equal(h.sent.length, 1);
});

// --- the audited mark in the Redis working store ---------------------------------------------

/** The Redis commands the store sends, on a fake that keeps the semantics the tests pin: hashes
 * with a time to live, the two scripts, the string key of the sweep's lock, SCAN pages. */
class FakeRedis {
  hashes = new Map(); // key -> { fields: Map, expiresAt }
  strings = new Map(); // key -> { value, expiresAt }

  liveHash(key) {
    const entry = this.hashes.get(key);
    if (entry !== undefined && entry.expiresAt <= Date.now()) {
      this.hashes.delete(key);
      return undefined;
    }
    return entry;
  }

  liveString(key) {
    const entry = this.strings.get(key);
    if (entry !== undefined && entry.expiresAt <= Date.now()) {
      this.strings.delete(key);
      return undefined;
    }
    return entry;
  }

  async hGet(key, field) {
    return this.liveHash(key)?.fields.get(field) ?? null;
  }

  async hmGet(key, fields) {
    const entry = this.liveHash(key);
    return fields.map((field) => entry?.fields.get(field) ?? null);
  }

  async eval(script, { keys: [key], arguments: args }) {
    if (script === REDIS_MARK_AUDITED) {
      const entry = this.liveHash(key);
      if (entry !== undefined) {
        entry.fields.set('audited', args[0]);
      }
      return 1;
    }
    assert.equal(script, REDIS_SAVE, 'the store sends its own scripts');
    const [expected, turn, text, ttl] = args;
    const held = this.liveHash(key)?.fields.get('turn');
    if (expected === '0' ? held !== undefined : held !== expected) {
      return 0;
    }
    if (ttl === '0') {
      this.hashes.delete(key);
    } else {
      const fields = this.liveHash(key)?.fields ?? new Map();
      fields.set('turn', turn);
      fields.set('record', text);
      this.hashes.set(key, { fields, expiresAt: Date.now() + Number(ttl) * 1000 });
    }
    return 1;
  }

  async ttl(key) {
    const entry = this.liveHash(key) ?? this.liveString(key);
    return entry === undefined ? -2 : Math.round((entry.expiresAt - Date.now()) / 1000);
  }

  async exists(key) {
    return this.liveHash(key) !== undefined || this.liveString(key) !== undefined ? 1 : 0;
  }

  async del(key) {
    return this.hashes.delete(key) || this.strings.delete(key) ? 1 : 0;
  }

  async expire(key, seconds) {
    const entry = this.liveHash(key);
    if (entry === undefined) {
      return 0;
    }
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async set(key, value, options = {}) {
    if (options.NX && (this.liveString(key) !== undefined || this.liveHash(key) !== undefined)) {
      return null;
    }
    this.strings.set(key, { value, expiresAt: options.PX ? Date.now() + options.PX : Infinity });
    return 'OK';
  }

  async* scanIterator({ MATCH }) {
    const pattern = new RegExp(`^${MATCH.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    yield [...this.hashes.keys(), ...this.strings.keys()].filter((key) => pattern.test(key)); // one page, as the client yields
  }
}

test('the redis store keeps the audited mark beside the turn and the record', async () => {
  // the compare-and-set never touches the mark, the mark never resurrects a released record, the
  // release applies the retention, and the sweep reads two fields per live record
  const client = new FakeRedis();
  const store = new RedisStore(client);
  const conversation = 'a'.repeat(32);
  const key = `transcript:${conversation}`;
  assert.equal(await store.save(conversation, 0, record({}), 600), true);
  assert.equal(await store.audited(conversation), 0);
  await store.markAudited(conversation, 1);
  assert.equal(await client.hGet(key, 'audited'), '1');
  assert.ok((await client.ttl(key)) >= 599, 'the mark leaves the time to live alone');
  assert.equal(await store.save(conversation, 1, record({ messages: [PROMPT, RESULT_MESSAGE], turn: 2, pending: [] }), 600), true);
  assert.equal(await store.audited(conversation), 1, 'the compare-and-set leaves the mark alone');
  assert.equal(await client.set(AUDIT_SWEEP_LOCK, 'x'), 'OK'); // the lock under the prefix is skipped
  assert.deepEqual(await store.unaudited(), [conversation]);
  await store.markAudited(conversation, 2);
  assert.deepEqual(await store.unaudited(), []);
  await store.markAudited('b'.repeat(32), 1);
  assert.equal(await client.exists(`transcript:${'b'.repeat(32)}`), 0, 'no record, no hash');
  await store.release(conversation, 60);
  assert.ok((await client.ttl(key)) <= 60 && (await client.ttl(key)) >= 59);
  await store.release(conversation, 0);
  assert.equal(await client.exists(key), 0);
  await store.release(conversation, 0); // gone already: nothing to do
});

test('the redis sweep lock is one per interval', async () => {
  const client = new FakeRedis();
  const store = new RedisStore(client);
  assert.equal(await store.sweepLock(60000), true);
  assert.equal(await store.sweepLock(60000), false, 'another replica holds this interval');
  assert.ok((await client.ttl(AUDIT_SWEEP_LOCK)) <= 60);
  assert.equal(await new MemoryStore().sweepLock(60000), true, 'one process sweeps its own');
});

// --- the PostgreSQL store on a recording fake of the pool ------------------------------------

/** pg.Pool as the store uses it, recording every statement. */
class FakePool {
  constructor({ rows = [], openError } = {}) {
    this.log = [];
    this.rows = rows;
    this.openError = openError;
    this.ended = false;
    this.listeners = {};
  }

  async connect() {
    if (this.openError) {
      throw this.openError;
    }
    return { query: (text, params) => this.run(text, params), release: () => this.log.push(['RELEASE', null]) };
  }

  async query(text, params) {
    return this.run(text, params);
  }

  async run(text, params) {
    this.log.push([text, params ?? null]);
    return { rows: text === SQL_TURNS ? this.rows : [] };
  }

  async end() {
    this.ended = true;
  }

  on(event, listener) {
    this.listeners[event] = listener;
  }
}

const conversationRowOf = (conversation) => ({
  conversation, correlation_id: 'corr-1', graph_id: 'order-assistant', node: 'assistant', model: 'claude-opus-5-5',
  status: 'done', turns: 2, started_at: '2026-11-17T01:02:03.456Z', updated_at: '2026-11-17T01:02:06.000Z',
  ended_at: '2026-11-17T01:02:05.012Z', expires_at: '2027-11-17T01:02:03.456Z', system: 'Be brief.', tools: [TOOL]
});
const turnRowOf = (conversation) => ({
  conversation, turn: 1, trace_id: TRACE_ID, trace_path: TRACE_PATH, correlation_id: 'corr-1',
  started_at: '2026-11-17T01:02:03.456Z', ended_at: '2026-11-17T01:02:05.012Z', stop_reason: 'tool_use',
  status: 'tool_use', request_id: 'req_loop_trace', input_tokens: 40, output_tokens: 9, cache_creation_input_tokens: 30,
  cache_read_input_tokens: 0, request: [PROMPT], response: TURN.content, calls: CALLS
});

test('the postgres store runs the statements in one transaction', async () => {
  // the exact statements and parameters: JSON as compact text cast to jsonb, the stamps as text
  // cast to timestamptz, the totals recomputed from the turn rows - the Python twin runs the same
  const conversation = 'd'.repeat(32);
  const pool = new FakePool({ rows: [{ turn: 1 }, { turn: 2 }] });
  const store = new PostgresAuditStore(pool);
  await store.open();
  assert.deepEqual(pool.log, [['RELEASE', null]], 'open takes and returns one connection');
  assert.deepEqual(await store.turns(conversation), new Set([1, 2]));
  assert.deepEqual(pool.log.at(-1), [SQL_TURNS, [conversation]]);
  pool.log.length = 0;
  await store.write(conversationRowOf(conversation), [turnRowOf(conversation)]);
  assert.deepEqual(pool.log, [
    ['BEGIN', null],
    [SQL_UPSERT_CONVERSATION, [conversation, 'corr-1', 'order-assistant', 'assistant', 'claude-opus-5-5', 'done', 2,
      '2026-11-17T01:02:03.456Z', '2026-11-17T01:02:06.000Z', '2026-11-17T01:02:05.012Z', '2027-11-17T01:02:03.456Z',
      'Be brief.', JSON.stringify([TOOL])]],
    [SQL_INSERT_TURN, [conversation, 1, TRACE_ID, TRACE_PATH, 'corr-1', '2026-11-17T01:02:03.456Z',
      '2026-11-17T01:02:05.012Z', 'tool_use', 'tool_use', 'req_loop_trace', 40, 9, 30, 0, JSON.stringify([PROMPT]),
      JSON.stringify(TURN.content), JSON.stringify(CALLS)]],
    [SQL_TOTALS, [conversation, conversation]],
    ['COMMIT', null],
    ['RELEASE', null]
  ]);
  assert.ok(SQL_UPSERT_CONVERSATION.includes('ON CONFLICT (conversation) DO UPDATE'));
  assert.ok(SQL_INSERT_TURN.includes('ON CONFLICT (conversation, turn) DO NOTHING'));
  await store.close();
  assert.equal(pool.ended, true);
});

test('a failed statement rolls the transaction back and a null json column stays null', async () => {
  const pool = new FakePool();
  const store = new PostgresAuditStore(pool);
  await store.write({ ...conversationRowOf('d'.repeat(32)), tools: null }, [{ ...turnRowOf('d'.repeat(32)), calls: null }]);
  assert.equal(pool.log[1][1].at(-1), null, 'tools NULL');
  assert.equal(pool.log[2][1].at(-1), null, 'calls NULL');
  const failing = new FakePool();
  failing.run = async (text, params) => {
    failing.log.push([text, params ?? null]);
    if (text === SQL_INSERT_TURN) {
      throw new DatabaseError();
    }
    return { rows: [] };
  };
  await assert.rejects(new PostgresAuditStore(failing).write(conversationRowOf('d'.repeat(32)), [turnRowOf('d'.repeat(32))]),
    DatabaseError);
  assert.deepEqual(failing.log.map(([text]) => text), ['BEGIN', SQL_UPSERT_CONVERSATION, SQL_INSERT_TURN, 'ROLLBACK', 'RELEASE']);
});

test('the postgres store is built from its connection keys', async () => {
  const seen = {};
  const fakeModule = {
    Pool: class {
      constructor(options) {
        seen.options = options;
      }

      on(event, listener) {
        seen[event] = listener;
      }
    }
  };
  const audit = defaultAudit(settings({
    'llm.transcript.audit': 'postgres',
    'llm.transcript.audit.postgres.host': 'postgres.internal',
    'llm.transcript.audit.postgres.port': '5433',
    'llm.transcript.audit.postgres.database': 'audit',
    'llm.transcript.audit.postgres.username': 'transcript_writer',
    'llm.transcript.audit.postgres.password': 'test-only-password',
    'llm.transcript.audit.postgres.ssl': 'false',
    'llm.transcript.audit.postgres.timeout.ms': '2500'
  }), { importer: async () => fakeModule, log: silent });
  const store = await audit();
  assert.ok(store instanceof PostgresAuditStore);
  assert.equal(await audit(), store, 'built once');
  assert.deepEqual(seen.options, {
    host: 'postgres.internal', port: 5433, database: 'audit', user: 'transcript_writer', password: 'test-only-password',
    ssl: false, max: 4, connectionTimeoutMillis: 2500, query_timeout: 2500, statement_timeout: 2500
  });
  assert.equal(typeof seen.error, 'function', 'a lost connection must not stop the process');
  // the defaults: localhost, the mercury database, TLS on, no credential in a file
  await defaultAudit(settings({ 'llm.transcript.audit': 'postgres' }), { importer: async () => fakeModule, log: silent })();
  assert.deepEqual(seen.options, {
    host: '127.0.0.1', port: 5432, database: 'mercury', user: undefined, password: undefined,
    ssl: { rejectUnauthorized: false }, max: 4, connectionTimeoutMillis: 5000, query_timeout: 5000,
    statement_timeout: 5000
  });
});

test('the postgres store without the pg package is a 503 that names it', async () => {
  const missing = Object.assign(new Error("Cannot find package 'pg'"), { code: 'ERR_MODULE_NOT_FOUND' });
  await assert.rejects(defaultAudit(settings(CONFIG), { importer: async () => { throw missing; } })(), (error) => {
    assert.equal(error.status, 503);
    assert.ok(error.message.includes('npm install pg'), error.message);
    return true;
  });
});

test('an audit store that is not configured or unknown is named', async () => {
  await assert.rejects(defaultAudit(settings({}))(), (error) => error.status === 503 && error.message.includes('llm.transcript.audit'));
  await assert.rejects(defaultAudit(settings({ 'llm.transcript.audit': 'mongo' }))(), (error) => {
    assert.equal(error.status, 500);
    assert.equal(error.message, 'llm.transcript.audit must be one of: postgres');
    return true;
  });
});

// --- the boot ----------------------------------------------------------------------------------

test('the boot registers the function once, opens the store and starts the sweep', async () => {
  const log = lines();
  const pool = new FakePool();
  const registry = new FunctionRegistry();
  const h = auditHelper({ audit: new PostgresAuditStore(pool), registry, log,
    config: { ...CONFIG, 'llm.transcript.audit.sweep.ms': '50' } });
  await h.helper.auditBoot();
  const service = registry.get(AUDIT_ROUTE);
  assert.ok(service !== undefined && service.instances === 1 && service.isPrivate);
  assert.equal(service.handler, h.helper.transcriptAudit);
  assert.deepEqual(pool.log, [['RELEASE', null]], 'opened: one connection taken and returned');
  assert.ok(log.seen.includes('transcript audit store postgres ready'));
  assert.equal(h.helper.sweeping(), true);
  await h.helper.auditBoot(); // again: one registration, one sweep
  assert.equal(registry.get(AUDIT_ROUTE), service);
  await h.helper.auditShutdown();
  assert.equal(h.helper.sweeping(), false);
  assert.equal(pool.ended, true);
});

test('a store that does not answer at boot is logged and the application starts', async () => {
  const log = lines();
  const pool = new FakePool({ openError: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }) });
  const h = auditHelper({ audit: new PostgresAuditStore(pool), registry: new FunctionRegistry(), log,
    config: { ...CONFIG, 'llm.transcript.audit.sweep.ms': '0' } });
  await h.helper.auditBoot();
  assert.ok(log.seen.includes('transcript audit store postgres not answering at start - Error: connect ECONNREFUSED '
    + '127.0.0.1:5432; the sweep repairs what the outage defers'), log.seen.join('\n'));
  assert.equal(h.helper.sweeping(), false, 'sweep.ms 0 disables the sweep');
  await h.helper.auditShutdown();
});

test('a configured driver that is not installed stops the application by name', async () => {
  const log = lines();
  const missing = Object.assign(new Error("Cannot find package 'pg'"), { code: 'ERR_MODULE_NOT_FOUND' });
  const helper = createLlmHelper({
    prop: settings(CONFIG), audit: defaultAudit(settings(CONFIG), { importer: async () => { throw missing; } }),
    registry: new FunctionRegistry(), log, trace: () => {}
  });
  await assert.rejects(helper.auditBoot(), (error) => error.status === 503);
  assert.ok(log.seen.some((line) => line.startsWith('transcript audit store cannot start') && line.includes('npm install pg')),
    log.seen.join('\n'));
});

test('the boot does nothing without an audit store', async () => {
  const registry = new FunctionRegistry();
  const h = auditHelper({ config: { 'llm.transcript.store': 'memory' }, registry });
  await h.helper.auditBoot();
  assert.equal(registry.exists(AUDIT_ROUTE), false);
  assert.equal(h.helper.sweeping(), false);
});

test('health reports the audit store', async () => {
  const h = auditHelper();
  const info = await h.helper.health({ type: 'info' });
  assert.deepEqual([info.transcript_store, info.transcript_audit], ['memory', 'postgres']);
  const plain = auditHelper({ config: { 'llm.transcript.store': 'memory' } });
  assert.equal('transcript_audit' in await plain.helper.health({ type: 'info' }), false);
});

test('the failure text never quotes a row', () => {
  assert.equal(auditFailure(new DatabaseError()), 'DatabaseError sqlstate=23514');
  assert.equal(auditFailure(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })),
    'Error: connect ECONNREFUSED 127.0.0.1:5432');
  assert.equal(auditFailure(new AppException(503, 'transcript audit store not configured')),
    'AppException: transcript audit store not configured');
  assert.equal(auditFailure(new Error('x\nDETAIL: a row')), 'Error');
});

// --- the schema files --------------------------------------------------------------------------

test('the schema files are the published ones', () => {
  // the reference schema and the purge, shipped with the helper and byte-identical in the Python
  // twin: the two tables, the status values, the three indexes, the two purge statements
  const schema = readFileSync(new URL('postgres.sql', SCHEMA), 'utf8');
  for (const table of ['transcript_schema', 'transcript (', 'transcript_turn (']) {
    assert.ok(schema.includes(`CREATE TABLE IF NOT EXISTS ${table}`), table);
  }
  assert.ok(schema.includes("CHECK (status IN ('open','done','refusal','cap','expired'))"));
  assert.ok(schema.includes("CHECK (status IN ('done','tool_use','refusal','cap'))"));
  for (const index of ['transcript_correlation_id', 'transcript_started_at', 'transcript_expires_at',
    'transcript_turn_trace_id', 'transcript_turn_correlation_id', 'transcript_turn_started_at']) {
    assert.ok(schema.includes(`CREATE INDEX IF NOT EXISTS ${index} `), index);
  }
  assert.ok(schema.includes('REFERENCES transcript (conversation) ON DELETE CASCADE'));
  const purge = readFileSync(new URL('purge.sql', SCHEMA), 'utf8');
  assert.ok(purge.includes('DELETE FROM transcript WHERE expires_at < now();'));
  assert.ok(purge.includes("UPDATE transcript SET status = 'expired' WHERE status = 'open' AND updated_at < now() - interval '7 days';"));
});

// --- the live store ----------------------------------------------------------------------------

test('live postgres: the rows land on a real PostgreSQL', { skip: !LIVE_POSTGRES && 'set LLM_TRANSCRIPT_AUDIT_TEST_URL, e.g. '
  + 'postgres://mercury:...@127.0.0.1:5432/mercury?sslmode=disable' }, async () => {
  // the schema applied, a two-turn conversation written through the function (a write, a closing
  // write, the check), the section-6 questions answered, a repeated check idempotent
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: LIVE_POSTGRES, max: 2 });
  const audit = new PostgresAuditStore(pool);
  await audit.open();
  const h = auditHelper({ audit });
  let conversation;
  try {
    await pool.query(readFileSync(new URL('postgres.sql', SCHEMA), 'utf8'));
    conversation = await runWithTrace({ traceId: TRACE_ID, tracePath: TRACE_PATH, myCorrelationId: 'corr-live' }, async () => {
      const started = await firstTurn(h);
      await h.helper.transcriptAudit({}, { conversation: started, turn: 1 });
      await closingTurn(h, started, { retention: '1h' });
      return started;
    });
    await h.helper.transcriptAudit({}, { conversation, turn: 2 });
    await h.helper.transcriptAudit({}, { conversation, check: true });
    await h.helper.transcriptAudit({}, { conversation, check: true });
    assert.equal(await h.store.audited(conversation), 2);
    const { rows: [head] } = await pool.query(
      'SELECT status, turns, graph_id, node, correlation_id, input_tokens, output_tokens, cache_creation_input_tokens, '
      + 'cache_read_input_tokens, system, tools, ended_at IS NOT NULL AS ended, expires_at - started_at AS kept '
      + 'FROM transcript WHERE conversation = $1', [conversation]);
    const { rows: turns } = await pool.query(
      'SELECT turn, trace_id, status, stop_reason, request, response, calls FROM transcript_turn '
      + 'WHERE correlation_id = $1 ORDER BY turn', ['corr-live']);
    const { rows: [byTrace] } = await pool.query('SELECT count(*)::int AS n FROM transcript_turn WHERE trace_id = $1', [TRACE_ID]);
    assert.deepEqual([head.status, head.turns, head.graph_id, head.node, head.correlation_id],
      ['done', 2, 'order-assistant', 'assistant', 'corr-live']);
    assert.deepEqual([head.input_tokens, head.output_tokens, head.cache_creation_input_tokens, head.cache_read_input_tokens]
      .map(Number), [100, 21, 30, 30]);
    assert.deepEqual([head.system, head.tools, head.ended], ['Be brief.', [TOOL], true]);
    assert.equal(head.kept.days, 365);
    assert.deepEqual(turns.map((t) => [t.turn, t.trace_id, t.status, t.stop_reason]),
      [[1, TRACE_ID, 'tool_use', 'tool_use'], [2, TRACE_ID, 'done', 'end_turn']]);
    assert.deepEqual([turns[0].request, turns[0].response, turns[0].calls], [[PROMPT], TURN.content, CALLS]);
    assert.deepEqual([turns[1].request, turns[1].calls], [[RESULT_MESSAGE], null]);
    assert.equal(byTrace.n, 2);
  } finally {
    if (conversation !== undefined) {
      await pool.query('DELETE FROM transcript WHERE conversation = $1', [conversation]);
    }
    await audit.close();
  }
});
