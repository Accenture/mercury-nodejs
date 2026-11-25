/**
 * The agent-question app - the first channel of RFC-0014 (the engines' draft-design-specs/ask-a-person-channel.md,
 * Part II) and, since round 4 of the paper (section 21.3), the backend of the React UI maintained in this pack: a
 * reader of the question record the main flow keeps in the audit database, a feed of its changes for a person's
 * device, and the automated click that answers a wait. The Node.js twin of mercury-python's extensions/agent-question.
 * The main flow (person.ask in extensions/ask-person) knows nothing of it: it records every message and answer itself,
 * then sends the message event to the routes it is configured with, and this application is one of those routes.
 *
 * - agent.question.inbox is the intake, a composable function reached over Event-over-HTTP like any peer function. It
 *   writes nothing: the record is the recorder's (question.audit in the ask-person process). It checks the event and
 *   wakes the feed, so a connected device sees the row the moment it is recorded.
 * - The person's side is a set of REST automation entries (resources/rest.yaml, the engines' grammar, served with
 *   rest.automation: true), each a private function of this process; who is at the UI is resolved once by the
 *   entries' authentication function, question.identity, and read from the request's session map.
 *   GET /questions/config (question.config) tells the UI how to sign in; GET /questions?since=<seq> (question.list)
 *   is the replay a reconnecting device calls first - every row that changed since its
 *   cursor, oldest change first; GET /questions?before=<seq>&limit=<n> the history's older page, newest first, for an
 *   infinite scroll; GET /questions/events the stream a connected device holds, each event a changed row, Last-Event-ID
 *   the same cursor. GET /transcripts and GET /transcripts/{conversation} browse the transcript audit store the LLM
 *   helper writes beside the record. The person selects which card to answer; the card's button automates the click:
 *   POST /questions/{id}/decide posts {ticket, decisions, decided_by} to the main flow's reply endpoint - the link's own
 *   base, under this app's bearer - and the answer lands on the row through the recorder; the feed carries the change
 *   to every device.
 * - The React UI (extensions/agent-question-ui, the one front-end of both packs' backends) is served by the host's
 *   static content service from resources/public next to this file, at the application's root; the bundle is built
 *   there and committed here. This app generates no page of its own.
 * - The store this app reads is PostgreSQL (question.store: postgres, the pg driver, the audit database the main flow
 *   and the LLM helper write) or, for the tests, memory - nothing writes a memory store at run time. The feed polls the
 *   record's change sequence (question.poll) and the intake wakes it. Who may use the UI is question.auth: none in
 *   development, oauth2 (an OAuth 2.0 access token validated against the issuer's published keys; the UI obtains one by
 *   Authorization Code with PKCE from the issuer named by /questions/config).
 *
 * Run:  node dist/src/cli.js extensions/agent-question/agent-question.mjs -Dquestion.store=postgres -Dquestion.store.postgres.ssl=false
 *
 * The pure half - the event the intake accepts, the request the click sends, the pages the feed and the history read -
 * is pinned by test/vectors/agent-question-vectors.json, byte-identical with the Python pack.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AppException, appConfig, AsyncHttpRequest, defaultRegistry, EventEnvelope, EventStreamWriter, getLogger, isoUtc, loadConfig,
  platform, preload
} from 'mercury-composable';

const log = getLogger('agent-question');
const HERE = dirname(fileURLToPath(import.meta.url));

// --- the contract -----------------------------------------------------------------------------

export const INTAKE_ROUTE = 'agent.question.inbox';
export const HEALTH_ROUTE = 'question.health';
export const KINDS = ['approval', 'question', 'advice'];
export const WAIT_KINDS = ['approval', 'question'];
// a wait's states; an advice has none (null) - whether a person read it is the device's business
export const STATES = ['open', 'answered', 'expired'];
export const LIST_PATH = '/questions';
export const EVENTS_PATH = '/questions/events';
export const CONFIG_PATH = '/questions/config';
export const TRANSCRIPTS_PATH = '/transcripts';
// the person's side: the URLs of resources/rest.yaml (RFC-0018) and the private functions behind them
export const LIST_ROUTE = 'question.list';
export const EVENTS_ROUTE = 'question.events';
export const CONFIG_ROUTE = 'question.config';
export const DECIDE_ROUTE = 'question.decide';
export const TRANSCRIPTS_ROUTE = 'transcript.list';
export const TRANSCRIPT_ROUTE = 'transcript.show';
// the entries' authentication function and the session keys it leaves on the request
export const IDENTITY_ROUTE = 'question.identity';
export const SESSION_WHO = 'who';
export const SESSION_VIA = 'via';
export const INSTANCES = 10;
// a device's stream is quiet for as long as nothing changes: its idle allowance (the head's x-ttl) is a day, after
// which the device reconnects from its cursor
export const STREAM_IDLE_SECONDS = 86_400;
export const AUTH_MODES = ['none', 'oauth2'];
export const JWT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512'];
export const LIST_LIMIT = 200;
export const LIST_LIMIT_MAX = 1000;
export const TRANSCRIPTS_LIMIT = 50;
export const TRANSCRIPTS_LIMIT_MAX = 200;
const CONVERSATION_ID = /^[0-9a-f]{32}$/;

// configuration keys
export const STORE = 'question.store';
export const POSTGRES_PREFIX = 'question.store.postgres.';
export const POLL = 'question.poll';
export const AUTH = 'question.auth';
export const OAUTH2_ISSUER = 'question.auth.oauth2.issuer';
export const OAUTH2_AUDIENCE = 'question.auth.oauth2.audience';
export const OAUTH2_JWKS_URL = 'question.auth.oauth2.jwks-url';
export const OAUTH2_CLIENT_ID = 'question.auth.oauth2.client-id';
export const OAUTH2_SCOPES = 'question.auth.oauth2.scopes';
export const REPLY_TOKEN = 'question.reply.token';
export const REPLY_TIMEOUT = 'question.reply.timeout';
export const PAGE_TITLE = 'question.page.title';

export const MISSING_POSTGRES = 'question.store is postgres but the pg driver is not installed - npm install pg';
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
  const store = text(config, STORE, 'memory').toLowerCase();
  if (!['memory', 'postgres'].includes(store)) throw new QuestionError(`${STORE} must be memory or postgres`);
  const auth = text(config, AUTH, 'none').toLowerCase();
  if (!AUTH_MODES.includes(auth)) throw new QuestionError(`${AUTH} must be one of ${AUTH_MODES.join(', ')}`);
  const issuer = text(config, OAUTH2_ISSUER).replace(/\/+$/, '');
  const jwksUrl = text(config, OAUTH2_JWKS_URL);
  const clientId = text(config, OAUTH2_CLIENT_ID);
  if (auth === 'oauth2') {
    if (!issuer && !jwksUrl) throw new QuestionError(`${AUTH} is oauth2 - set ${OAUTH2_ISSUER} or ${OAUTH2_JWKS_URL}`);
    if (!issuer || !clientId) {
      log.warn(`${AUTH} is oauth2 without ${OAUTH2_ISSUER} and ${OAUTH2_CLIENT_ID} - the UI cannot sign a person in; a token obtained elsewhere still works`);
    }
  }
  const timeoutMs = wholeMs(config, `${POSTGRES_PREFIX}timeout.ms`, 5000);
  const portText = text(config, `${POSTGRES_PREFIX}port`, '5432');
  if (!/^\d+$/.test(portText) || Number.parseInt(portText, 10) <= 0) throw new QuestionError(`${POSTGRES_PREFIX}port must be a port number`);
  const ssl = text(config, `${POSTGRES_PREFIX}ssl`, 'true').toLowerCase() !== 'false';
  return {
    store,
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
    pollMs: timeout(config, POLL, '1s'),
    auth,
    oauth2Issuer: issuer,
    oauth2Audience: text(config, OAUTH2_AUDIENCE),
    oauth2JwksUrl: jwksUrl,
    oauth2ClientId: clientId,
    oauth2Scopes: text(config, OAUTH2_SCOPES, 'openid profile email'),
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

/** The row as the UI, the replay and the stream carry it (the row the main flow's recorder writes). */
export function publicRow(row) {
  return {
    id: row.id, seq: row.seq, kind: row.kind, graph_id: row.graph_id, correlation_id: row.correlation_id, turn: row.turn,
    ticket: row.ticket, link: row.link, description: row.description, summary: row.summary, details: row.details,
    calls: row.message?.calls ?? null, state: row.state, requested_at: row.requested_at, expires_at: row.expires_at,
    updated_at: row.updated_at, answered_at: row.answered_at, answered_by: row.answered_by, decisions: row.decisions,
    outcome: row.outcome
  };
}

/** The message event the main flow sends, checked for what a channel needs - or an AppException(400). */
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

/** The click, automated: the reply endpoint is the link's own base, the body what a person's browser would post. */
export function replyRequest(link, ticket, decisions, who) {
  const at = link.indexOf('/ask/');
  if (at < 0) throw new ReplyError(409, "the row's link does not name a reply endpoint");
  return [`${link.slice(0, at)}/ask/reply`, { ticket, decisions: decisions.map((d) => ({ ...d })), decided_by: who }];
}

/** The replay's page: the rows whose sequence passed the cursor, oldest change first, and the cursor to continue from. */
export function pageSince(rows, since, limit) {
  const changed = rows.filter((row) => row.seq > since).sort((a, b) => a.seq - b.seq).slice(0, limit);
  return { rows: changed.map(publicRow), next: Math.max(since, ...changed.map((row) => row.seq)), more: changed.length >= limit };
}

/**
 * The history's page: the rows whose sequence is before the cursor (every row when there is none), newest change
 * first, and the cursor of the older page (the smallest sequence shown; null when nothing was).
 */
export function pageBefore(rows, before, limit) {
  const older = rows.filter((row) => before === null || before === undefined || row.seq < before).sort((a, b) => b.seq - a.seq).slice(0, limit);
  return { rows: older.map(publicRow), next: older.length > 0 ? Math.min(...older.map((row) => row.seq)) : null, more: older.length >= limit };
}

// --- the readers ------------------------------------------------------------------------------
//
// The app reads the question record the main flow writes and the transcript audit store the LLM helper writes, both
// in the audit database, under a reader's role; it writes nothing. The memory reader carries the contract's
// semantics for the tests: rows and conversations put there stand for what the recorder and the helper wrote.

export class MemoryReader {
  name = 'memory';

  constructor() {
    this.rows = new Map();
    this.conversationRows = new Map();
    this.turnRows = new Map();
  }

  async open() {}

  async close() {}

  put(row) {
    this.rows.set(row.id, row);
    return row;
  }

  putConversation(conversation, turns) {
    const key = String(conversation.conversation);
    this.conversationRows.set(key, { ...conversation });
    this.turnRows.set(key, turns.map((turn) => ({ ...turn })));
  }

  async get(id) {
    return this.rows.get(id) ?? null;
  }

  async since(seq, limit) {
    return [...this.rows.values()].filter((r) => r.seq > seq).sort((a, b) => a.seq - b.seq).slice(0, limit);
  }

  async before(seq, limit) {
    return [...this.rows.values()].filter((r) => seq === null || seq === undefined || r.seq < seq).sort((a, b) => b.seq - a.seq).slice(0, limit);
  }

  async latest() {
    return Math.max(0, ...[...this.rows.values()].map((r) => r.seq));
  }

  async counts() {
    const result = {};
    for (const row of this.rows.values()) {
      const label = row.state ?? row.kind;
      result[label] = (result[label] ?? 0) + 1;
    }
    return result;
  }

  async conversations(before, limit, correlationId, graphId) {
    const light = ({ system: _system, tools: _tools, ...rest }) => rest;
    return [...this.conversationRows.values()]
      .filter((c) => (before === null || before === undefined || String(c.started_at) < before)
        && (correlationId === null || correlationId === undefined || c.correlation_id === correlationId)
        && (graphId === null || graphId === undefined || c.graph_id === graphId))
      .sort((a, b) => (String(a.started_at) < String(b.started_at) ? 1 : -1))
      .slice(0, limit)
      .map(light);
  }

  async conversation(key) {
    const held = this.conversationRows.get(key);
    if (!held) return null;
    return { conversation: { ...held }, turns: (this.turnRows.get(key) ?? []).map((turn) => ({ ...turn })) };
  }
}

// the statements the reference reader runs, with pg's placeholders - selects only, on the question record
// (extensions/ask-person/schema/postgres.sql) and the transcript audit tables (extensions/llm-helper/schema/postgres.sql)
export const COLUMNS = 'id, seq, ticket, graph_id, correlation_id, turn, kind, description, summary, details, message, link, '
  + 'state, requested_at, expires_at, updated_at, answered_at, answered_by, decisions, outcome';
export const SQL_GET = `SELECT ${COLUMNS} FROM question WHERE id = $1`;
export const SQL_SINCE = `SELECT ${COLUMNS} FROM question WHERE seq > $1 ORDER BY seq LIMIT $2`;
export const SQL_BEFORE = `SELECT ${COLUMNS} FROM question WHERE $1::bigint IS NULL OR seq < $1::bigint ORDER BY seq DESC LIMIT $2`;
export const SQL_LATEST = 'SELECT COALESCE(max(seq), 0) AS latest FROM question';
export const SQL_COUNTS = 'SELECT COALESCE(state, kind) AS label, count(*) FROM question GROUP BY COALESCE(state, kind)';
export const CONVERSATION_COLUMNS = 'conversation, correlation_id, graph_id, node, model, status, turns, started_at, updated_at, '
  + 'ended_at, expires_at, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens';
export const SQL_CONVERSATIONS = `SELECT ${CONVERSATION_COLUMNS} FROM transcript `
  + 'WHERE ($1::timestamptz IS NULL OR started_at < $1::timestamptz) AND ($2::text IS NULL OR correlation_id = $2::text) '
  + 'AND ($3::text IS NULL OR graph_id = $3::text) ORDER BY started_at DESC LIMIT $4';
export const SQL_CONVERSATION = `SELECT ${CONVERSATION_COLUMNS}, system, tools FROM transcript WHERE conversation = $1`;
export const TURN_COLUMNS = 'turn, trace_id, trace_path, correlation_id, started_at, ended_at, stop_reason, status, request_id, '
  + 'input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, request, response, calls';
export const SQL_TURNS = `SELECT ${TURN_COLUMNS} FROM transcript_turn WHERE conversation = $1 ORDER BY turn`;

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
    details: record.details ?? null, message: json(record.message) ?? {},
    state: record.state === null || record.state === undefined ? null : String(record.state),
    requested_at: stamp(record.requested_at) ?? '', expires_at: stamp(record.expires_at), updated_at: stamp(record.updated_at) ?? '',
    answered_at: stamp(record.answered_at), answered_by: record.answered_by ?? null, decisions: json(record.decisions),
    outcome: json(record.outcome)
  };
}

const STAMPS = new Set(['started_at', 'updated_at', 'ended_at', 'expires_at']);
const COUNTS = new Set(['turns', 'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']);

/** A conversation row of the transcript audit store, as the UI shows it (the snapshot columns when selected). */
export function conversationFromRecord(record) {
  const result = {};
  for (const [name, value] of Object.entries(record)) {
    if (STAMPS.has(name)) result[name] = stamp(value);
    else if (COUNTS.has(name)) result[name] = Number(value ?? 0);
    else if (name === 'tools') result[name] = json(value);
    else result[name] = value === null || value === undefined ? null : String(value);
  }
  return result;
}

/** A turn row of the transcript audit store: the facts, and the request and response as the model exchanged them. */
export function turnFromRecord(record) {
  const result = {};
  for (const [name, value] of Object.entries(record)) {
    if (name === 'started_at' || name === 'ended_at') result[name] = stamp(value);
    else if (name === 'turn' || COUNTS.has(name)) result[name] = Number(value ?? 0);
    else if (name === 'request' || name === 'response' || name === 'calls') result[name] = json(value);
    else result[name] = value === null || value === undefined ? null : String(value);
  }
  return result;
}

/** The reference reader: the pg driver's pool, selects only - a reader role suffices. */
export class PostgresReader {
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

  async records(sql, params) {
    const { rows } = await this.pool.query(sql, params);
    return rows;
  }

  async get(id) {
    const rows = await this.records(SQL_GET, [id]);
    return rows.length > 0 ? rowFromRecord(rows[0]) : null;
  }

  async since(seq, limit) {
    return (await this.records(SQL_SINCE, [seq, limit])).map(rowFromRecord);
  }

  async before(seq, limit) {
    return (await this.records(SQL_BEFORE, [seq ?? null, limit])).map(rowFromRecord);
  }

  async latest() {
    const rows = await this.records(SQL_LATEST, []);
    return rows.length > 0 && rows[0].latest !== null && rows[0].latest !== undefined ? Number(rows[0].latest) : 0;
  }

  async counts() {
    const result = {};
    for (const row of await this.records(SQL_COUNTS, [])) result[String(row.label)] = Number(row.count);
    return result;
  }

  async conversations(before, limit, correlationId, graphId) {
    return (await this.records(SQL_CONVERSATIONS, [before ?? null, correlationId ?? null, graphId ?? null, limit])).map(conversationFromRecord);
  }

  async conversation(key) {
    const rows = await this.records(SQL_CONVERSATION, [key]);
    if (rows.length === 0) return null;
    const turns = await this.records(SQL_TURNS, [key]);
    return { conversation: conversationFromRecord(rows[0]), turns: turns.map(turnFromRecord) };
  }
}

/** The pool from the question.store.postgres.* keys; nothing connects until open(). */
export async function postgresReader(config, importer = (name) => import(name)) {
  let pg;
  try {
    pg = await importer('pg');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') throw new QuestionError(MISSING_POSTGRES);
    throw error;
  }
  const Pool = pg.Pool ?? pg.default?.Pool;
  const pool = new Pool({ ...config.postgres });
  pool.on('error', (error) => log.warn(`store - ${error.name}: ${error.message}`));
  return new PostgresReader(pool);
}

/** A failure as a log may carry it: the type and the database's SQLSTATE, never a message that could quote a row. */
export function failure(error) {
  const constructor = error?.constructor?.name;
  const name = constructor && constructor !== 'Object' ? constructor : (error?.name ?? 'Error');
  const database = error?.severity !== undefined || name === 'DatabaseError';
  return database && error?.code ? `${name} sqlstate=${error.code}` : name;
}

// --- the wake-ups and the feed ----------------------------------------------------------------

/** Every connected device holds a queue; a changed row goes to all of them. */
/** The item a closing Wakeups puts on every queue: the application is stopping, the stream ends. */
export const CLOSED = Symbol('closed');

export class Wakeups {
  constructor() {
    this.queues = new Set();
    this.closing = false;
  }

  subscribe() {
    const queue = { items: [], waiter: null };
    this.queues.add(queue);
    if (this.closing) queue.items.push(CLOSED);
    return queue;
  }

  /** The application is stopping: every connected device's stream ends now, a stream opened from here on ends at once. */
  close() {
    this.closing = true;
    this.publish([CLOSED]);
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

/**
 * The record's changes, read by their sequence and handed to the connected devices: a poll every question.poll and a
 * wake-up from the intake or a click, whichever comes first.
 */
export class Feed {
  constructor() {
    this.cursor = 0;
    this.wake = null;
    this.pending = false;
    this.loop = null;
    this.stopped = false;
  }

  kick() {
    if (this.wake) {
      const wake = this.wake;
      this.wake = null;
      wake();
    } else {
      this.pending = true;
    }
  }

  /** Read what changed since the cursor, tell every device, move the cursor; a store that cannot be read is logged by type. */
  async pollOnce() {
    let rows;
    try {
      rows = await reader().since(this.cursor, LIST_LIMIT_MAX);
    } catch (error) {
      log.warn(`The feed could not read the record - ${failure(error)}`); // the next poll retries
      return [];
    }
    if (rows.length > 0) {
      this.cursor = Math.max(this.cursor, ...rows.map((row) => row.seq));
      wakeups.publish(rows);
    }
    return rows;
  }

  async run(pollMs) {
    while (!this.stopped) {
      if (!this.pending) {
        let timer;
        await new Promise((resolveWait) => {
          this.wake = resolveWait;
          timer = setTimeout(resolveWait, pollMs);
          timer.unref();
        });
        clearTimeout(timer);
        this.wake = null;
      }
      this.pending = false;
      if (this.stopped) break;
      await this.pollOnce();
    }
  }

  start(pollMs) {
    if (this.loop) return;
    this.stopped = false;
    this.loop = this.run(pollMs);
  }

  async stop() {
    this.stopped = true;
    this.kick();
    if (this.loop) await this.loop;
    this.loop = null;
  }

  get running() {
    return this.loop !== null && !this.stopped;
  }
}

let theReader = null;
export let wakeups = new Wakeups();
export let feed = new Feed();

export function reader() {
  theReader ??= new MemoryReader();
  return theReader;
}

/** A test hook: a fresh reader, fresh wake-ups and a fresh feed. */
export function reset(freshReader = new MemoryReader()) {
  theReader = freshReader;
  wakeups = new Wakeups();
  feed = new Feed();
}

// --- the intake -------------------------------------------------------------------------------

/**
 * Take a message event from the main flow: nothing to write - the recorder has the row - but every connected device is
 * told to look, so the card is on its screen the moment it is recorded.
 */
export async function intake(_headers, body) {
  const event = validateEvent(body);
  feed.kick();
  log.info(`Intake took ${event.kind} for ${event.graph_id} turn ${event.turn ?? null} - the feed looks`);
  return { accepted: true, kind: event.kind, graph_id: event.graph_id, turn: event.turn ?? null };
}

export async function questionHealth(headers) {
  const config = currentSettings();
  if (headers.type === 'info') {
    let counts;
    try {
      counts = await reader().counts();
    } catch (error) {
      counts = { error: failure(error) };
    }
    return {
      service: INTAKE_ROUTE, href: 'http://127.0.0.1', store: reader().name, rows: counts, feed: feed.cursor,
      connected: wakeups.connected, auth: config.auth
    };
  }
  return 'agent.question.inbox is running fine';
}

preload(INTAKE_ROUTE, { instances: 5 }, intake);
preload(HEALTH_ROUTE, { instances: 5, isPrivate: true }, questionHealth);
// the browser side's functions (resources/rest.yaml) are registered by attach(), below their definitions

// --- identity ---------------------------------------------------------------------------------

/** The bearer token of a request (the AsyncHttpRequest), or null. */
function bearerOf(request) {
  const value = request.header('authorization') ?? '';
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

/** Who is at the UI: nobody is asked in development, or a validated access token (obtained by the UI through PKCE). */
export async function identify(request, config, claimedBy) {
  if (config.auth === 'none') return { who: claimedBy || 'anonymous', via: 'none' };
  const bearer = bearerOf(request);
  if (!bearer) throw new ReplyError(401, 'sign-in required - a bearer access token');
  const claims = await oauth2(config).verify(bearer);
  const who = claims.preferred_username || claims.email || claims.sub;
  if (!who) throw new ReplyError(401, 'the access token names nobody');
  return { who: String(who), via: 'oauth2' };
}

/**
 * `decided_by` from a JSON body when it is text - the name the page offers in development; anything else is left to
 * the click's own check.
 */
function claimed(request) {
  const body = request.body;
  const value = isMap(body) ? body.decided_by : undefined;
  return isText(value) && value ? value : null;
}

/**
 * The authentication function of the feed, the history, the transcripts and the click (question.identity): `true`
 * with who is at the UI in the headers, which the edge leaves on the request as its session map; a refusal is the
 * error the UI sees.
 */
export async function questionIdentity(_headers, body) {
  const request = new AsyncHttpRequest(body);
  let identity;
  try {
    identity = await identify(request, currentSettings(), claimed(request));
  } catch (error) {
    if (!(error instanceof ReplyError)) throw error;
    throw new AppException(error.status, error.message);
  }
  return new EventEnvelope().setBody(true).setHeader(SESSION_WHO, identity.who).setHeader(SESSION_VIA, identity.via);
}

/** Who the entry's authentication function found, from the request's session map. */
const identityOf = (request) => ({
  who: request.sessionInfo(SESSION_WHO) || 'anonymous', via: request.sessionInfo(SESSION_VIA) || 'none'
});

// --- the browser side -------------------------------------------------------------------------

/**
 * A JSON reply as the UI reads it: serialized here, so a null stays a null (an advice's `state`, a silent engine's
 * `status` - the engines' renderer would omit them), under its content type.
 */
const jsonReply = (status, body) => new EventEnvelope().setStatus(status).setHeader('content-type', 'application/json').setBody(JSON.stringify(body));

/** What the UI needs before it signs in: the auth mode, the title and, under oauth2, the issuer, the public client id, the scopes and the audience. */
export function uiConfig(config) {
  const result = { auth: config.auth, title: config.pageTitle };
  if (config.auth === 'oauth2') {
    result.oauth2 = { issuer: config.oauth2Issuer, client_id: config.oauth2ClientId, scopes: config.oauth2Scopes, audience: config.oauth2Audience };
  }
  return result;
}

/** GET /questions/config (question.config): the UI's sign-in configuration - open, it holds no secret. */
export async function questionConfig() {
  return jsonReply(200, uiConfig(currentSettings()));
}

/** A whole number from a query value, the default when absent; null when not a number. */
function whole(value, defaultValue) {
  if (value === null || value === undefined || value === '') return defaultValue;
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : null;
}

/**
 * GET /questions?since=<seq>&limit=<n>: every row that changed since the cursor, oldest change first, and the cursor to
 * continue from - the replay. GET /questions?before=<seq>&limit=<n>: the history's older page, newest change first, and
 * the cursor of the page before it - the infinite scroll.
 */
export async function questionList(_headers, body) {
  const request = new AsyncHttpRequest(body);
  const paging = 'before' in request.queryParametersMap;
  const limitRaw = whole(request.queryParameter('limit'), LIST_LIMIT);
  const before = paging ? whole(request.queryParameter('before'), null) : null;
  const since = paging ? 0 : whole(request.queryParameter('since'), 0);
  if (limitRaw === null || since === null || (paging && request.queryParameter('before') && before === null)) {
    throw new AppException(400, 'since, before and limit must be whole numbers');
  }
  const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, limitRaw));
  let page;
  try {
    if (paging) {
      page = { ...pageBefore(await reader().before(before, limit), null, limit), before };
    } else {
      page = { ...pageSince(await reader().since(since, limit), since, limit), since };
    }
  } catch (error) {
    log.warn(`The record could not be read - ${failure(error)}`);
    throw new AppException(503, 'the question record is not available');
  }
  return jsonReply(200, page);
}


/** The host's SSE keep-alive interval (event.stream.keep.alive, the engines' key; default 30s, 0 disables). */
export function keepAliveMs() {
  const raw = String(appConfig().getProperty('event.stream.keep.alive', '30s') ?? '30s').trim().toLowerCase();
  if (['0', '0s', '0ms', '0m'].includes(raw)) return 0;
  const match = /^(\d+)(ms|s|m)?$/.exec(raw);
  if (!match) return 30_000;
  const unit = match[2] ?? 's';
  return Number.parseInt(match[1], 10) * (unit === 'ms' ? 1 : unit === 'm' ? 60_000 : 1000);
}

/** A changed row as the `question` event's data: serialized here, so a null stays a null. */
const frame = (row) => JSON.stringify(publicRow(row));

/**
 * One device's stream: the rows since its cursor first, then every change the feed finds, until the device leaves
 * (the edge closes the reply sink and `connected` turns false) or the application stops (the wake-ups close); the
 * edge sends the keep-alive comments while nothing changes.
 */
async function follow(out, since) {
  const queue = wakeups.subscribe();
  const pingMs = keepAliveMs();
  const checkMs = pingMs > 0 ? pingMs : 30_000;
  try {
    for (const row of await reader().since(since, LIST_LIMIT_MAX)) {
      out.writeNamed('question', frame(row));
      since = row.seq;
    }
    while (out.connected) {
      const row = await Wakeups.next(queue, checkMs);
      if (row === null) continue;
      if (row === CLOSED) {
        out.close(); // the application is stopping; the device reconnects
        break;
      }
      if (row.seq > since && out.connected) {
        out.writeNamed('question', frame(row));
        since = row.seq;
      }
    }
  } catch (error) {
    log.warn(`The stream could not read the record - ${failure(error)}`); // a store that cannot be read ends the stream; the device reconnects
    out.fail(new AppException(503, 'the question record is not available'));
  } finally {
    wakeups.unsubscribe(queue);
  }
}

/**
 * GET /questions/events (question.events, a streaming entry): the stream a connected device holds. The head goes out
 * at once, with a day's idle allowance; the rows since Last-Event-ID (or since) and every later change follow from a
 * task of their own, so the function's workers are never held by the devices.
 */
export async function questionEvents(_headers, event) {
  const request = new AsyncHttpRequest(event.body);
  const since = Number(request.header('last-event-id') || request.queryParameter('since') || '0');
  if (!Number.isInteger(since)) throw new AppException(400, 'Last-Event-ID must be a whole number');
  const out = EventStreamWriter.fromRequest(event);
  out.first(200, 'text/event-stream', STREAM_IDLE_SECONDS);
  out.write(null); // the head alone: the stream is open before the first row
  void follow(out, since);
}

/** GET /transcripts?before=<iso>&limit=<n>&correlation_id=&graph_id=: the audit store's conversations, newest first. */
export async function transcriptList(_headers, body) {
  const request = new AsyncHttpRequest(body);
  let before = request.queryParameter('before') || null;
  if (before !== null) {
    const parsed = parseIso(before);
    if (parsed === null) throw new AppException(400, 'before must be an ISO-8601 time');
    before = isoUtc(parsed);
  }
  const limitRaw = whole(request.queryParameter('limit'), TRANSCRIPTS_LIMIT);
  if (limitRaw === null) throw new AppException(400, 'limit must be a whole number');
  const limit = Math.min(TRANSCRIPTS_LIMIT_MAX, Math.max(1, limitRaw));
  let rows;
  try {
    rows = await reader().conversations(before, limit, request.queryParameter('correlation_id') || null, request.queryParameter('graph_id') || null);
  } catch (error) {
    log.warn(`The transcripts could not be read - ${failure(error)}`);
    throw new AppException(503, 'the transcript audit store is not available');
  }
  return jsonReply(200, { conversations: rows, next: rows.length > 0 ? rows.at(-1).started_at : null, more: rows.length >= limit });
}

/** GET /transcripts/{conversation} (transcript.show): one conversation of the audit store with its turns, as the model exchanged them. */
export async function transcriptShow(_headers, body) {
  const request = new AsyncHttpRequest(body);
  const conversation = request.pathParameter('conversation') ?? '';
  if (!CONVERSATION_ID.test(conversation)) throw new AppException(400, 'a conversation is 32 hexadecimal characters');
  let found;
  try {
    found = await reader().conversation(conversation);
  } catch (error) {
    log.warn(`The transcript could not be read - ${failure(error)}`);
    throw new AppException(503, 'the transcript audit store is not available');
  }
  if (!found) throw new AppException(404, `conversation ${conversation} is not in the audit store`);
  return jsonReply(200, found);
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

/**
 * POST /questions/{id}/decide with {decisions, decided_by?}: the click, automated - the decisions go to the link's
 * reply endpoint under this app's bearer, the recorder behind that endpoint writes the answer on the row, and the
 * invoker gets the row as it then stands with the engine's outcome; the feed carries the change to every device.
 */
export async function questionDecide(_headers, requestBody) {
  const request = new AsyncHttpRequest(requestBody);
  const config = currentSettings();
  const body = request.body;
  if (!isMap(body)) throw new AppException(400, 'the decision must be a JSON map with decisions');
  const claimedBy = body.decided_by;
  if (claimedBy !== undefined && claimedBy !== null && !isText(claimedBy)) throw new AppException(400, 'decided_by must be text');
  const identity = identityOf(request);
  const decisions = body.decisions;
  if (!Array.isArray(decisions) || decisions.length === 0 || !decisions.every(isMap)) {
    throw new AppException(400, 'decisions must be a non-empty list, one per waiting call');
  }
  const idText = request.pathParameter('id') ?? '';
  if (!/^\d+$/.test(idText)) throw new AppException(400, 'the row id must be a whole number');
  const id = Number(idText);
  let row;
  try {
    row = await reader().get(id);
  } catch (error) {
    log.warn(`The record could not be read - ${failure(error)}`);
    throw new AppException(503, 'the question record is not available');
  }
  if (!row) throw new AppException(404, `row ${id} is not in the record`);
  if (!WAIT_KINDS.includes(row.kind) || !row.ticket || !row.link) throw new AppException(409, `row ${id} is an advice - nothing to decide`);
  if (row.state !== 'open') throw new AppException(409, `row ${id} is ${row.state} - decided by ${row.answered_by ?? 'nobody'}`);
  let target;
  try {
    target = replyRequest(row.link, row.ticket, decisions, identity.who);
  } catch (error) {
    if (!(error instanceof ReplyError)) throw error;
    throw new AppException(error.status, error.message);
  }
  const [status, answer, error] = await forward(target[0], target[1], config);
  const outcome = error
    ? { status: 502, body: { type: 'error', message: `the reply endpoint did not answer - ${error}` } }
    : { status, body: answer };
  // the recorder behind the reply endpoint has written the answer by now: read the row as it stands and let the feed
  // carry the change to every device
  feed.kick();
  let updated = null;
  try {
    updated = await reader().get(id);
  } catch (readError) {
    log.warn(`The record could not be re-read after a decision - ${failure(readError)}`); // the decision reached the engine
  }
  const shown = updated ?? row;
  log.info(`Row ${id} decided by ${identity.who} via ${identity.via} - ${outcome.status} -> ${shown.state}`);
  return jsonReply(200, { row: publicRow(shown), outcome });
}

/**
 * The person's side as REST automation entries (resources/rest.yaml, served with rest.automation: true): each path a
 * private function of this process, who is at the UI resolved once by the entries' authentication function - the
 * engines' way, in place of routes mounted by hand on the host. The stream is an interceptor behind an entry with
 * stream: true.
 */
export const REST_FUNCTIONS = [
  [CONFIG_ROUTE, questionConfig, { instances: INSTANCES, isPrivate: true }],
  [LIST_ROUTE, questionList, { instances: INSTANCES, isPrivate: true }],
  [EVENTS_ROUTE, questionEvents, { instances: INSTANCES, isPrivate: true, interceptor: true }],
  [TRANSCRIPTS_ROUTE, transcriptList, { instances: INSTANCES, isPrivate: true }],
  [TRANSCRIPT_ROUTE, transcriptShow, { instances: INSTANCES, isPrivate: true }],
  [DECIDE_ROUTE, questionDecide, { instances: INSTANCES, isPrivate: true }],
  [IDENTITY_ROUTE, questionIdentity, { instances: INSTANCES, isPrivate: true }]
];

/** Register the browser side's functions on a registry that lacks them (a platform of its own, in a test). */
export function registerRestFunctions(registry = defaultRegistry) {
  for (const [route, handler, options] of REST_FUNCTIONS) {
    if (!registry.exists(route)) registry.register(route, handler, options);
  }
}

// --- boot -------------------------------------------------------------------------------------

/**
 * Load the settings and open the reader before the host listens; a bad configuration or a silent database stops it by
 * name. The feed starts at the record's newest sequence and follows from there.
 */
export async function boot() {
  const config = configure();
  if (config.store === 'postgres') {
    theReader = await postgresReader(config);
  } else {
    theReader = new MemoryReader();
    log.warn(`The store is in memory - nothing is recorded there at run time; set ${STORE}=postgres to read the question record and the transcripts the main flow and the LLM helper write`);
  }
  try {
    await theReader.open();
    feed.cursor = await theReader.latest();
  } catch (error) {
    if (error instanceof QuestionError) throw error;
    throw new QuestionError(`the ${config.store} store could not open - ${failure(error)}`);
  }
  feed.start(config.pollMs);
  log.info(`agent-question ready - store ${theReader.name} (feed from ${feed.cursor}), stream ${EVENTS_PATH}, poll ${config.pollMs} ms, auth ${config.auth}`);
}

/**
 * The application is stopping (Platform.onShutdown): end every connected device's stream, so the server can close its
 * connections and the process exits within a container manager's grace period; a device reconnects to the next
 * instance from its last sequence and misses nothing.
 */
export async function closeStreams() {
  wakeups.close();
}

export async function shutdown() {
  await feed.stop();
  if (theReader) await theReader.close();
}

export const feedRunning = () => feed.running;

export function attach(target = platform) {
  target.onStartup(boot);
  target.onShutdown(closeStreams);
  target.onCleanup(shutdown);
  // the browser side is rest.yaml entries served by this process's functions, not mounted routes
  registerRestFunctions(target.registry ?? defaultRegistry);
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
