/**
 * The agent-question app (extensions/agent-question/agent-question.mjs).
 *
 * The shared contract file test/vectors/agent-question-vectors.json (byte-identical in mercury-python) pins the pure
 * half: the row a message event becomes, the state an outcome leaves, the request the automated click sends, and the
 * reference inbox on a scripted sequence. The tests after the vector runs drive the app in-process: the intake on the
 * bus (a wait upserted, an advice appended, every connected device told), the replay and the stream over the host, a
 * decision forwarded to a fake reply endpoint under the app's bearer with the outcome recorded and broadcast, an advice
 * marked seen, open waits expiring, the proxy mode, the PostgreSQL inbox's statements on a recording fake of the pool,
 * the boot's refusals by name, the platform hooks, and - gated on AGENT_QUESTION_TEST_URL - the schema and the rows on
 * a live PostgreSQL.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { AppException, appConfig, EventApiServer, FunctionRegistry, isoUtc, Platform, PostOffice } from 'mercury-composable';
import * as aq from '../extensions/agent-question/agent-question.mjs';

const VECTORS_FILE = new URL('./vectors/agent-question-vectors.json', import.meta.url);
// the Python twin runs the same file: change it in both packs or in neither
const VECTORS_SHA256 = '4ccf076692bbc87b656cefd874f4474a5141fb8c7882f2833267c1c6ddb93844';
const VECTORS = JSON.parse(readFileSync(VECTORS_FILE, 'utf8'));
const SCHEMA = new URL('../extensions/agent-question/schema/postgres.sql', import.meta.url);

const CALLS = [{ id: 'toolu_01A', name: 'issue_refund', route: 'demo.refund.issue', wait: true,
  input: { order_id: 'ORD-1002', amount: 174.0, reason: 'Shipment lost in transit' } }];
const BASE = { [aq.INBOX]: 'memory', [aq.AUTH]: 'none', [aq.REPLY_TOKEN]: '', 'event.stream.keep.alive': '1s' };

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

/** Set keys on the shared configuration, reload the settings, give the module a fresh inbox and wake-ups. */
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
const take = async (event) => {
  const row = await aq.inbox().take(aq.validateEvent(event), isoUtc());
  aq.wakeups.publish([row]);
  return row;
};
const postJson = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// --- the shared vectors -------------------------------------------------------------------------

test('the vector file is the one the Python twin runs', () => {
  assert.equal(createHash('sha256').update(readFileSync(VECTORS_FILE)).digest('hex'), VECTORS_SHA256);
  assert.equal(VECTORS.contract, 'agent-question');
  assert.equal(VECTORS.version, 2);
});

for (const c of VECTORS.row_cases) {
  test(`row: ${c.name}`, () => {
    if (c.row) {
      const event = aq.validateEvent(c.event);
      assert.deepEqual(aq.waitKey(event), c.key);
      assert.deepEqual(aq.rowFields(event, c.now), c.row);
    } else {
      assert.throws(() => aq.validateEvent(c.event), (e) => e instanceof AppException && e.status === c.status && e.message === c.error);
    }
  });
}

for (const c of VECTORS.outcome_cases) {
  test(`outcome: ${c.name}`, () => assert.equal(aq.stateAfter(c.status, c.body), c.state));
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

for (const c of VECTORS.transition_cases) {
  test(`transitions: ${c.name}`, async () => {
    const box = new aq.MemoryInbox();
    const results = [];
    for (const step of c.steps) {
      if (step.op === 'take') {
        const row = await box.take(aq.validateEvent(step.event), step.now);
        results.push({ id: row.id, seq: row.seq, state: row.state, ticket: row.ticket });
      } else if (step.op === 'decided') {
        const state = aq.stateAfter(step.status, step.body);
        const row = await box.decided(step.id, step.decisions, step.who, state, { status: step.status, body: step.body }, step.now);
        results.push({ id: row.id, seq: row.seq, state: row.state, answered_by: row.answered_by });
      } else if (step.op === 'seen') {
        const row = await box.seen(step.id, step.now);
        results.push({ id: row.id, seq: row.seq, state: row.state });
      } else if (step.op === 'expire') {
        const changed = await box.expire(step.now);
        results.push({ expired: changed.map((r) => ({ id: r.id, seq: r.seq })) });
      } else if (step.op === 'since') {
        const rows = await box.since(step.seq, step.limit);
        results.push({ ids: rows.map((r) => r.id), seqs: rows.map((r) => r.seq) });
      }
    }
    assert.deepEqual(results, c.results);
    const final = (await box.since(0, 100)).sort((a, b) => a.id - b.id).map((r) => ({
      id: r.id, seq: r.seq, kind: r.kind, state: r.state, ticket: r.ticket, turn: r.turn, requested_at: r.requested_at,
      expires_at: r.expires_at, updated_at: r.updated_at, answered_by: r.answered_by, outcome: r.outcome
    }));
    assert.deepEqual(final, c.final);
  });
}

// --- configuration ------------------------------------------------------------------------------

for (const [values, names] of [
  [{ [aq.INBOX]: 'redis' }, 'question.inbox must be memory or postgres'],
  [{ [aq.AUTH]: 'basic' }, 'question.auth must be one of none, proxy, oauth2'],
  [{ [aq.AUTH]: 'proxy', [aq.AUTH_HEADER]: '' }, 'question.auth.header names the header'],
  [{ [aq.AUTH]: 'oauth2' }, 'set question.auth.oauth2.issuer or question.auth.oauth2.jwks-url'],
  [{ [`${aq.POSTGRES_PREFIX}port`]: 'db' }, 'question.inbox.postgres.port must be a port number'],
  [{ [aq.SWEEP]: '0' }, 'question.sweep must be a duration']
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
  const clear = configure({ ...BASE, [aq.INBOX]: 'postgres', [`${aq.POSTGRES_PREFIX}host`]: 'db.internal', [`${aq.POSTGRES_PREFIX}port`]: '6543',
    [`${aq.POSTGRES_PREFIX}database`]: 'agents', [`${aq.POSTGRES_PREFIX}username`]: 'inbox', [`${aq.POSTGRES_PREFIX}password`]: 's3',
    [`${aq.POSTGRES_PREFIX}ssl`]: 'false', [`${aq.POSTGRES_PREFIX}timeout.ms`]: 2500 });
  try {
    assert.deepEqual(clear.settings.postgres, { host: 'db.internal', port: 6543, database: 'agents', user: 'inbox', password: 's3', ssl: false,
      max: 4, connectionTimeoutMillis: 2500, query_timeout: 2500, statement_timeout: 2500 });
    assert.equal(clear.settings.sweepMs, 30_000);
    assert.equal(clear.settings.replyTimeoutMs, 10_000);
  } finally {
    clear();
  }
});

// --- the intake on the bus ----------------------------------------------------------------------

test('the intake upserts a wait, appends an advice and wakes the devices', async () => {
  const clear = configure(BASE);
  const registry = new FunctionRegistry();
  registry.register(aq.INTAKE_ROUTE, aq.intake, { instances: 1 });
  const office = new PostOffice(undefined, {}, registry);
  const queue = aq.wakeups.subscribe();
  try {
    const first = await office.request(aq.INTAKE_ROUTE, waitEvent(), { timeoutMs: 5000 });
    assert.equal(first.getStatus(), 200, String(first.body));
    assert.deepEqual(first.body, { stored: true, id: 1, seq: 1, state: 'open' });
    const again = await office.request(aq.INTAKE_ROUTE, waitEvent({ ticket: 't-second' }), { timeoutMs: 5000 });
    assert.deepEqual(again.body, { stored: true, id: 1, seq: 2, state: 'open' }, 'the same turn upserts the same row');
    const advice = await office.request(aq.INTAKE_ROUTE, adviceEvent(), { timeoutMs: 5000 });
    assert.deepEqual(advice.body, { stored: true, id: 2, seq: 3, state: 'open' });
    const bad = await office.request(aq.INTAKE_ROUTE, { kind: 'notice' }, { timeoutMs: 5000 });
    assert.equal(bad.getStatus(), 400);
    assert.ok(String(bad.body).includes('kind must be one of'));
    const rows = await aq.inbox().since(0, 10);
    assert.deepEqual(rows.map((r) => [r.id, r.seq, r.kind, r.ticket]), [[1, 2, 'approval', 't-second'], [2, 3, 'advice', null]]);
    assert.deepEqual(queue.items.map((r) => r.seq), [1, 2, 3], 'every change reaches a connected device');
  } finally {
    aq.wakeups.unsubscribe(queue);
    await registry.bus.close();
    clear();
  }
});

// --- the person's side over the host -------------------------------------------------------------

/** The main flow's reply endpoint as the app sees it: scripted by ticket, recording every click. */
class FakeReply {
  constructor() {
    this.posts = [];
    this.server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        this.posts.push({ body, authorization: req.headers.authorization ?? null });
        const send = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
        if (body.ticket === 't-expired') return send(410, { type: 'expired', message: 'Ticket expired' });
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

test('the replay lists every change since the cursor', async () => {
  const clear = configure(BASE);
  try {
    await take(waitEvent());
    await take(adviceEvent());
    await take(waitEvent({ ticket: 't-plan', correlation_id: 'release-42', graph_id: 'plan-assistant', kind: 'question', turn: 1 }));
    let response = await fetch(`${host}/questions?since=0`);
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.deepEqual(page.rows.map((r) => r.id), [1, 2, 3]);
    assert.equal(page.next, 3);
    assert.equal(page.more, false);
    assert.deepEqual(page.rows[0].calls, CALLS);
    assert.equal(page.rows[0].ticket, 't-answer');
    assert.equal(page.rows[1].kind, 'advice');
    response = await fetch(`${host}/questions?since=2&limit=1`);
    const tail = await response.json();
    assert.deepEqual(tail.rows.map((r) => r.id), [3]);
    assert.equal(tail.next, 3);
    response = await fetch(`${host}/questions?since=x`);
    assert.equal(response.status, 400);
    response = await fetch(`${host}/questions/app`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('Agent questions'));
    assert.ok(html.includes('id="history"') && html.includes('Waiting for you'), 'the page separates what waits from the history');
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

test('the stream replays, then follows the changes with keep-alives', async () => {
  const clear = configure(BASE);
  const controller = new AbortController();
  try {
    await take(waitEvent());
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
    await take(adviceEvent());
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

test('a decision is forwarded, recorded and broadcast', async () => {
  const clear = configure({ ...BASE, [aq.REPLY_TOKEN]: 'channel-app-bearer' });
  try {
    reply.posts.length = 0;
    const row = await take(waitEvent({ ticket: 't-answer', base: replyUrl }));
    const queue = aq.wakeups.subscribe();
    const decisions = [{ id: 'toolu_01A', approved: true, note: 'Carrier confirmed the loss' }];
    let response = await postJson(`${host}/questions/${row.id}/decide`, { decisions, decided_by: 'operator-17' });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.row.state, 'answered');
    assert.equal(result.row.answered_by, 'operator-17');
    assert.equal(result.outcome.status, 200);
    assert.equal(result.outcome.body.type, 'answer');
    assert.deepEqual(reply.posts[0].body, { ticket: 't-answer', decisions, decided_by: 'operator-17' });
    assert.equal(reply.posts[0].authorization, 'Bearer channel-app-bearer');
    assert.equal(queue.items[0].id, row.id);
    assert.equal(queue.items[0].state, 'answered');
    response = await postJson(`${host}/questions/${row.id}/decide`, { decisions });
    assert.equal(response.status, 409);
    const expired = await take(waitEvent({ ticket: 't-expired', base: replyUrl, correlation_id: 'case-2' }));
    response = await postJson(`${host}/questions/${expired.id}/decide`, { decisions });
    assert.equal((await response.json()).row.state, 'expired');
    const refused = await take(waitEvent({ ticket: 't-refused', base: replyUrl, correlation_id: 'case-3' }));
    response = await postJson(`${host}/questions/${refused.id}/decide`, { decisions });
    const body = await response.json();
    assert.equal(body.row.state, 'open');
    assert.ok(body.outcome.body.error.startsWith('not a call'));
    const silent = await take(waitEvent({ ticket: 't-silent', base: 'http://127.0.0.1:9', correlation_id: 'case-4' }));
    appConfig().set(aq.REPLY_TIMEOUT, '2s');
    aq.configure();
    response = await postJson(`${host}/questions/${silent.id}/decide`, { decisions });
    const quiet = await response.json();
    assert.equal(quiet.row.state, 'open');
    assert.equal(quiet.outcome.status, 502);
    appConfig().set(aq.REPLY_TIMEOUT, undefined);
    response = await fetch(`${host}/questions/${row.id}/decide`, { method: 'POST', body: 'nope' });
    assert.equal(response.status, 400);
    response = await postJson(`${host}/questions/${row.id}/decide`, { decisions: [] });
    assert.equal(response.status, 400);
    response = await postJson(`${host}/questions/999/decide`, { decisions });
    assert.equal(response.status, 404);
    const advice = await take(adviceEvent());
    response = await postJson(`${host}/questions/${advice.id}/decide`, { decisions });
    assert.equal(response.status, 409);
    response = await fetch(`${host}/questions/${advice.id}/seen`, { method: 'POST' });
    assert.equal((await response.json()).row.state, 'seen');
    response = await fetch(`${host}/questions/${row.id}/seen`, { method: 'POST' });
    assert.equal(response.status, 409);
    aq.wakeups.unsubscribe(queue);
  } finally {
    clear();
  }
});

test('open waits past their expiry are marked expired', async () => {
  const clear = configure(BASE);
  try {
    const stale = await take(waitEvent({ ticket: 't-stale', expires_at: isoUtc(new Date(Date.now() - 5000)) }));
    const fresh = await take(waitEvent({ ticket: 't-fresh', correlation_id: 'case-2' }));
    const queue = aq.wakeups.subscribe();
    const response = await fetch(`${host}/questions?since=0`);
    const states = Object.fromEntries((await response.json()).rows.map((r) => [r.id, r.state]));
    assert.deepEqual(states, { [stale.id]: 'expired', [fresh.id]: 'open' });
    assert.equal(queue.items[0].id, stale.id, 'the expiry is broadcast like any change');
    aq.wakeups.unsubscribe(queue);
  } finally {
    clear();
  }
});

test("the proxy mode takes the gateway's header", async () => {
  const clear = configure({ ...BASE, [aq.AUTH]: 'proxy' });
  try {
    reply.posts.length = 0;
    const row = await take(waitEvent({ base: replyUrl }));
    const decisions = [{ id: 'toolu_01A', approved: false }];
    for (const path of ['/questions?since=0', '/questions/events', '/questions/app']) {
      const response = await fetch(`${host}${path}`);
      assert.equal(response.status, 401, path);
    }
    let response = await postJson(`${host}/questions/${row.id}/decide`, { decisions });
    assert.equal(response.status, 401);
    response = await postJson(`${host}/questions/${row.id}/decide`, { decisions, decided_by: 'spoof' }, { 'x-forwarded-user': 'operator-17' });
    assert.equal(response.status, 200);
    assert.equal(reply.posts[0].body.decided_by, 'operator-17', "the gateway's name, never the body's");
  } finally {
    clear();
  }
});

// --- the PostgreSQL inbox on a recording fake of the pool -------------------------------------------

const record = (overrides = {}) => {
  const now = new Date('2026-11-19T09:12:05.123Z');
  return {
    id: '7', seq: '12', ticket: 't-answer', graph_id: 'order-assistant', correlation_id: 'order-1002-case', turn: 2, kind: 'approval',
    description: 'Customer-support assistant', summary: 'A refund waits', details: null, message: { kind: 'approval', calls: CALLS },
    link: 'https://ask.example.test/ask/t-answer', state: 'open', requested_at: now, expires_at: new Date(now.getTime() + 2 * 86_400_000),
    updated_at: now, answered_at: null, answered_by: null, decisions: null, outcome: null, ...overrides
  };
};

class FakePool {
  constructor(rows = []) {
    this.rows = rows;
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
    return { rows: this.rows };
  }

  async end() {
    this.ended = true;
  }
}

test('the postgres inbox runs the statements and maps the records', async () => {
  const pool = new FakePool([record()]);
  const box = new aq.PostgresInbox(pool);
  await box.open();
  assert.ok(pool.connected);
  const now = '2026-11-19T09:12:05.123Z';
  const row = await box.take(aq.validateEvent(waitEvent()), now);
  let [sql, params] = pool.log.at(-1);
  assert.equal(sql, aq.SQL_UPSERT_WAIT);
  assert.equal(params[0], 't-answer');
  assert.deepEqual(params.slice(1, 5), ['order-assistant', 'order-1002-case', 2, 'approval']);
  assert.deepEqual(JSON.parse(params[7]).calls, CALLS);
  assert.equal(params[11], now);
  assert.equal(row.id, 7);
  assert.equal(row.seq, 12);
  assert.equal(row.requested_at, now);
  assert.equal(row.expires_at, '2026-11-21T09:12:05.123Z');
  assert.deepEqual(aq.publicRow(row).calls, CALLS);
  await box.take(aq.validateEvent(adviceEvent()), now);
  [sql, params] = pool.log.at(-1);
  assert.equal(sql, aq.SQL_INSERT_ADVICE);
  assert.equal(params[3], 'Customer-support assistant');
  await box.decided(7, [{ id: 'toolu_01A', approved: true }], 'operator-17', 'answered', { status: 200, body: {} }, now);
  [sql, params] = pool.log.at(-1);
  assert.equal(sql, aq.SQL_DECIDED);
  assert.deepEqual(params, ['answered', '[{"id":"toolu_01A","approved":true}]', '{"status":200,"body":{}}', 'operator-17', now, now, 7, 'answered']);
  await box.seen(8, now);
  assert.deepEqual(pool.log.at(-1), [aq.SQL_SEEN, [now, 8]]);
  await box.expire(now);
  assert.deepEqual(pool.log.at(-1), [aq.SQL_EXPIRE, [now, now]]);
  await box.since(3, 50);
  assert.deepEqual(pool.log.at(-1), [aq.SQL_SINCE, [3, 50]]);
  await box.get(7);
  assert.deepEqual(pool.log.at(-1), [aq.SQL_GET, [7]]);
  pool.rows = [{ state: 'open', count: '3' }, { state: 'answered', count: '1' }];
  assert.deepEqual(await box.counts(), { open: 3, answered: 1 });
  await box.close();
  assert.ok(pool.ended);
});

test("a record's JSON may arrive as text and its big integers as text", () => {
  const row = aq.rowFromRecord(record({ message: '{"kind":"advice"}', decisions: '[]', outcome: '{"status":410}', kind: 'advice', ticket: null, link: null, turn: null, expires_at: null, state: 'seen' }));
  assert.deepEqual(row.message, { kind: 'advice' });
  assert.deepEqual(row.decisions, []);
  assert.deepEqual(row.outcome, { status: 410 });
  assert.equal(row.turn, null);
  assert.equal(row.expires_at, null);
  assert.equal(row.state, 'seen');
  assert.equal(row.id, 7);
});

// --- the platform hooks and the boot -------------------------------------------------------------------

test('the platform hooks mount the routes and run the boot', async () => {
  const clear = configure(BASE);
  const fresh = new Platform(new FunctionRegistry());
  aq.attach(fresh);
  let server;
  try {
    server = await fresh.run({ port: 0 });
    assert.equal(aq.inbox().name, 'memory');
    assert.ok(aq.sweeperRunning(), 'the boot started the sweeper');
    const base = `http://127.0.0.1:${server.address().port}`;
    let response = await fetch(`${base}/questions/app`);
    assert.equal(response.status, 200);
    response = await fetch(`${base}/nothing`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).status, 404, "the catch-all still answers the engines' shape");
    const info = await aq.questionHealth({ type: 'info' });
    assert.equal(info.service, 'agent.question.inbox');
    assert.equal(info.inbox, 'memory');
    assert.equal(await aq.questionHealth({}), 'agent.question.inbox is running fine');
  } finally {
    if (server) await close(server);
    await fresh.shutdown();
    assert.equal(aq.sweeperRunning(), false, 'the cleanup stops the sweeper');
    clear();
  }
});

// --- a live PostgreSQL -----------------------------------------------------------------------------------

const LIVE = process.env.AGENT_QUESTION_TEST_URL;
test('the rows land on a live postgres', { skip: !LIVE && 'set AGENT_QUESTION_TEST_URL, e.g. postgres://mercury:...@127.0.0.1:5432/mercury?sslmode=disable' }, async () => {
  const pg = await import('pg');
  const Pool = pg.Pool ?? pg.default?.Pool;
  const pool = new Pool({ connectionString: LIVE, max: 2 });
  const box = new aq.PostgresInbox(pool);
  await box.open();
  try {
    await pool.query(readFileSync(SCHEMA, 'utf8'));
    const cid = `live-${Date.now()}`;
    const first = await box.take(aq.validateEvent(waitEvent({ ticket: `${cid}-1`, correlation_id: cid })), isoUtc());
    const again = await box.take(aq.validateEvent(waitEvent({ ticket: `${cid}-2`, correlation_id: cid })), isoUtc());
    assert.equal(again.id, first.id, 'the same turn upserts');
    assert.ok(again.seq > first.seq);
    assert.equal(again.ticket, `${cid}-2`);
    const advice = await box.take(aq.validateEvent(adviceEvent({ correlation_id: cid })), isoUtc());
    assert.notEqual(advice.id, first.id);
    const decided = await box.decided(first.id, [{ id: 'toolu_01A', approved: true }], 'operator-17', 'answered', { status: 200, body: { type: 'answer' } }, isoUtc());
    assert.equal(decided.state, 'answered');
    assert.deepEqual(decided.outcome, { status: 200, body: { type: 'answer' } });
    assert.equal((await box.seen(advice.id, isoUtc())).state, 'seen');
    const stale = await box.take(aq.validateEvent(waitEvent({ ticket: `${cid}-3`, correlation_id: `${cid}-b`, expires_at: isoUtc(new Date(Date.now() - 1000)) })), isoUtc());
    const expired = await box.expire(isoUtc());
    assert.ok(expired.some((r) => r.id === stale.id && r.state === 'expired'));
    const rows = await box.since(first.seq, 100);
    assert.ok([first.id, advice.id, stale.id].every((id) => rows.some((r) => r.id === id)));
    assert.ok(((await box.counts()).answered ?? 0) >= 1);
  } finally {
    await box.close();
  }
});
