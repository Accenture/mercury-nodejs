/**
 * Ask a person - the main flow (extensions/ask-person/ask-person.mjs).
 *
 * The shared contract file test/vectors/ask-person-vectors.json (byte-identical in mercury-python) pins the pure
 * half: the ticket issued, verified, tampered, expired and rotated; the message validated in its fixed order and
 * the event built; the re-advice and the resume requests; the outcomes. The tests after the vector runs drive the
 * function on the bus with channels that take, refuse and miss the event, and the reply page and endpoint over the
 * host against a fake engine: the page shown and never resuming, the decisions forwarded with who decided prefixed
 * to each note, an expired ticket refused before the engine is called, the three auth modes (none, the gateway's
 * header, a signed access token against a JWKS the fake serves) and a channel app's bearer, the host hook that mounts
 * the routes before the catch-all, the boot that fails by name, the health route and the inspect command.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { AppException, appConfig, EventApiServer, FunctionRegistry, Platform, PostOffice } from 'mercury-composable';
import * as ask from '../extensions/ask-person/ask-person.mjs';

const VECTORS_FILE = new URL('./vectors/ask-person-vectors.json', import.meta.url);
// the Python twin runs the same file: change it in both packs or in neither
const VECTORS_SHA256 = '19533694e3f663222b113ad3ab4f09767599bffda01ed73e7702ecdd5fd9ef08';
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
  [ask.CHANNEL_ENDPOINTS]: [], [ask.GRAPHS]: [], [ask.REPLY_AUTH]: 'none', [ask.APP_TOKEN]: '' };

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
  assert.equal(VECTORS.version, 1);
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
  [{ [ask.REPLY_AUTH]: 'basic' }, 'ask.reply.auth must be one of none, proxy, oauth2'],
  [{ [ask.REPLY_AUTH]: 'proxy', [ask.AUTH_HEADER]: '' }, 'ask.reply.auth.header names the header'],
  [{ [ask.REPLY_AUTH]: 'oauth2' }, 'set ask.reply.auth.oauth2.issuer or ask.reply.auth.oauth2.jwks-url'],
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

test('the fan-out takes, refuses and misses channels on the default registry', async () => {
  const { defaultRegistry } = await import('mercury-composable');
  const taken = [];
  defaultRegistry.register('ask.test.channel', async (_h, body) => { taken.push(body); return { stored: true }; }, { instances: 1 });
  defaultRegistry.register('ask.test.refusing', async () => { throw new AppException(500, 'the channel is down'); }, { instances: 1 });
  const clear = configure({ ...BASE, [ask.CHANNELS]: ['ask.test.channel', 'ask.test.refusing', 'ask.test.missing'] });
  try {
    const result = await ask.personAsk({}, approvalMessage());
    assert.deepEqual(result.delivered, [
      { route: 'ask.test.channel', ok: true, status: 200 }, { route: 'ask.test.refusing', ok: false, status: 500 },
      { route: 'ask.test.missing', ok: false, status: 404 }
    ]);
    assert.equal(taken.length, 1);
    assert.equal(taken[0].ticket, result.ticket);
    assert.equal(taken[0].link, result.link);
    assert.deepEqual(taken[0].calls, CALLS);
    const advice = await ask.personAsk({}, { kind: 'advice', graph_id: 'order-assistant', description: 'd', correlation_id: 'c', turn: 3, summary: 's', details: 'x' });
    assert.deepEqual(advice, { delivered: [{ route: 'ask.test.channel', ok: true, status: 200 }, { route: 'ask.test.refusing', ok: false, status: 500 }, { route: 'ask.test.missing', ok: false, status: 404 }] });
    assert.equal(taken[1].ticket, undefined);
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

test('health reports the setup', async () => {
  const clear = configure({ ...BASE, [ask.CHANNELS]: ['a.route'], [ask.GRAPHS]: 'g1=http://e/1' });
  try {
    assert.deepEqual(await ask.askHealth({ type: 'info' }), { service: 'person.ask', href: 'http://127.0.0.1', enabled: true, channels: ['a.route'], graphs: ['g1'], reply_url: REPLY_URL, auth: 'none' });
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

test('the page shows the wait and never resumes', async () => {
  const clear = configure({ ...BASE, [ask.GRAPHS]: graphs() });
  try {
    engine.requests.length = 0;
    const ticket = ticketFor();
    const response = await fetch(`${host}/ask/${ticket}`);
    const page = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.deepEqual(engine.requests, [{ graph: 'order-assistant', cid: 'order-1002-case', body: { turn: 2 } }]);
    for (const expected of ['issue_refund - waits for a decision', 'ask_owner - a question', 'order_lookup - runs on resume', 'value="refund"', `data-ticket="${ticket}"`, 'data-reply="/ask/reply"', '&quot;order_id&quot;: &quot;ORD-1002&quot;']) {
      assert.ok(page.includes(expected), expected);
    }
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
    assert.equal(engine.requests.length, 0, 'no ticket above reached the engine');
    response = await fetch(`${host}/ask/${ticketFor({ cid: 'expired-case' })}`);
    assert.equal(response.status, 410);
    assert.ok((await response.text()).includes('This wait has expired'));
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

test("the proxy mode takes the gateway's header and a channel app its bearer", async () => {
  const clear = configure({ ...BASE, [ask.GRAPHS]: graphs(), [ask.REPLY_AUTH]: 'proxy', [ask.APP_TOKEN]: APP_TOKEN });
  try {
    engine.requests.length = 0;
    const body = { ticket: ticketFor(), decisions: [{ id: 'toolu_01A', approved: false }] };
    const post = (payload, headers = {}) => fetch(`${host}/ask/reply`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
    let response = await fetch(`${host}/ask/${ticketFor()}`);
    assert.equal(response.status, 401);
    assert.ok((await response.text()).includes('Sign-in required'));
    response = await post(body);
    assert.equal(response.status, 401);
    response = await post(body, { 'x-forwarded-user': 'operator-17' });
    assert.equal(response.status, 200);
    assert.ok(engine.requests.at(-1).body.decisions[0].note.startsWith('[operator-17 at '));
    response = await post({ ...body, decided_by: 'operator-9' }, { authorization: `Bearer ${APP_TOKEN}` });
    assert.equal(response.status, 200);
    assert.ok(engine.requests.at(-1).body.decisions[0].note.startsWith('[operator-9 at '));
    response = await post(body, { authorization: 'Bearer wrong' });
    assert.equal(response.status, 401);
    response = await fetch(`${host}/ask/${ticketFor()}`, { headers: { 'x-forwarded-user': 'operator-17' } });
    assert.equal(response.status, 200);
  } finally {
    clear();
  }
});

test("the oauth2 mode validates an access token against the issuer's keys", async () => {
  const jose = await import('jose');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  engine.jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] };
  const clear = configure({ ...BASE, [ask.GRAPHS]: graphs(), [ask.REPLY_AUTH]: 'oauth2', [ask.OAUTH2_ISSUER]: ISSUER, [ask.OAUTH2_AUDIENCE]: AUDIENCE, [ask.OAUTH2_JWKS_URL]: `${engineUrl}/jwks` });
  try {
    const sign = (key, audience = AUDIENCE) => new jose.SignJWT({ sub: 'u-17', preferred_username: 'operator-17' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISSUER).setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(key);
    const token = await sign(privateKey);
    const forged = await sign(other.privateKey);
    const wrongAudience = await sign(privateKey, 'someone-else');
    const body = { ticket: ticketFor(), decisions: [{ id: 'toolu_01A', approved: true }] };
    const post = (headers = {}) => fetch(`${host}/ask/reply`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    let response = await post();
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
    response = await fetch(`${host}/ask/${ticketFor()}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
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
    await close(server);
    await fresh.shutdown();
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
