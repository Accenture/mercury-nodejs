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
 * - The browser side runs under the pack's host (Platform.addRoutes). GET /questions/config tells the UI how to sign
 *   in; GET /questions?since=<seq> is the replay a reconnecting device calls first - every row that changed since its
 *   cursor, oldest change first; GET /questions?before=<seq>&limit=<n> the history's older page, newest first, for an
 *   infinite scroll; GET /questions/events the stream a connected device holds, each event a changed row, Last-Event-ID
 *   the same cursor. GET /transcripts and GET /transcripts/{conversation} browse the transcript audit store the LLM
 *   helper writes beside the record. The person selects which card to answer; the card's button automates the click:
 *   POST /questions/{id}/decide posts {ticket, decisions, decided_by} to the main flow's reply endpoint - the link's own
 *   base, under this app's bearer - and the answer lands on the row through the recorder; the feed carries the change
 *   to every device.
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
import { AppException, appConfig, getLogger, isoUtc, loadConfig, platform, preload } from 'mercury-composable';

const log = getLogger('agent-question');
const HERE = dirname(fileURLToPath(import.meta.url));

// --- the contract -----------------------------------------------------------------------------

export const INTAKE_ROUTE = 'agent.question.inbox';
export const HEALTH_ROUTE = 'question.health';
export const KINDS = ['approval', 'question', 'advice'];
export const WAIT_KINDS = ['approval', 'question'];
// a wait's states; an advice has none (null) - whether a person read it is the device's business
export const STATES = ['open', 'answered', 'expired'];
export const PAGE_PATH = '/questions/app';
export const LIST_PATH = '/questions';
export const EVENTS_PATH = '/questions/events';
export const CONFIG_PATH = '/questions/config';
export const TRANSCRIPTS_PATH = '/transcripts';
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

/** Who is at the UI: nobody is asked in development, or a validated access token (obtained by the UI through PKCE). */
export async function identify(req, config, claimed) {
  if (config.auth === 'none') return { who: claimed || 'anonymous', via: 'none' };
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

/** What the UI needs before it signs in: the auth mode, the title and, under oauth2, the issuer, the public client id, the scopes and the audience. */
export function uiConfig(config) {
  const result = { auth: config.auth, title: config.pageTitle };
  if (config.auth === 'oauth2') {
    result.oauth2 = { issuer: config.oauth2Issuer, client_id: config.oauth2ClientId, scopes: config.oauth2Scopes, audience: config.oauth2Audience };
  }
  return result;
}

/** GET /questions/config: the UI's sign-in configuration - open, it holds no secret. */
export async function showConfig(_req, res) {
  sendJson(res, 200, uiConfig(currentSettings()));
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
export async function listRows(req, res, url) {
  const config = currentSettings();
  try {
    await identify(req, config, null);
  } catch (error) {
    if (!(error instanceof ReplyError)) throw error;
    return sendError(res, error.status, error.message);
  }
  const limitRaw = whole(url.searchParams.get('limit'), LIST_LIMIT);
  const history = url.searchParams.has('before');
  const before = history ? whole(url.searchParams.get('before'), null) : null;
  const since = history ? 0 : whole(url.searchParams.get('since'), 0);
  if (limitRaw === null || since === null || (history && url.searchParams.get('before') && before === null)) {
    return sendError(res, 400, 'since, before and limit must be whole numbers');
  }
  const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, limitRaw));
  try {
    if (history) {
      const older = await reader().before(before, limit);
      return sendJson(res, 200, { ...pageBefore(older, null, limit), before });
    }
    const rows = await reader().since(since, limit);
    return sendJson(res, 200, { ...pageSince(rows, since, limit), since });
  } catch (error) {
    log.warn(`The record could not be read - ${failure(error)}`);
    return sendError(res, 503, 'the question record is not available');
  }
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

/** GET /questions/events: rows since Last-Event-ID (or since) first, then every change the feed finds; keep-alive comments. */
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
    for (const row of await reader().since(since, LIST_LIMIT_MAX)) {
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
  } catch (error) {
    log.warn(`The stream could not read the record - ${failure(error)}`); // the device reconnects
  } finally {
    wakeups.unsubscribe(queue);
  }
  if (!res.writableEnded) res.end();
}

/** GET /transcripts?before=<iso>&limit=<n>&correlation_id=&graph_id=: the audit store's conversations, newest first. */
export async function listTranscripts(req, res, url) {
  const config = currentSettings();
  try {
    await identify(req, config, null);
  } catch (error) {
    if (!(error instanceof ReplyError)) throw error;
    return sendError(res, error.status, error.message);
  }
  let before = url.searchParams.get('before') || null;
  if (before !== null) {
    const parsed = parseIso(before);
    if (parsed === null) return sendError(res, 400, 'before must be an ISO-8601 time');
    before = isoUtc(parsed);
  }
  const limitRaw = whole(url.searchParams.get('limit'), TRANSCRIPTS_LIMIT);
  if (limitRaw === null) return sendError(res, 400, 'limit must be a whole number');
  const limit = Math.min(TRANSCRIPTS_LIMIT_MAX, Math.max(1, limitRaw));
  let rows;
  try {
    rows = await reader().conversations(before, limit, url.searchParams.get('correlation_id') || null, url.searchParams.get('graph_id') || null);
  } catch (error) {
    log.warn(`The transcripts could not be read - ${failure(error)}`);
    return sendError(res, 503, 'the transcript audit store is not available');
  }
  return sendJson(res, 200, { conversations: rows, next: rows.length > 0 ? rows.at(-1).started_at : null, more: rows.length >= limit });
}

/** GET /transcripts/{conversation}: one conversation of the audit store with its turns, as the model exchanged them. */
export async function showTranscript(req, res, conversation) {
  const config = currentSettings();
  try {
    await identify(req, config, null);
  } catch (error) {
    if (!(error instanceof ReplyError)) throw error;
    return sendError(res, error.status, error.message);
  }
  if (!CONVERSATION_ID.test(conversation)) return sendError(res, 400, 'a conversation is 32 hexadecimal characters');
  let found;
  try {
    found = await reader().conversation(conversation);
  } catch (error) {
    log.warn(`The transcript could not be read - ${failure(error)}`);
    return sendError(res, 503, 'the transcript audit store is not available');
  }
  if (!found) return sendError(res, 404, `conversation ${conversation} is not in the audit store`);
  return sendJson(res, 200, found);
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
  let row;
  try {
    row = await reader().get(id);
  } catch (error) {
    log.warn(`The record could not be read - ${failure(error)}`);
    return sendError(res, 503, 'the question record is not available');
  }
  if (!row) return sendError(res, 404, `row ${id} is not in the record`);
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
  return sendJson(res, 200, { row: publicRow(shown), outcome });
}

const STYLE = 'body{font-family:-apple-system,Helvetica,Arial,sans-serif;margin:0;color:#222;background:#f4f5f7}'
  + 'header{background:#1f2a44;color:#fff;padding:.8rem 1.2rem;display:flex;gap:1rem;align-items:center}'
  + 'header h1{font-size:1.1rem;margin:0;flex:1}header input{padding:.3rem .5rem;border-radius:6px;border:1px solid #889}'
  + '#status{font-size:.8rem;opacity:.85}main{padding:1rem 1.2rem;max-width:1000px;margin:0 auto}'
  + '.case{background:#fff;border:1px solid #dde;border-radius:10px;margin:1rem 0;padding:.8rem 1rem}'
  + '.case h2{font-size:1rem;margin:0 0 .3rem}.meta{color:#667;font-size:.8rem}'
  + '.card{border-top:1px solid #eee;padding:.7rem 0}.card.open{border-left:4px solid #e0a800;padding-left:.8rem}'
  + '.card.answered{border-left:4px solid #2e9e5b;padding-left:.8rem;opacity:.85}'
  + '.card.expired{border-left:4px solid #999;padding-left:.8rem;opacity:.7}'
  + '.card.advice{border-left:4px solid #3a7bd5;padding-left:.8rem}pre{background:#f3f3f3;border-radius:6px;'
  + 'padding:.5rem .7rem;overflow:auto;font-size:.8rem}fieldset{border:1px solid #ddd;border-radius:8px;margin:.5rem 0}'
  + 'textarea,input[type=text]{width:100%;box-sizing:border-box;margin:.2rem 0}button{padding:.4rem 1rem;border-radius:6px;'
  + 'border:1px solid #556;background:#fff;cursor:pointer}button.primary{background:#1f2a44;color:#fff}'
  + '.outcome{font-size:.85rem;color:#334;margin-top:.4rem}.empty{color:#667;padding:2rem;text-align:center}'
  + 'header{position:sticky;top:0;z-index:2}.section{display:flex;align-items:center;gap:.5rem;font-size:.95rem;color:#445;margin:1.2rem 0 .4rem}.count{background:#e0a800;color:#222;border-radius:999px;padding:0 .5rem;font-size:.8rem;min-width:1.2rem;text-align:center}.count:empty{display:none}#history-section .count{background:#dde;color:#334}.panel{max-height:45vh;overflow-y:auto;border:1px solid #dde;border-radius:10px;background:#fafbfc;padding:0 .8rem}.panel .case{margin:.6rem 0}';

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
  let body = '<div class="card ' + esc(r.state || '') + ' ' + esc(r.kind) + '" data-row="' + r.id + '"><div><strong>' + esc(r.summary) + '</strong> <span class="meta">' + esc(r.kind) + (r.turn != null ? ' · turn ' + r.turn : '') + (r.state ? ' · ' + esc(r.state) : '') + ' · ' + when + '</span></div>';
  if (r.details) body += '<p>' + esc(r.details) + '</p>';
  if (r.kind === 'advice') { /* an advice is a notice: nothing to decide */ }
  else if (r.state === 'open') {
    body += '<form data-decide="' + r.id + '">' + (r.calls || []).map(callForm).join('') + '<button class="primary" type="submit">Send the decision</button></form>';
    if (r.expires_at) body += '<div class="meta">expires ' + esc(r.expires_at.replace('T', ' ').slice(0, 19)) + '</div>';
  } else {
    body += '<div class="outcome">' + (r.answered_by ? 'decided by ' + esc(r.answered_by) + ' at ' + esc((r.answered_at || '').replace('T', ' ').slice(0, 19)) : '') + (r.outcome ? ' · ' + esc((r.outcome.body && (r.outcome.body.type || r.outcome.body.message)) || r.outcome.status) : '') + '</div>';
  }
  return body + '</div>';
}
function caseHtml(list) {
  list.sort((a, b) => a.seq - b.seq);
  const first = list[0];
  return '<section class="case"><h2>' + esc(first.description) + '</h2><div class="meta">' + esc(first.graph_id) + ' · ' + esc(first.correlation_id) + '</div>' + list.map(card).join('') + '</section>';
}
function render() {
  // what waits for the person first - every case with an open card - and the closed cases in the history panel,
  // newest activity first on both sides; the panel keeps its scroll position across updates
  const waiting = document.getElementById('cases'), history = document.getElementById('history');
  const groups = new Map();
  for (const r of rows.values()) { const key = r.graph_id + '\u0000' + r.correlation_id; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r); }
  const newest = (list) => Math.max(...list.map(r => r.seq));
  const ordered = [...groups.values()].sort((a, b) => newest(b) - newest(a));
  const open = ordered.filter(list => list.some(r => r.state === 'open'));
  const closed = ordered.filter(list => !list.some(r => r.state === 'open'));
  const openCards = open.reduce((n, list) => n + list.filter(r => r.state === 'open').length, 0);
  document.getElementById('waiting-count').textContent = openCards ? String(openCards) : '';
  document.getElementById('history-count').textContent = closed.length ? String(closed.length) : '';
  document.title = (openCards ? '(' + openCards + ') ' : '') + TITLE;
  waiting.innerHTML = open.length ? open.map(caseHtml).join('') : '<div class="empty">Nothing waits for you.</div>';
  const keep = history.scrollTop;
  history.innerHTML = closed.length ? closed.map(caseHtml).join('') : '<div class="empty">Nothing yet.</div>';
  history.scrollTop = keep;
}
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

/** The development page (question.auth: none): the React UI of this pack replaces it, served from resources/public when deployed there. */
export function page(title) {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n`
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + `<title>${escapeHtml(title)}</title>\n<style>${STYLE}</style>\n</head>\n<body>\n`
    + `<header><h1>${escapeHtml(title)}</h1><label class="meta">your name <input id="name" type="text" `
    + 'placeholder="as the model will see it"></label><span id="status">connecting...</span></header>\n'
    + '<main><section id="waiting-section"><h2 class="section">Waiting for you <span id="waiting-count" '
    + 'class="count"></span></h2><div id="cases"><div class="empty">Loading...</div></div></section>\n'
    + '<section id="history-section"><h2 class="section">History <span id="history-count" class="count"></span>'
    + '</h2><div id="history" class="panel"><div class="empty">Loading...</div></div></section></main>\n'
    + `<script>const LIST = ${JSON.stringify(LIST_PATH)}; const EVENTS = ${JSON.stringify(EVENTS_PATH)}; `
    + `const TITLE = ${JSON.stringify(title)};${SCRIPT}</script>\n`
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
  if (req.method === 'GET') {
    if (path === CONFIG_PATH) {
      await showConfig(req, res);
      return true;
    }
    if (path === PAGE_PATH) {
      await servePage(req, res);
      return true;
    }
    if (path === EVENTS_PATH) {
      await events(req, res, url);
      return true;
    }
    if (path === LIST_PATH) {
      await listRows(req, res, url);
      return true;
    }
    if (path === TRANSCRIPTS_PATH) {
      await listTranscripts(req, res, url);
      return true;
    }
    const transcript = /^\/transcripts\/([^/]+)$/.exec(path);
    if (transcript) {
      await showTranscript(req, res, decodeURIComponent(transcript[1]));
      return true;
    }
  }
  const action = /^\/questions\/([^/]+)\/decide$/.exec(path);
  if (req.method === 'POST' && action) {
    const id = Number(action[1]);
    if (!Number.isInteger(id)) {
      sendError(res, 400, 'the row id must be a whole number');
      return true;
    }
    await decide(req, res, id);
    return true;
  }
  return false;
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
  log.info(`agent-question ready - store ${theReader.name} (feed from ${feed.cursor}), page ${PAGE_PATH}, stream ${EVENTS_PATH}, poll ${config.pollMs} ms, auth ${config.auth}`);
}

export async function shutdown() {
  await feed.stop();
  if (theReader) await theReader.close();
}

export const feedRunning = () => feed.running;

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
