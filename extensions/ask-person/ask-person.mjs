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
 *   from the engine by the reference graph's re-advice and only a submit resumes. POST /ask/reply with
 *   {ticket, decisions} - a person's browser, or a channel app on the person's behalf under its own bearer with
 *   decided_by - verifies the ticket, maps the graph id to the engine's entry through the ask.graphs allowlist, prefixes
 *   who decided and when to each note, sends the resume and returns the engine's outcome to the invoker.
 *
 * Run:  node dist/src/cli.js extensions/ask-person/ask-person.mjs -Dask.ticket.key='${ASK_TICKET_KEY}'
 *
 * The pure half is pinned by test/vectors/ask-person-vectors.json, byte-identical with the Python pack.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppException, appConfig, getLogger, isoUtc, loadConfig, platform, PostOffice, preload } from 'mercury-composable';

const log = getLogger('ask-person');
const HERE = dirname(fileURLToPath(import.meta.url));

// --- the contract -----------------------------------------------------------------------------

export const ROUTE = 'person.ask';
export const HEALTH_ROUTE = 'ask.health';
export const INSTANCES = 10;
export const KINDS = ['approval', 'question', 'advice'];
export const WAIT_KINDS = ['approval', 'question'];
export const TICKET_VERSION = 'v1';
export const SHOW_PREFIX = '/ask/';
export const REPLY_PATH = '/ask/reply';
export const AUTH_MODES = ['none', 'proxy', 'oauth2'];
export const JWT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512'];
export const GRAPH_ID_HEADER = 'x-graph-id';
export const CORRELATION_HEADER = 'x-correlation-id';

// configuration keys
export const ENABLED = 'ask.enabled';
export const CHANNELS = 'ask.channels';
export const CHANNEL_TIMEOUT = 'ask.channel.timeout';
export const CHANNEL_ENDPOINTS = 'ask.channel.endpoints';
export const TICKET_KEY = 'ask.ticket.key';
export const PREVIOUS_KEY = 'ask.ticket.previous-key';
export const REPLY_URL = 'ask.reply.url';
export const REPLY_AUTH = 'ask.reply.auth';
export const AUTH_HEADER = 'ask.reply.auth.header';
export const OAUTH2_ISSUER = 'ask.reply.auth.oauth2.issuer';
export const OAUTH2_AUDIENCE = 'ask.reply.auth.oauth2.audience';
export const OAUTH2_JWKS_URL = 'ask.reply.auth.oauth2.jwks-url';
export const APP_TOKEN = 'ask.reply.auth.token';
export const GRAPHS = 'ask.graphs';
export const ENGINE_TIMEOUT = 'ask.engine.timeout';

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

/** The extension's settings from the application configuration, or an AskError naming the key that stops the boot. */
export function loadSettings(config) {
  const enabled = flag(config, ENABLED, true);
  const currentKey = text(config, TICKET_KEY);
  // the current key signs; the previous one only verifies, so it never stands in for the current
  const keys = [currentKey, text(config, PREVIOUS_KEY)].filter((k) => k).map((k) => Buffer.from(k, 'utf8'));
  const replyUrl = text(config, REPLY_URL).replace(/\/+$/, '');
  const auth = text(config, REPLY_AUTH, 'none').toLowerCase();
  const authHeader = text(config, AUTH_HEADER, 'x-forwarded-user').toLowerCase();
  const settings = {
    enabled,
    channels: names(config.get(CHANNELS)),
    channelTimeoutMs: timeout(config, CHANNEL_TIMEOUT, '5s'),
    channelEndpoints: pairs(config.get(CHANNEL_ENDPOINTS), 'route', 'url', CHANNEL_ENDPOINTS),
    keys,
    replyUrl,
    auth,
    authHeader,
    oauth2Issuer: text(config, OAUTH2_ISSUER).replace(/\/+$/, ''),
    oauth2Audience: text(config, OAUTH2_AUDIENCE),
    oauth2JwksUrl: text(config, OAUTH2_JWKS_URL),
    appToken: text(config, APP_TOKEN),
    graphs: pairs(config.get(GRAPHS), 'id', 'entry', GRAPHS),
    engineTimeoutMs: timeout(config, ENGINE_TIMEOUT, '60s')
  };
  if (!enabled) return settings;
  if (!currentKey) throw new AskError(`${TICKET_KEY} is not set - the ticket's HMAC key, a \${ASK_TICKET_KEY} reference`);
  if (!/^https?:\/\//.test(replyUrl)) throw new AskError(`${REPLY_URL} must be the public base of the resume link (http or https)`);
  if (!AUTH_MODES.includes(auth)) throw new AskError(`${REPLY_AUTH} must be one of ${AUTH_MODES.join(', ')}`);
  if (auth === 'proxy' && !authHeader) throw new AskError(`${AUTH_HEADER} names the header the gateway sets - it must not be empty`);
  if (auth === 'oauth2' && !settings.oauth2Issuer && !settings.oauth2JwksUrl) {
    throw new AskError(`${REPLY_AUTH} is oauth2 - set ${OAUTH2_ISSUER} or ${OAUTH2_JWKS_URL}`);
  }
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

// --- the function -----------------------------------------------------------------------------

let postOffice;
const po = () => (postOffice ??= new PostOffice());

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
  const delivered = await deliver(event, config);
  const result = { delivered };
  if (WAIT_KINDS.includes(message.kind)) {
    result.ticket = event.ticket;
    result.link = event.link;
    result.expires_at = event.expires_at;
  }
  log.info(`person.ask ${message.kind} for ${message.graph_id} turn ${message.turn} - ${delivered.filter((d) => d.ok).length} of ${delivered.length} channel(s) took it`);
  return result;
}

/** Health check speaking the engines' interface contract (type=info / type=health). */
export async function askHealth(headers) {
  const config = currentSettings();
  if (headers.type === 'info') {
    return {
      service: ROUTE, href: 'http://127.0.0.1', enabled: config.enabled, channels: [...config.channels],
      graphs: Object.keys(config.graphs).sort(), reply_url: config.replyUrl, auth: config.auth
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

/** Who is answering: a channel app under its bearer, or a person by the configured mode. */
export async function identify(req, config, decidedBy, allowApp) {
  const bearer = bearerOf(req);
  if (allowApp && config.appToken && bearer && sameSecret(bearer, config.appToken)) {
    return { who: decidedBy || 'channel', via: 'app' };
  }
  if (config.auth === 'none') return { who: decidedBy || 'anonymous', via: 'none' };
  if (config.auth === 'proxy') {
    const who = String(req.headers[config.authHeader] ?? '').trim();
    if (!who) throw new ReplyError(401, `sign-in required - the ${config.authHeader} header names the person`);
    return { who, via: 'proxy' };
  }
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

const SCRIPT = `
const form = document.getElementById('decisions');
form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const decisions = [];
  for (const set of form.querySelectorAll('fieldset[data-id]')) {
    const id = set.dataset.id;
    if (set.dataset.kind === 'ask') {
      const picked = set.querySelector('input[type=radio]:checked');
      const text = set.querySelector('textarea').value.trim();
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
  const out = document.getElementById('outcome');
  out.textContent = 'Sending...';
  const response = await fetch(form.dataset.reply, {method: 'POST', credentials: 'same-origin',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({ticket: form.dataset.ticket, decisions})});
  const body = await response.text();
  out.innerHTML = '<p class="meta">status ' + response.status + '</p><pre></pre>';
  out.querySelector('pre').textContent = body;
  if (response.ok) form.querySelector('button').disabled = true;
});
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

/** One waiting call as a fieldset: an answer for a question, approve or refuse with a note for a tool call. */
function renderCall(call) {
  const callId = String(call.id ?? '');
  const name = escapeHtml(call.name ?? callId);
  const inputs = call.input;
  const shown = inputs === undefined || inputs === null ? '' : escapeHtml(JSON.stringify(inputs, null, 2));
  if (call.ask) {
    const options = isMap(inputs) && Array.isArray(inputs.options) ? inputs.options : [];
    let radios = '';
    if (options.length > 0) {
      options.forEach((option, index) => {
        const value = escapeHtml(String(option));
        radios += `<label><input type="radio" name="a-${escapeHtml(callId)}" value="${value}"${index === 0 ? ' checked' : ''}> ${value}</label><br>\n`;
      });
      radios += `<label><input type="radio" name="a-${escapeHtml(callId)}" value="__other__"> another answer:</label>\n`;
    }
    return `<fieldset data-id="${escapeHtml(callId)}" data-kind="ask">\n<legend>${name} - a question</legend>\n`
      + `<pre>${shown}</pre>\n${radios}<textarea rows="3" placeholder="Your answer"></textarea>\n</fieldset>\n`;
  }
  if (call.wait === false) {
    return `<fieldset>\n<legend>${name} - runs on resume</legend>\n<pre>${shown}</pre>\n</fieldset>\n`;
  }
  return `<fieldset data-id="${escapeHtml(callId)}" data-kind="write">\n<legend>${name} - waits for a decision</legend>\n`
    + `<p class="meta">${escapeHtml(call.route ?? '')}</p>\n<pre>${shown}</pre>\n`
    + `<label><input type="radio" name="d-${escapeHtml(callId)}" value="yes"> approve</label> \n`
    + `<label><input type="radio" name="d-${escapeHtml(callId)}" value="no"> refuse</label>\n`
    + '<input type="text" placeholder="A note for the model (optional)">\n</fieldset>\n';
}

/** The page for a wait as the engine returned it on re-advice: the calls and the form. */
export function renderWait(ticket, payload, advice) {
  const calls = Array.isArray(advice.calls) ? advice.calls.filter(isMap).map(renderCall).join('') : '<p>The graph reported no waiting call.</p>';
  const intro = advice.message ? `<p>${escapeHtml(String(advice.message))}</p>\n` : '';
  const meta = `<p class="meta">graph ${escapeHtml(payload.g)} &middot; correlation id ${escapeHtml(payload.c)} &middot; turn ${escapeHtml(payload.t)}</p>\n`;
  const form = `<form id="decisions" data-ticket="${escapeHtml(ticket)}" data-reply="${REPLY_PATH}">\n${calls}`
    + `<button type="submit">Send the decision</button>\n</form>\n<div id="outcome"></div>`;
  const title = `${payload.k.charAt(0).toUpperCase()}${payload.k.slice(1)} - ${payload.g}`;
  return page(title, meta + intro + form, SCRIPT);
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

/** GET /ask/{ticket}: show the current wait and the decision form - never resume. */
export async function showWait(req, res, ticket) {
  const config = currentSettings();
  let payload;
  try {
    payload = verifyTicket(ticket, config.keys, Date.now() / 1000);
  } catch (error) {
    if (!(error instanceof TicketError)) throw error;
    return notice(res, error.status, error.status === 410 ? 'This wait has expired' : 'This link cannot be used', error.message);
  }
  let readvice;
  try {
    await identify(req, config, null, false);
    readvice = readviceRequest(payload, config.graphs);
  } catch (error) {
    if (!(error instanceof ReplyError)) throw error;
    return notice(res, error.status, error.status === 404 ? 'This graph is not configured' : 'Sign-in required', error.message);
  }
  const [status, advice] = await engine(readvice, config.engineTimeoutMs);
  if (status === 410 || advice.type === 'nothing-waiting') {
    return notice(res, 410, 'This wait has expired', 'Nothing is waiting for this decision any more - it was decided already, or the suspension expired.');
  }
  if (status >= 400) return notice(res, status, 'The graph refused', JSON.stringify(advice));
  if (advice.type !== 'approval') return notice(res, 200, 'The graph has moved on', JSON.stringify(advice));
  return sendHtml(res, 200, renderWait(ticket, payload, advice));
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
  let identity;
  let resume;
  try {
    identity = await identify(req, config, decidedBy || null, true);
    resume = buildResume(payload, body.decisions, identity.who, isoUtc(), config.graphs);
  } catch (error) {
    if (!(error instanceof ReplyError)) throw error;
    return sendJson(res, error.status, { type: 'error', message: error.message });
  }
  const [status, outcome] = await engine(resume, config.engineTimeoutMs);
  log.info(`reply for ${payload.g} turn ${payload.t} by ${identity.who} via ${identity.via} - the graph answered ${status} ${outcome.type}`);
  return sendJson(res, status, outcome);
}

/** The reply page and endpoint on the host (Platform.addRoutes). */
export async function mount(req, res, url) {
  if (req.method === 'POST' && url.pathname === REPLY_PATH) {
    await postReply(req, res);
    return true;
  }
  if (req.method === 'GET' && url.pathname.startsWith(SHOW_PREFIX) && url.pathname !== REPLY_PATH) {
    const ticket = decodeURIComponent(url.pathname.slice(SHOW_PREFIX.length));
    if (ticket && !ticket.includes('/')) {
      await showWait(req, res, ticket);
      return true;
    }
  }
  return false;
}

// --- boot -------------------------------------------------------------------------------------

/** Load the settings before the host listens; a configuration the extension cannot start with stops the application by name. */
export async function boot() {
  const config = configure();
  if (!config.enabled) {
    log.info(`person.ask is disabled - ${ENABLED} is false`);
    return;
  }
  if (config.channels.length === 0) log.warn(`No channel configured (${CHANNELS}) - the link is returned to the graph only`);
  if (Object.keys(config.graphs).length === 0) log.warn(`No graph configured (${GRAPHS}) - a reply cannot be forwarded`);
  log.info(`person.ask ready - ${config.channels.length} channel(s) ${JSON.stringify(config.channels)}, ${Object.keys(config.graphs).length} graph(s), reply page ${config.replyUrl}/ask/{ticket}, auth ${config.auth}`);
}

export async function shutdown() {
  postOffice = undefined;
}

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
