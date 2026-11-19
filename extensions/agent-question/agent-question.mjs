/**
 * The agent-question app - the first channel of RFC-0014 (the engines' draft-design-specs/ask-a-person-channel.md,
 * Part II), the Node.js twin of mercury-python's extensions/agent-question: a store-and-forward inbox for a person
 * whose device is not always connected, standing beside a chat, a mail server or a topic as one channel among equals.
 * The main flow (person.ask in extensions/ask-person) knows nothing of it: it sends one message event with the resume
 * link to the routes it is configured with, and this application is one of those routes.
 *
 * - agent.question.inbox is the intake, a composable function reached over Event-over-HTTP like any peer function. A
 *   wait (kind approval or question) is upserted on (graph_id, correlation_id, turn) - a re-advice for the same turn
 *   updates the card rather than adding one - and an advice (a status update, an acknowledgement, an outcome) is
 *   appended. Write first: the row is committed before any push to a browser.
 * - The browser side runs under the pack's host (Platform.addRoutes): GET /questions/app is the page,
 *   GET /questions?since=<seq> the replay a reconnecting device calls first - every row that changed since its cursor -
 *   and GET /questions/events the stream a connected device holds; Last-Event-ID is the same cursor. The person selects
 *   which card to answer; the card's button automates the click: POST /questions/{id}/decide posts
 *   {ticket, decisions, decided_by} to the main flow's reply endpoint - the link's own base, under this app's bearer -
 *   records the outcome on the row and tells every connected device. POST /questions/{id}/seen marks an advice read.
 * - The inbox is PostgreSQL (question.inbox: postgres, the pg driver, schema/postgres.sql) or, for development and
 *   tests, memory. The engine stays the authority on an answer; rows are never deleted here (schema/purge.sql is the
 *   installation's). Who may use the page is question.auth: none (development), proxy (the installation's SSO, a
 *   trusted header set by the gateway) or oauth2 (an access token validated against the issuer's published keys).
 *
 * Run:  node dist/src/cli.js extensions/agent-question/agent-question.mjs
 *
 * The pure half is pinned by test/vectors/agent-question-vectors.json, byte-identical with the Python pack.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppException, appConfig, getLogger, isoUtc, loadConfig, platform, preload } from 'mercury-composable';

const log = getLogger('agent-question');
const HERE = dirname(fileURLToPath(import.meta.url));

// --- the contract -----------------------------------------------------------------------------

export const INTAKE_ROUTE = 'agent.question.inbox';
export const HEALTH_ROUTE = 'question.health';
export const KINDS = ['approval', 'question', 'advice'];
export const WAIT_KINDS = ['approval', 'question'];
export const STATES = ['open', 'answered', 'expired', 'seen'];
export const PAGE_PATH = '/questions/app';
export const LIST_PATH = '/questions';
export const EVENTS_PATH = '/questions/events';
export const AUTH_MODES = ['none', 'proxy', 'oauth2'];
export const JWT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512'];
export const LIST_LIMIT = 200;
export const LIST_LIMIT_MAX = 1000;

// configuration keys
export const INBOX = 'question.inbox';
export const POSTGRES_PREFIX = 'question.inbox.postgres.';
export const SWEEP = 'question.sweep';
export const AUTH = 'question.auth';
export const AUTH_HEADER = 'question.auth.header';
export const OAUTH2_ISSUER = 'question.auth.oauth2.issuer';
export const OAUTH2_AUDIENCE = 'question.auth.oauth2.audience';
export const OAUTH2_JWKS_URL = 'question.auth.oauth2.jwks-url';
export const REPLY_TOKEN = 'question.reply.token';
export const REPLY_TIMEOUT = 'question.reply.timeout';
export const PAGE_TITLE = 'question.page.title';

export const MISSING_POSTGRES = 'question.inbox is postgres but the pg driver is not installed - npm install pg';
const DURATION = /^(\d+)\s*(ms|s|m|h|d)?$/;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A configuration the application cannot start with - the boot fails by name. */
export class QuestionError extends Error {}

/** A request the page or a channel client made that cannot be served: its status and message. */
export class ReplyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isMap = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === 'string';
const isWhole = (value) => typeof value === 'number' && Number.isInteger(value);

export function durationMs(value) {
  if (typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value * 1000 : null;
  if (!isText(value)) return null;
  const match = DURATION.exec(value.trim());
  if (!match) return null;
  return Number.parseInt(match[1], 10) * UNIT_MS[match[2] ?? 's'];
}

export function parseIso(text) {
  const candidate = String(text).trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(candidate)) return null;
  const ms = Date.parse(candidate);
  return Number.isNaN(ms) ? null : new Date(ms);
}

// --- configuration ----------------------------------------------------------------------------

function text(config, key, defaultValue = '') {
  const value = config.get(key);
  return value === undefined || value === null ? defaultValue : String(value).trim();
}

function timeout(config, key, defaultValue) {
  const value = config.get(key);
  const ms = durationMs(value === undefined || value === null ? defaultValue : value);
  if (ms === null || ms <= 0) throw new QuestionError(`${key} must be a duration such as 10s or 2m (seconds, s, m, h, d) > 0`);
  return ms;
}

/** A key named in milliseconds (timeout.ms): a whole number > 0. */
function wholeMs(config, key, defaultValue) {
  const value = config.get(key);
  const candidate = String(value === undefined || value === null ? defaultValue : value).trim();
  if (!/^\d+$/.test(candidate) || Number.parseInt(candidate, 10) <= 0) {
    throw new QuestionError(`${key} must be a whole number of milliseconds > 0`);
  }
  return Number.parseInt(candidate, 10);
}

export function loadSettings(config) {
  const inbox = text(config, INBOX, 'memory').toLowerCase();
  if (!['memory', 'postgres'].includes(inbox)) throw new QuestionError(`${INBOX} must be memory or postgres`);
  const auth = text(config, AUTH, 'none').toLowerCase();
  if (!AUTH_MODES.includes(auth)) throw new QuestionError(`${AUTH} must be one of ${AUTH_MODES.join(', ')}`);
  const authHeader = text(config, AUTH_HEADER, 'x-forwarded-user').toLowerCase();
  if (auth === 'proxy' && !authHeader) throw new QuestionError(`${AUTH_HEADER} names the header the gateway sets - it must not be empty`);
  const issuer = text(config, OAUTH2_ISSUER).replace(/\/+$/, '');
  const jwksUrl = text(config, OAUTH2_JWKS_URL);
  if (auth === 'oauth2' && !issuer && !jwksUrl) throw new QuestionError(`${AUTH} is oauth2 - set ${OAUTH2_ISSUER} or ${OAUTH2_JWKS_URL}`);
  const timeoutMs = wholeMs(config, `${POSTGRES_PREFIX}timeout.ms`, 5000);
  const portText = text(config, `${POSTGRES_PREFIX}port`, '5432');
  if (!/^\d+$/.test(portText) || Number.parseInt(portText, 10) <= 0) throw new QuestionError(`${POSTGRES_PREFIX}port must be a port number`);
  const ssl = text(config, `${POSTGRES_PREFIX}ssl`, 'true').toLowerCase() !== 'false';
  return {
    inbox,
    postgres: {
      host: text(config, `${POSTGRES_PREFIX}host`, '127.0.0.1'),
      port: Number.parseInt(portText, 10),
      database: text(config, `${POSTGRES_PREFIX}database`, 'mercury'),
      user: text(config, `${POSTGRES_PREFIX}username`) || undefined,
      password: text(config, `${POSTGRES_PREFIX}password`) || undefined,
      // the twin of libpq's sslmode=require (the audit store's rule); sslmode=disable when false
      ssl: ssl ? { rejectUnauthorized: false } : false,
      max: 4,
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
      statement_timeout: timeoutMs
    },
    postgresTimeoutMs: timeoutMs,
    sweepMs: timeout(config, SWEEP, '30s'),
    auth,
    authHeader,
    oauth2Issuer: issuer,
    oauth2Audience: text(config, OAUTH2_AUDIENCE),
    oauth2JwksUrl: jwksUrl,
    replyToken: text(config, REPLY_TOKEN),
    replyTimeoutMs: timeout(config, REPLY_TIMEOUT, '10s'),
    pageTitle: text(config, PAGE_TITLE, 'Agent questions')
  };
}

let settings;

export function configure(config) {
  settings = loadSettings(config ?? appConfig());
  return settings;
}

export function currentSettings() {
  return settings ?? configure();
}

// --- the row and the pure half ----------------------------------------------------------------

/** The row as the page and the replay carry it. */
export function publicRow(row) {
  return {
    id: row.id, seq: row.seq, kind: row.kind, graph_id: row.graph_id, correlation_id: row.correlation_id, turn: row.turn,
    ticket: row.ticket, link: row.link, description: row.description, summary: row.summary, details: row.details,
    calls: row.message?.calls ?? null, state: row.state, requested_at: row.requested_at, expires_at: row.expires_at,
    updated_at: row.updated_at, answered_at: row.answered_at, answered_by: row.answered_by, decisions: row.decisions,
    outcome: row.outcome
  };
}

/** The message event the main flow sends, checked for what a row stores - or an AppException(400). */
export function validateEvent(event) {
  if (!isMap(event)) throw new AppException(400, 'the inbox takes the message event as a map');
  const kind = event.kind;
  if (!KINDS.includes(kind)) throw new AppException(400, 'kind must be one of approval, question, advice');
  for (const name of ['graph_id', 'description', 'correlation_id', 'summary']) {
    const value = event[name];
    if (!isText(value) || !value.trim()) throw new AppException(400, `${name} is required`);
  }
  const turn = event.turn;
  if (turn !== undefined && turn !== null && (!isWhole(turn) || turn < 0)) throw new AppException(400, 'turn must be a whole number >= 0');
  if (WAIT_KINDS.includes(kind)) {
    if (turn === undefined || turn === null) throw new AppException(400, 'turn is required for an approval or a question');
    for (const name of ['ticket', 'link', 'expires_at']) {
      if (!isText(event[name]) || !event[name]) throw new AppException(400, `${name} is required for an approval or a question`);
    }
    if (!Array.isArray(event.calls) || event.calls.length === 0) {
      throw new AppException(400, 'calls must be a non-empty list for an approval or a question');
    }
  }
  for (const name of ['details', 'requested_at']) {
    if (event[name] !== undefined && event[name] !== null && !isText(event[name])) throw new AppException(400, `${name} must be text`);
  }
  return { ...event };
}

/** The key a wait upserts on; an advice has none and appends. */
export function waitKey(event) {
  if (!WAIT_KINDS.includes(event.kind)) return null;
  return [String(event.graph_id), String(event.correlation_id), Number(event.turn)];
}

/** What a row takes from a message event. */
export function rowFields(event, now) {
  const wait = WAIT_KINDS.includes(event.kind);
  return {
    kind: event.kind,
    graph_id: event.graph_id,
    correlation_id: event.correlation_id,
    turn: event.turn ?? null,
    ticket: wait ? (event.ticket ?? null) : null,
    link: wait ? (event.link ?? null) : null,
    description: event.description,
    summary: event.summary,
    details: event.details ?? null,
    message: { ...event },
    state: 'open',
    requested_at: event.requested_at || now,
    expires_at: wait ? (event.expires_at ?? null) : null,
    updated_at: now,
    answered_at: null,
    answered_by: null,
    decisions: null,
    outcome: null
  };
}

/** The state a decision's outcome leaves: answered, expired, or open (refused or unreachable). */
export function stateAfter(status, body) {
  const kind = isMap(body) ? body.type : null;
  if (status === 410 || kind === 'nothing-waiting') return 'expired';
  if (status !== null && status !== undefined && status >= 200 && status < 300 && !(isMap(body) && body.error)) return 'answered';
  return 'open';
}

/** The click, automated: the reply endpoint is the link's own base, the body what a person's browser would post. */
export function replyRequest(link, ticket, decisions, who) {
  const at = link.indexOf('/ask/');
  if (at < 0) throw new ReplyError(409, "the row's link does not name a reply endpoint");
  return [`${link.slice(0, at)}/ask/reply`, { ticket, decisions: decisions.map((d) => ({ ...d })), decided_by: who }];
}

// --- the inboxes ------------------------------------------------------------------------------

/** The reference semantics in one process: ids and a change sequence assigned here. */
export class MemoryInbox {
  name = 'memory';

  constructor() {
    this.rows = new Map();
    this.keys = new Map();
    this.nextId = 0;
    this.seq = 0;
  }

  async open() {}

  async close() {}

  bump() {
    this.seq += 1;
    return this.seq;
  }

  async take(event, now) {
    const fields = rowFields(event, now);
    const key = waitKey(event);
    const keyText = key ? key.join('\u0000') : null;
    const existingId = keyText !== null ? this.keys.get(keyText) : undefined;
    let row;
    if (existingId !== undefined) {
      row = { ...this.rows.get(existingId), ...fields, seq: this.bump() };
    } else {
      this.nextId += 1;
      row = { id: this.nextId, seq: this.bump(), ...fields };
      if (keyText !== null) this.keys.set(keyText, row.id);
    }
    this.rows.set(row.id, row);
    return row;
  }

  async get(id) {
    return this.rows.get(id) ?? null;
  }

  async since(seq, limit) {
    return [...this.rows.values()].filter((r) => r.seq > seq).sort((a, b) => a.seq - b.seq).slice(0, limit);
  }

  async decided(id, decisions, who, state, outcome, now) {
    const row = this.rows.get(id);
    if (!row) return null;
    const updated = { ...row, seq: this.bump(), state, decisions, outcome, answered_by: who, answered_at: now, updated_at: now };
    this.rows.set(id, updated);
    return updated;
  }

  async seen(id, now) {
    const row = this.rows.get(id);
    if (!row) return null;
    const updated = { ...row, seq: this.bump(), state: 'seen', updated_at: now };
    this.rows.set(id, updated);
    return updated;
  }

  async expire(now) {
    const changed = [];
    for (const row of [...this.rows.values()]) {
      if (row.state === 'open' && WAIT_KINDS.includes(row.kind) && row.expires_at && row.expires_at < now) {
        const updated = { ...row, seq: this.bump(), state: 'expired', updated_at: now };
        this.rows.set(row.id, updated);
        changed.push(updated);
      }
    }
    return changed;
  }

  async counts() {
    const result = {};
    for (const row of this.rows.values()) result[row.state] = (result[row.state] ?? 0) + 1;
    return result;
  }
}

// the statements the reference inbox runs, with pg's placeholders; JSON travels as compact text cast to jsonb and
// stamps as text cast to timestamptz, so the Python twin runs the same statements
export const COLUMNS = 'id, seq, ticket, graph_id, correlation_id, turn, kind, description, summary, details, message, link, '
  + 'state, requested_at, expires_at, updated_at, answered_at, answered_by, decisions, outcome';
export const SQL_UPSERT_WAIT = 'INSERT INTO question_inbox (seq, ticket, graph_id, correlation_id, turn, kind, description, summary, '
  + "details, message, link, state, requested_at, expires_at, updated_at) VALUES (nextval('question_inbox_seq'), $1, $2, $3, $4, $5, "
  + "$6, $7, NULL, $8::jsonb, $9, 'open', $10::timestamptz, $11::timestamptz, $12::timestamptz) "
  + "ON CONFLICT (graph_id, correlation_id, turn) WHERE kind <> 'advice' DO UPDATE SET seq = nextval('question_inbox_seq'), "
  + 'ticket = EXCLUDED.ticket, description = EXCLUDED.description, summary = EXCLUDED.summary, details = NULL, '
  + "message = EXCLUDED.message, link = EXCLUDED.link, state = 'open', requested_at = EXCLUDED.requested_at, "
  + 'expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at, answered_at = NULL, answered_by = NULL, '
  + `decisions = NULL, outcome = NULL RETURNING ${COLUMNS}`;
export const SQL_INSERT_ADVICE = 'INSERT INTO question_inbox (seq, ticket, graph_id, correlation_id, turn, kind, description, summary, '
  + "details, message, link, state, requested_at, expires_at, updated_at) VALUES (nextval('question_inbox_seq'), NULL, $1, $2, $3, "
  + `'advice', $4, $5, $6, $7::jsonb, NULL, 'open', $8::timestamptz, NULL, $9::timestamptz) RETURNING ${COLUMNS}`;
export const SQL_GET = `SELECT ${COLUMNS} FROM question_inbox WHERE id = $1`;
export const SQL_SINCE = `SELECT ${COLUMNS} FROM question_inbox WHERE seq > $1 ORDER BY seq LIMIT $2`;
export const SQL_DECIDED = "UPDATE question_inbox SET seq = nextval('question_inbox_seq'), state = $1, decisions = $2::jsonb, "
  + 'outcome = $3::jsonb, answered_by = $4, answered_at = $5::timestamptz, updated_at = $6::timestamptz '
  + `WHERE id = $7 RETURNING ${COLUMNS}`;
export const SQL_SEEN = "UPDATE question_inbox SET seq = nextval('question_inbox_seq'), state = 'seen', updated_at = $1::timestamptz "
  + `WHERE id = $2 AND kind = 'advice' RETURNING ${COLUMNS}`;
export const SQL_EXPIRE = "UPDATE question_inbox SET seq = nextval('question_inbox_seq'), state = 'expired', updated_at = $1::timestamptz "
  + `WHERE state = 'open' AND kind <> 'advice' AND expires_at < $2::timestamptz RETURNING ${COLUMNS}`;
export const SQL_COUNTS = 'SELECT state, count(*) FROM question_inbox GROUP BY state';

const compact = (value) => JSON.stringify(value);

function stamp(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return isoUtc(value);
  const parsed = parseIso(String(value));
  return parsed ? isoUtc(parsed) : String(value);
}

const json = (value) => (typeof value === 'string' ? JSON.parse(value) : (value ?? null));

/** A row from a record as pg returns it (jsonb parsed, timestamptz as Dates, int8 as text). */
export function rowFromRecord(record) {
  return {
    id: Number(record.id), seq: Number(record.seq), kind: String(record.kind), graph_id: String(record.graph_id),
    correlation_id: String(record.correlation_id), turn: record.turn === null || record.turn === undefined ? null : Number(record.turn),
    ticket: record.ticket ?? null, link: record.link ?? null, description: String(record.description), summary: String(record.summary),
    details: record.details ?? null, message: json(record.message) ?? {}, state: String(record.state),
    requested_at: stamp(record.requested_at) ?? '', expires_at: stamp(record.expires_at), updated_at: stamp(record.updated_at) ?? '',
    answered_at: stamp(record.answered_at), answered_by: record.answered_by ?? null, decisions: json(record.decisions),
    outcome: json(record.outcome)
  };
}

/** The reference inbox: the pg driver's pool. The application inserts, selects and updates one table and nothing else. */
export class PostgresInbox {
  name = 'postgres';

  constructor(pool) {
    this.pool = pool; // pg.Pool, or a recording fake in the tests
  }

  async open() {
    // a connection taken and returned: a database that does not answer stops the boot by name
    const client = await this.pool.connect();
    client.release();
  }

  async close() {
    await this.pool.end();
  }

  async one(sql, params) {
    const { rows } = await this.pool.query(sql, params);
    return rows.length > 0 ? rowFromRecord(rows[0]) : null;
  }

  async many(sql, params) {
    const { rows } = await this.pool.query(sql, params);
    return rows.map(rowFromRecord);
  }

  async take(event, now) {
    const f = rowFields(event, now);
    const row = waitKey(event) !== null
      ? await this.one(SQL_UPSERT_WAIT, [f.ticket, f.graph_id, f.correlation_id, f.turn, f.kind, f.description, f.summary,
        compact(f.message), f.link, f.requested_at, f.expires_at, now])
      : await this.one(SQL_INSERT_ADVICE, [f.graph_id, f.correlation_id, f.turn, f.description, f.summary, f.details,
        compact(f.message), f.requested_at, now]);
    if (!row) throw new AppException(500, 'the inbox returned no row');
    return row;
  }

  async get(id) {
    return this.one(SQL_GET, [id]);
  }

  async since(seq, limit) {
    return this.many(SQL_SINCE, [seq, limit]);
  }

  async decided(id, decisions, who, state, outcome, now) {
    return this.one(SQL_DECIDED, [state, compact(decisions), compact(outcome), who, now, now, id]);
  }

  async seen(id, now) {
    return this.one(SQL_SEEN, [now, id]);
  }

  async expire(now) {
    return this.many(SQL_EXPIRE, [now, now]);
  }

  async counts() {
    const { rows } = await this.pool.query(SQL_COUNTS, []);
    const result = {};
    for (const row of rows) result[String(row.state)] = Number(row.count);
    return result;
  }
}

/** The pool from the question.inbox.postgres.* keys; nothing connects until open(). */
export async function postgresInbox(config, importer = (name) => import(name)) {
  let pg;
  try {
    pg = await importer('pg');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') throw new QuestionError(MISSING_POSTGRES);
    throw error;
  }
  const Pool = pg.Pool ?? pg.default?.Pool;
  const pool = new Pool({ ...config.postgres });
  pool.on('error', (error) => log.warn(`inbox - ${error.name}: ${error.message}`));
  return new PostgresInbox(pool);
}

/** A failure as a log may carry it: the type and the database's SQLSTATE, never a message that could quote a row. */
export function failure(error) {
  const constructor = error?.constructor?.name;
  const name = constructor && constructor !== 'Object' ? constructor : (error?.name ?? 'Error');
  const database = error?.severity !== undefined || name === 'DatabaseError';
  return database && error?.code ? `${name} sqlstate=${error.code}` : name;
}

// --- the wake-ups -----------------------------------------------------------------------------

/** Every connected device holds a queue; a changed row goes to all of them. */
export class Wakeups {
  constructor() {
    this.queues = new Set();
  }

  subscribe() {
    const queue = { items: [], waiter: null };
    this.queues.add(queue);
    return queue;
  }

  unsubscribe(queue) {
    this.queues.delete(queue);
  }

  publish(rows) {
    for (const queue of this.queues) {
      for (const row of rows) queue.items.push(row);
      if (queue.waiter && queue.items.length > 0) {
        const wake = queue.waiter;
        queue.waiter = null;
        wake();
      }
    }
  }

  /** The next row of a queue, or null after the wait. */
  static async next(queue, waitMs) {
    if (queue.items.length > 0) return queue.items.shift();
    let timer;
    const woken = new Promise((resolveWait) => {
      queue.waiter = resolveWait;
    });
    const timedOut = new Promise((resolveWait) => {
      timer = setTimeout(() => resolveWait('timeout'), waitMs);
    });
    const outcome = await Promise.race([woken, timedOut]);
    clearTimeout(timer);
    queue.waiter = null;
    return outcome === 'timeout' && queue.items.length === 0 ? null : (queue.items.shift() ?? null);
  }

  get connected() {
    return this.queues.size;
  }
}

let theInbox = null;
export let wakeups = new Wakeups();
let sweeper = null;

export function inbox() {
  theInbox ??= new MemoryInbox();
  return theInbox;
}

/** A test hook: a fresh inbox and fresh wake-ups. */
export function reset(freshInbox = new MemoryInbox()) {
  theInbox = freshInbox;
  wakeups = new Wakeups();
}

// --- the intake -------------------------------------------------------------------------------

/** Take a message event from the main flow: a wait upserted, an advice appended, every connected device told. */
export async function intake(_headers, body) {
  const event = validateEvent(body);
  let row;
  try {
    row = await inbox().take(event, isoUtc());
  } catch (error) {
    // the main flow logs a channel failure by type and never fails the hold
    log.warn(`The inbox could not take a ${event.kind} for ${event.graph_id} - ${failure(error)}`);
    throw new AppException(503, 'the inbox is not available');
  }
  wakeups.publish([row]);
  log.info(`Inbox took ${row.kind} ${row.id} for ${row.graph_id} turn ${row.turn} (seq ${row.seq})`);
  return { stored: true, id: row.id, seq: row.seq, state: row.state };
}

export async function questionHealth(headers) {
  const config = currentSettings();
  if (headers.type === 'info') {
    let counts;
    try {
      counts = await inbox().counts();
    } catch (error) {
      counts = { error: failure(error) };
    }
    return { service: INTAKE_ROUTE, href: 'http://127.0.0.1', inbox: inbox().name, rows: counts, connected: wakeups.connected, auth: config.auth };
  }
  return 'agent.question.inbox is running fine';
}

preload(INTAKE_ROUTE, { instances: 1 }, intake);
preload(HEALTH_ROUTE, { instances: 5, isPrivate: true }, questionHealth);

// --- identity ---------------------------------------------------------------------------------

function bearerOf(req) {
  const value = req.headers.authorization ?? '';
  const at = value.indexOf(' ');
  if (at < 0) return null;
  const token = value.slice(at + 1).trim();
  return value.slice(0, at).toLowerCase() === 'bearer' && token ? token : null;
}

/** The same verifier as the main flow's reply endpoint (extensions/ask-person): jose against the issuer's keys. */
export class OAuth2Verifier {
  constructor(issuer, audience, jwksUrl) {
    this.issuer = issuer;
    this.audience = audience;
    this.jwksUrl = jwksUrl;
    this.jwks = null;
  }

  async keys() {
    if (this.jwks) return this.jwks;
    const jose = await import('jose');
    let url = this.jwksUrl;
    if (!url) {
      const response = await fetch(`${this.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new ReplyError(503, `the issuer's keys are not reachable - ${response.status}`);
      const discovery = await response.json();
      url = isMap(discovery) && discovery.jwks_uri ? String(discovery.jwks_uri) : '';
      if (!url) throw new ReplyError(503, 'the issuer publishes no jwks_uri');
      this.jwksUrl = url;
    }
    this.jwks = jose.createRemoteJWKSet(new URL(url));
    return this.jwks;
  }

  async verify(token) {
    const jose = await import('jose');
    const keys = await this.keys();
    try {
      const { payload } = await jose.jwtVerify(token, keys, {
        issuer: this.issuer || undefined, audience: this.audience || undefined, algorithms: [...JWT_ALGORITHMS], requiredClaims: ['exp']
      });
      return payload;
    } catch (error) {
      if (error instanceof ReplyError) throw error;
      throw new ReplyError(401, `the access token was not accepted - ${error?.code ?? error?.name ?? 'error'}`);
    }
  }
}

let verifier;

function oauth2(config) {
  if (!verifier || verifier.issuer !== config.oauth2Issuer || verifier.audience !== config.oauth2Audience
      || (config.oauth2JwksUrl && verifier.jwksUrl !== config.oauth2JwksUrl)) {
    verifier = new OAuth2Verifier(config.oauth2Issuer, config.oauth2Audience, config.oauth2JwksUrl);
  }
  return verifier;
}

/** Who is at the page: nobody is asked in development, the gateway's trusted header, or a validated access token. */
export async function identify(req, config, claimed) {
  if (config.auth === 'none') return { who: claimed || 'anonymous', via: 'none' };
  if (config.auth === 'proxy') {
    const who = String(req.headers[config.authHeader] ?? '').trim();
    if (!who) throw new ReplyError(401, `sign-in required - the ${config.authHeader} header names the person`);
    return { who, via: 'proxy' };
  }
  const bearer = bearerOf(req);
  if (!bearer) throw new ReplyError(401, 'sign-in required - a bearer access token');
  const claims = await oauth2(config).verify(bearer);
  const who = claims.preferred_username || claims.email || claims.sub;
  if (!who) throw new ReplyError(401, 'the access token names nobody');
  return { who: String(who), via: 'oauth2' };
}

// --- the browser side -------------------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const sendError = (res, status, message) => sendJson(res, status, { type: 'error', message });

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Open waits past their expiry become expired, and every device is told. */
async function expireNow() {
  let changed;
  try {
    changed = await inbox().expire(isoUtc());
  } catch (error) {
    log.warn(`The inbox could not expire its waits - ${failure(error)}`);
    return;
  }
  if (changed.length > 0) wakeups.publish(changed);
}

/** GET /questions?since=<seq>&limit=<n>: every row that changed since the cursor, and the cursor to continue from. */
export async function listRows(req, res, url) {
  const config = currentSettings();
  try {
    await identify(req, config, null);
  } catch (error) {
    if (!(error instanceof ReplyError)) throw error;
    return sendError(res, error.status, error.message);
  }
  const since = Number(url.searchParams.get('since') ?? '0');
  const limitRaw = Number(url.searchParams.get('limit') ?? String(LIST_LIMIT));
  if (!Number.isInteger(since) || !Number.isInteger(limitRaw)) return sendError(res, 400, 'since and limit must be whole numbers');
  const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, limitRaw));
  await expireNow();
  let rows;
  try {
    rows = await inbox().since(since, limit);
  } catch (error) {
    log.warn(`The inbox could not list - ${failure(error)}`);
    return sendError(res, 503, 'the inbox is not available');
  }
  return sendJson(res, 200, {
    since, rows: rows.map(publicRow), next: Math.max(since, ...rows.map((r) => r.seq)), more: rows.length >= limit
  });
}

const frame = (row) => `id: ${row.seq}\nevent: question\ndata: ${JSON.stringify(publicRow(row))}\n\n`;

/** The host's SSE keep-alive interval (event.stream.keep.alive, the engines' key; default 30s, 0 disables). */
export function keepAliveMs() {
  const raw = String(appConfig().getProperty('event.stream.keep.alive', '30s') ?? '30s').trim().toLowerCase();
  if (['0', '0s', '0ms', '0m'].includes(raw)) return 0;
  const match = /^(\d+)(ms|s|m)?$/.exec(raw);
  if (!match) return 30_000;
  const unit = match[2] ?? 's';
  return Number.parseInt(match[1], 10) * (unit === 'ms' ? 1 : unit === 'm' ? 60_000 : 1000);
}

/** GET /questions/events: rows since Last-Event-ID (or since) first, then every change; keep-alive comments. */
export async function events(req, res, url) {
  const config = currentSettings();
  try {
    await identify(req, config, null);
  } catch (error) {
    if (!(error instanceof ReplyError)) throw error;
    return sendError(res, error.status, error.message);
  }
  let since = Number(req.headers['last-event-id'] || url.searchParams.get('since') || '0');
  if (!Number.isInteger(since)) return sendError(res, 400, 'Last-Event-ID must be a whole number');
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  const queue = wakeups.subscribe();
  const pingMs = keepAliveMs();
  try {
    await expireNow();
    for (const row of await inbox().since(since, LIST_LIMIT_MAX)) {
      res.write(frame(row));
      since = row.seq;
    }
    while (!res.writableEnded && !res.destroyed) {
      const row = await Wakeups.next(queue, pingMs > 0 ? pingMs : 3_600_000);
      if (res.writableEnded || res.destroyed) break;
      if (row === null) {
        res.write(': ping\n\n');
        continue;
      }
      if (row.seq > since) {
        res.write(frame(row));
        since = row.seq;
      }
    }
  } finally {
    wakeups.unsubscribe(queue);
  }
  if (!res.writableEnded) res.end();
}

async function forward(url, body, config) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (config.replyToken) headers.authorization = `Bearer ${config.replyToken}`;
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(config.replyTimeoutMs) });
    const textBody = await response.text();
    let parsed;
    try {
      parsed = textBody ? JSON.parse(textBody) : null;
    } catch {
      parsed = { text: textBody.slice(0, 500) };
    }
    return [response.status, parsed, null];
  } catch (error) {
    return [null, null, error?.cause?.code ?? error?.name ?? 'Error'];
  }
}

/** POST /questions/{id}/decide with {decisions, decided_by?}: the click, automated. */
export async function decide(req, res, id) {
  const config = currentSettings();
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    body = null;
  }
  if (!isMap(body)) return sendError(res, 400, 'the decision must be a JSON map with decisions');
  const claimed = body.decided_by;
  if (claimed !== undefined && claimed !== null && !isText(claimed)) return sendError(res, 400, 'decided_by must be text');
  let identity;
  try {
    identity = await identify(req, config, claimed || null);
  } catch (error) {
    if (!(error instanceof ReplyError)) throw error;
    return sendError(res, error.status, error.message);
  }
  const decisions = body.decisions;
  if (!Array.isArray(decisions) || decisions.length === 0 || !decisions.every(isMap)) {
    return sendError(res, 400, 'decisions must be a non-empty list, one per waiting call');
  }
  const row = await inbox().get(id);
  if (!row) return sendError(res, 404, `row ${id} is not in the inbox`);
  if (!WAIT_KINDS.includes(row.kind) || !row.ticket || !row.link) return sendError(res, 409, `row ${id} is an advice - nothing to decide`);
  if (row.state !== 'open') return sendError(res, 409, `row ${id} is ${row.state} - decided by ${row.answered_by ?? 'nobody'}`);
  let target;
  try {
    target = replyRequest(row.link, row.ticket, decisions, identity.who);
  } catch (error) {
    if (!(error instanceof ReplyError)) throw error;
    return sendError(res, error.status, error.message);
  }
  const [status, answer, error] = await forward(target[0], target[1], config);
  const outcome = error
    ? { status: 502, body: { type: 'error', message: `the reply endpoint did not answer - ${error}` } }
    : { status, body: answer };
  const state = stateAfter(outcome.status, outcome.body);
  const updated = await inbox().decided(id, decisions.map((d) => ({ ...d })), identity.who, state, outcome, isoUtc());
  if (!updated) return sendError(res, 404, `row ${id} is not in the inbox`);
  wakeups.publish([updated]);
  log.info(`Row ${id} decided by ${identity.who} via ${identity.via} - ${outcome.status} -> ${state}`);
  return sendJson(res, 200, { row: publicRow(updated), outcome });
}

/** POST /questions/{id}/seen: an advice the person has read. */
export async function markSeen(req, res, id) {
  const config = currentSettings();
  try {
    await identify(req, config, null);
  } catch (error) {
    if (!(error instanceof ReplyError)) throw error;
    return sendError(res, error.status, error.message);
  }
  const row = await inbox().get(id);
  if (!row) return sendError(res, 404, `row ${id} is not in the inbox`);
  if (row.kind !== 'advice') return sendError(res, 409, `row ${id} is a wait - decide it instead`);
  const updated = await inbox().seen(id, isoUtc());
  if (!updated) return sendError(res, 404, `row ${id} is not in the inbox`);
  wakeups.publish([updated]);
  return sendJson(res, 200, { row: publicRow(updated) });
}

const STYLE = 'body{font-family:-apple-system,Helvetica,Arial,sans-serif;margin:0;color:#222;background:#f4f5f7}'
  + 'header{background:#1f2a44;color:#fff;padding:.8rem 1.2rem;display:flex;gap:1rem;align-items:center}'
  + 'header h1{font-size:1.1rem;margin:0;flex:1}header input{padding:.3rem .5rem;border-radius:6px;border:1px solid #889}'
  + '#status{font-size:.8rem;opacity:.85}main{padding:1rem 1.2rem;max-width:1000px;margin:0 auto}'
  + '.case{background:#fff;border:1px solid #dde;border-radius:10px;margin:1rem 0;padding:.8rem 1rem}'
  + '.case h2{font-size:1rem;margin:0 0 .3rem}.meta{color:#667;font-size:.8rem}'
  + '.card{border-top:1px solid #eee;padding:.7rem 0}.card.open{border-left:4px solid #e0a800;padding-left:.8rem}'
  + '.card.answered{border-left:4px solid #2e9e5b;padding-left:.8rem;opacity:.85}'
  + '.card.expired{border-left:4px solid #999;padding-left:.8rem;opacity:.7}.card.seen{opacity:.6}'
  + '.card.advice{border-left:4px solid #3a7bd5;padding-left:.8rem}pre{background:#f3f3f3;border-radius:6px;'
  + 'padding:.5rem .7rem;overflow:auto;font-size:.8rem}fieldset{border:1px solid #ddd;border-radius:8px;margin:.5rem 0}'
  + 'textarea,input[type=text]{width:100%;box-sizing:border-box;margin:.2rem 0}button{padding:.4rem 1rem;border-radius:6px;'
  + 'border:1px solid #556;background:#fff;cursor:pointer}button.primary{background:#1f2a44;color:#fff}'
  + '.outcome{font-size:.85rem;color:#334;margin-top:.4rem}.empty{color:#667;padding:2rem;text-align:center}';

const SCRIPT = String.raw`
const rows = new Map(); let cursor = 0; let source = null;
const status = document.getElementById('status');
const nameBox = document.getElementById('name');
try { nameBox.value = localStorage.getItem('agent-question.name') || ''; } catch (e) {}
nameBox.addEventListener('change', () => { try { localStorage.setItem('agent-question.name', nameBox.value); } catch (e) {} });
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function merge(list) { for (const r of list) { rows.set(r.id, r); if (r.seq > cursor) cursor = r.seq; } render(); }
async function replay() {
  const res = await fetch(LIST + '?since=' + cursor, {credentials: 'same-origin'});
  if (!res.ok) { status.textContent = 'replay failed: ' + res.status; return; }
  const body = await res.json(); merge(body.rows); if (body.more) return replay();
}
function listen() {
  if (source) source.close();
  source = new EventSource(EVENTS + '?since=' + cursor, {withCredentials: true});
  source.addEventListener('question', (ev) => { merge([JSON.parse(ev.data)]); });
  source.onopen = () => { status.textContent = 'connected'; };
  source.onerror = () => { status.textContent = 'reconnecting...'; };
}
function callForm(call, i) {
  const id = esc(call.id), input = call.input ? '<pre>' + esc(JSON.stringify(call.input, null, 2)) + '</pre>' : '';
  if (call.ask) {
    const opts = Array.isArray(call.input && call.input.options) ? call.input.options : [];
    const radios = opts.map((o, k) => '<label><input type="radio" name="a-' + i + '" value="' + esc(o) + '"' + (k === 0 ? ' checked' : '') + '> ' + esc(o) + '</label><br>').join('')
      + (opts.length ? '<label><input type="radio" name="a-' + i + '" value="__other__"> another answer:</label>' : '');
    return '<fieldset data-id="' + id + '" data-kind="ask"><legend>' + esc(call.name) + ' - a question</legend>' + input + radios + '<textarea rows="2" placeholder="Your answer"></textarea></fieldset>';
  }
  if (call.wait === false) return '<fieldset><legend>' + esc(call.name) + ' - runs on resume</legend>' + input + '</fieldset>';
  return '<fieldset data-id="' + id + '" data-kind="write"><legend>' + esc(call.name) + ' - waits for a decision</legend>' + input
    + '<label><input type="radio" name="d-' + i + '" value="yes"> approve</label> <label><input type="radio" name="d-' + i + '" value="no"> refuse</label>'
    + '<input type="text" placeholder="A note for the model (optional)"></fieldset>';
}
function card(r) {
  const when = esc((r.updated_at || '').replace('T', ' ').slice(0, 19));
  let body = '<div class="card ' + esc(r.state) + ' ' + esc(r.kind) + '" data-row="' + r.id + '"><div><strong>' + esc(r.summary) + '</strong> <span class="meta">' + esc(r.kind) + (r.turn != null ? ' · turn ' + r.turn : '') + ' · ' + esc(r.state) + ' · ' + when + '</span></div>';
  if (r.details) body += '<p>' + esc(r.details) + '</p>';
  if (r.kind === 'advice') { if (r.state === 'open') body += '<button data-seen="' + r.id + '">Seen</button>'; }
  else if (r.state === 'open') {
    body += '<form data-decide="' + r.id + '">' + (r.calls || []).map(callForm).join('') + '<button class="primary" type="submit">Send the decision</button></form>';
    if (r.expires_at) body += '<div class="meta">expires ' + esc(r.expires_at.replace('T', ' ').slice(0, 19)) + '</div>';
  } else {
    body += '<div class="outcome">' + (r.answered_by ? 'decided by ' + esc(r.answered_by) + ' at ' + esc((r.answered_at || '').replace('T', ' ').slice(0, 19)) : '') + (r.outcome ? ' · ' + esc((r.outcome.body && (r.outcome.body.type || r.outcome.body.message)) || r.outcome.status) : '') + '</div>';
  }
  return body + '</div>';
}
function render() {
  const main = document.getElementById('cases');
  if (!rows.size) { main.innerHTML = '<div class="empty">Nothing waits for you.</div>'; return; }
  const groups = new Map();
  for (const r of rows.values()) { const key = r.graph_id + '\u0000' + r.correlation_id; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r); }
  const ordered = [...groups.entries()].sort((a, b) => Math.max(...b[1].map(r => r.seq)) - Math.max(...a[1].map(r => r.seq)));
  main.innerHTML = ordered.map(([key, list]) => {
    list.sort((a, b) => a.seq - b.seq);
    const first = list[0];
    return '<section class="case"><h2>' + esc(first.description) + '</h2><div class="meta">' + esc(first.graph_id) + ' · ' + esc(first.correlation_id) + '</div>' + list.map(card).join('') + '</section>';
  }).join('');
}
document.getElementById('cases').addEventListener('click', async (ev) => {
  const seen = ev.target.closest('button[data-seen]');
  if (seen) { await fetch(LIST + '/' + seen.dataset.seen + '/seen', {method: 'POST', credentials: 'same-origin'}); }
});
document.getElementById('cases').addEventListener('submit', async (ev) => {
  const form = ev.target.closest('form[data-decide]'); if (!form) return;
  ev.preventDefault();
  const decisions = [];
  for (const set of form.querySelectorAll('fieldset[data-id]')) {
    if (set.dataset.kind === 'ask') {
      const picked = set.querySelector('input[type=radio]:checked'); const text = set.querySelector('textarea').value.trim();
      decisions.push({id: set.dataset.id, answer: picked && picked.value !== '__other__' ? picked.value : text});
    } else {
      const choice = set.querySelector('input[type=radio]:checked');
      if (!choice) { alert('Approve or refuse every waiting call'); return; }
      const note = set.querySelector('input[type=text]').value.trim();
      const d = {id: set.dataset.id, approved: choice.value === 'yes'}; if (note) d.note = note; decisions.push(d);
    }
  }
  const button = form.querySelector('button'); button.disabled = true; button.textContent = 'Sending...';
  const res = await fetch(LIST + '/' + form.dataset.decide + '/decide', {method: 'POST', credentials: 'same-origin',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({decisions, decided_by: nameBox.value.trim() || undefined})});
  if (!res.ok) { const err = await res.json().catch(() => ({})); alert(err.message || ('failed: ' + res.status)); button.disabled = false; button.textContent = 'Send the decision'; return; }
  const body = await res.json(); merge([body.row]);
});
replay().then(listen);
`;

const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function page(title) {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n`
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + `<title>${escapeHtml(title)}</title>\n<style>${STYLE}</style>\n</head>\n<body>\n`
    + `<header><h1>${escapeHtml(title)}</h1><label class="meta">your name <input id="name" type="text" `
    + 'placeholder="as the model will see it"></label><span id="status">connecting...</span></header>\n'
    + '<main id="cases"><div class="empty">Loading...</div></main>\n'
    + `<script>const LIST = ${JSON.stringify(LIST_PATH)}; const EVENTS = ${JSON.stringify(EVENTS_PATH)};${SCRIPT}</script>\n`
    + '</body>\n</html>\n';
}

export async function servePage(req, res) {
  const config = currentSettings();
  try {
    await identify(req, config, null);
  } catch (error) {
    if (!(error instanceof ReplyError)) throw error;
    res.writeHead(error.status, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page(`Sign-in required - ${error.message}`));
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  return res.end(page(config.pageTitle));
}

/** The browser side on the host (Platform.addRoutes). */
export async function mount(req, res, url) {
  const path = url.pathname;
  if (req.method === 'GET' && path === PAGE_PATH) {
    await servePage(req, res);
    return true;
  }
  if (req.method === 'GET' && path === EVENTS_PATH) {
    await events(req, res, url);
    return true;
  }
  if (req.method === 'GET' && path === LIST_PATH) {
    await listRows(req, res, url);
    return true;
  }
  const action = /^\/questions\/([^/]+)\/(decide|seen)$/.exec(path);
  if (req.method === 'POST' && action) {
    const id = Number(action[1]);
    if (!Number.isInteger(id)) {
      sendError(res, 400, 'the row id must be a whole number');
      return true;
    }
    if (action[2] === 'decide') {
      await decide(req, res, id);
    } else {
      await markSeen(req, res, id);
    }
    return true;
  }
  return false;
}

// --- boot -------------------------------------------------------------------------------------

/** Load the settings and open the inbox before the host listens; a bad configuration or a silent database stops it by name. */
export async function boot() {
  const config = configure();
  if (config.inbox === 'postgres') {
    theInbox = await postgresInbox(config);
  } else {
    theInbox = new MemoryInbox();
    log.warn(`The inbox is in memory - a restart forgets every card; set ${INBOX}=postgres for a deployment`);
  }
  try {
    await theInbox.open();
  } catch (error) {
    if (error instanceof QuestionError) throw error;
    throw new QuestionError(`the ${config.inbox} inbox could not open - ${failure(error)}`);
  }
  sweeper = setInterval(() => { expireNow().catch(() => {}); }, config.sweepMs);
  sweeper.unref();
  log.info(`agent-question ready - inbox ${theInbox.name}, page ${PAGE_PATH}, stream ${EVENTS_PATH}, auth ${config.auth}`);
}

export async function shutdown() {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  if (theInbox) await theInbox.close();
}

export const sweeperRunning = () => sweeper !== null;

export function attach(target = platform) {
  target.onStartup(boot);
  target.onCleanup(shutdown);
  target.addRoutes(mount);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  loadConfig(undefined, HERE);
  attach();
  await platform.run();
} else {
  // loaded by mercury-serve: the boot runs inside the serving loop, before the host listens
  attach();
}
