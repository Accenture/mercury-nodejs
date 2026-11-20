/**
 * Ask a person - the main flow of RFC-0014 (the engines' draft-design-specs/ask-a-person-channel.md), the Node.js
 * twin of mercury-python's extensions/ask-person. A graph's agent loop can wait for a person - a tool call marked
 * write: true under the default mode, or the ask row of the loop spec's section 7.3 - and the graph suspends durably
 * on its state store. This extension carries the wait to a person and brings the decision back; it knows no channel,
 * and it keeps no store: the engine's at-most-once resume is the authority.
 *
 * - person.ask is a composable function the graph's hold path calls before it suspends. The message names the graph
 *   (graph_id, description, node), the transaction (correlation_id, turn), the waiting calls exactly as the loop
 *   returned them, and the suspension's ttl. The function issues a signed, stateless ticket, builds the resume link and
 *   sends the whole message as one event to every route in ask.channels - the agent-question app, a chat poster, a mail
 *   sender, a topic publisher - knowing nothing of what a route does with it; a channel that fails is logged by type and
 *   never fails the hold. A third kind, advice, is a notification with no decision: no ticket, no link.
 * - The resume link opens the wait on this process's reply page, GET /ask/{ticket}: the page reads the current wait
 *   from the engine by the reference graph's re-advice (GET /ask/{ticket}/wait) and only a submit resumes.
 *   POST /ask/reply with {ticket, decisions} - a person's browser, or a channel app on the person's behalf under its
 *   own bearer with decided_by - verifies the ticket, maps the graph id to the engine's entry through the ask.graphs
 *   allowlist, prefixes who decided and when to each note, sends the resume and returns the engine's outcome.
 * - The question record (round 4 of the paper, section 21): the main flow records and the channels deliver. Every wait
 *   and advice person.ask sends, whatever channel delivers it, and every answer the reply endpoint brings back - who
 *   decided, when, the engine's outcome - is written to the question record, part of the transcript audit log, by
 *   question.audit: a private composable function of this process behind local events, off the request path, whose
 *   writes are order-independent (a wait upserts on its key unless an older message arrives late, an advice appends,
 *   the first accepted answer stands), so it may run several instances. The store is PostgreSQL (ask.audit: postgres,
 *   schema/postgres.sql) or memory for the tests; the contract is published so a field implements another database.
 *   A failure is logged by type and never fails a hold or a reply.
 *
 * Run:  node dist/src/cli.js extensions/ask-person/ask-person.mjs -Dask.ticket.key='${ASK_TICKET_KEY}'
 *
 * The pure half - the ticket, the message and the event, the resume and the outcome, the row a message becomes, the
 * state an answer leaves and the record's transitions - is pinned by test/vectors/ask-person-vectors.json,
 * byte-identical with the Python pack.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppException, appConfig, defaultRegistry, getLogger, isoUtc, loadConfig, platform, PostOffice, preload } from 'mercury-composable';

const log = getLogger('ask-person');
const HERE = dirname(fileURLToPath(import.meta.url));

// --- the contract -----------------------------------------------------------------------------

export const ROUTE = 'person.ask';
export const HEALTH_ROUTE = 'ask.health';
export const AUDIT_ROUTE = 'question.audit';
export const INSTANCES = 10;
export const KINDS = ['approval', 'question', 'advice'];
export const WAIT_KINDS = ['approval', 'question'];
// a wait's states; an advice has none (null): whether a person read it is the device's business
export const STATES = ['open', 'answered', 'expired'];
export const TICKET_VERSION = 'v1';
export const SHOW_PREFIX = '/ask/';
export const WAIT_SUFFIX = '/wait';
export const REPLY_PATH = '/ask/reply';
export const CONFIG_PATH = '/ask/config';
export const AUTH_MODES = ['none', 'oauth2'];
export const JWT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512'];
export const GRAPH_ID_HEADER = 'x-graph-id';
export const CORRELATION_HEADER = 'x-correlation-id';
export const AUDITS = ['memory', 'postgres'];

// configuration keys
export const ENABLED = 'ask.enabled';
export const CHANNELS = 'ask.channels';
export const CHANNEL_TIMEOUT = 'ask.channel.timeout';
export const CHANNEL_ENDPOINTS = 'ask.channel.endpoints';
export const TICKET_KEY = 'ask.ticket.key';
export const PREVIOUS_KEY = 'ask.ticket.previous-key';
export const REPLY_URL = 'ask.reply.url';
export const REPLY_AUTH = 'ask.reply.auth';
export const OAUTH2_ISSUER = 'ask.reply.auth.oauth2.issuer';
export const OAUTH2_AUDIENCE = 'ask.reply.auth.oauth2.audience';
export const OAUTH2_JWKS_URL = 'ask.reply.auth.oauth2.jwks-url';
export const OAUTH2_CLIENT_ID = 'ask.reply.auth.oauth2.client-id';
export const OAUTH2_SCOPES = 'ask.reply.auth.oauth2.scopes';
export const APP_TOKEN = 'ask.reply.auth.token';
export const GRAPHS = 'ask.graphs';
export const ENGINE_TIMEOUT = 'ask.engine.timeout';
export const AUDIT = 'ask.audit';
export const AUDIT_POSTGRES_PREFIX = 'ask.audit.postgres.';
export const AUDIT_SWEEP = 'ask.audit.sweep';
export const AUDIT_INSTANCES = 'ask.audit.instances';
export const AUDIT_TIMEOUT = 'ask.audit.timeout';

export const MISSING_POSTGRES = 'ask.audit is postgres but the pg driver is not installed - npm install pg';
const DURATION = /^(\d+)\s*(ms|s|m|h|d)?$/;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION_RULE = 'a duration such as 30m, 12h or 2d (seconds, s, m, h, d)';
// the base64url alphabet without padding - a ticket part outside it is malformed, never decoded leniently
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A configuration the extension cannot start with - the boot fails by name. */
export class AskError extends Error {}

/** A ticket that cannot be accepted: its status and the message the invoker sees. */
export class TicketError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** A reply that cannot be forwarded: its status and the message the invoker sees. */
export class ReplyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isMap = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === 'string';
const isWhole = (value) => typeof value === 'number' && Number.isInteger(value);

// --- durations and times ----------------------------------------------------------------------

/** Milliseconds from a whole number of seconds or a duration such as 500ms, 30m, 12h or 2d; null otherwise. */
export function durationMs(value) {
  if (typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value * 1000 : null;
  if (!isText(value)) return null;
  const match = DURATION.exec(value.trim());
  if (!match) return null;
  return Number.parseInt(match[1], 10) * UNIT_MS[match[2] ?? 's'];
}

/** An ISO-8601 time with an offset or Z, as a Date; null when it is not one. */
export function parseIso(text) {
  const candidate = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(candidate)) return null;
  const ms = Date.parse(candidate);
  return Number.isNaN(ms) ? null : new Date(ms);
}

// --- configuration ----------------------------------------------------------------------------

function text(config, key, defaultValue = '') {
  const value = config.get(key);
  return value === undefined || value === null ? defaultValue : String(value).trim();
}

function flag(config, key, defaultValue) {
  const value = config.get(key);
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  return ['true', 'yes', 'on', '1'].includes(String(value).trim().toLowerCase());
}

/** A list of names from a YAML list or a comma-separated text (a -D override). */
function names(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(',');
  return items.map((item) => String(item).trim()).filter((item) => item);
}

/** A mapping from a YAML list of {keyName, valueName} maps or a comma-separated key=value text. */
function pairs(value, keyName, valueName, setting) {
  const result = {};
  if (value === undefined || value === null) return result;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isMap(item) || !item[keyName] || !item[valueName]) {
        throw new AskError(`${setting} entries need ${keyName} and ${valueName}`);
      }
      result[String(item[keyName]).trim()] = String(item[valueName]).trim();
    }
    return result;
  }
  for (const part of String(value).split(',')) {
    if (!part.trim()) continue;
    const at = part.indexOf('=');
    const key = at < 0 ? '' : part.slice(0, at).trim();
    const target = at < 0 ? '' : part.slice(at + 1).trim();
    if (!key || !target) throw new AskError(`${setting} takes ${keyName}=${valueName} pairs`);
    result[key] = target;
  }
  return result;
}

function timeout(config, key, defaultValue) {
  const value = config.get(key);
  const ms = durationMs(value === undefined || value === null ? defaultValue : value);
  if (ms === null || ms <= 0) throw new AskError(`${key} must be ${DURATION_RULE} > 0`);
  return ms;
}

/** A whole number >= minimum (a count of instances, a number of milliseconds). */
function whole(config, key, defaultValue, minimum) {
  const value = config.get(key);
  const given = String(value === undefined || value === null ? defaultValue : value).trim();
  if (!/^\d+$/.test(given) || Number.parseInt(given, 10) < minimum) throw new AskError(`${key} must be a whole number >= ${minimum}`);
  return Number.parseInt(given, 10);
}

/**
 * The connection keys of the question record's PostgreSQL store - the transcript audit store's keys under the
 * ask.audit.postgres. prefix; the password a reference, never logged.
 */
function auditPostgres(config, timeoutMs) {
  const portText = text(config, `${AUDIT_POSTGRES_PREFIX}port`, '5432');
  if (!/^\d+$/.test(portText) || Number.parseInt(portText, 10) <= 0) throw new AskError(`${AUDIT_POSTGRES_PREFIX}port must be a port number`);
  const ssl = text(config, `${AUDIT_POSTGRES_PREFIX}ssl`, 'true').toLowerCase() !== 'false';
  return {
    host: text(config, `${AUDIT_POSTGRES_PREFIX}host`, '127.0.0.1'),
    port: Number.parseInt(portText, 10),
    database: text(config, `${AUDIT_POSTGRES_PREFIX}database`, 'mercury'),
    user: text(config, `${AUDIT_POSTGRES_PREFIX}username`) || undefined,
    password: text(config, `${AUDIT_POSTGRES_PREFIX}password`) || undefined,
    // the twin of libpq's sslmode=require (the audit store's rule); sslmode=disable when false
    ssl: ssl ? { rejectUnauthorized: false } : false,
    max: 4,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    // the server-side bound on a statement, as the transcript audit store sets it
    statement_timeout: timeoutMs
  };
}

/** The extension's settings from the application configuration, or an AskError naming the key that stops the boot. */
export function loadSettings(config) {
  const enabled = flag(config, ENABLED, true);
  const currentKey = text(config, TICKET_KEY);
  // the current key signs; the previous one only verifies, so it never stands in for the current
  const keys = [currentKey, text(config, PREVIOUS_KEY)].filter((k) => k).map((k) => Buffer.from(k, 'utf8'));
  const replyUrl = text(config, REPLY_URL).replace(/\/+$/, '');
  const auth = text(config, REPLY_AUTH, 'none').toLowerCase();
  const audit = text(config, AUDIT, 'memory').toLowerCase();
  const postgresTimeoutMs = whole(config, `${AUDIT_POSTGRES_PREFIX}timeout.ms`, 5000, 1);
  const settings = {
    enabled,
    channels: names(config.get(CHANNELS)),
    channelTimeoutMs: timeout(config, CHANNEL_TIMEOUT, '5s'),
    channelEndpoints: pairs(config.get(CHANNEL_ENDPOINTS), 'route', 'url', CHANNEL_ENDPOINTS),
    keys,
    replyUrl,
    auth,
    oauth2Issuer: text(config, OAUTH2_ISSUER).replace(/\/+$/, ''),
    oauth2Audience: text(config, OAUTH2_AUDIENCE),
    oauth2JwksUrl: text(config, OAUTH2_JWKS_URL),
    oauth2ClientId: text(config, OAUTH2_CLIENT_ID),
    oauth2Scopes: text(config, OAUTH2_SCOPES, 'openid profile email'),
    appToken: text(config, APP_TOKEN),
    graphs: pairs(config.get(GRAPHS), 'id', 'entry', GRAPHS),
    engineTimeoutMs: timeout(config, ENGINE_TIMEOUT, '60s'),
    audit,
    auditPostgres: auditPostgres(config, postgresTimeoutMs),
    auditPostgresTimeoutMs: postgresTimeoutMs,
    auditSweepMs: timeout(config, AUDIT_SWEEP, '30s'),
    auditInstances: whole(config, AUDIT_INSTANCES, 1, 1),
    auditTimeoutMs: timeout(config, AUDIT_TIMEOUT, '5s')
  };
  if (!enabled) return settings;
  if (!currentKey) throw new AskError(`${TICKET_KEY} is not set - the ticket's HMAC key, a \${ASK_TICKET_KEY} reference`);
  if (!/^https?:\/\//.test(replyUrl)) throw new AskError(`${REPLY_URL} must be the public base of the resume link (http or https)`);
  if (!AUTH_MODES.includes(auth)) throw new AskError(`${REPLY_AUTH} must be one of ${AUTH_MODES.join(', ')}`);
  if (auth === 'oauth2') {
    if (!settings.oauth2Issuer && !settings.oauth2JwksUrl) {
      throw new AskError(`${REPLY_AUTH} is oauth2 - set ${OAUTH2_ISSUER} or ${OAUTH2_JWKS_URL}`);
    }
    if (!settings.oauth2Issuer || !settings.oauth2ClientId) {
      log.warn(`${REPLY_AUTH} is oauth2 without ${OAUTH2_ISSUER} and ${OAUTH2_CLIENT_ID} - the reply page cannot sign a person in; `
        + "a channel app's bearer and a token obtained elsewhere still work");
    }
  }
  if (!AUDITS.includes(audit)) throw new AskError(`${AUDIT} must be one of ${AUDITS.join(', ')}`);
  for (const [graphId, entry] of Object.entries(settings.graphs)) {
    if (!/^https?:\/\//.test(entry)) throw new AskError(`${GRAPHS}: the entry of ${graphId} must be an http or https URL`);
  }
  return settings;
}

let settings;

/** Load (or reload) the settings; the boot and the tests call it, the handlers read it. */
export function configure(config) {
  settings = loadSettings(config ?? appConfig());
  return settings;
}

export function currentSettings() {
  return settings ?? configure();
}

// --- the ticket -------------------------------------------------------------------------------

const b64u = (buffer) => Buffer.from(buffer).toString('base64url');

/** The canonical JSON a ticket's payload is signed as: keys sorted, no spaces, Unicode kept - the binding's digest rule. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isMap(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const mac = (payload, key) => createHmac('sha256', key).update(payload).digest();

/** v1.<payload>.<mac>: the canonical payload and its HMAC-SHA256, both base64url without padding. */
export function issueTicket(payload, key) {
  const encoded = Buffer.from(canonicalJson(payload), 'utf8');
  return `${TICKET_VERSION}.${b64u(encoded)}.${b64u(mac(encoded, key))}`;
}

function payloadIsValid(payload) {
  if (!isMap(payload)) return false;
  const keys = Object.keys(payload).sort().join(',');
  if (keys !== 'c,e,g,k,t') return false;
  return isText(payload.g) && payload.g.length > 0 && isText(payload.c) && payload.c.length > 0
    && isWhole(payload.t) && payload.t >= 0 && WAIT_KINDS.includes(payload.k) && isWhole(payload.e);
}

/**
 * The payload of a ticket this process issued, or a TicketError: 400 when the ticket is malformed or of another
 * version, 403 when no key signs it, 410 when it has expired.
 */
export function verifyTicket(ticket, keys, nowSeconds) {
  const parts = String(ticket).split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) throw new TicketError(400, 'Ticket is malformed');
  const [version, encoded, signature] = parts;
  if (version !== TICKET_VERSION) throw new TicketError(400, `Ticket version ${version} is not supported`);
  if (!BASE64URL.test(encoded) || !BASE64URL.test(signature)) throw new TicketError(400, 'Ticket is malformed');
  const payloadBytes = Buffer.from(encoded, 'base64url');
  const given = Buffer.from(signature, 'base64url');
  const signed = keys.some((key) => {
    const expected = mac(payloadBytes, key);
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  if (!signed) throw new TicketError(403, 'Ticket signature is invalid');
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw new TicketError(400, 'Ticket is malformed');
  }
  if (!payloadIsValid(payload)) throw new TicketError(400, 'Ticket is malformed');
  if (payload.e < nowSeconds) throw new TicketError(410, 'Ticket expired');
  return payload;
}

// --- the message and the event ----------------------------------------------------------------

function requiredText(body, name) {
  const value = body[name];
  if (value === undefined || value === null) throw new AppException(400, `${name} is required`);
  if (!isText(value)) throw new AppException(400, `${name} must be text`);
  if (!value.trim()) throw new AppException(400, `${name} is required`);
  return value;
}

function optionalText(body, name) {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (!isText(value)) throw new AppException(400, `${name} must be text`);
  return value;
}

function turnOf(value, required) {
  if (value === undefined || value === null) {
    if (required) throw new AppException(400, 'turn is required for an approval or a question');
    return null;
  }
  if (!isWhole(value) || value < 0) throw new AppException(400, 'turn must be a whole number >= 0');
  return value;
}

/** The message a hold node sends, checked in a fixed order - the same in the Python twin - or an AppException(400). */
export function validateMessage(body) {
  if (!isMap(body)) throw new AppException(400, 'person.ask takes a map');
  const kind = body.kind;
  if (!KINDS.includes(kind)) throw new AppException(400, 'kind must be one of approval, question, advice');
  const graphId = requiredText(body, 'graph_id');
  const description = requiredText(body, 'description');
  const correlationId = requiredText(body, 'correlation_id');
  const summary = requiredText(body, 'summary');
  const node = optionalText(body, 'node');
  const requestedAtText = optionalText(body, 'requested_at');
  if (requestedAtText !== null && parseIso(requestedAtText) === null) {
    throw new AppException(400, 'requested_at must be an ISO-8601 time');
  }
  const requestedAt = requestedAtText || isoUtc();
  if (kind === 'advice') {
    if ('calls' in body || 'ttl' in body) throw new AppException(400, 'an advice carries no calls and no ttl');
    return {
      kind, graph_id: graphId, description, correlation_id: correlationId, summary, requested_at: requestedAt, node,
      turn: turnOf(body.turn, false), calls: null, ttl: null, ttl_ms: null, details: optionalText(body, 'details')
    };
  }
  const turn = turnOf(body.turn, true);
  const calls = body.calls;
  if (!Array.isArray(calls) || calls.length === 0
      || !calls.every((call) => isMap(call) && isText(call.id) && call.id.length > 0)) {
    throw new AppException(400, 'calls must be a non-empty list of the waiting calls, each with an id');
  }
  if (!('ttl' in body)) throw new AppException(400, 'ttl is required for an approval or a question');
  const ttlMs = durationMs(body.ttl);
  if (ttlMs === null || ttlMs <= 0) throw new AppException(400, `ttl must be ${DURATION_RULE} > 0`);
  return {
    kind, graph_id: graphId, description, correlation_id: correlationId, summary, requested_at: requestedAt, node, turn,
    calls: calls.map((call) => ({ ...call })), ttl: body.ttl, ttl_ms: ttlMs, details: null
  };
}

export function ticketPayload(message, expiresAt) {
  return { g: message.graph_id, c: message.correlation_id, t: message.turn, k: message.kind, e: Math.floor(expiresAt.getTime() / 1000) };
}

/** The message event the channels receive: the message, and for a wait the ticket, the resume link and the expiry. */
export function buildEvent(message, key, replyUrl) {
  const event = { kind: message.kind, graph_id: message.graph_id, description: message.description, correlation_id: message.correlation_id };
  if (message.turn !== null) event.turn = message.turn;
  if (message.node !== null) event.node = message.node;
  event.summary = message.summary;
  if (message.details !== null) event.details = message.details;
  if (message.calls !== null) event.calls = message.calls;
  if (message.ttl !== null) event.ttl = message.ttl;
  event.requested_at = message.requested_at;
  if (WAIT_KINDS.includes(message.kind) && message.ttl_ms !== null) {
    const requested = parseIso(message.requested_at) ?? new Date();
    const expiresAt = new Date(requested.getTime() + message.ttl_ms);
    const ticket = issueTicket(ticketPayload(message, expiresAt), key);
    event.expires_at = isoUtc(expiresAt);
    event.ticket = ticket;
    event.link = `${replyUrl.replace(/\/+$/, '')}/ask/${ticket}`;
  }
  return event;
}

// --- the resume and the outcome ---------------------------------------------------------------

function entryOf(payload, graphs) {
  const entry = graphs[String(payload.g)];
  if (!entry) throw new ReplyError(404, `graph ${payload.g} is not configured for replies`);
  return entry;
}

/** The reference graph's re-advice: the same entry and correlation id, the turn and no decisions. */
export function readviceRequest(payload, graphs) {
  return { url: entryOf(payload, graphs), headers: { [CORRELATION_HEADER]: String(payload.c) }, body: { turn: payload.t } };
}

/** The person's decisions, one per waiting call - {id, approved, note?} or {id, answer} - or a ReplyError(400). */
export function validateDecisions(decisions) {
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throw new ReplyError(400, 'decisions must be a non-empty list, one per waiting call');
  }
  const result = [];
  for (const decision of decisions) {
    if (!isMap(decision) || !isText(decision.id) || !decision.id) throw new ReplyError(400, 'each decision needs the id of its call');
    const hasApproved = 'approved' in decision;
    const hasAnswer = 'answer' in decision;
    if (hasApproved && hasAnswer) throw new ReplyError(400, 'each decision carries approved (with an optional note) or answer, not both');
    if (!hasApproved && !hasAnswer) throw new ReplyError(400, 'each decision carries approved (with an optional note) or answer');
    if (hasApproved && typeof decision.approved !== 'boolean') throw new ReplyError(400, 'approved must be true or false');
    if ('note' in decision && decision.note !== null && !isText(decision.note)) throw new ReplyError(400, 'note must be text');
    if (hasAnswer && 'note' in decision) throw new ReplyError(400, "a question's decision carries an answer and no note");
    result.push({ ...decision });
  }
  return result;
}

/** Who decided and when, prefixed to each tool call's note; a question's answer travels unchanged. */
export function stampDecisions(decisions, who, at) {
  return decisions.map((decision) => {
    const copy = { ...decision };
    if ('approved' in copy) {
      const prefix = `[${who} at ${at}]`;
      copy.note = copy.note ? `${prefix} ${copy.note}` : prefix;
    }
    return copy;
  });
}

/** The resume the reply endpoint sends: the entry from the allowlist, the correlation id, the turn and the stamped decisions. */
export function buildResume(payload, decisions, who, at, graphs) {
  const checked = validateDecisions(decisions);
  return {
    url: entryOf(payload, graphs),
    headers: { [CORRELATION_HEADER]: String(payload.c) },
    body: { turn: payload.t, decisions: stampDecisions(checked, who, at) }
  };
}

/** What the invoker gets back: the engine's status and body as they are, or a 502 when it did not answer or answered outside the contract. */
export function mapOutcome(status, textBody, error) {
  if (error) return [502, { type: 'error', message: `the graph did not answer - ${error}` }];
  let body = null;
  try {
    body = textBody ? JSON.parse(textBody) : null;
  } catch {
    body = null;
  }
  if (status === null || status === undefined || !isMap(body)) {
    return [502, { type: 'error', message: 'the graph answered outside the contract' }];
  }
  return [status, body];
}

// --- the question record (round 4) ------------------------------------------------------------
//
// The main flow records and the channels deliver: every wait and advice person.ask sends and every answer the reply
// endpoint brings back is written here, part of the transcript audit log, by the question.audit function behind local
// events. The row is what the agent-question app's feed carries to a device; the shape is pinned by the shared vectors.

/** The row as a feed carries it. */
export function publicRow(row) {
  return {
    id: row.id, seq: row.seq, kind: row.kind, graph_id: row.graph_id, correlation_id: row.correlation_id, turn: row.turn,
    ticket: row.ticket, link: row.link, description: row.description, summary: row.summary, details: row.details,
    calls: row.message.calls ?? null, state: row.state, requested_at: row.requested_at, expires_at: row.expires_at,
    updated_at: row.updated_at, answered_at: row.answered_at, answered_by: row.answered_by, decisions: row.decisions,
    outcome: row.outcome
  };
}

/** The key a wait upserts on; an advice has none and appends. */
export function waitKey(event) {
  if (!WAIT_KINDS.includes(event.kind)) return null;
  return [String(event.graph_id), String(event.correlation_id), Number(event.turn)];
}

/** What a row takes from a message event: a wait starts open with its ticket, link and expiry; an advice has none and no state. */
export function rowFields(event, now) {
  const wait = WAIT_KINDS.includes(event.kind);
  return {
    kind: event.kind, graph_id: event.graph_id, correlation_id: event.correlation_id, turn: event.turn ?? null,
    ticket: wait ? (event.ticket ?? null) : null, link: wait ? (event.link ?? null) : null,
    description: event.description, summary: event.summary, details: event.details ?? null, message: { ...event },
    state: wait ? 'open' : null, requested_at: event.requested_at || now, expires_at: wait ? (event.expires_at ?? null) : null,
    updated_at: now, answered_at: null, answered_by: null, decisions: null, outcome: null
  };
}

/** The state an answer's outcome leaves: the engine accepted it (answered), nothing was waiting (expired), or open. */
export function answerState(status, body) {
  const kind = isMap(body) ? body.type : null;
  if (status === 410 || kind === 'nothing-waiting') return 'expired';
  if (status !== null && status !== undefined && status >= 200 && status < 300 && !(isMap(body) && body.error)) return 'answered';
  return 'open';
}

const keyOf = (key) => key.join('\u0000');

/**
 * The question record's contract, in memory - published so a field implements it on another database: record (a wait
 * upserted on its key unless the row holds a newer message, an advice appended), answer (applied while the row is open
 * or when the engine accepted the decision; the row as it stands otherwise; null when no wait was recorded), expire,
 * since and counts. PostgreSQL is the reference; this store carries the same semantics for the tests.
 */
export class MemoryQuestionStore {
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

  async record(event, now) {
    const fields = rowFields(event, now);
    const key = waitKey(event);
    const existingId = key === null ? undefined : this.keys.get(keyOf(key));
    const existing = existingId === undefined ? undefined : this.rows.get(existingId);
    let row;
    if (existing) {
      if (fields.requested_at < existing.requested_at) return existing; // an older message landing late never overwrites a newer row
      row = { ...existing, ...fields, seq: this.bump() };
    } else {
      this.nextId += 1;
      row = { id: this.nextId, seq: this.bump(), ...fields };
      if (key !== null) this.keys.set(keyOf(key), row.id);
    }
    this.rows.set(row.id, row);
    return row;
  }

  async answer(key, decisions, who, state, outcome, now) {
    const id = this.keys.get(keyOf(key));
    const row = id === undefined ? undefined : this.rows.get(id);
    if (!row) return null;
    if (row.state !== 'open' && state !== 'answered') return row; // decided first by another device: a later nothing-waiting never overwrites it
    const updated = { ...row, seq: this.bump(), state, decisions, outcome, answered_by: who, answered_at: now, updated_at: now };
    this.rows.set(updated.id, updated);
    return updated;
  }

  async expire(now) {
    const changed = [];
    for (const row of [...this.rows.values()]) {
      if (row.state === 'open' && WAIT_KINDS.includes(row.kind) && row.expires_at && row.expires_at < now) {
        const updated = { ...row, seq: this.bump(), state: 'expired', updated_at: now };
        this.rows.set(updated.id, updated);
        changed.push(updated);
      }
    }
    return changed;
  }

  async since(seq, limit) {
    return [...this.rows.values()].filter((r) => r.seq > seq).sort((a, b) => a.seq - b.seq).slice(0, limit);
  }

  async counts() {
    const result = {};
    for (const row of this.rows.values()) {
      const label = row.state ?? row.kind;
      result[label] = (result[label] ?? 0) + 1;
    }
    return result;
  }
}

// the statements the reference store runs, with pg's placeholders; JSON travels as compact text cast to jsonb and
// stamps as text cast to timestamptz, so the Python twin runs the same statements
export const COLUMNS = 'id, seq, ticket, graph_id, correlation_id, turn, kind, description, summary, details, message, link, '
  + 'state, requested_at, expires_at, updated_at, answered_at, answered_by, decisions, outcome';
export const SQL_RECORD_WAIT = 'INSERT INTO question (seq, ticket, graph_id, correlation_id, turn, kind, description, summary, '
  + "details, message, link, state, requested_at, expires_at, updated_at) VALUES (nextval('question_seq'), $1, $2, $3, $4, $5, "
  + "$6, $7, NULL, $8::jsonb, $9, 'open', $10::timestamptz, $11::timestamptz, $12::timestamptz) "
  + "ON CONFLICT (graph_id, correlation_id, turn) WHERE kind <> 'advice' DO UPDATE SET seq = nextval('question_seq'), "
  + 'ticket = EXCLUDED.ticket, description = EXCLUDED.description, summary = EXCLUDED.summary, details = NULL, '
  + "message = EXCLUDED.message, link = EXCLUDED.link, state = 'open', requested_at = EXCLUDED.requested_at, "
  + 'expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at, answered_at = NULL, answered_by = NULL, '
  + `decisions = NULL, outcome = NULL WHERE EXCLUDED.requested_at >= question.requested_at RETURNING ${COLUMNS}`;
export const SQL_RECORD_ADVICE = 'INSERT INTO question (seq, ticket, graph_id, correlation_id, turn, kind, description, summary, '
  + "details, message, link, state, requested_at, expires_at, updated_at) VALUES (nextval('question_seq'), NULL, $1, $2, $3, "
  + `'advice', $4, $5, $6, $7::jsonb, NULL, NULL, $8::timestamptz, NULL, $9::timestamptz) RETURNING ${COLUMNS}`;
export const SQL_WAIT = `SELECT ${COLUMNS} FROM question WHERE graph_id = $1 AND correlation_id = $2 AND turn = $3 AND kind <> 'advice'`;
export const SQL_ANSWER = "UPDATE question SET seq = nextval('question_seq'), state = $1, decisions = $2::jsonb, outcome = $3::jsonb, "
  + 'answered_by = $4, answered_at = $5::timestamptz, updated_at = $6::timestamptz '
  + "WHERE graph_id = $7 AND correlation_id = $8 AND turn = $9 AND kind <> 'advice' "
  + `AND (state = 'open' OR $10::text = 'answered') RETURNING ${COLUMNS}`;
export const SQL_EXPIRE = "UPDATE question SET seq = nextval('question_seq'), state = 'expired', updated_at = $1::timestamptz "
  + `WHERE state = 'open' AND kind <> 'advice' AND expires_at < $2::timestamptz RETURNING ${COLUMNS}`;
export const SQL_SINCE = `SELECT ${COLUMNS} FROM question WHERE seq > $1 ORDER BY seq LIMIT $2`;
export const SQL_COUNTS = 'SELECT COALESCE(state, kind) AS label, count(*) FROM question GROUP BY COALESCE(state, kind)';

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
    details: record.details ?? null, message: json(record.message) ?? {},
    state: record.state === null || record.state === undefined ? null : String(record.state),
    requested_at: stamp(record.requested_at) ?? '', expires_at: stamp(record.expires_at), updated_at: stamp(record.updated_at) ?? '',
    answered_at: stamp(record.answered_at), answered_by: record.answered_by ?? null, decisions: json(record.decisions),
    outcome: json(record.outcome)
  };
}

/** The reference store: the pg driver's pool. The function inserts and updates one table and nothing else; the agent-question app and people read. */
export class PostgresQuestionStore {
  name = 'postgres';

  constructor(pool) {
    this.pool = pool; // pg.Pool, or a recording fake in the tests
  }

  async open() {
    // a connection taken and returned: a database that does not answer is reported at the boot
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

  async record(event, now) {
    const f = rowFields(event, now);
    const key = waitKey(event);
    let row;
    if (key !== null) {
      row = await this.one(SQL_RECORD_WAIT, [f.ticket, f.graph_id, f.correlation_id, f.turn, f.kind, f.description, f.summary,
        compact(f.message), f.link, f.requested_at, f.expires_at, now]);
      if (!row) row = await this.one(SQL_WAIT, key); // the guard kept a newer row: answer with it as it stands
    } else {
      row = await this.one(SQL_RECORD_ADVICE, [f.graph_id, f.correlation_id, f.turn, f.description, f.summary, f.details,
        compact(f.message), f.requested_at, now]);
    }
    if (!row) throw new AppException(500, 'the question record returned no row');
    return row;
  }

  async answer(key, decisions, who, state, outcome, now) {
    const row = await this.one(SQL_ANSWER, [state, compact(decisions), compact(outcome), who, now, now, key[0], key[1], key[2], state]);
    // no row: the guard kept a row another device decided first (or no wait was recorded) - as stored
    return row ?? await this.one(SQL_WAIT, key);
  }

  async expire(now) {
    return this.many(SQL_EXPIRE, [now, now]);
  }

  async since(seq, limit) {
    return this.many(SQL_SINCE, [seq, limit]);
  }

  async counts() {
    const { rows } = await this.pool.query(SQL_COUNTS, []);
    const result = {};
    for (const row of rows) result[String(row.label)] = Number(row.count);
    return result;
  }
}

/** The pool from the ask.audit.postgres.* keys; nothing connects until open(). */
export async function postgresStore(config, importer = (name) => import(name)) {
  let pg;
  try {
    pg = await importer('pg');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') throw new AskError(MISSING_POSTGRES);
    throw error;
  }
  const Pool = pg.Pool ?? pg.default?.Pool;
  const pool = new Pool({ ...config.auditPostgres });
  pool.on('error', (error) => log.warn(`question record - ${error.name}: ${error.message}`));
  return new PostgresQuestionStore(pool);
}

/** A failure as a log may carry it: the type and the database's SQLSTATE, never a message that could quote a row. */
export function failure(error) {
  const constructor = error?.constructor?.name;
  const name = constructor && constructor !== 'Object' ? constructor : (error?.name ?? 'Error');
  const database = error?.severity !== undefined || name === 'DatabaseError';
  return database && error?.code ? `${name} sqlstate=${error.code}` : name;
}

let theStore;
let sweeper = null;

export function questionStore() {
  theStore ??= new MemoryQuestionStore();
  return theStore;
}

/** A test hook: a fresh store. */
export function resetStore(fresh = new MemoryQuestionStore()) {
  theStore = fresh;
}

/**
 * The recorder (round 4): {record: <message event>} from person.ask - a wait upserted, an advice appended - and
 * {answer: {graph_id, correlation_id, turn, decisions, who, at, status, body}} from the reply endpoint. Registered at
 * boot with ask.audit.instances workers: the writes are order-independent. A failure is logged by type and reported,
 * never raised with a message that could quote a row.
 */
export async function questionAudit(_headers, body) {
  const event = isMap(body) ? body : {};
  const store = questionStore();
  const now = isoUtc();
  try {
    if (isMap(event.record)) {
      const row = await store.record(event.record, now);
      log.info(`${AUDIT_ROUTE} recorded ${row.kind} ${row.id} for ${row.graph_id} turn ${row.turn} (seq ${row.seq})`);
      return { recorded: true, id: row.id, seq: row.seq, state: row.state };
    }
    if (isMap(event.answer)) {
      const answer = event.answer;
      const key = [String(answer.graph_id), String(answer.correlation_id), Number(answer.turn)];
      const state = answerState(answer.status ?? null, answer.body);
      const row = await store.answer(key, Array.isArray(answer.decisions) ? answer.decisions : [], String(answer.who ?? ''),
        state, { status: answer.status ?? null, body: answer.body ?? null }, now);
      if (!row) {
        log.warn(`${AUDIT_ROUTE} has no wait for ${key.join(' ')} - the answer is not recorded`);
        return { recorded: false, error: 'no wait recorded' };
      }
      log.info(`${AUDIT_ROUTE} recorded the answer on ${row.id} by ${row.answered_by} - ${row.state}`);
      return { recorded: true, id: row.id, seq: row.seq, state: row.state };
    }
  } catch (error) {
    // off the request path: logged by type, reported to the caller
    log.warn(`${AUDIT_ROUTE} could not write - ${failure(error)}`);
    return { recorded: false, error: failure(error) };
  }
  throw new AppException(400, `${AUDIT_ROUTE} takes record or answer`);
}

// --- the function -----------------------------------------------------------------------------

let postOffice;
const po = () => (postOffice ??= new PostOffice());

/** A test hook: the PostOffice the function and the reply endpoint send through. */
export function resetPostOffice(fresh) {
  postOffice = fresh;
}

/**
 * Tell the recorder, as a local request so the row is written before anyone is told of the message: the record of a
 * message event, or an answer. A recorder that fails or does not answer is logged by type and never fails the caller.
 */
export async function record(event, config) {
  let reply;
  try {
    reply = await po().request(AUDIT_ROUTE, event, { timeoutMs: config.auditTimeoutMs });
  } catch (error) {
    log.warn(`${AUDIT_ROUTE} did not take the write - ${error?.constructor?.name ?? 'Error'}`);
    return false;
  }
  const result = isMap(reply.body) ? reply.body : {};
  if (reply.getStatus() >= 400 || !result.recorded) {
    log.warn(`${AUDIT_ROUTE} did not record - status ${reply.getStatus()}, ${result.error ?? 'no detail'}`);
    return false;
  }
  return true;
}

/** Send the event to every channel route, in parallel and best effort; a failure is logged by type, never by content. */
export async function deliver(event, config) {
  const one = async (route) => {
    const endpoint = config.channelEndpoints[route];
    try {
      const reply = await po().request(route, { ...event }, { timeoutMs: config.channelTimeoutMs, endpoint });
      const ok = reply.getStatus() < 400;
      if (!ok) log.warn(`Channel ${route} refused the message - status ${reply.getStatus()}`);
      return { route, ok, status: reply.getStatus() };
    } catch (error) {
      // a failure of any kind in a channel never fails the hold
      const name = error?.constructor?.name ?? 'Error';
      log.warn(`Channel ${route} failed - ${name}`);
      return { route, ok: false, error: name };
    }
  };
  if (config.channels.length === 0) return [];
  return Promise.all(config.channels.map(one));
}

/** Carry a wait, or an advice, to the configured channels; answer with the ticket, the link, the expiry and what was delivered. */
export async function personAsk(headers, body) {
  const config = currentSettings();
  if (!config.enabled) throw new AppException(503, 'person.ask is disabled - ask.enabled is false');
  const message = validateMessage(body);
  const graphHeader = headers[GRAPH_ID_HEADER];
  if (graphHeader && graphHeader !== message.graph_id) {
    throw new AppException(400, `graph_id ${message.graph_id} does not match the ${GRAPH_ID_HEADER} header ${graphHeader}`);
  }
  const event = buildEvent(message, config.keys[0], config.replyUrl);
  // the question record first, so a channel's device finds the row it is told of
  const recorded = await record({ record: event }, config);
  const delivered = await deliver(event, config);
  const result = { delivered, recorded };
  if (WAIT_KINDS.includes(message.kind)) {
    result.ticket = event.ticket;
    result.link = event.link;
    result.expires_at = event.expires_at;
  }
  log.info(`person.ask ${message.kind} for ${message.graph_id} turn ${message.turn} - recorded ${recorded}, ${delivered.filter((d) => d.ok).length} of ${delivered.length} channel(s) took it`);
  return result;
}

/** Health check speaking the engines' interface contract (type=info / type=health). */
export async function askHealth(headers) {
  const config = currentSettings();
  if (headers.type === 'info') {
    let rows;
    try {
      rows = await questionStore().counts();
    } catch (error) {
      rows = { error: failure(error) }; // health reports a store it cannot read by type
    }
    return {
      service: ROUTE, href: 'http://127.0.0.1', enabled: config.enabled, channels: [...config.channels],
      graphs: Object.keys(config.graphs).sort(), reply_url: config.replyUrl, auth: config.auth,
      audit: questionStore().name, rows
    };
  }
  return 'person.ask is running fine';
}

preload(ROUTE, { instances: INSTANCES }, personAsk);
preload(HEALTH_ROUTE, { instances: 5, isPrivate: true }, askHealth);

// --- identity ---------------------------------------------------------------------------------

function bearerOf(req) {
  const value = req.headers.authorization ?? '';
  const at = value.indexOf(' ');
  if (at < 0) return null;
  const scheme = value.slice(0, at).toLowerCase();
  const token = value.slice(at + 1).trim();
  return scheme === 'bearer' && token ? token : null;
}

function sameSecret(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * An OAuth 2.0 access token validated against the issuer's published keys (jose), fetched from the JWKS URL given or
 * discovered from the issuer, and cached by jose; the same verifier as the agent-question app's.
 */
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

/**
 * Who is answering: a channel app under its bearer (decided_by is the person it acts for), or a person by the
 * configured mode - nobody in development, or a validated OAuth 2.0 access token (the page obtains one by
 * Authorization Code with PKCE, a channel app's device through its own UI).
 */
export async function identify(req, config, decidedBy, allowApp) {
  const bearer = bearerOf(req);
  if (allowApp && config.appToken && bearer && sameSecret(bearer, config.appToken)) {
    return { who: decidedBy || 'channel', via: 'app' };
  }
  if (config.auth === 'none') return { who: decidedBy || 'anonymous', via: 'none' };
  if (!bearer) throw new ReplyError(401, 'sign-in required - a bearer access token');
  const claims = await oauth2(config).verify(bearer);
  const who = claims.preferred_username || claims.email || claims.sub;
  if (!who) throw new ReplyError(401, 'the access token names nobody');
  return { who: String(who), via: 'oauth2' };
}

// --- the reply page and endpoint --------------------------------------------------------------

const STYLE = 'body{font-family:-apple-system,Helvetica,Arial,sans-serif;margin:2rem;color:#222;background:#fafafa}'
  + 'h1{font-size:1.3rem}.meta{color:#666;font-size:.85rem}fieldset{background:#fff;border:1px solid #ddd;'
  + 'border-radius:8px;padding:1rem;margin:1rem 0;max-width:800px}legend{font-weight:600}'
  + 'pre{background:#f3f3f3;border-radius:6px;padding:.6rem .8rem;overflow:auto;font-size:.85rem}'
  + 'textarea,input[type=text]{width:100%;box-sizing:border-box;margin:.3rem 0}'
  + 'button{font-size:1rem;padding:.5rem 1.2rem}#outcome{margin-top:1rem}';

// The reply page's script: the wait is read from this process (GET /ask/{ticket}/wait, which re-advises the engine and
// never resumes) and rendered here, so that under oauth2 the page can first sign the person in - Authorization Code
// with PKCE, a public client in the browser, the token kept for this tab and sent as a bearer on the wait and the
// reply (round 4, R12: no gateway header, no cookie session). Byte-identical with the Python twin's SCRIPT.
const SCRIPT = String.raw`
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const wait = document.getElementById('wait'), out = document.getElementById('outcome');
let token = null;
const store = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) {} },
  del: (k) => { try { sessionStorage.removeItem(k); } catch (e) {} }
};
function b64url(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function random(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
async function sha256(text) { return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }
async function discovery(issuer) {
  const key = 'ask.oidc.' + issuer, cached = store.get(key);
  if (cached) return JSON.parse(cached);
  const res = await fetch(issuer.replace(/\/$/, '') + '/.well-known/openid-configuration');
  if (!res.ok) throw new Error('the issuer is not reachable: ' + res.status);
  const doc = await res.json(); store.set(key, JSON.stringify(doc)); return doc;
}
async function signIn(oauth2) {
  const held = store.get('ask.token'), until = Number(store.get('ask.token.exp') || 0);
  if (held && until > Date.now() / 1000 + 30) return held;
  const doc = await discovery(oauth2.issuer), here = new URL(location.href);
  const redirect = location.origin + location.pathname;
  const code = here.searchParams.get('code'), state = here.searchParams.get('state');
  if (code && state && state === store.get('ask.state')) {
    const body = new URLSearchParams({grant_type: 'authorization_code', code, redirect_uri: redirect,
      client_id: oauth2.client_id, code_verifier: store.get('ask.verifier') || ''});
    const res = await fetch(doc.token_endpoint, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body});
    if (!res.ok) throw new Error('the sign-in was refused: ' + res.status);
    const grant = await res.json();
    store.set('ask.token', grant.access_token);
    store.set('ask.token.exp', String(Math.floor(Date.now() / 1000) + (grant.expires_in || 300)));
    store.del('ask.state'); store.del('ask.verifier');
    history.replaceState(null, '', location.pathname);
    return grant.access_token;
  }
  const verifier = random(32), nonce = random(16);
  store.set('ask.verifier', verifier); store.set('ask.state', nonce);
  const params = new URLSearchParams({response_type: 'code', client_id: oauth2.client_id, redirect_uri: redirect,
    scope: oauth2.scopes || 'openid', state: nonce, code_challenge: await sha256(verifier), code_challenge_method: 'S256'});
  if (oauth2.audience) params.set('audience', oauth2.audience);
  location.assign(doc.authorization_endpoint + '?' + params.toString());
  return new Promise(() => {});
}
function headers(extra) { const h = Object.assign({}, extra || {}); if (token) h['authorization'] = 'Bearer ' + token; return h; }
function callForm(call, i) {
  const id = esc(call.id), input = call.input ? '<pre>' + esc(JSON.stringify(call.input, null, 2)) + '</pre>' : '';
  if (call.ask) {
    const opts = Array.isArray(call.input && call.input.options) ? call.input.options : [];
    const radios = opts.map((o, k) => '<label><input type="radio" name="a-' + i + '" value="' + esc(o) + '"' + (k === 0 ? ' checked' : '') + '> ' + esc(o) + '</label><br>').join('')
      + (opts.length ? '<label><input type="radio" name="a-' + i + '" value="__other__"> another answer:</label>' : '');
    return '<fieldset data-id="' + id + '" data-kind="ask"><legend>' + esc(call.name) + ' - a question</legend>' + input + radios + '<textarea rows="3" placeholder="Your answer"></textarea></fieldset>';
  }
  if (call.wait === false) return '<fieldset><legend>' + esc(call.name) + ' - runs on resume</legend>' + input + '</fieldset>';
  return '<fieldset data-id="' + id + '" data-kind="write"><legend>' + esc(call.name) + ' - waits for a decision</legend><p class="meta">' + esc(call.route || '') + '</p>' + input
    + '<label><input type="radio" name="d-' + i + '" value="yes"> approve</label> <label><input type="radio" name="d-' + i + '" value="no"> refuse</label>'
    + '<input type="text" placeholder="A note for the model (optional)"></fieldset>';
}
function notice(title, text) { wait.innerHTML = '<h2>' + esc(title) + '</h2><p>' + esc(text) + '</p>'; }
function render(payload, advice) {
  const calls = Array.isArray(advice.calls) ? advice.calls : [];
  let html = '<p class="meta">graph ' + esc(payload.g) + ' &middot; correlation id ' + esc(payload.c) + ' &middot; turn ' + esc(payload.t) + '</p>';
  if (advice.message) html += '<p>' + esc(advice.message) + '</p>';
  html += '<form id="decisions">' + (calls.length ? calls.map(callForm).join('') : '<p>The graph reported no waiting call.</p>')
    + '<button type="submit">Send the decision</button></form>';
  wait.innerHTML = html;
  document.getElementById('decisions').addEventListener('submit', submit);
}
async function submit(ev) {
  ev.preventDefault();
  const form = ev.target, decisions = [];
  for (const set of form.querySelectorAll('fieldset[data-id]')) {
    const id = set.dataset.id;
    if (set.dataset.kind === 'ask') {
      const picked = set.querySelector('input[type=radio]:checked'), text = set.querySelector('textarea').value.trim();
      decisions.push({id, answer: picked && picked.value !== '__other__' ? picked.value : text});
    } else {
      const choice = set.querySelector('input[type=radio]:checked');
      if (!choice) { alert('Approve or refuse every waiting call'); return; }
      const note = set.querySelector('input[type=text]').value.trim();
      const decision = {id, approved: choice.value === 'yes'};
      if (note) decision.note = note;
      decisions.push(decision);
    }
  }
  out.textContent = 'Sending...';
  const response = await fetch(REPLY, {method: 'POST', credentials: 'same-origin',
    headers: headers({'content-type': 'application/json'}), body: JSON.stringify({ticket: TICKET, decisions})});
  const body = await response.text();
  out.innerHTML = '<p class="meta">status ' + response.status + '</p><pre></pre>';
  out.querySelector('pre').textContent = body;
  if (response.ok) form.querySelector('button').disabled = true;
}
async function load() {
  try {
    const config = await (await fetch(CONFIG, {credentials: 'same-origin'})).json();
    if (config.auth === 'oauth2') {
      if (!config.oauth2 || !config.oauth2.issuer || !config.oauth2.client_id) {
        notice('Sign-in required', 'This page cannot sign you in - the issuer or the client id is not configured.'); return;
      }
      token = await signIn(config.oauth2);
    }
    const res = await fetch(WAIT, {credentials: 'same-origin', headers: headers()});
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { store.del('ask.token'); notice('Sign-in required', body.message || 'a bearer access token'); return; }
    if (res.status === 410 || body.type === 'nothing-waiting') {
      notice('This wait has expired', 'Nothing is waiting for this decision any more - it was decided already, or the suspension expired.'); return;
    }
    if (!res.ok) { notice('The graph refused', JSON.stringify(body)); return; }
    if (!body.advice || body.advice.type !== 'approval') { notice('The graph has moved on', JSON.stringify(body.advice || body)); return; }
    render(body.payload, body.advice);
  } catch (e) { notice('Something went wrong', String((e && e.message) || e)); }
}
load();
`;

const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(title, body, script = '') {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">\n`
    + `<title>${escapeHtml(title)}</title>\n<style>${STYLE}</style>\n</head>\n<body>\n<h1>${escapeHtml(title)}</h1>\n${body}\n`
    + (script ? `<script>${script}</script>\n` : '') + '</body>\n</html>\n';
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const notice = (res, status, title, message) => sendHtml(res, status, page(title, `<p>${escapeHtml(message)}</p>`));

/**
 * The page for a wait: the kind and the graph from the ticket, and the script that signs the person in when the
 * installation asks for it, reads the wait from this process and renders the form. The ticket is verified before this
 * is rendered, so its characters are base64url and dots.
 */
export function shellPage(ticket, payload) {
  const constants = `const TICKET = ${JSON.stringify(ticket)}; const WAIT = ${JSON.stringify(`${SHOW_PREFIX}${ticket}${WAIT_SUFFIX}`)}; `
    + `const REPLY = ${JSON.stringify(REPLY_PATH)}; const CONFIG = ${JSON.stringify(CONFIG_PATH)};`;
  const body = '<div id="wait"><p class="meta">Loading the wait...</p></div>\n<div id="outcome"></div>';
  const kind = String(payload.k);
  return page(`${kind.charAt(0).toUpperCase()}${kind.slice(1)} - ${payload.g}`, body, constants + SCRIPT);
}

/**
 * What the page needs to sign a person in: the auth mode and, under oauth2, the issuer, the public client id, the
 * scopes and the audience - no secret, since a public client has none.
 */
export function pageConfig(config) {
  const result = { auth: config.auth };
  if (config.auth === 'oauth2') {
    result.oauth2 = { issuer: config.oauth2Issuer, client_id: config.oauth2ClientId, scopes: config.oauth2Scopes, audience: config.oauth2Audience };
  }
  return result;
}

/** GET /ask/config: the sign-in configuration the page reads first - open, it holds no secret. */
export async function showConfig(_req, res) {
  sendJson(res, 200, pageConfig(currentSettings()));
}

/** Send a request to the graph's entry and map what comes back. */
async function engine(request, timeoutMs) {
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: { ...request.headers, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(timeoutMs + 1000)
    });
    return mapOutcome(response.status, await response.text(), null);
  } catch (error) {
    const name = error?.cause?.code ?? error?.name ?? 'Error';
    log.warn(`The graph at ${request.url} did not answer - ${name}`);
    return mapOutcome(null, null, name);
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * GET /ask/{ticket}: the page for the wait - a shell whose script signs the person in when the installation asks for
 * it and reads the wait from GET /ask/{ticket}/wait. A ticket that cannot be used is told so here, before any sign-in;
 * the graph is never resumed.
 */
export async function showWait(_req, res, ticket) {
  const config = currentSettings();
  let payload;
  try {
    payload = verifyTicket(ticket, config.keys, Date.now() / 1000);
  } catch (error) {
    if (!(error instanceof TicketError)) throw error;
    return notice(res, error.status, error.status === 410 ? 'This wait has expired' : 'This link cannot be used', error.message);
  }
  if (!config.graphs[String(payload.g)]) {
    return notice(res, 404, 'This graph is not configured', `graph ${payload.g} is not configured for replies`);
  }
  return sendHtml(res, 200, shellPage(ticket, payload));
}

/**
 * GET /ask/{ticket}/wait: the current wait as the engine returns it on re-advice, for the page's script - the signed-in
 * person's request; never a resume. 410 nothing-waiting when the engine holds nothing; the engine's own status and body
 * when it refuses.
 */
export async function readWait(req, res, ticket) {
  const config = currentSettings();
  let payload;
  try {
    payload = verifyTicket(ticket, config.keys, Date.now() / 1000);
  } catch (error) {
    if (!(error instanceof TicketError)) throw error;
    return sendJson(res, error.status, { type: error.status === 410 ? 'expired' : 'error', message: error.message });
  }
  let readvice;
  try {
    await identify(req, config, null, false);
    readvice = readviceRequest(payload, config.graphs);
  } catch (error) {
    if (!(error instanceof ReplyError)) throw error;
    return sendJson(res, error.status, { type: 'error', message: error.message });
  }
  const [status, advice] = await engine(readvice, config.engineTimeoutMs);
  if (status === 410 || advice.type === 'nothing-waiting') {
    return sendJson(res, 410, {
      type: 'nothing-waiting',
      message: 'Nothing is waiting for this decision any more - it was decided already, or the suspension expired.'
    });
  }
  if (status >= 400) return sendJson(res, status, advice);
  return sendJson(res, 200, { payload: { g: payload.g, c: payload.c, t: payload.t, k: payload.k }, advice });
}

/** POST /ask/reply: verify the ticket, identify who decides, forward the resume and return the engine's outcome. */
export async function postReply(req, res) {
  const config = currentSettings();
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    body = null;
  }
  if (!isMap(body)) return sendJson(res, 400, { type: 'error', message: 'the reply must be a JSON map with ticket and decisions' });
  const ticket = body.ticket;
  if (!isText(ticket) || !ticket) return sendJson(res, 400, { type: 'error', message: 'ticket is required' });
  let payload;
  try {
    payload = verifyTicket(ticket, config.keys, Date.now() / 1000);
  } catch (error) {
    if (!(error instanceof TicketError)) throw error;
    return sendJson(res, error.status, { type: error.status === 410 ? 'expired' : 'error', message: error.message });
  }
  const decidedBy = body.decided_by;
  if (decidedBy !== undefined && decidedBy !== null && !isText(decidedBy)) {
    return sendJson(res, 400, { type: 'error', message: 'decided_by must be text' });
  }
  const at = isoUtc();
  let identity;
  let resume;
  try {
    identity = await identify(req, config, decidedBy || null, true);
    resume = buildResume(payload, body.decisions, identity.who, at, config.graphs);
  } catch (error) {
    if (!(error instanceof ReplyError)) throw error;
    return sendJson(res, error.status, { type: 'error', message: error.message });
  }
  const [status, outcome] = await engine(resume, config.engineTimeoutMs);
  log.info(`reply for ${payload.g} turn ${payload.t} by ${identity.who} via ${identity.via} - the graph answered ${status} ${outcome.type}`);
  // the answer on the question record: the stamped decisions, who decided, when, and the engine's outcome, written
  // before the invoker is answered so a device's feed finds the row changed
  await record({ answer: {
    graph_id: payload.g, correlation_id: payload.c, turn: payload.t, ticket, decisions: resume.body.decisions,
    who: identity.who, via: identity.via, at, status, body: outcome
  } }, config);
  return sendJson(res, status, outcome);
}

/** The reply page and endpoint on the host (Platform.addRoutes): the configuration before the ticket paths. */
export async function mount(req, res, url) {
  if (req.method === 'GET' && url.pathname === CONFIG_PATH) {
    await showConfig(req, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === REPLY_PATH) {
    await postReply(req, res);
    return true;
  }
  if (req.method === 'GET' && url.pathname.startsWith(SHOW_PREFIX) && url.pathname !== REPLY_PATH) {
    const rest = decodeURIComponent(url.pathname.slice(SHOW_PREFIX.length));
    if (rest.endsWith(WAIT_SUFFIX)) {
      const ticket = rest.slice(0, -WAIT_SUFFIX.length);
      if (ticket && !ticket.includes('/')) {
        await readWait(req, res, ticket);
        return true;
      }
    } else if (rest && !rest.includes('/')) {
      await showWait(req, res, rest);
      return true;
    }
  }
  return false;
}

// --- boot -------------------------------------------------------------------------------------

/** Expire the waits the engine stopped waiting for, so the record never says open past the expiry even when nobody asks. */
async function sweep() {
  try {
    const expired = await questionStore().expire(isoUtc());
    if (expired.length > 0) log.info(`${AUDIT_ROUTE} expired ${expired.length} wait(s)`);
  } catch (error) {
    log.warn(`${AUDIT_ROUTE} could not expire the waits - ${failure(error)}`); // the store may be down; the next interval retries
  }
}

/**
 * Load the settings before the host listens, open the question record and register its recorder; a configuration the
 * extension cannot start with stops the application by name, a record store that does not answer is logged and the
 * writes fail by type until it does.
 */
export async function boot() {
  const config = configure();
  if (!config.enabled) {
    log.info(`person.ask is disabled - ${ENABLED} is false`);
    return;
  }
  if (config.channels.length === 0) log.warn(`No channel configured (${CHANNELS}) - the link is returned to the graph only`);
  if (Object.keys(config.graphs).length === 0) log.warn(`No graph configured (${GRAPHS}) - a reply cannot be forwarded`);
  theStore = config.audit === 'postgres' ? await postgresStore(config) : new MemoryQuestionStore();
  if (config.audit !== 'postgres') {
    log.warn(`The question record is in memory - a restart forgets every row and no other process reads it; set ${AUDIT}=postgres for a deployment`);
  }
  if (!defaultRegistry.exists(AUDIT_ROUTE)) {
    defaultRegistry.register(AUDIT_ROUTE, questionAudit, { instances: config.auditInstances, isPrivate: true });
    log.info(`Loaded PRIVATE ${AUDIT_ROUTE}, instances=${config.auditInstances} - question record ${theStore.name}`);
  }
  try {
    await theStore.open();
  } catch (error) {
    // an outage, not a deployment error: the writes fail by type until it answers
    log.warn(`The question record (${theStore.name}) is not answering at start - ${failure(error)}`);
  }
  if (!sweeper) {
    sweeper = setInterval(() => { sweep().catch(() => {}); }, config.auditSweepMs);
    sweeper.unref();
  }
  log.info(`person.ask ready - ${config.channels.length} channel(s) ${JSON.stringify(config.channels)}, ${Object.keys(config.graphs).length} graph(s), reply page ${config.replyUrl}/ask/{ticket}, auth ${config.auth}, record ${theStore.name}`);
}

export async function shutdown() {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  if (theStore) {
    await theStore.close();
    theStore = undefined;
  }
  postOffice = undefined;
}

export const sweeperRunning = () => sweeper !== null;

/** inspect <ticket>: print a ticket's payload, or why it is refused, under the current configuration - a check, never a resume. */
export function inspect(words) {
  if (words.length !== 1) {
    console.error('usage: node ask-person.mjs inspect <ticket>');
    return 1;
  }
  let config;
  try {
    config = configure();
  } catch (error) {
    console.error(`configuration: ${error.message}`);
    return 1;
  }
  try {
    const payload = verifyTicket(words[0], config.keys, Date.now() / 1000);
    console.log(JSON.stringify({ ...payload, expires_at: isoUtc(new Date(payload.e * 1000)) }, null, 2));
    return 0;
  } catch (error) {
    if (!(error instanceof TicketError)) throw error;
    console.log(`${error.status} ${error.message}`);
    return 1;
  }
}

export function attach(target = platform) {
  target.onStartup(boot);
  target.onCleanup(shutdown);
  target.addRoutes(mount);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  // -Dkey=value arguments belong to the configuration, which reads them from process.argv itself
  const words = process.argv.slice(2).filter((a) => !a.startsWith('-D'));
  loadConfig(undefined, HERE);
  if (words[0] === 'inspect') {
    process.exitCode = inspect(words.slice(1));
  } else {
    attach();
    await platform.run();
  }
} else {
  // loaded by mercury-serve: the boot runs inside the serving loop, before the host listens
  attach();
}
