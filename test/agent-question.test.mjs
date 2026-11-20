/**
 * The agent-question app (extensions/agent-question/agent-question.mjs).
 *
 * The shared contract file test/vectors/agent-question-vectors.json (byte-identical in mercury-python) pins the pure
 * half: the event the intake accepts or refuses, the request the automated click sends, the pages the replay and the
 * history read. The tests after the vector runs drive the app in-process as the reader of the question record the main
 * flow keeps: the intake waking the feed, the replay and the history pages and the stream over the host, the
 * transcripts browsed, a decision forwarded to a fake reply endpoint under the app's bearer and the row re-read as the
 * recorder left it, the two auth modes with the UI's configuration, the PostgreSQL reader's statements on a recording
 * fake of the pool, the boot's refusals by name, the platform hooks, and - gated on AGENT_QUESTION_TEST_URL - the
 * schemas and the rows on a live PostgreSQL.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { AppException, appConfig, EventApiServer, FunctionRegistry, isoUtc, Platform, PostOffice } from 'mercury-composable';
import * as aq from '../extensions/agent-question/agent-question.mjs';

const VECTORS_FILE = new URL('./vectors/agent-question-vectors.json', import.meta.url);
// the Python twin runs the same file: change it in both packs or in neither
const VECTORS_SHA256 = 'ec5f3490cb2993feaf40e9ac91c8fc1748d5e2c6fa1c8cd55122ad9f84d22dba';
const VECTORS = JSON.parse(readFileSync(VECTORS_FILE, 'utf8'));
const RECORD_SCHEMA = new URL('../extensions/ask-person/schema/postgres.sql', import.meta.url);
const PUBLIC = fileURLToPath(new URL('../extensions/agent-question/resources/public', import.meta.url));
const TRANSCRIPT_SCHEMA = new URL('../extensions/llm-helper/schema/postgres.sql', import.meta.url);

const ISSUER = 'https://issuer.example.test';
const AUDIENCE = 'agent-question';
const CALLS = [{ id: 'toolu_01A', name: 'issue_refund', route: 'demo.refund.issue', wait: true,
  input: { order_id: 'ORD-1002', amount: 174.0, reason: 'Shipment lost in transit' } }];
const BASE = { [aq.STORE]: 'memory', [aq.AUTH]: 'none', [aq.REPLY_TOKEN]: '', 'event.stream.keep.alive': '1s' };
const CONVERSATION_A = 'a'.repeat(32);
const CONVERSATION_B = 'b'.repeat(32);
const CONVERSATION_C = 'c'.repeat(32);

const waitEvent = ({ ticket = 't-answer', base = 'https://ask.example.test', ...overrides } = {}) => ({
  kind: 'approval', graph_id: 'order-assistant', description: 'Customer-support assistant: a refund waits for a supervisor',
  correlation_id: 'order-1002-case', turn: 2, node: 'assist', summary: "A refund waits for the supervisor's decision", calls: CALLS,
  ttl: '2d', requested_at: isoUtc(), expires_at: isoUtc(new Date(Date.now() + 2 * 86_400_000)), ticket, link: `${base}/ask/${ticket}`,
  ...overrides
});
const adviceEvent = (overrides = {}) => ({
  kind: 'advice', graph_id: 'order-assistant', description: 'Customer-support assistant', correlation_id: 'order-1002-case', turn: 2,
  node: 'decide', summary: "The supervisor's decision was received; the assistant continues",
  details: 'The assistant runs the decided call and answers the customer', ...overrides
});

/** A row as the main flow's recorder writes it, for the reader under test. */
function makeRow(event, id, seq, overrides = {}) {
  const wait = aq.WAIT_KINDS.includes(event.kind);
  const now = isoUtc();
  return {
    id, seq, kind: event.kind, graph_id: event.graph_id, correlation_id: event.correlation_id, turn: event.turn ?? null,
    ticket: wait ? (event.ticket ?? null) : null, link: wait ? (event.link ?? null) : null, description: event.description,
    summary: event.summary, details: event.details ?? null, message: { ...event }, state: wait ? 'open' : null,
    requested_at: event.requested_at || now, expires_at: wait ? (event.expires_at ?? null) : null, updated_at: now,
    answered_at: null, answered_by: null, decisions: null, outcome: null, ...overrides
  };
}
const put = (event, id, seq, overrides = {}) => aq.reader().put(makeRow(event, id, seq, overrides));

const conversation = (key, startedAt, { correlationId = 'order-1002-case', graphId = 'order-assistant', status = 'done' } = {}) => ({
  conversation: key, correlation_id: correlationId, graph_id: graphId, node: 'assist', model: 'claude-haiku-4-5', status, turns: 2,
  started_at: startedAt, updated_at: startedAt, ended_at: status === 'done' ? startedAt : null, expires_at: '2027-11-19T09:00:00.000Z',
  input_tokens: 120, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  system: 'You are a careful assistant.', tools: [{ name: 'issue_refund' }]
});
const turn = (number, status = 'done') => ({
  turn: number, trace_id: `trace-${number}`, trace_path: 'POST /api/graph/order-assistant', correlation_id: 'order-1002-case',
  started_at: '2026-11-19T09:00:00.000Z', ended_at: '2026-11-19T09:00:01.000Z', stop_reason: status === 'done' ? 'end_turn' : 'tool_use',
  status, request_id: `req-${number}`, input_tokens: 60, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  request: [{ role: 'user', content: 'refund?' }], response: [{ type: 'text', text: 'Done.' }],
  calls: status === 'done' ? null : [{ id: 'toolu_01A', name: 'issue_refund', input: {} }]
});

/** Set keys on the shared configuration, reload the settings, give the module a fresh reader, wake-ups and feed. */
function configure(values) {
  for (const [key, value] of Object.entries(values)) appConfig().set(key, value);
  aq.reset();
  const settings = aq.configure();
  return Object.assign(() => {
    for (const key of Object.keys(values)) appConfig().set(key, undefined);
    aq.reset();
  }, { settings });
}

const listen = (server) => new Promise((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolveClose) => server.close(() => resolveClose()));
const postJson = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const getJson = async (url, headers = {}) => { const response = await fetch(url, { headers }); return [response.status, await response.json()]; };

// --- the shared vectors -------------------------------------------------------------------------

test('the vector file is the one the Python twin runs', () => {
  assert.equal(createHash('sha256').update(readFileSync(VECTORS_FILE)).digest('hex'), VECTORS_SHA256);
  assert.equal(VECTORS.contract, 'agent-question');
  assert.equal(VECTORS.version, 3);
  for (const section of ['intake_cases', 'click_cases', 'feed_cases']) assert.ok(VECTORS[section].length > 0, section);
});

for (const c of VECTORS.intake_cases) {
  test(`intake: ${c.name}`, () => {
    if (c.accepted) {
      const event = aq.validateEvent(c.event);
      assert.deepEqual({ accepted: true, kind: event.kind, graph_id: event.graph_id, turn: event.turn ?? null }, c.accepted);
    } else {
      assert.throws(() => aq.validateEvent(c.event), (e) => e instanceof AppException && e.status === c.status && e.message === c.error);
    }
  });
}

for (const c of VECTORS.click_cases) {
  test(`click: ${c.name}`, () => {
    if (c.url) {
      assert.deepEqual(aq.replyRequest(c.link, c.ticket, c.decisions, c.who), [c.url, c.body]);
    } else {
      assert.throws(() => aq.replyRequest(c.link, c.ticket, c.decisions, c.who), (e) => e instanceof aq.ReplyError && e.status === c.status && e.message === c.error);
    }
  });
}

const feedRows = (specs) => specs.map((s) => ({
  id: s.id, seq: s.seq, kind: s.kind, graph_id: 'g', correlation_id: `c-${s.id}`, turn: s.kind === 'advice' ? null : 2,
  ticket: s.kind === 'advice' ? null : `t-${s.id}`, link: null, description: 'd', summary: 's', details: null, message: {}, state: s.state,
  requested_at: '2026-11-20T00:00:00.000Z', expires_at: null, updated_at: '2026-11-20T00:00:00.000Z',
  answered_at: null, answered_by: null, decisions: null, outcome: null
}));

for (const c of VECTORS.feed_cases) {
  test(`feed: ${c.name}`, async () => {
    const rows = feedRows(c.rows);
    const reader = new aq.MemoryReader();
    for (const row of rows) reader.put(row);
    for (const query of c.queries) {
      const page = 'before' in query ? aq.pageBefore(rows, query.before, query.limit) : aq.pageSince(rows, query.since, query.limit);
      const read = 'before' in query ? await reader.before(query.before, query.limit) : await reader.since(query.since, query.limit);
      assert.deepEqual({ ids: page.rows.map((r) => r.id), seqs: page.rows.map((r) => r.seq), next: page.next, more: page.more },
        { ids: query.ids, seqs: query.seqs, next: query.next, more: query.more }, JSON.stringify(query));
      assert.deepEqual(read.map((r) => r.id), query.ids, JSON.stringify(query));
    }
    assert.equal(await reader.latest(), Math.max(...c.rows.map((s) => s.seq)));
  });
}

// --- configuration ------------------------------------------------------------------------------

for (const [values, names] of [
  [{ [aq.STORE]: 'redis' }, 'question.store must be memory or postgres'],
  [{ [aq.AUTH]: 'basic' }, 'question.auth must be one of none, oauth2'],
  [{ [aq.AUTH]: 'proxy' }, 'question.auth must be one of none, oauth2'],
  [{ [aq.AUTH]: 'oauth2' }, 'set question.auth.oauth2.issuer or question.auth.oauth2.jwks-url'],
  [{ [`${aq.POSTGRES_PREFIX}port`]: 'db' }, 'question.store.postgres.port must be a port number'],
  [{ [aq.POLL]: '0' }, 'question.poll must be a duration']
]) {
  test(`the boot fails by name: ${names}`, () => {
    for (const [key, value] of Object.entries({ ...BASE, ...values })) appConfig().set(key, value);
    try {
      assert.throws(() => aq.configure(), (e) => e instanceof aq.QuestionError && e.message.includes(names));
    } finally {
      for (const key of Object.keys({ ...BASE, ...values })) appConfig().set(key, undefined);
    }
  });
}

test("the postgres settings follow the audit store's", () => {
  const clear = configure({ ...BASE, [aq.STORE]: 'postgres', [`${aq.POSTGRES_PREFIX}host`]: 'db.internal', [`${aq.POSTGRES_PREFIX}port`]: '6543',
    [`${aq.POSTGRES_PREFIX}database`]: 'agents', [`${aq.POSTGRES_PREFIX}username`]: 'reader', [`${aq.POSTGRES_PREFIX}password`]: 's3',
    [`${aq.POSTGRES_PREFIX}ssl`]: 'false', [`${aq.POSTGRES_PREFIX}timeout.ms`]: 2500, [aq.POLL]: '250ms' });
  try {
    assert.deepEqual(clear.settings.postgres, { host: 'db.internal', port: 6543, database: 'agents', user: 'reader', password: 's3', ssl: false,
      max: 4, connectionTimeoutMillis: 2500, query_timeout: 2500, statement_timeout: 2500 });
    assert.equal(clear.settings.pollMs, 250);
    assert.equal(clear.settings.replyTimeoutMs, 10_000);
    assert.equal(clear.settings.oauth2Scopes, 'openid profile email');
  } finally {
    clear();
  }
});

// --- the intake and the feed ----------------------------------------------------------------------

test('the intake accepts the event and wakes the feed', async () => {
  const clear = configure(BASE);
  const registry = new FunctionRegistry();
  registry.register(aq.INTAKE_ROUTE, aq.intake, { instances: 1 });
  const office = new PostOffice(undefined, {}, registry);
  const queue = aq.wakeups.subscribe();
  aq.feed.start(60_000); // a poll a minute away: only the wake-up can make the feed look
  try {
    put(waitEvent(), 1, 1); // the recorder wrote the row before the channel was told
    const reply = await office.request(aq.INTAKE_ROUTE, waitEvent(), { timeoutMs: 5000 });
    assert.equal(reply.getStatus(), 200, String(reply.body));
    assert.deepEqual(reply.body, { accepted: true, kind: 'approval', graph_id: 'order-assistant', turn: 2 });
    const woken = await aq.Wakeups.next(queue, 2000);
    assert.equal(woken?.id, 1, "the intake's wake-up made the feed look at once");
    assert.equal(aq.feed.cursor, 1);
    const bad = await office.request(aq.INTAKE_ROUTE, { kind: 'notice' }, { timeoutMs: 5000 });
    assert.equal(bad.getStatus(), 400);
    assert.ok(String(bad.body).includes('kind must be one of'));
    const advice = await office.request(aq.INTAKE_ROUTE, adviceEvent(), { timeoutMs: 5000 });
    assert.deepEqual(advice.body, { accepted: true, kind: 'advice', graph_id: 'order-assistant', turn: 2 });
    put(adviceEvent(), 2, 2);
    assert.deepEqual((await aq.feed.pollOnce()).map((r) => r.id), [2]);
    assert.equal((await aq.Wakeups.next(queue, 2000))?.kind, 'advice');
  } finally {
    await aq.feed.stop();
    aq.wakeups.unsubscribe(queue);
    await registry.bus.close();
    clear();
  }
});

// --- the person's side over the host -------------------------------------------------------------

/**
 * The main flow's reply endpoint as the app sees it: scripted by ticket, recording every click, letting a test play
 * the recorder behind it (onPost) before the outcome goes back; and the issuer's JWKS document.
 */
class FakeReply {
  constructor() {
    this.posts = [];
    this.onPost = null;
    this.jwks = { keys: [] };
    this.server = http.createServer((req, res) => {
      const send = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (req.method === 'GET' && req.url === '/jwks') return send(200, this.jwks);
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        this.posts.push({ body, authorization: req.headers.authorization ?? null });
        if (this.onPost) await this.onPost(body);
        if (body.ticket === 't-expired') return send(410, { type: 'nothing-waiting', run: 'fresh' });
        if (body.ticket === 't-refused') return send(200, { type: 'approval', turn: 2, error: 'not a call waiting for approval', calls: CALLS });
        return send(200, { type: 'answer', turn: 3, run: 'resume', message: 'Your refund has been issued.' });
      });
    });
  }
}

let reply;
let replyUrl;
let hostServer;
let host;

before(async () => {
  reply = new FakeReply();
  replyUrl = await listen(reply.server);
  hostServer = new EventApiServer(new FunctionRegistry()).createServer([aq.mount]);
  host = await listen(hostServer);
});

after(async () => {
  await close(hostServer);
  await close(reply.server);
});

function sevenRows() {
  const specs = [[1, 3, 'approval', 'answered'], [2, 2, 'advice', null], [3, 5, 'question', 'open'], [4, 4, 'approval', 'expired'],
    [5, 7, 'approval', 'open'], [6, 6, 'advice', null], [7, 1, 'approval', 'answered']];
  for (const [id, seq, kind, state] of specs) {
    const event = kind === 'advice' ? adviceEvent({ correlation_id: `case-${id}` }) : waitEvent({ ticket: `t-${id}`, correlation_id: `case-${id}`, kind });
    put(event, id, seq, { state });
  }
}

test('the replay and the history page the record', async () => {
  const clear = configure(BASE);
  try {
    sevenRows();
    let [status, page] = await getJson(`${host}/questions?since=0`);
    assert.equal(status, 200);
    assert.deepEqual(page.rows.map((r) => r.id), [7, 2, 1, 4, 3, 6, 5]);
    assert.equal(page.next, 7);
    assert.equal(page.more, false);
    assert.deepEqual(page.rows[2].calls, CALLS);
    assert.equal(page.rows[2].ticket, 't-1');
    assert.equal(page.rows[1].state, null);
    [status, page] = await getJson(`${host}/questions?since=5&limit=1`);
    assert.deepEqual(page.rows.map((r) => r.id), [6]);
    assert.equal(page.next, 6);
    assert.equal(page.more, true);
    [status, page] = await getJson(`${host}/questions?before=&limit=3`);
    assert.equal(status, 200);
    assert.deepEqual(page.rows.map((r) => r.id), [5, 6, 3]);
    assert.equal(page.next, 5);
    assert.equal(page.more, true);
    assert.equal(page.before, null);
    [status, page] = await getJson(`${host}/questions?before=5&limit=3`);
    assert.deepEqual(page.rows.map((r) => r.id), [4, 1, 2]);
    assert.equal(page.next, 2);
    assert.equal(page.more, true);
    [status, page] = await getJson(`${host}/questions?before=2&limit=3`);
    assert.deepEqual(page.rows.map((r) => r.id), [7]);
    assert.equal(page.next, 1);
    assert.equal(page.more, false);
    assert.equal((await getJson(`${host}/questions?since=x`))[0], 400);
    assert.equal((await getJson(`${host}/questions?before=x`))[0], 400);
  } finally {
    clear();
  }
});

/** Read SSE frames from a fetch body: each frame is the lines before a blank line. */
function frames(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async () => {
    for (;;) {
      const at = buffer.indexOf('\n\n');
      if (at >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        return frame.split('\n');
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  };
}

test('the stream replays, then follows the feed with keep-alives', async () => {
  const clear = configure(BASE);
  const controller = new AbortController();
  try {
    put(waitEvent(), 1, 1);
    const response = await fetch(`${host}/questions/events`, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const next = frames(response);
    const replayed = await next();
    assert.equal(replayed[0], 'id: 1');
    assert.equal(replayed[1], 'event: question');
    assert.equal(JSON.parse(replayed[2].slice('data: '.length)).ticket, 't-answer');
    const ping = await next();
    assert.deepEqual(ping, [': ping'], 'a keep-alive while nothing changes');
    put(adviceEvent(), 2, 2);
    await aq.feed.pollOnce();
    const live = await next();
    assert.equal(live[0], 'id: 2');
    assert.equal(JSON.parse(live[2].slice('data: '.length)).kind, 'advice');
    controller.abort();
    const resumed = await fetch(`${host}/questions/events`, { headers: { 'last-event-id': '1' }, signal: AbortSignal.timeout(3000) });
    const first = await frames(resumed)();
    assert.equal(first[0], 'id: 2', 'the reconnect resumes after the cursor the browser kept');
  } finally {
    controller.abort();
    clear();
  }
});

test('the UI configuration names the sign-in', async () => {
  const clear = configure(BASE);
  try {
    assert.deepEqual(await getJson(`${host}/questions/config`), [200, { auth: 'none', title: 'Agent questions' }]);
    for (const [key, value] of Object.entries({ [aq.AUTH]: 'oauth2', [aq.OAUTH2_ISSUER]: ISSUER, [aq.OAUTH2_AUDIENCE]: AUDIENCE,
      [aq.OAUTH2_CLIENT_ID]: 'agent-question-ui', [aq.PAGE_TITLE]: 'Decisions' })) appConfig().set(key, value);
    aq.configure();
    assert.deepEqual(await getJson(`${host}/questions/config`), [200, {
      auth: 'oauth2', title: 'Decisions', oauth2: { issuer: ISSUER, client_id: 'agent-question-ui', scopes: 'openid profile email', audience: AUDIENCE }
    }]);
    for (const key of [aq.OAUTH2_ISSUER, aq.OAUTH2_AUDIENCE, aq.OAUTH2_CLIENT_ID, aq.PAGE_TITLE]) appConfig().set(key, undefined);
  } finally {
    clear();
  }
});

test('a decision is forwarded and the row is re-read as the recorder left it', async () => {
  const clear = configure({ ...BASE, [aq.REPLY_TOKEN]: 'channel-app-bearer' });
  try {
    reply.posts.length = 0;
    const row = put(waitEvent({ ticket: 't-answer', base: replyUrl }), 1, 1);
    const queue = aq.wakeups.subscribe();
    const decisions = [{ id: 'toolu_01A', approved: true, note: 'Carrier confirmed the loss' }];
    // the recorder behind the reply endpoint writes the answer before the outcome goes back
    reply.onPost = async (body) => {
      put(waitEvent({ ticket: body.ticket, base: replyUrl }), 1, 2, { state: 'answered', answered_by: body.decided_by, answered_at: isoUtc(),
        decisions: body.decisions, outcome: { status: 200, body: { type: 'answer' } } });
    };
    let response = await postJson(`${host}/questions/${row.id}/decide`, { decisions, decided_by: 'operator-17' });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.row.state, 'answered');
    assert.equal(result.row.answered_by, 'operator-17');
    assert.equal(result.outcome.status, 200);
    assert.equal(result.outcome.body.type, 'answer');
    assert.deepEqual(reply.posts[0].body, { ticket: 't-answer', decisions, decided_by: 'operator-17' });
    assert.equal(reply.posts[0].authorization, 'Bearer channel-app-bearer');
    // the feed was told to look: the change reaches every device
    assert.deepEqual((await aq.feed.pollOnce()).map((r) => r.id), [1]);
    assert.equal(queue.items[0].id, row.id);
    assert.equal(queue.items[0].state, 'answered');
    response = await postJson(`${host}/questions/${row.id}/decide`, { decisions });
    assert.equal(response.status, 409);
    assert.ok((await response.json()).message.includes('operator-17'));
    // a recorder that did not write (or a wait decided elsewhere): the row is reported as it stands
    reply.onPost = null;
    const expired = put(waitEvent({ ticket: 't-expired', base: replyUrl, correlation_id: 'case-2' }), 2, 3);
    response = await postJson(`${host}/questions/${expired.id}/decide`, { decisions });
    let body = await response.json();
    assert.equal(body.row.state, 'open');
    assert.equal(body.outcome.status, 410);
    const refused = put(waitEvent({ ticket: 't-refused', base: replyUrl, correlation_id: 'case-3' }), 3, 4);
    response = await postJson(`${host}/questions/${refused.id}/decide`, { decisions });
    body = await response.json();
    assert.equal(body.row.state, 'open');
    assert.ok(body.outcome.body.error.startsWith('not a call'));
    const silent = put(waitEvent({ ticket: 't-silent', base: 'http://127.0.0.1:9', correlation_id: 'case-4' }), 4, 5);
    appConfig().set(aq.REPLY_TIMEOUT, '2s');
    aq.configure();
    response = await postJson(`${host}/questions/${silent.id}/decide`, { decisions });
    body = await response.json();
    assert.equal(body.row.state, 'open');
    assert.equal(body.outcome.status, 502);
    appConfig().set(aq.REPLY_TIMEOUT, undefined);
    response = await fetch(`${host}/questions/${row.id}/decide`, { method: 'POST', body: 'nope' });
    assert.equal(response.status, 400);
    response = await postJson(`${host}/questions/${row.id}/decide`, { decisions: [] });
    assert.equal(response.status, 400);
    response = await postJson(`${host}/questions/999/decide`, { decisions });
    assert.equal(response.status, 404);
    const advice = put(adviceEvent(), 5, 6);
    response = await postJson(`${host}/questions/${advice.id}/decide`, { decisions });
    assert.equal(response.status, 409);
    response = await fetch(`${host}/questions/${advice.id}/seen`, { method: 'POST' });
    assert.equal(response.status, 404, 'the seen endpoint is gone with the state');
    aq.wakeups.unsubscribe(queue);
  } finally {
    reply.onPost = null;
    clear();
  }
});

test('the transcripts are browsed from the audit store', async () => {
  const clear = configure(BASE);
  try {
    const reader = aq.reader();
    reader.putConversation(conversation(CONVERSATION_A, '2026-11-19T09:00:00.000Z'), [turn(1, 'tool_use'), turn(2)]);
    reader.putConversation(conversation(CONVERSATION_B, '2026-11-19T10:00:00.000Z', { correlationId: 'release-42', graphId: 'plan-assistant', status: 'open' }), [turn(1, 'tool_use')]);
    reader.putConversation(conversation(CONVERSATION_C, '2026-11-19T11:00:00.000Z'), [turn(1)]);
    let [status, page] = await getJson(`${host}/transcripts`);
    assert.equal(status, 200);
    assert.deepEqual(page.conversations.map((c) => c.conversation), [CONVERSATION_C, CONVERSATION_B, CONVERSATION_A]);
    assert.equal(page.next, '2026-11-19T09:00:00.000Z');
    assert.equal(page.more, false);
    assert.ok(!('system' in page.conversations[0]) && !('tools' in page.conversations[0]), 'the list is light');
    [status, page] = await getJson(`${host}/transcripts?before=2026-11-19T11:00:00Z&limit=1`);
    assert.deepEqual(page.conversations.map((c) => c.conversation), [CONVERSATION_B]);
    assert.equal(page.next, '2026-11-19T10:00:00.000Z');
    assert.equal(page.more, true);
    [status, page] = await getJson(`${host}/transcripts?correlation_id=order-1002-case`);
    assert.deepEqual(page.conversations.map((c) => c.conversation), [CONVERSATION_C, CONVERSATION_A]);
    [status, page] = await getJson(`${host}/transcripts?graph_id=plan-assistant`);
    assert.deepEqual(page.conversations.map((c) => c.conversation), [CONVERSATION_B]);
    const [one, found] = await getJson(`${host}/transcripts/${CONVERSATION_A}`);
    assert.equal(one, 200);
    assert.equal(found.conversation.system, 'You are a careful assistant.');
    assert.deepEqual(found.turns.map((t) => t.turn), [1, 2]);
    assert.equal(found.turns[0].calls[0].name, 'issue_refund');
    assert.equal((await getJson(`${host}/transcripts/${'f'.repeat(32)}`))[0], 404);
    assert.equal((await getJson(`${host}/transcripts/not-a-conversation`))[0], 400);
    assert.equal((await getJson(`${host}/transcripts?before=yesterday`))[0], 400);
    assert.equal((await getJson(`${host}/transcripts?limit=x`))[0], 400);
  } finally {
    clear();
  }
});

test('the oauth2 mode guards every read and the click', async () => {
  const jose = await import('jose');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  reply.jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] };
  const clear = configure({ ...BASE, [aq.AUTH]: 'oauth2', [aq.OAUTH2_ISSUER]: ISSUER, [aq.OAUTH2_AUDIENCE]: AUDIENCE,
    [aq.OAUTH2_JWKS_URL]: `${replyUrl}/jwks`, [aq.OAUTH2_CLIENT_ID]: 'agent-question-ui' });
  try {
    reply.posts.length = 0;
    const token = await new jose.SignJWT({ sub: 'u-17', preferred_username: 'operator-17' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const row = put(waitEvent({ base: replyUrl }), 1, 1);
    const decisions = [{ id: 'toolu_01A', approved: false }];
    for (const path of ['/questions?since=0', '/questions/events', '/transcripts', `/transcripts/${CONVERSATION_A}`]) {
      const response = await fetch(`${host}${path}`);
      assert.equal(response.status, 401, path);
    }
    let [status, config] = await getJson(`${host}/questions/config`);
    assert.equal(status, 200);
    assert.equal(config.oauth2.client_id, 'agent-question-ui');
    let response = await postJson(`${host}/questions/${row.id}/decide`, { decisions });
    assert.equal(response.status, 401);
    const bearer = { authorization: `Bearer ${token}` };
    [status, config] = await getJson(`${host}/questions?since=0`, bearer);
    assert.equal(status, 200);
    assert.deepEqual(config.rows.map((r) => r.id), [1]);
    assert.equal((await getJson(`${host}/transcripts`, bearer))[0], 200);
    response = await postJson(`${host}/questions/${row.id}/decide`, { decisions, decided_by: 'spoof' }, bearer);
    assert.equal(response.status, 200);
    assert.equal(reply.posts[0].body.decided_by, 'operator-17', "the token's name, never the body's");
  } finally {
    clear();
  }
});

// --- the PostgreSQL reader on a recording fake of the pool -------------------------------------------

const record = (overrides = {}) => {
  const now = new Date('2026-11-19T09:12:05.123Z');
  return {
    id: '7', seq: '12', ticket: 't-answer', graph_id: 'order-assistant', correlation_id: 'order-1002-case', turn: 2, kind: 'approval',
    description: 'Customer-support assistant', summary: 'A refund waits', details: null, message: { kind: 'approval', calls: CALLS },
    link: 'https://ask.example.test/ask/t-answer', state: 'open', requested_at: now, expires_at: new Date(now.getTime() + 2 * 86_400_000),
    updated_at: now, answered_at: null, answered_by: null, decisions: null, outcome: null, ...overrides
  };
};

const conversationRecord = (light = true) => {
  const started = new Date('2026-11-19T09:00:00.000Z');
  const values = { conversation: CONVERSATION_A, correlation_id: 'order-1002-case', graph_id: 'order-assistant', node: 'assist',
    model: 'claude-haiku-4-5', status: 'done', turns: 2, started_at: started, updated_at: started, ended_at: started,
    expires_at: new Date(started.getTime() + 365 * 86_400_000), input_tokens: '120', output_tokens: '40', cache_creation_input_tokens: '0',
    cache_read_input_tokens: '0' };
  return light ? values : { ...values, system: 'You are a careful assistant.', tools: [{ name: 'issue_refund' }] };
};

const turnRecord = () => ({
  turn: 1, trace_id: 'trace-1', trace_path: 'POST /api/graph/order-assistant', correlation_id: 'order-1002-case',
  started_at: new Date('2026-11-19T09:00:00.000Z'), ended_at: new Date('2026-11-19T09:00:01.000Z'), stop_reason: 'tool_use', status: 'tool_use',
  request_id: 'req-1', input_tokens: 60, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  request: [{ role: 'user', content: 'refund?' }], response: [{ type: 'tool_use', id: 'toolu_01A', name: 'issue_refund', input: {} }],
  calls: '[{"id":"toolu_01A","name":"issue_refund","input":{}}]'
});

class FakePool {
  constructor(rows = []) {
    this.rows = rows;
    this.queue = []; // answers for the next queries, when a test scripts them
    this.log = [];
    this.connected = false;
    this.ended = false;
  }

  async connect() {
    this.connected = true;
    return { release: () => {} };
  }

  async query(sql, params) {
    this.log.push([sql, params]);
    return { rows: this.queue.length > 0 ? this.queue.shift() : this.rows };
  }

  async end() {
    this.ended = true;
  }
}

test('the postgres reader runs the statements and maps the records', async () => {
  const pool = new FakePool([record()]);
  const reader = new aq.PostgresReader(pool);
  await reader.open();
  assert.ok(pool.connected);
  const row = await reader.get(7);
  assert.deepEqual(pool.log.at(-1), [aq.SQL_GET, [7]]);
  assert.equal(row.id, 7);
  assert.equal(row.seq, 12);
  assert.equal(row.requested_at, '2026-11-19T09:12:05.123Z');
  assert.equal(row.expires_at, '2026-11-21T09:12:05.123Z');
  assert.deepEqual(aq.publicRow(row).calls, CALLS);
  await reader.since(3, 50);
  assert.deepEqual(pool.log.at(-1), [aq.SQL_SINCE, [3, 50]]);
  await reader.before(null, 20);
  assert.deepEqual(pool.log.at(-1), [aq.SQL_BEFORE, [null, 20]]);
  await reader.before(9, 20);
  assert.deepEqual(pool.log.at(-1), [aq.SQL_BEFORE, [9, 20]]);
  pool.queue = [[{ latest: '42' }]];
  assert.equal(await reader.latest(), 42);
  assert.deepEqual(pool.log.at(-1), [aq.SQL_LATEST, []]);
  pool.queue = [[]];
  assert.equal(await reader.latest(), 0);
  pool.queue = [[{ label: 'open', count: '3' }, { label: 'advice', count: '1' }]];
  assert.deepEqual(await reader.counts(), { open: 3, advice: 1 });
  pool.queue = [[conversationRecord()]];
  const shown = await reader.conversations('2026-11-19T12:00:00.000Z', 20, 'order-1002-case', null);
  assert.deepEqual(pool.log.at(-1), [aq.SQL_CONVERSATIONS, ['2026-11-19T12:00:00.000Z', 'order-1002-case', null, 20]]);
  assert.equal(shown[0].conversation, CONVERSATION_A);
  assert.equal(shown[0].started_at, '2026-11-19T09:00:00.000Z');
  assert.equal(shown[0].turns, 2);
  assert.equal(shown[0].input_tokens, 120);
  assert.ok(!('system' in shown[0]));
  pool.queue = [[conversationRecord(false)], [turnRecord()]];
  const one = await reader.conversation(CONVERSATION_A);
  assert.deepEqual(pool.log.slice(-2).map((entry) => entry[0]), [aq.SQL_CONVERSATION, aq.SQL_TURNS]);
  assert.equal(one.conversation.system, 'You are a careful assistant.');
  assert.deepEqual(one.conversation.tools, [{ name: 'issue_refund' }]);
  assert.equal(one.turns[0].turn, 1);
  assert.equal(one.turns[0].status, 'tool_use');
  assert.deepEqual(one.turns[0].calls, [{ id: 'toolu_01A', name: 'issue_refund', input: {} }], 'json text is parsed');
  assert.equal(one.turns[0].ended_at, '2026-11-19T09:00:01.000Z');
  pool.queue = [[]];
  assert.equal(await reader.conversation(CONVERSATION_B), null);
  await reader.close();
  assert.ok(pool.ended);
});

test("a record's JSON may arrive as text and an advice has no state", () => {
  const row = aq.rowFromRecord(record({ message: '{"kind":"advice"}', decisions: '[]', outcome: '{"status":410}', kind: 'advice', ticket: null, link: null, turn: null, expires_at: null, state: null }));
  assert.deepEqual(row.message, { kind: 'advice' });
  assert.deepEqual(row.decisions, []);
  assert.deepEqual(row.outcome, { status: 410 });
  assert.equal(row.turn, null);
  assert.equal(row.expires_at, null);
  assert.equal(row.state, null);
  assert.equal(row.id, 7);
  assert.equal(aq.failure(new RangeError('quotes a row')), 'RangeError');
});

test('a configured driver that is not installed stops the boot by name', async () => {
  const clear = configure({ ...BASE, [aq.STORE]: 'postgres' });
  try {
    await assert.rejects(aq.postgresReader(clear.settings, async () => { throw Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' }); }),
      (e) => e instanceof aq.QuestionError && e.message === aq.MISSING_POSTGRES);
    const built = [];
    const fakePg = { Pool: class { constructor(options) { built.push(options); } on() {} } };
    const reader = await aq.postgresReader(clear.settings, async () => fakePg);
    assert.equal(reader.name, 'postgres');
    assert.equal(built[0].database, 'mercury');
  } finally {
    clear();
  }
});

// --- the platform hooks and the boot -------------------------------------------------------------------

test('the platform hooks mount the routes and run the boot, and the host serves the committed UI bundle at the root', async () => {
  // the React UI is built in extensions/agent-question-ui and its bundle committed in resources/public next to the
  // application file; the host's static content service serves it at the root - the app generates no page
  const clear = configure({ ...BASE, 'static.html.folder': `file:${PUBLIC}` });
  const fresh = new Platform(new FunctionRegistry());
  aq.attach(fresh);
  let server;
  try {
    server = await fresh.run({ port: 0 });
    assert.equal(aq.reader().name, 'memory');
    assert.ok(aq.feedRunning(), 'the boot started the feed');
    assert.equal(aq.feed.cursor, 0);
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [path, expected] of [['/', 200], ['/favicon.svg', 200], ['/questions/config', 200], ['/questions?since=0', 200], ['/transcripts', 200],
      [`/transcripts/${CONVERSATION_A}`, 404], ['/transcripts/nope', 400], ['/questions/app', 404], ['/nothing', 404]]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, expected, path);
    }
    // the engines' actuator endpoints stay at their paths beside the bundle - Kubernetes probes and operations depend on them
    for (const path of ['/info', '/info/routes', '/health', '/env']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200, path);
      assert.ok(response.headers.get('content-type').startsWith('application/json'), path);
      await response.json();
    }
    const probe = await fetch(`${base}/livenessprobe`);
    assert.equal(probe.status, 200);
    assert.equal(await probe.text(), 'OK');
    const home = await fetch(`${base}/`);
    assert.ok(home.headers.get('content-type').startsWith('text/html'), home.headers.get('content-type'));
    const index = await home.text();
    assert.ok(index.includes('<div id="root">') && index.includes('href="/favicon.svg"'), 'the bundle\'s index.html');
    const scripts = [...index.matchAll(/src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
    const styles = [...index.matchAll(/href="(\/assets\/[^"]+\.css)"/g)].map((m) => m[1]);
    assert.equal(scripts.length, 1); assert.equal(styles.length, 1);
    assert.ok((await fetch(`${base}${scripts[0]}`)).headers.get('content-type').startsWith('text/javascript'));
    assert.ok((await fetch(`${base}${styles[0]}`)).headers.get('content-type').startsWith('text/css'));
    const info = await aq.questionHealth({ type: 'info' });
    assert.equal(info.service, 'agent.question.inbox');
    assert.equal(info.store, 'memory');
    assert.equal(info.feed, 0);
    assert.deepEqual(info.rows, {});
    assert.equal(await aq.questionHealth({}), 'agent.question.inbox is running fine');
  } finally {
    if (server) await close(server);
    await fresh.shutdown();
    assert.equal(aq.feedRunning(), false, 'the cleanup stops the feed');
    clear();
  }
});

// --- a live PostgreSQL -----------------------------------------------------------------------------------

const LIVE = process.env.AGENT_QUESTION_TEST_URL;
test('the reader finds the rows on a live postgres', { skip: !LIVE && 'set AGENT_QUESTION_TEST_URL, e.g. postgres://mercury:...@127.0.0.1:5432/mercury?sslmode=disable' }, async () => {
  const pg = await import('pg');
  const Pool = pg.Pool ?? pg.default?.Pool;
  const pool = new Pool({ connectionString: LIVE, max: 2 });
  const reader = new aq.PostgresReader(pool);
  await reader.open();
  try {
    await pool.query(readFileSync(RECORD_SCHEMA, 'utf8'));
    await pool.query(readFileSync(TRANSCRIPT_SCHEMA, 'utf8'));
    const cid = `live-${Date.now()}`;
    const event = waitEvent({ ticket: `${cid}-1`, correlation_id: cid });
    const inserted = await pool.query(
      "INSERT INTO question (seq, ticket, graph_id, correlation_id, turn, kind, description, summary, message, link, state, requested_at, expires_at, updated_at) "
      + "VALUES (nextval('question_seq'), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'open', $10::timestamptz, $11::timestamptz, $12::timestamptz) RETURNING id, seq",
      [event.ticket, event.graph_id, cid, 2, 'approval', event.description, event.summary, JSON.stringify(event), event.link, event.requested_at, event.expires_at, isoUtc()]);
    const conv = Date.now().toString(16).padStart(32, '0').slice(-32);
    await pool.query(
      'INSERT INTO transcript (conversation, correlation_id, graph_id, node, model, status, turns, started_at, updated_at, ended_at, expires_at, system, tools) '
      + "VALUES ($1, $2, $3, $4, $5, 'done', 1, $6::timestamptz, $6::timestamptz, $6::timestamptz, $6::timestamptz, $7, $8::jsonb) ON CONFLICT DO NOTHING",
      [conv, cid, 'order-assistant', 'assist', 'claude-haiku-4-5', isoUtc(), 'sys', '[]']);
    await pool.query(
      'INSERT INTO transcript_turn (conversation, turn, trace_id, trace_path, correlation_id, started_at, ended_at, stop_reason, status, request_id, '
      + "input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, request, response, calls) VALUES ($1, 1, $2, $3, $4, $5::timestamptz, "
      + "$5::timestamptz, 'end_turn', 'done', $6, 1, 1, 0, 0, $7::jsonb, $8::jsonb, NULL) ON CONFLICT DO NOTHING",
      [conv, 'trace-live', 'POST /api/graph/order-assistant', cid, isoUtc(), 'req-live', '[{"role":"user","content":"hi"}]', '[{"type":"text","text":"hello"}]']);
    const rowId = Number(inserted.rows[0].id);
    const seq = Number(inserted.rows[0].seq);
    const found = await reader.get(rowId);
    assert.equal(found.ticket, `${cid}-1`);
    assert.equal(found.state, 'open');
    assert.ok((await reader.since(seq - 1, 10)).some((r) => r.id === rowId));
    assert.ok((await reader.before(null, 5))[0].seq >= seq);
    assert.ok(await reader.latest() >= seq);
    assert.ok(((await reader.counts()).open ?? 0) >= 1);
    assert.deepEqual((await reader.conversations(null, 10, cid, null)).map((c) => c.conversation), [conv]);
    const one = await reader.conversation(conv);
    assert.equal(one.conversation.system, 'sys');
    assert.equal(one.turns[0].turn, 1);
  } finally {
    await reader.close();
  }
});
