/**
 * Ask a person - the main flow (extensions/ask-person/ask-person.mjs).
 *
 * The shared contract file test/vectors/ask-person-vectors.json (byte-identical in mercury-python) pins the pure
 * half: the ticket issued, verified, tampered, expired and rotated; the message validated in its fixed order and
 * the event built; the re-advice and the resume requests; the outcomes; the row a message becomes in the question
 * record, the state an answer leaves and the record's transitions on the reference store. The tests after the vector
 * runs drive the function on the bus with channels that take, refuse and miss the event - the record written before
 * they are told - and the reply page and endpoint over the host against a fake engine: the page's shell and the wait
 * read without resuming, the decisions forwarded with who decided prefixed to each note and the answer recorded, an
 * expired ticket refused before the engine is called, the two auth modes (none, a signed access token against a JWKS
 * the fake serves) with the page's sign-in configuration and a channel app's bearer, the PostgreSQL store's statements
 * on a recording fake of the pool, the host hook that mounts the routes before the catch-all, the boot that fails by
 * name, the health route and the inspect command.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { AppException, appConfig, defaultRegistry, EventApiServer, FunctionRegistry, isoUtc, Platform, PostOffice } from 'mercury-composable';
import * as ask from '../extensions/ask-person/ask-person.mjs';

const VECTORS_FILE = new URL('./vectors/ask-person-vectors.json', import.meta.url);
// the Python twin runs the same file: change it in both packs or in neither
const VECTORS_SHA256 = 'd825e6296ff3b5b808c921d94e19b902c05f14fafcdc4cb383bbd6dcfd39fa7f';
const VECTORS = JSON.parse(readFileSync(VECTORS_FILE, 'utf8'));

const KEY = 'test-key-current';
const PREVIOUS = 'test-key-previous';
const REPLY_URL = 'https://ask.example.test';
const APP_TOKEN = 'channel-app-bearer';
const ISSUER = 'https://issuer.example.test';
const AUDIENCE = 'ask-person';
const CALLS = [
  { id: 'toolu_01A', name: 'issue_refund', route: 'demo.refund.issue', wait: true,
    input: { order_id: 'ORD-1002', amount: 174.0, reason: 'Shipment lost in transit' } },
  { id: 'toolu_02B', name: 'ask_owner', ask: true, wait: true,
    input: { question: 'Refund in full or offer a replacement?', options: ['refund', 'replacement'] } },
  { id: 'toolu_03C', name: 'order_lookup', route: 'demo.order.lookup', wait: false, input: { order_id: 'ORD-1002' } }
];
const BASE = { [ask.TICKET_KEY]: KEY, [ask.PREVIOUS_KEY]: PREVIOUS, [ask.REPLY_URL]: REPLY_URL, [ask.CHANNELS]: [],
  [ask.CHANNEL_ENDPOINTS]: [], [ask.GRAPHS]: [], [ask.REPLY_AUTH]: 'none', [ask.APP_TOKEN]: '', [ask.AUDIT]: 'memory' };

/** The recorder on the default registry with a fresh memory store, as the boot registers it; the store is returned. */
function recorder() {
  ask.resetStore();
  if (!defaultRegistry.exists(ask.AUDIT_ROUTE)) {
    defaultRegistry.register(ask.AUDIT_ROUTE, ask.questionAudit, { instances: 2, isPrivate: true });
  }
  return ask.questionStore();
}

const approvalMessage = (overrides = {}) => ({
  kind: 'approval', graph_id: 'order-assistant', description: 'Customer-support assistant: a refund waits for a supervisor',
  correlation_id: 'order-1002-case', turn: 2, node: 'assist', summary: 'issue_refund for ORD-1002, 174.00 USD',
  calls: CALLS, ttl: '2d', ...overrides
});

/** Set keys on the shared configuration, reload the settings, and give back a function that clears them. */
function configure(values) {
  for (const [key, value] of Object.entries(values)) appConfig().set(key, value);
  const settings = ask.configure();
  return Object.assign(() => {
    for (const key of Object.keys(values)) appConfig().set(key, undefined);
  }, { settings });
}

const ticketFor = ({ graph = 'order-assistant', cid = 'order-1002-case', turn = 2, kind = 'approval', expiresIn = 3600, key = KEY } = {}) =>
  ask.issueTicket({ g: graph, c: cid, t: turn, k: kind, e: Math.floor(Date.now() / 1000) + expiresIn }, Buffer.from(key));

const listen = (server) => new Promise((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolveClose) => server.close(() => resolveClose()));
const readJson = (req) => new Promise((resolveBody) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}));
});

// --- the shared vectors -------------------------------------------------------------------------

test('the vector file is the one the Python twin runs', () => {
  assert.equal(createHash('sha256').update(readFileSync(VECTORS_FILE)).digest('hex'), VECTORS_SHA256);
  assert.equal(VECTORS.contract, 'ask-person');
  assert.equal(VECTORS.version, 2);
  for (const section of ['ticket_cases', 'verify_cases', 'message_cases', 'readvice_cases', 'reply_cases', 'outcome_cases',
    'record_cases', 'answer_cases', 'transition_cases']) {
    assert.ok(VECTORS[section].length > 0, section);
  }
});

for (const c of VECTORS.ticket_cases) {
  test(`ticket: ${c.name}`, () => assert.equal(ask.issueTicket(c.payload, Buffer.from(c.key)), c.ticket));
}

for (const c of VECTORS.verify_cases) {
  test(`verify: ${c.name}`, () => {
    const keys = c.keys.map((k) => Buffer.from(k));
    if (c.payload) {
      assert.deepEqual(ask.verifyTicket(c.ticket, keys, c.now), c.payload);
    } else {
      assert.throws(() => ask.verifyTicket(c.ticket, keys, c.now), (e) => e instanceof ask.TicketError && e.status === c.status && e.message === c.message);
    }
  });
}

for (const c of VECTORS.message_cases) {
  test(`message: ${c.name}`, () => {
    if (c.event) {
      assert.deepEqual(ask.buildEvent(ask.validateMessage(c.message), Buffer.from(c.key), c.reply_url), c.event);
    } else {
      assert.throws(() => ask.validateMessage(c.message), (e) => e instanceof AppException && e.status === c.status && e.message === c.error);
    }
  });
}

for (const c of VECTORS.readvice_cases) {
  test(`re-advice: ${c.name}`, () => {
    if (c.request) {
      assert.deepEqual(ask.readviceRequest(c.payload, c.graphs), c.request);
    } else {
      assert.throws(() => ask.readviceRequest(c.payload, c.graphs), (e) => e instanceof ask.ReplyError && e.status === c.status && e.message === c.error);
    }
  });
}

for (const c of VECTORS.reply_cases) {
  test(`reply: ${c.name}`, () => {
    if (c.request) {
      assert.deepEqual(ask.buildResume(c.payload, c.decisions, c.who, c.at, c.graphs), c.request);
    } else {
      assert.throws(() => ask.buildResume(c.payload, c.decisions, c.who, c.at, c.graphs), (e) => e instanceof ask.ReplyError && e.status === c.status && e.message === c.error);
    }
  });
}

for (const c of VECTORS.outcome_cases) {
  test(`outcome: ${c.name}`, () => assert.deepEqual(ask.mapOutcome(c.engine.status, c.engine.body, c.engine.error), [c.status, c.body]));
}

for (const c of VECTORS.record_cases) {
  test(`record: ${c.name}`, () => {
    assert.deepEqual(ask.waitKey(c.event), c.key);
    assert.deepEqual(ask.rowFields(c.event, c.now), c.row);
  });
}

for (const c of VECTORS.answer_cases) {
  test(`answer: ${c.name}`, () => assert.equal(ask.answerState(c.status, c.body), c.state));
}

const pick = (row, names) => Object.fromEntries(names.map((name) => [name, row[name]]));

for (const c of VECTORS.transition_cases) {
  test(`transitions: ${c.name}`, async () => {
    const store = new ask.MemoryQuestionStore();
    const results = [];
    for (const step of c.steps) {
      if (step.op === 'record') {
        results.push(pick(await store.record(step.event, step.now), ['id', 'seq', 'state', 'ticket']));
      } else if (step.op === 'answer') {
        const state = ask.answerState(step.status, step.body);
        const row = await store.answer(step.key, step.decisions, step.who, state, { status: step.status, body: step.body }, step.now);
        results.push(row === null ? null : pick(row, ['id', 'seq', 'state', 'answered_by']));
      } else if (step.op === 'expire') {
        results.push({ expired: (await store.expire(step.now)).map((r) => pick(r, ['id', 'seq'])) });
      } else if (step.op === 'since') {
        const rows = await store.since(step.seq, step.limit);
        results.push({ ids: rows.map((r) => r.id), seqs: rows.map((r) => r.seq) });
      }
    }
    assert.deepEqual(results, c.results);
    const final = (await store.since(0, 100)).sort((a, b) => a.id - b.id)
      .map((r) => pick(r, ['id', 'seq', 'kind', 'state', 'ticket', 'turn', 'requested_at', 'expires_at', 'updated_at', 'answered_by', 'outcome']));
    assert.deepEqual(final, c.final);
    const expected = {};
    for (const r of c.final) expected[r.state ?? r.kind] = (expected[r.state ?? r.kind] ?? 0) + 1;
    assert.deepEqual(await store.counts(), expected);
  });
}

test('the duration grammar and the default requested_at', () => {
  assert.equal(ask.durationMs('500ms'), 500);
  assert.equal(ask.durationMs('30m'), 1_800_000);
  assert.equal(ask.durationMs(90), 90_000);
  assert.equal(ask.durationMs(true), null);
  assert.equal(ask.durationMs('soon'), null);
  const before = Date.now();
  const event = ask.buildEvent(ask.validateMessage(approvalMessage({ ttl: '1h' })), Buffer.from(KEY), REPLY_URL);
  const requested = Date.parse(event.requested_at);
  assert.ok(before - 1000 <= requested && requested <= Date.now() + 1000);
  assert.equal(Date.parse(event.expires_at) - requested, 3_600_000);
  const payload = ask.verifyTicket(event.ticket, [Buffer.from(KEY)], Date.now() / 1000);
  assert.deepEqual(payload, { g: 'order-assistant', c: 'order-1002-case', t: 2, k: 'approval', e: Math.floor(Date.parse(event.expires_at) / 1000) });
  assert.equal(event.link, `${REPLY_URL}/ask/${event.ticket}`);
});

// --- configuration --------------------------------------------------------------------------------

test('the settings read lists and pairs in both forms', () => {
  const clear = configure({ ...BASE, [ask.CHANNELS]: ['agent.question.inbox', 'chat.post'],
    [ask.CHANNEL_ENDPOINTS]: [{ route: 'agent.question.inbox', url: 'http://127.0.0.1:8092/api/event' }],
    [ask.GRAPHS]: [{ id: 'order-assistant', entry: 'http://127.0.0.1:8085/api/graph/order-assistant' }], [ask.CHANNEL_TIMEOUT]: '2s' });
  try {
    const s = clear.settings;
    assert.deepEqual(s.channels, ['agent.question.inbox', 'chat.post']);
    assert.deepEqual(s.channelEndpoints, { 'agent.question.inbox': 'http://127.0.0.1:8092/api/event' });
    assert.deepEqual(s.graphs, { 'order-assistant': 'http://127.0.0.1:8085/api/graph/order-assistant' });
    assert.equal(s.channelTimeoutMs, 2000);
    assert.equal(s.engineTimeoutMs, 60_000);
    assert.deepEqual(s.keys.map(String), [KEY, PREVIOUS]);
    const text = configure({ [ask.CHANNELS]: 'a.route, b.route', [ask.CHANNEL_ENDPOINTS]: 'b.route=http://peer:8085/api/event', [ask.GRAPHS]: 'g1=http://e/1, g2=http://e/2' });
    assert.deepEqual(text.settings.channels, ['a.route', 'b.route']);
    assert.deepEqual(text.settings.channelEndpoints, { 'b.route': 'http://peer:8085/api/event' });
    assert.deepEqual(text.settings.graphs, { g1: 'http://e/1', g2: 'http://e/2' });
    text();
  } finally {
    clear();
  }
});

for (const [values, names] of [
  [{ [ask.TICKET_KEY]: '' }, 'ask.ticket.key is not set'],
  [{ [ask.REPLY_URL]: 'ask.example.test' }, 'ask.reply.url must be the public base'],
  [{ [ask.REPLY_AUTH]: 'basic' }, 'ask.reply.auth must be one of none, oauth2'],
  [{ [ask.REPLY_AUTH]: 'proxy' }, 'ask.reply.auth must be one of none, oauth2'],
  [{ [ask.REPLY_AUTH]: 'oauth2' }, 'set ask.reply.auth.oauth2.issuer or ask.reply.auth.oauth2.jwks-url'],
  [{ [ask.AUDIT]: 'mongo' }, 'ask.audit must be one of memory, postgres'],
  [{ [ask.AUDIT_INSTANCES]: '0' }, 'ask.audit.instances must be a whole number >= 1'],
  [{ [ask.AUDIT_SWEEP]: 'never' }, 'ask.audit.sweep must be a duration'],
  [{ [ask.GRAPHS]: [{ id: 'g', entry: 'ftp://x' }] }, 'the entry of g must be an http or https URL'],
  [{ [ask.GRAPHS]: [{ id: 'g' }] }, 'ask.graphs entries need id and entry'],
  [{ [ask.CHANNEL_ENDPOINTS]: 'nonsense' }, 'ask.channel.endpoints takes route=url pairs'],
  [{ [ask.CHANNEL_TIMEOUT]: '0' }, 'ask.channel.timeout must be a duration']
]) {
  test(`the boot fails by name: ${names}`, () => {
    for (const [key, value] of Object.entries({ ...BASE, ...values })) appConfig().set(key, value);
    try {
      assert.throws(() => ask.configure(), (e) => e instanceof ask.AskError && e.message.includes(names));
    } finally {
      for (const key of Object.keys({ ...BASE, ...values })) appConfig().set(key, undefined);
    }
  });
}

test('a disabled extension loads without a key', () => {
  const clear = configure({ ...BASE, [ask.ENABLED]: false, [ask.TICKET_KEY]: '', [ask.PREVIOUS_KEY]: '' });
  try {
    assert.equal(clear.settings.enabled, false);
    assert.deepEqual(clear.settings.keys, []);
  } finally {
    clear();
  }
});

// --- the function on the bus ---------------------------------------------------------------------

test('the fan-out records the event, then takes, refuses and misses channels on the default registry', async () => {
  const taken = [];
  const rowsAtDelivery = []; // how many rows the record held when the channel was told
  defaultRegistry.register('ask.test.channel', async (_h, body) => {
    taken.push(body);
    rowsAtDelivery.push((await ask.questionStore().since(0, 100)).length);
    return { stored: true };
  }, { instances: 1 });
  defaultRegistry.register('ask.test.refusing', async () => { throw new AppException(500, 'the channel is down'); }, { instances: 1 });
  const store = recorder();
  const clear = configure({ ...BASE, [ask.CHANNELS]: ['ask.test.channel', 'ask.test.refusing', 'ask.test.missing'] });
  try {
    const result = await ask.personAsk({}, approvalMessage());
    assert.deepEqual(result.delivered, [
      { route: 'ask.test.channel', ok: true, status: 200 }, { route: 'ask.test.refusing', ok: false, status: 500 },
      { route: 'ask.test.missing', ok: false, status: 404 }
    ]);
    assert.equal(result.recorded, true);
    assert.equal(taken.length, 1);
    assert.equal(taken[0].ticket, result.ticket);
    assert.equal(taken[0].link, result.link);
    assert.deepEqual(taken[0].calls, CALLS);
    // the record: the row was there before the channel was told, and holds the event as the channel got it
    assert.deepEqual(rowsAtDelivery, [1]);
    const rows = await store.since(0, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'open');
    assert.equal(rows[0].ticket, result.ticket);
    assert.equal(rows[0].expires_at, result.expires_at);
    assert.deepEqual(rows[0].message, taken[0]);
    assert.deepEqual(ask.publicRow(rows[0]).calls, CALLS);
    const advice = await ask.personAsk({}, { kind: 'advice', graph_id: 'order-assistant', description: 'd', correlation_id: 'c', turn: 3, summary: 's', details: 'x' });
    assert.deepEqual(advice, { delivered: [{ route: 'ask.test.channel', ok: true, status: 200 }, { route: 'ask.test.refusing', ok: false, status: 500 }, { route: 'ask.test.missing', ok: false, status: 404 }], recorded: true });
    assert.equal(taken[1].ticket, undefined);
    const all = await store.since(0, 10);
    assert.equal(all.length, 2);
    assert.equal(all[1].kind, 'advice');
    assert.equal(all[1].state, null);
    assert.equal(all[1].details, 'x');
    await assert.rejects(ask.personAsk({ 'x-graph-id': 'other' }, approvalMessage()), (e) => e.status === 400 && e.message.includes('does not match the x-graph-id header'));
    await assert.rejects(ask.personAsk({}, approvalMessage({ ttl: 'soon' })), (e) => e.status === 400 && e.message.includes('ttl must be a duration'));
    configure({ [ask.ENABLED]: false });
    await assert.rejects(ask.personAsk({}, approvalMessage()), (e) => e.status === 503 && e.message.includes('ask.enabled is false'));
    appConfig().set(ask.ENABLED, undefined);
  } finally {
    clear();
    await defaultRegistry.bus.close();
    await ask.shutdown();
  }
});

test('a write the recorder does not take is logged and never fails the caller', async () => {
  const clear = configure({ ...BASE, [ask.AUDIT_TIMEOUT]: '1s' });
  const event = ask.buildEvent(ask.validateMessage(approvalMessage()), Buffer.from(KEY), REPLY_URL);
  try {
    // no recorder anywhere: the write is refused by the bus
    ask.resetPostOffice(new PostOffice(undefined, {}, new FunctionRegistry()));
    assert.equal(await ask.record({ record: event }, clear.settings), false);
    // a recorder that reports a failure of its store
    const registry = new FunctionRegistry();
    registry.register(ask.AUDIT_ROUTE, async () => ({ recorded: false, error: 'DatabaseError sqlstate=08006' }), { instances: 1, isPrivate: true });
    ask.resetPostOffice(new PostOffice(undefined, {}, registry));
    assert.equal(await ask.record({ answer: {} }, clear.settings), false);
    await registry.bus.close();
    // the recorder itself: a store that fails is reported by type, never thrown; an unknown event is a 400
    class Broken {
      name = 'broken';

      async record() { throw new RangeError('the row would be quoted here'); }
    }
    ask.resetStore(new Broken());
    assert.deepEqual(await ask.questionAudit({}, { record: event }), { recorded: false, error: 'RangeError' });
    await assert.rejects(ask.questionAudit({}, { nothing: true }), (e) => e instanceof AppException && e.status === 400);
  } finally {
    ask.resetPostOffice(undefined);
    ask.resetStore();
    clear();
  }
});

test('health reports the setup', async () => {
  ask.resetStore();
  const clear = configure({ ...BASE, [ask.CHANNELS]: ['a.route'], [ask.GRAPHS]: 'g1=http://e/1' });
  try {
    assert.deepEqual(await ask.askHealth({ type: 'info' }), { service: 'person.ask', href: 'http://127.0.0.1', enabled: true, channels: ['a.route'], graphs: ['g1'], reply_url: REPLY_URL, auth: 'none', audit: 'memory', rows: {} });
    assert.equal(await ask.askHealth({}), 'person.ask is running fine');
  } finally {
    clear();
  }
});

// --- the reply page and endpoint against a fake engine ---------------------------------------------

/** A graph entry as the Playground serves it, and the issuer's JWKS document. */
class FakeEngine {
  constructor() {
    this.requests = [];
    this.jwks = { keys: [] };
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/jwks') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(this.jwks));
      }
      const graph = /^\/api\/graph\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'POST' && graph) {
        const body = await readJson(req);
        const cid = req.headers['x-correlation-id'];
        this.requests.push({ graph: graph[1], cid, body });
        const send = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
        if (cid === 'expired-case') return send(410, { type: 'nothing-waiting', cid });
        if ('decisions' in body) return send(200, { type: 'answer', turn: body.turn + 1, run: 'resume', message: 'Your refund has been issued.' });
        return send(200, { type: 'approval', turn: body.turn, run: 'resume', calls: CALLS, message: "A tool call waits for a supervisor's decision.", cid });
      }
      res.writeHead(404);
      res.end();
    });
  }
}

let engine;
let engineUrl;
let hostServer;
let host;

before(async () => {
  engine = new FakeEngine();
  engineUrl = await listen(engine.server);
  hostServer = new EventApiServer(new FunctionRegistry()).createServer([ask.mount]);
  host = await listen(hostServer);
});

after(async () => {
  await close(hostServer);
  await close(engine.server);
});

const graphs = () => `order-assistant=${engineUrl}/api/graph/order-assistant`;

test('the page is a shell and the wait is read without resuming', async () => {
  const clear = configure({ ...BASE, [ask.GRAPHS]: graphs() });
  try {
    engine.requests.length = 0;
    const ticket = ticketFor();
    let response = await fetch(`${host}/ask/${ticket}`);
    const page = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.deepEqual(engine.requests, [], 'the page itself never calls the engine - its script reads the wait');
    for (const expected of [`const TICKET = ${JSON.stringify(ticket)};`, `const WAIT = "/ask/${ticket}/wait";`, 'const REPLY = "/ask/reply";',
      'const CONFIG = "/ask/config";', '<title>Approval - order-assistant</title>', 'waits for a decision', 'a question', 'runs on resume',
      "code_challenge_method: 'S256'", 'authorization_endpoint']) {
      assert.ok(page.includes(expected), expected);
    }
    response = await fetch(`${host}/ask/config`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { auth: 'none' });
    response = await fetch(`${host}/ask/${ticket}/wait`);
    assert.equal(response.status, 200);
    const shown = await response.json();
    assert.deepEqual(engine.requests, [{ graph: 'order-assistant', cid: 'order-1002-case', body: { turn: 2 } }]);
    assert.deepEqual(shown.payload, { g: 'order-assistant', c: 'order-1002-case', t: 2, k: 'approval' });
    assert.equal(shown.advice.type, 'approval');
    assert.deepEqual(shown.advice.calls, CALLS);
  } finally {
    clear();
  }
});

test('the page refuses bad tickets and reports an expired wait', async () => {
  const clear = configure({ ...BASE, [ask.GRAPHS]: graphs() });
  try {
    engine.requests.length = 0;
    let response = await fetch(`${host}/ask/${ticketFor({ expiresIn: -5 })}`);
    assert.equal(response.status, 410);
    assert.ok((await response.text()).includes('Ticket expired'));
    response = await fetch(`${host}/ask/${ticketFor({ key: 'another' })}`);
    assert.equal(response.status, 403);
    response = await fetch(`${host}/ask/v1.nonsense`);
    assert.equal(response.status, 400);
    response = await fetch(`${host}/ask/${ticketFor({ graph: 'other-graph' })}`);
    assert.equal(response.status, 404);
    assert.ok((await response.text()).includes('not configured'));
    response = await fetch(`${host}/ask/${ticketFor({ expiresIn: -5 })}/wait`);
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), { type: 'expired', message: 'Ticket expired' });
    response = await fetch(`${host}/ask/${ticketFor({ graph: 'other-graph' })}/wait`);
    assert.equal(response.status, 404);
    assert.ok((await response.json()).message.includes('not configured'));
    assert.equal(engine.requests.length, 0, 'no ticket above reached the engine');
    response = await fetch(`${host}/ask/${ticketFor({ cid: 'expired-case' })}/wait`);
    assert.equal(response.status, 410);
    assert.equal((await response.json()).type, 'nothing-waiting');
    assert.equal(engine.requests.length, 1);
  } finally {
    clear();
  }
});

test('a reply resumes the graph with who decided on each note', async () => {
  const clear = configure({ ...BASE, [ask.GRAPHS]: graphs() });
  try {
    engine.requests.length = 0;
    const decisions = [{ id: 'toolu_01A', approved: true, note: 'Carrier confirmed the loss' }, { id: 'toolu_02B', answer: 'refund' }];
    const response = await fetch(`${host}/ask/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: ticketFor(), decisions }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: 'answer', turn: 3, run: 'resume', message: 'Your refund has been issued.' });
    const sent = engine.requests[0];
    assert.equal(sent.cid, 'order-1002-case');
    assert.equal(sent.body.turn, 2);
    assert.match(sent.body.decisions[0].note, /^\[anonymous at 20.*Z\] Carrier confirmed the loss$/);
    assert.deepEqual(sent.body.decisions[1], { id: 'toolu_02B', answer: 'refund' });
  } finally {
    clear();
  }
});

test('a reply is refused before the engine when the ticket or the decisions are wrong', async () => {
  const clear = configure({ ...BASE, [ask.GRAPHS]: graphs() });
  try {
    engine.requests.length = 0;
    const good = [{ id: 'toolu_01A', approved: true }];
    const post = (body, raw = false) => fetch(`${host}/ask/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? body : JSON.stringify(body) });
    let response = await post('not json', true);
    assert.equal(response.status, 400);
    response = await post({ decisions: good });
    assert.equal((await response.json()).message, 'ticket is required');
    response = await post({ ticket: ticketFor({ expiresIn: -5 }), decisions: good });
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), { type: 'expired', message: 'Ticket expired' });
    response = await post({ ticket: ticketFor(), decisions: [] });
    assert.equal(response.status, 400);
    response = await post({ ticket: ticketFor({ graph: 'x' }), decisions: good });
    assert.equal(response.status, 404);
    response = await post({ ticket: ticketFor(), decisions: good, decided_by: 5 });
    assert.equal(response.status, 400);
    assert.equal(engine.requests.length, 0);
    response = await post({ ticket: ticketFor({ cid: 'expired-case' }), decisions: good });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).type, 'nothing-waiting');
    assert.equal(engine.requests.length, 1);
  } finally {
    clear();
  }
});

test("the engine's outcome is passed through and a silent engine is a 502", async () => {
  const clear = configure({ ...BASE, [ask.GRAPHS]: 'order-assistant=http://127.0.0.1:9/api/graph/order-assistant', [ask.ENGINE_TIMEOUT]: '2s' });
  try {
    const response = await fetch(`${host}/ask/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: ticketFor(), decisions: [{ id: 'toolu_01A', approved: true }] }) });
    assert.equal(response.status, 502);
    const outcome = await response.json();
    assert.equal(outcome.type, 'error');
    assert.ok(outcome.message.startsWith('the graph did not answer - '), outcome.message);
  } finally {
    clear();
  }
});

test('a reply records the answer with who decided and the outcome', async () => {
  const store = recorder();
  const clear = configure({ ...BASE, [ask.GRAPHS]: graphs(), [ask.APP_TOKEN]: APP_TOKEN });
  try {
    engine.requests.length = 0;
    // the wait as person.ask records it; the reply's ticket is another one for the same turn
    const event = ask.buildEvent(ask.validateMessage(approvalMessage()), Buffer.from(KEY), REPLY_URL);
    const recorded = await store.record(event, isoUtc());
    assert.equal(recorded.state, 'open');
    const body = { ticket: ticketFor(), decisions: [{ id: 'toolu_01A', approved: true, note: 'Carrier confirmed' }], decided_by: 'operator-9' };
    let response = await fetch(`${host}/ask/reply`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${APP_TOKEN}` }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    const rows = await store.since(0, 10);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.id, recorded.id);
    assert.equal(row.state, 'answered');
    assert.equal(row.answered_by, 'operator-9');
    assert.ok(row.answered_at.endsWith('Z'));
    assert.ok(row.decisions[0].note.startsWith('[operator-9 at '));
    assert.ok(row.decisions[0].note.endsWith('] Carrier confirmed'));
    assert.deepEqual(row.outcome, { status: 200, body: { type: 'answer', turn: 3, run: 'resume', message: 'Your refund has been issued.' } });
    // a wait decided elsewhere: the engine says nothing waits; a wait nobody recorded is not written
    response = await fetch(`${host}/ask/reply`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: ticketFor({ cid: 'expired-case' }), decisions: [{ id: 'toolu_01A', approved: false }] }) });
    assert.equal(response.status, 410);
    const after = await store.since(0, 10);
    assert.equal(after.length, 1);
    assert.equal(after[0].answered_by, 'operator-9');
  } finally {
    clear();
    await defaultRegistry.bus.close();
    await ask.shutdown();
  }
});

test('the oauth2 mode validates an access token and the page learns how to sign in', async () => {
  const jose = await import('jose');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  engine.jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] };
  const clear = configure({ ...BASE, [ask.GRAPHS]: graphs(), [ask.REPLY_AUTH]: 'oauth2', [ask.OAUTH2_ISSUER]: ISSUER, [ask.OAUTH2_AUDIENCE]: AUDIENCE,
    [ask.OAUTH2_JWKS_URL]: `${engineUrl}/jwks`, [ask.OAUTH2_CLIENT_ID]: 'ask-page', [ask.APP_TOKEN]: APP_TOKEN, [ask.AUDIT_TIMEOUT]: '1s' });
  try {
    const sign = (key, audience = AUDIENCE) => new jose.SignJWT({ sub: 'u-17', preferred_username: 'operator-17' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISSUER).setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(key);
    const token = await sign(privateKey);
    const forged = await sign(other.privateKey);
    const wrongAudience = await sign(privateKey, 'someone-else');
    const body = { ticket: ticketFor(), decisions: [{ id: 'toolu_01A', approved: true }] };
    const post = (headers = {}, payload = body) => fetch(`${host}/ask/reply`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
    let response = await fetch(`${host}/ask/config`);
    assert.deepEqual(await response.json(), { auth: 'oauth2', oauth2: { issuer: ISSUER, client_id: 'ask-page', scopes: 'openid profile email', audience: AUDIENCE } });
    response = await fetch(`${host}/ask/${ticketFor()}`);
    assert.equal(response.status, 200, 'the shell is open: the script signs the person in');
    response = await fetch(`${host}/ask/${ticketFor()}/wait`);
    assert.equal(response.status, 401);
    assert.ok((await response.json()).message.includes('bearer access token'));
    response = await post();
    assert.equal(response.status, 401);
    assert.ok((await response.json()).message.includes('bearer access token'));
    response = await post({ authorization: `Bearer ${forged}` });
    assert.equal(response.status, 401);
    assert.ok((await response.json()).message.includes('ERR_JWS_SIGNATURE_VERIFICATION_FAILED'));
    response = await post({ authorization: `Bearer ${wrongAudience}` });
    assert.equal(response.status, 401);
    assert.ok((await response.json()).message.includes('ERR_JWT_CLAIM_VALIDATION_FAILED'));
    engine.requests.length = 0;
    response = await post({ authorization: `Bearer ${token}` });
    assert.equal(response.status, 200);
    assert.ok(engine.requests.at(-1).body.decisions[0].note.startsWith('[operator-17 at '));
    response = await fetch(`${host}/ask/${ticketFor()}/wait`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).advice.type, 'approval');
    // a channel app's bearer names the person it acts for, in this mode too
    response = await post({ authorization: `Bearer ${APP_TOKEN}` }, { ...body, decided_by: 'operator-9' });
    assert.equal(response.status, 200);
    assert.ok(engine.requests.at(-1).body.decisions[0].note.startsWith('[operator-9 at '));
  } finally {
    clear();
    await ask.shutdown();
  }
});

// --- the PostgreSQL store on a recording fake of the pool -------------------------------------------

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

function record(overrides = {}) {
  const now = new Date('2026-11-19T09:12:05.123Z');
  return {
    id: '7', seq: '12', ticket: 't-answer', graph_id: 'order-assistant', correlation_id: 'order-1002-case', turn: 2, kind: 'approval',
    description: 'Customer-support assistant', summary: 'A refund waits', details: null, message: { kind: 'approval', calls: CALLS },
    link: 'https://ask.example.test/ask/t-answer', state: 'open', requested_at: now, expires_at: new Date(now.getTime() + 2 * 86_400_000),
    updated_at: now, answered_at: null, answered_by: null, decisions: null, outcome: null, ...overrides
  };
}

test('the postgres store runs the statements and maps the records', async () => {
  const pool = new FakePool([record()]);
  const store = new ask.PostgresQuestionStore(pool);
  await store.open();
  assert.ok(pool.connected);
  const now = '2026-11-19T09:12:05.123Z';
  const event = ask.buildEvent(ask.validateMessage(approvalMessage({ requested_at: '2026-11-19T09:12:04.118Z' })), Buffer.from(KEY), REPLY_URL);
  const row = await store.record(event, now);
  let [sql, params] = pool.log.at(-1);
  assert.equal(sql, ask.SQL_RECORD_WAIT);
  assert.equal(params[0], event.ticket);
  assert.deepEqual(params.slice(1, 5), ['order-assistant', 'order-1002-case', 2, 'approval']);
  assert.deepEqual(JSON.parse(params[7]), event, 'the message travels as text for the jsonb column');
  assert.equal(params[9], '2026-11-19T09:12:04.118Z');
  assert.equal(params[11], now);
  assert.equal(row.id, 7);
  assert.equal(row.seq, 12);
  assert.equal(row.requested_at, '2026-11-19T09:12:05.123Z');
  assert.equal(row.expires_at, '2026-11-21T09:12:05.123Z');
  assert.deepEqual(row.message.calls, CALLS);
  const advice = ask.buildEvent(ask.validateMessage({ kind: 'advice', graph_id: 'order-assistant', description: 'Customer-support assistant', correlation_id: 'order-1002-case', summary: 'The queue is empty' }), Buffer.from(KEY), REPLY_URL);
  await store.record(advice, now);
  [sql, params] = pool.log.at(-1);
  assert.equal(sql, ask.SQL_RECORD_ADVICE);
  assert.deepEqual(params.slice(0, 2), ['order-assistant', 'order-1002-case']);
  // the guard kept a newer row (no row returned): the standing row is read
  pool.queue = [[], [record({ seq: '13' })]];
  const stale = await store.record(event, now);
  assert.deepEqual(pool.log.slice(-2).map((entry) => entry[0]), [ask.SQL_RECORD_WAIT, ask.SQL_WAIT]);
  assert.equal(stale.seq, 13);
  const answered = await store.answer(['order-assistant', 'order-1002-case', 2], [{ id: 'toolu_01A', approved: true }], 'operator-17', 'answered', { status: 200, body: { type: 'answer' } }, now);
  [sql, params] = pool.log.at(-1);
  assert.equal(sql, ask.SQL_ANSWER);
  assert.ok(answered);
  assert.equal(params[0], 'answered');
  assert.equal(params[3], 'operator-17');
  assert.deepEqual(params.slice(6, 9), ['order-assistant', 'order-1002-case', 2]);
  assert.equal(params[9], 'answered');
  assert.deepEqual(JSON.parse(params[1]), [{ id: 'toolu_01A', approved: true }]);
  // the guard kept the first decision (no row returned): the row as stored comes back
  pool.queue = [[], [record({ state: 'answered', answered_by: 'operator-3' })]];
  const kept = await store.answer(['order-assistant', 'order-1002-case', 2], [], 'operator-9', 'expired', { status: 410, body: { type: 'nothing-waiting' } }, now);
  assert.equal(kept.answered_by, 'operator-3');
  await store.expire(now);
  assert.deepEqual(pool.log.at(-1), [ask.SQL_EXPIRE, [now, now]]);
  await store.since(3, 50);
  assert.deepEqual(pool.log.at(-1), [ask.SQL_SINCE, [3, 50]]);
  pool.queue = [[{ label: 'open', count: '2' }, { label: 'advice', count: '1' }]];
  assert.deepEqual(await store.counts(), { open: 2, advice: 1 });
  await store.close();
  assert.ok(pool.ended);
  const mapped = ask.rowFromRecord(record({ kind: 'advice', state: null, ticket: null, link: null, decisions: '[{"id":"x","approved":true}]' }));
  assert.equal(mapped.state, null);
  assert.deepEqual(mapped.decisions, [{ id: 'x', approved: true }]);
  assert.equal(mapped.outcome, null);
  assert.equal(ask.failure(new RangeError('quotes a row')), 'RangeError');
  assert.equal(ask.failure(Object.assign(new Error('x'), { severity: 'ERROR', code: '23505' })), 'Error sqlstate=23505');
});

test('a configured driver that is not installed stops the boot by name', async () => {
  const clear = configure({ ...BASE, [ask.AUDIT]: 'postgres' });
  try {
    await assert.rejects(ask.postgresStore(clear.settings, async () => { throw Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' }); }),
      (e) => e instanceof ask.AskError && e.message === ask.MISSING_POSTGRES);
    // a fake driver: the pool is built from the connection keys and nothing connects until open()
    const built = [];
    const fakePg = { Pool: class { constructor(options) { built.push(options); } on() {} } };
    const store = await ask.postgresStore(clear.settings, async () => fakePg);
    assert.equal(store.name, 'postgres');
    assert.equal(built[0].database, 'mercury');
    assert.equal(built[0].statement_timeout, 5000);
  } finally {
    clear();
  }
});

// --- the host hook, the boot and the inspect command -------------------------------------------------

test('the host mounts the routes before the catch-all and keeps its own', async () => {
  const clear = configure(BASE);
  try {
    let response = await fetch(`${host}/nothing/here`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).status, 404, "the catch-all still answers the engines' shape");
    response = await fetch(`${host}/health`);
    assert.equal(response.status, 200, "the actuator stays the host's");
    response = await fetch(`${host}/ask/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 400, "the extension's path wins over the catch-all");
  } finally {
    clear();
  }
});

test('the platform hooks run the boot and fail by name', async () => {
  const clear = configure(BASE);
  const fresh = new Platform(new FunctionRegistry());
  ask.attach(fresh);
  try {
    const server = await fresh.run({ port: 0 });
    assert.ok(defaultRegistry.exists(ask.AUDIT_ROUTE), 'the boot registered the recorder');
    assert.equal(ask.questionStore().name, 'memory');
    assert.ok(ask.sweeperRunning());
    await close(server);
    await fresh.shutdown();
    assert.equal(ask.sweeperRunning(), false, 'the shutdown stopped the sweeper');
    appConfig().set(ask.TICKET_KEY, '');
    const failing = new Platform(new FunctionRegistry());
    ask.attach(failing);
    await assert.rejects(failing.run({ port: 0 }), (e) => e instanceof ask.AskError && e.message.includes('ask.ticket.key is not set'));
  } finally {
    clear();
  }
});

test('inspect reads a ticket or says why not', () => {
  const clear = configure(BASE);
  const lines = [];
  const original = console.log;
  console.log = (text) => lines.push(String(text));
  try {
    assert.equal(ask.inspect([ticketFor()]), 0);
    const shown = JSON.parse(lines[0]);
    assert.equal(shown.g, 'order-assistant');
    assert.ok(shown.expires_at.endsWith('Z'));
    assert.equal(ask.inspect([ticketFor({ expiresIn: -1 })]), 1);
    assert.equal(lines[1], '410 Ticket expired');
  } finally {
    console.log = original;
    clear();
  }
});

// --- a live PostgreSQL ---------------------------------------------------------------------------------

const LIVE = process.env.ASK_AUDIT_TEST_URL;
test('the record lands on a live postgres', { skip: !LIVE && 'set ASK_AUDIT_TEST_URL, e.g. postgres://mercury:...@127.0.0.1:5432/mercury?sslmode=disable' }, async () => {
  const pg = await import('pg');
  const Pool = pg.Pool ?? pg.default?.Pool;
  const pool = new Pool({ connectionString: LIVE, max: 2 });
  const store = new ask.PostgresQuestionStore(pool);
  await store.open();
  try {
    await pool.query(readFileSync(new URL('../extensions/ask-person/schema/postgres.sql', import.meta.url), 'utf8'));
    const cid = `live-${Date.now()}`;
    const key = Buffer.from(KEY);
    const event = (overrides) => ask.buildEvent(ask.validateMessage(approvalMessage(overrides)), key, REPLY_URL);
    const first = await store.record(event({ correlation_id: cid, requested_at: '2026-11-19T09:00:00.000Z' }), isoUtc());
    const again = await store.record(event({ correlation_id: cid, requested_at: '2026-11-19T09:05:00.000Z' }), isoUtc());
    assert.equal(again.id, first.id, 'the same turn upserts');
    assert.ok(again.seq > first.seq && again.ticket !== first.ticket);
    const stale = await store.record(event({ correlation_id: cid, requested_at: '2026-11-19T08:00:00.000Z' }), isoUtc());
    assert.equal(stale.seq, again.seq, 'an older message never overwrites a newer row');
    assert.equal(stale.ticket, again.ticket);
    const advice = await store.record(ask.buildEvent(ask.validateMessage({ kind: 'advice', graph_id: 'order-assistant', description: 'd', correlation_id: cid, summary: 's' }), key, REPLY_URL), isoUtc());
    assert.equal(advice.kind, 'advice');
    assert.equal(advice.state, null);
    const answered = await store.answer(['order-assistant', cid, 2], [{ id: 'toolu_01A', approved: true }], 'operator-17', 'answered', { status: 200, body: { type: 'answer' } }, isoUtc());
    assert.equal(answered.state, 'answered');
    const kept = await store.answer(['order-assistant', cid, 2], [{ id: 'toolu_01A', approved: false }], 'operator-9', 'expired', { status: 410, body: { type: 'nothing-waiting' } }, isoUtc());
    assert.equal(kept.answered_by, 'operator-17', 'the first accepted decision stands');
    assert.equal(await store.answer(['order-assistant', `${cid}-none`, 1], [], 'x', 'answered', {}, isoUtc()), null);
    const past = await store.record({ ...event({ correlation_id: `${cid}-b` }), expires_at: isoUtc(new Date(Date.now() - 1000)) }, isoUtc());
    const expired = await store.expire(isoUtc());
    assert.ok(expired.some((r) => r.id === past.id && r.state === 'expired'));
    const rows = await store.since(first.seq, 100);
    assert.ok([first.id, advice.id, past.id].every((id) => rows.some((r) => r.id === id)));
    assert.ok(((await store.counts()).answered ?? 0) >= 1);
  } finally {
    await store.close();
  }
});
