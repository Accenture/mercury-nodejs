/**
 * The LLM helper - a dedicated polyglot function host for the AI nodes of the
 * agent-orchestration experiment: `llm.chat`, `llm.stream` and `llm.health`, on the
 * official Anthropic SDK. The engines stay LLM-free: a graph or a flow reaches these routes
 * through declarative Event-over-HTTP like any other function, so the certified model
 * decides control flow while the LLM advises within it.
 *
 * Run:  npm install --save-dev @anthropic-ai/sdk     (or: npm install @anthropic-ai/sdk)
 *       node dist/src/cli.js extensions/llm-helper/llm-helper.mjs
 *       (AWS Bedrock: also @anthropic-ai/bedrock-sdk, and -Dllm.backend=bedrock)
 *
 * The credential comes from the environment, never from a config file: ANTHROPIC_API_KEY for
 * the Claude API, the AWS credential chain (or AWS_BEARER_TOKEN_BEDROCK) for AWS Bedrock.
 * Settings live in resources/application.yml (or -Dkey=value): llm.backend (anthropic or
 * bedrock), llm.aws.api (mantle or runtime), llm.aws.region, llm.model, llm.max.tokens,
 * llm.timeout.ms, llm.max.retries, llm.fallbacks, llm.effort, and for the agent loop's turns
 * llm.transcript.store (memory or redis - the redis package), llm.transcript.ttl,
 * llm.transcript.retention and the llm.transcript.redis.* connection keys; the optional transcript
 * audit store (RFC-0012) adds llm.transcript.audit (postgres - the pg package),
 * llm.transcript.audit.retention, .grace, .sweep.ms, .single (a call without tools recorded too,
 * RFC-0015) and the llm.transcript.audit.postgres.*
 * connection keys; llm.attachments.root, .max.count and .max.bytes let a single llm.chat call name
 * images and PDF pages by reference (RFC-0016, attachments.mjs next to this file). The contract,
 * the keys and the backends are documented in README.md next to
 * this file. The Python twin (mercury-python extensions/llm-helper) speaks the same contract, and
 * both are pinned by shared vector files.
 *
 * Then map the routes from a Mercury engine application (event-over-http.yaml):
 *
 *   event:
 *     http:
 *       - route: 'llm.chat'
 *         target: 'http://127.0.0.1:8087/api/event'
 *       - route: 'llm.stream'
 *         target: 'http://127.0.0.1:8087/api/event'
 */
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import {
  AppException, annotateTrace, appConfig, defaultRegistry, EventStreamWriter, getLogger, getTrace, isoUtc,
  platform, PostOffice, preload
} from 'mercury-composable';
import {
  ATTACHMENTS_MAX_BYTES, ATTACHMENTS_ROOT, AttachmentError, loadInWorker, PDF_LIBRARY, resolveRoot
} from './attachments.mjs';

const defaultLog = getLogger('llm-helper');

// --- the contract's defaults and limits ----------------------------------------------

export const DEFAULT_PROVIDER = 'anthropic';
export const DEFAULT_BACKEND = 'anthropic';
export const BEDROCK_BACKEND = 'bedrock';
// the two Bedrock surfaces: the Anthropic-shaped endpoint (the default) and the classic runtime
export const AWS_API_MANTLE = 'mantle';
export const AWS_API_RUNTIME = 'runtime';
export const AWS_APIS = [AWS_API_MANTLE, AWS_API_RUNTIME];
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_MAX_TOKENS = 16000;
export const DEFAULT_TIMEOUT_MS = 60000;
export const DEFAULT_MAX_RETRIES = 2;
export const PROVIDERS = [DEFAULT_PROVIDER];
export const BACKENDS = [DEFAULT_BACKEND, BEDROCK_BACKEND];
// the Anthropic-shaped surface spells a model id with the vendor prefix; a bare id gets it, a
// prefixed one is kept. The classic runtime takes an inference profile id exactly as the account
// lists it (they carry dates and versions no rule can derive), so there the id is sent as written
const BEDROCK_MODEL_PREFIX = 'anthropic.';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const ROLES = ['user', 'assistant'];
// per-call params. Anything else is rejected: the current models take no sampling
// parameters, and a mistyped key must not vanish silently
export const PARAMS = ['provider', 'model', 'max_tokens', 'timeout_ms', 'effort', 'stop_sequences'];
const TEXT_EVENT_STREAM = 'text/event-stream';
// server-side refusal fallbacks, "default" form: the Claude API only, current models only
const FALLBACKS_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODEL_PREFIXES = ['claude-opus-5', 'claude-fable-5', 'claude-sonnet-5-5'];
const MISSING_CREDENTIAL = 'LLM provider credential missing - set ANTHROPIC_API_KEY in the environment';
const MISSING_AWS_CREDENTIAL = 'AWS credential missing - configure the AWS credential chain (AWS_ACCESS_KEY_ID and '
  + 'AWS_SECRET_ACCESS_KEY, a profile, or a role) or set AWS_BEARER_TOKEN_BEDROCK';
const MISSING_AWS_REGION = 'AWS region missing - set llm.aws.region or AWS_REGION in the environment';
const MISSING_BEDROCK_SDK = 'The Bedrock backend needs @anthropic-ai/bedrock-sdk - npm install @anthropic-ai/bedrock-sdk';
// the SDK raises a plain error, before sending anything, when no credential resolves
const CREDENTIAL_ERROR = 'Could not resolve authentication method';
// the AWS credential chain's own error when it resolves nothing (while the Bedrock SDK signs)
const AWS_CREDENTIAL_ERROR = 'CredentialsProviderError';

// --- the loop contract's defaults and limits (RFC-0011) -----------------------------------
// a request that carries tools is one turn of an agent loop; the other loop fields need tools
export const LOOP_FIELDS = ['conversation', 'turn', 'results', 'ttl', 'retention'];
export const LOOP_KEYS = ['tools', ...LOOP_FIELDS];
export const TOOL_KEYS = ['name', 'description', 'input_schema', 'strict'];
// the API's rule for an advertised name: a route name such as orders.search is mapped by the
// loop's catalog to an API-safe name, never advertised
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const CONVERSATION_ID = /^[0-9a-f]{32}$/;
const DURATION = /^(\d+)([smhd]?)$/;
const DURATION_SECONDS = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
export const DEFAULT_TRANSCRIPT_TTL = '7d';
export const DEFAULT_TRANSCRIPT_RETENTION = '0';
export const STORE_MEMORY = 'memory';
export const STORE_REDIS = 'redis';
export const STORES = [STORE_MEMORY, STORE_REDIS];
// the store's key prefix, so a Redis ACL can confine this app's user to ~transcript:*
export const TRANSCRIPT_PREFIX = 'transcript:';
const DONE_STOPS = new Set(['end_turn', 'stop_sequence']);
// a turn cut off by a limit: the loop names which one in its envelope
const CAPS = { max_tokens: 'max_tokens', model_context_window_exceeded: 'context' };
const CACHE_CONTROL = { type: 'ephemeral' };
const MISSING_STORE = 'transcript store not configured - set llm.transcript.store '
  + '(redis, or memory for a single process)';
const MISSING_REDIS_SDK = 'The redis transcript store needs redis - npm install redis';
const STREAM_LOOP = 'tools and the loop fields are not part of the streaming contract - use llm.chat';

// --- attachments on a single llm.chat call (RFC-0016) ------------------------------------------
// a request names a file inside one configured root and never carries one: the helper reads it
// (attachments.mjs), decides its kind by its first bytes and sends it as an image or a document block
export const ATTACHMENTS_MAX_COUNT = 'llm.attachments.max.count';
// 20: the most image and document blocks a request carries before the provider tightens each
// image's dimension limit
export const DEFAULT_ATTACHMENTS_MAX_COUNT = 20;
export const DEFAULT_ATTACHMENTS_MAX_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_KEYS = ['path', 'pages'];
const PAGES = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;
// an image's limit as the provider counts it, base64-encoded: by the route to the models
export const IMAGE_MAX_ENCODED = 10 * 1024 * 1024;
export const BEDROCK_IMAGE_MAX_ENCODED = 5 * 1024 * 1024;
const STREAM_ATTACHMENTS = 'attachments are not part of the streaming contract - use llm.chat';
const LOOP_ATTACHMENTS = 'attachments are not part of the loop contract - a loop turn carries text';
const ATTACHMENTS_SHAPE = 'attachments must be a non-empty list of paths or {path, pages}';

// --- the transcript audit store's defaults and limits (RFC-0012) ----------------------------
// a durable, queryable record of every model turn, written by the transcript.audit function behind
// a local event, never on the turn's path; PostgreSQL is the reference store, its schema published
export const AUDIT_ROUTE = 'transcript.audit';
export const AUDIT_POSTGRES = 'postgres';
export const AUDITS = [AUDIT_POSTGRES];
export const DEFAULT_AUDIT_RETENTION = '365d';
export const DEFAULT_AUDIT_GRACE = '1d';
export const DEFAULT_AUDIT_SWEEP_MS = 60000;
// the sweep's lock on Redis, under the store's prefix so one ACL covers it; never a conversation key
export const AUDIT_SWEEP_LOCK = `${TRANSCRIPT_PREFIX}audit:sweep`;
// the graph context the engines' loop sends on a turn, recorded at the first turn (null without)
export const GRAPH_ID_HEADER = 'x-graph-id';
export const NODE_HEADER = 'x-node';
const MISSING_AUDIT = 'transcript audit store not configured - set llm.transcript.audit (postgres)';
const MISSING_POSTGRES_SDK = 'The postgres transcript audit store needs pg - npm install pg';
// a call without tools in the audit store (RFC-0015): a conversation of one turn, recorded only
// where the installation switched it on - on by itself it would multiply what the store holds
export const AUDIT_SINGLE = 'llm.transcript.audit.single';
const MISSING_SINGLE_STORE = 'llm.transcript.audit.single needs the working store - set llm.transcript.store '
  + '(redis, or memory for a single process)';

const isMap = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
// a value Python reads as true: a non-empty list or map, a non-empty string, a non-zero number
function present(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (isMap(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}
// the order Python's sorted() gives the same keys (code units, which are code points in the BMP): an
// explicit comparator, so a locale never enters a message or a digest the twin repeats
function byCodeUnit(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** A whole number from a JSON number or a config string, or a 400 naming the field. */
function wholeNumber(name, value, minimum) {
  const valid = (typeof value === 'number' && Number.isInteger(value))
    || (typeof value === 'string' && /^\d+$/.test(value.trim()));
  if (!valid || Number(value) < minimum) {
    throw new AppException(400, `${name} must be a whole number >= ${minimum}`);
  }
  return Number(value);
}

// --- provider failures as the portable error contract ----------------------------------

/** status, error type, message and request id - the same text on every runtime. */
function detail(error) {
  const body = isMap(error.error) ? error.error : {};
  const inner = isMap(body.error) ? body.error : {};
  const kind = inner.type || error.type || 'error';
  const message = inner.message || error.message;
  const requestId = error.requestID ? ` (request_id ${error.requestID})` : '';
  return `${error.status} ${kind}: ${message}${requestId}`;
}

/** The AWS credential chain resolved nothing: its error by name, as thrown or as a cause. */
function isAwsCredentialError(error) {
  return error instanceof Error && (error.name === AWS_CREDENTIAL_ERROR
    || error.message.includes('Could not load credentials'));
}

/** Map a provider failure to AppException(status, message); undefined for anything else. */
export function failure(error, timeoutMs) {
  if (error instanceof AppException) {
    return error;
  }
  if (error instanceof Anthropic.APIUserAbortError
      || error instanceof Anthropic.APIConnectionTimeoutError) {
    return new AppException(408, `LLM request timed out after ${timeoutMs} ms`);
  }
  if (isAwsCredentialError(error) || isAwsCredentialError(error?.cause)) {
    return new AppException(503, MISSING_AWS_CREDENTIAL);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AppException(429, `LLM provider rate limit - ${detail(error)}`);
  }
  if (error instanceof Anthropic.APIError && error.status !== undefined) {
    const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
    return new AppException(status, `LLM provider error - ${detail(error)}`);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AppException(503, `LLM provider unreachable - ${error.message}`);
  }
  if (error instanceof Error && error.message.includes(CREDENTIAL_ERROR)) {
    return new AppException(503, MISSING_CREDENTIAL);
  }
  return undefined;
}

// --- the backend seam ------------------------------------------------------------------

/**
 * One way to reach Claude: the client, and what this route to the models supports - how it
 * spells a model id, whether server-side fallbacks exist, and what a missing credential looks
 * like. Nothing else in this module knows which route answered, so the routes, the contract
 * and the vector file are the same on every backend (see README.md, "Backends").
 */
export function anthropicBackend(name = DEFAULT_BACKEND, client = new Anthropic()) {
  return {
    name,
    client,
    supportsFallbacks: true,
    imageMaxEncoded: IMAGE_MAX_ENCODED, // an attached image's limit, base64-encoded
    providerModel: (model) => model,
    /** What is missing for a call to be sent, or undefined. No token is spent. */
    credentialProblem: () => (['apiKey', 'authToken', 'credentials'].some((key) => client[key])
      ? undefined : MISSING_CREDENTIAL)
  };
}

/** The Anthropic-shaped surface: a bare model id gets the prefix it expects
 * (anthropic.claude-opus-5-5); an id already spelled for Bedrock is sent as written. The classic
 * runtime surface sends every id as written. */
export const bedrockModel = (model) => (model.startsWith('claude-') ? `${BEDROCK_MODEL_PREFIX}${model}` : model);

/** AWS Bedrock over the SDK's client for the chosen surface: the AWS credential chain (or a
 * Bedrock API key) signs each call, and server-side refusal fallbacks are not offered there. */
export function bedrockBackend(client, name = BEDROCK_BACKEND, api = AWS_API_MANTLE) {
  return {
    name,
    client,
    api,
    supportsFallbacks: false,
    imageMaxEncoded: BEDROCK_IMAGE_MAX_ENCODED,
    providerModel: api === AWS_API_MANTLE ? bedrockModel : (model) => model,
    /** A Bedrock API key (the classic client holds it as its auth token), else what the AWS
     * credential chain resolves - the environment, a profile, a role; on an EC2 or ECS host that
     * includes the instance metadata service, the one lookup the chain makes outside the
     * process. No token is spent. */
    credentialProblem: async () => {
      if (client.apiKey || client.authToken) {
        return undefined;
      }
      try {
        const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
        await fromNodeProviderChain({ profile: client.awsProfile ?? undefined })();
        return undefined;
      } catch {
        return MISSING_AWS_CREDENTIAL;
      }
    }
  };
}

/** The backend of a route over a client: defaultBackend() builds the client, tests inject one.
 * For Bedrock, api names the surface, which decides how a model id is spelled. */
export function backendFor(name, client, api = AWS_API_MANTLE) {
  return name === BEDROCK_BACKEND ? bedrockBackend(client, name, api) : anthropicBackend(name, client);
}

/** The Bedrock surface a call goes to: the Anthropic-shaped endpoint (mantle, the default) or
 * the classic runtime - an account may be enabled for one and not the other. */
function awsApi(prop) {
  const api = String(prop('llm.aws.api', AWS_API_MANTLE) || AWS_API_MANTLE).toLowerCase();
  if (!AWS_APIS.includes(api)) {
    throw new AppException(500, `llm.aws.api must be one of: ${AWS_APIS.join(', ')}`);
  }
  return api;
}

/** The SDK's Bedrock client for the surface, with the region from llm.aws.region or the AWS
 * environment. */
async function bedrockClient(prop, api) {
  let sdk;
  try {
    sdk = await import('@anthropic-ai/bedrock-sdk');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new AppException(503, MISSING_BEDROCK_SDK);
    }
    throw error;
  }
  const region = prop('llm.aws.region');
  if (api === AWS_API_RUNTIME) {
    // the classic client would quietly fall back to us-east-1; a region is named or the call is not sent
    const resolved = region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!resolved) {
      throw new AppException(503, MISSING_AWS_REGION);
    }
    return new sdk.AnthropicBedrock({ awsRegion: String(resolved) });
  }
  try {
    return new sdk.AnthropicBedrockMantle(region ? { awsRegion: String(region) } : {});
  } catch (error) {
    // no region, and no base URL to stand in for one
    if (error instanceof Error && error.message.includes('No AWS region')) {
      throw new AppException(503, MISSING_AWS_REGION);
    }
    throw error;
  }
}

/** The backend, built on first use. Credentials resolve per call, so the app starts (and
 * reports its health) without one. */
export function defaultBackend(prop) {
  let built;
  return async () => {
    if (built === undefined) {
      const name = String(prop('llm.backend', DEFAULT_BACKEND) || DEFAULT_BACKEND).toLowerCase();
      if (!BACKENDS.includes(name)) {
        throw new AppException(501,
          `unknown LLM backend '${name}' - this helper serves: ${BACKENDS.join(', ')}`);
      }
      const api = name === BEDROCK_BACKEND ? awsApi(prop) : AWS_API_MANTLE;
      const client = name === BEDROCK_BACKEND ? await bedrockClient(prop, api) : new Anthropic();
      built = backendFor(name, client, api);
    }
    return built;
  };
}

// --- the transcript store (RFC-0011) -------------------------------------------------------
//
// Only this app reads or writes a transcript. A record holds the model pinned at the first turn,
// the messages in the provider's format, the turn count and the ids of the calls the last turn
// made. A write is a compare-and-set on the turn count, so a duplicated turn can never fork a
// conversation, and every write sets the record's time to live. Since record version 2
// (RFC-0012) a record also carries the facts the audit rows need - saved inside the same
// compare-and-set, so a turn that lost the race leaves no facts behind - and the store keeps a
// third value beside the turn count and the record, the audited mark, owned by the audit
// function. The record's JSON is the Python twin's, field for field.

/** A record with the version 2 defaults filled in - the Python twin's dataclass defaults. */
export const transcript = (fields) => ({
  model: fields.model,
  messages: fields.messages,
  turn: fields.turn,
  pending: fields.pending,
  closed: fields.closed ?? false,
  // the audit facts (record version 2): what the audit rows need and the transcript did not hold
  retention: fields.retention ?? 0, // the seconds the closing turn was given; the check applies them
  correlation_id: fields.correlation_id ?? null, // the business correlation id of the transaction
  graph_id: fields.graph_id ?? null, // the graph and the loop node, from the engines' two headers
  node: fields.node ?? null,
  system: fields.system ?? null, // the first turn's system prompt, stored once
  tools: fields.tools ?? null, // the catalog as advertised at the first turn
  turns: fields.turns ?? [] // one entry of facts per turn
});

export const recordJson = (record) => JSON.stringify({
  v: 2, model: record.model, turn: record.turn, pending: record.pending, closed: record.closed,
  retention: record.retention ?? 0, correlation_id: record.correlation_id ?? null,
  graph_id: record.graph_id ?? null, node: record.node ?? null, system: record.system ?? null,
  tools: record.tools ?? null, turns: record.turns ?? [], messages: record.messages
});

/** A version 2 record, or a version 1 record (a conversation that was open when the helper was
 * upgraded): its turns so far carry no facts, and the audit's check says so. */
export function recordFrom(text) {
  const { model, turn, pending, closed, messages, retention, correlation_id, graph_id, node, system, tools, turns }
    = JSON.parse(text);
  return transcript({ model, messages, turn, pending, closed, retention: Number(retention ?? 0),
    correlation_id, graph_id, node, system, tools, turns: turns ?? [] });
}

/** One process: for development and tests. A second replica cannot see these records. The
 * clock reads seconds. */
export class MemoryStore {
  name = STORE_MEMORY;

  constructor({ clock = () => performance.now() / 1000 } = {}) {
    this.clock = clock;
    this.records = new Map(); // conversation -> [expiry, turn, record, audited]
  }

  live(conversation) {
    const entry = this.records.get(conversation);
    if (entry !== undefined && entry[0] <= this.clock()) {
      this.records.delete(conversation);
      return undefined;
    }
    return entry;
  }

  async load(conversation) {
    const entry = this.live(conversation);
    return entry === undefined ? undefined : recordFrom(entry[2]);
  }

  /** Write the record if the stored one holds expectedTurn (0: none may exist yet), with ttlS to
   * live; ttlS 0 deletes it instead. False when another write came first. */
  async save(conversation, expectedTurn, record, ttlS) {
    // no await between the check and the write, so the event loop makes it atomic
    const entry = this.live(conversation);
    const held = entry === undefined ? 0 : entry[1];
    if (held !== expectedTurn || (entry !== undefined && expectedTurn === 0)) {
      return false;
    }
    if (ttlS === 0) {
      this.records.delete(conversation);
    } else {
      const audited = entry === undefined ? 0 : entry[3]; // the compare-and-set never touches it
      this.records.set(conversation, [this.clock() + ttlS, record.turn, recordJson(record), audited]);
    }
    return true;
  }

  // the audit half (RFC-0012): the audited mark is the audit function's, never the turn's

  /** The highest turn the audit store is known to hold for the record; 0 when none. */
  async audited(conversation) {
    const entry = this.live(conversation);
    return entry === undefined ? 0 : entry[3];
  }

  /** Set the audited mark; a record that is gone stays gone, and its time to live stays. */
  async markAudited(conversation, turn) {
    const entry = this.live(conversation);
    if (entry !== undefined) {
      this.records.set(conversation, [entry[0], entry[1], entry[2], turn]);
    }
  }

  /** The record's time to live becomes retentionS; 0 deletes it at once. */
  async release(conversation, retentionS) {
    const entry = this.live(conversation);
    if (entry === undefined) {
      return;
    }
    if (retentionS === 0) {
      this.records.delete(conversation);
    } else {
      this.records.set(conversation, [this.clock() + retentionS, ...entry.slice(1)]);
    }
  }

  /** The conversations whose audited mark is below their turn count - the sweep's work. */
  async unaudited() {
    const lagging = [];
    for (const conversation of [...this.records.keys()]) {
      const entry = this.live(conversation);
      if (entry !== undefined && entry[3] < entry[1]) {
        lagging.push(conversation);
      }
    }
    return lagging;
  }

  /** Claim this interval's sweep: one process sweeps its own records. */
  async sweepLock(_intervalMs) {
    return true;
  }
}

// one script, one key: atomic on a standalone server and safe on a cluster - the Python twin's. It
// writes the turn count and the record and sets the time to live - never the audited mark, which
// the audit function owns, so the two writers share a key and not a field
export const REDIS_SAVE = `
local held = redis.call('HGET', KEYS[1], 'turn')
if ARGV[1] == '0' then
  if held then return 0 end
elseif held ~= ARGV[1] then
  return 0
end
if ARGV[4] == '0' then
  redis.call('DEL', KEYS[1])
else
  redis.call('HSET', KEYS[1], 'turn', ARGV[2], 'record', ARGV[3])
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return 1
`;

// the audited mark, set only on a record that still exists: a bare HSET would resurrect a released
// record as a hash with no time to live
export const REDIS_MARK_AUDITED = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('HSET', KEYS[1], 'audited', ARGV[1])
end
return 1
`;

/** A hash per conversation under transcript:{conversation}: the turn count, the record and the
 * audited mark. The client (the redis package) connects on the first command, and again after it
 * gave up reconnecting; a client that needs no connect (a test double) is used as given. */
export class RedisStore {
  name = STORE_REDIS;

  #opening;

  constructor(client, { timeoutMs = 5000 } = {}) {
    this.client = client;
    this.timeoutMs = timeoutMs;
  }

  async ready() {
    if (this.client.isOpen !== false) {
      return;
    }
    if (this.#opening === undefined) {
      const opening = this.client.connect().finally(() => { this.#opening = undefined; });
      opening.catch(() => {}); // the waiting turn sees a failure; a late one reaches the error listener
      this.#opening = opening;
    }
    let timer;
    const limit = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no connection within ${this.timeoutMs} ms`)), this.timeoutMs);
    });
    try {
      await Promise.race([this.#opening, limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  async load(conversation) {
    await this.ready();
    const text = await this.client.hGet(TRANSCRIPT_PREFIX + conversation, 'record');
    return text === null || text === undefined ? undefined : recordFrom(text);
  }

  async save(conversation, expectedTurn, record, ttlS) {
    await this.ready();
    const written = await this.client.eval(REDIS_SAVE, {
      keys: [TRANSCRIPT_PREFIX + conversation],
      arguments: [String(expectedTurn), String(record.turn), recordJson(record), String(ttlS)]
    });
    return Number(written) === 1;
  }

  async audited(conversation) {
    await this.ready();
    const value = await this.client.hGet(TRANSCRIPT_PREFIX + conversation, 'audited');
    return value ? Number(value) : 0;
  }

  async markAudited(conversation, turn) {
    await this.ready();
    await this.client.eval(REDIS_MARK_AUDITED, { keys: [TRANSCRIPT_PREFIX + conversation], arguments: [String(turn)] });
  }

  async release(conversation, retentionS) {
    await this.ready();
    const key = TRANSCRIPT_PREFIX + conversation;
    if (retentionS === 0) {
      await this.client.del(key);
    } else {
      await this.client.expire(key, retentionS);
    }
  }

  /** Two hash fields per live record and no database query; the sweep's lock and anything else
   * under the prefix that is not a conversation key are skipped. */
  async unaudited() {
    await this.ready();
    const lagging = [];
    for await (const page of this.client.scanIterator({ MATCH: `${TRANSCRIPT_PREFIX}*`, COUNT: 100 })) {
      for (const key of Array.isArray(page) ? page : [page]) { // the client yields pages since v5
        const conversation = String(key).slice(TRANSCRIPT_PREFIX.length);
        if (!CONVERSATION_ID.test(conversation)) {
          continue;
        }
        const [turn, audited] = await this.client.hmGet(key, ['turn', 'audited']);
        if (turn !== null && turn !== undefined && Number(audited ?? 0) < Number(turn)) {
          lagging.push(conversation);
        }
      }
    }
    return lagging;
  }

  /** SET NX PX: one sweep per interval across the replicas; the lock expires with the interval. */
  async sweepLock(intervalMs) {
    await this.ready();
    const claimed = await this.client.set(AUDIT_SWEEP_LOCK, randomUUID(), { NX: true, PX: Math.max(1, intervalMs) });
    return claimed === 'OK';
  }
}

/** The Redis client from the llm.transcript.redis.* keys - the engines' redis.* connection set
 * under this store's own prefix. A command waits at most timeout.ms, and none is queued while
 * the client is offline, so a store that is gone answers at once. */
export async function redisStore(prop, { importer = (name) => import(name), log = defaultLog } = {}) {
  let redis;
  try {
    redis = await importer('redis');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new AppException(503, MISSING_REDIS_SDK);
    }
    throw error;
  }
  const timeoutMs = wholeNumber('llm.transcript.redis.timeout.ms',
    prop('llm.transcript.redis.timeout.ms', '5000'), 1);
  const client = redis.createClient({
    socket: {
      host: String(prop('llm.transcript.redis.host', '127.0.0.1')),
      port: wholeNumber('llm.transcript.redis.port', prop('llm.transcript.redis.port', '6379'), 1),
      tls: String(prop('llm.transcript.redis.ssl', 'false')).toLowerCase() === 'true',
      connectTimeout: timeoutMs,
      // a dropped connection is retried three times; then the next turn connects afresh
      reconnectStrategy: (retries, cause) => (retries >= 3 ? cause : 100 * (retries + 1))
    },
    username: prop('llm.transcript.redis.username') || undefined,
    password: prop('llm.transcript.redis.password') || undefined,
    database: wholeNumber('llm.transcript.redis.database', prop('llm.transcript.redis.database', '0'), 0),
    commandOptions: { timeout: timeoutMs },
    disableOfflineQueue: true
  });
  // the client reports a lost connection as an event; without a listener Node would stop
  client.on('error', (error) => log.warn(`transcript store - ${error.name}: ${error.message}`));
  return new RedisStore(client, { timeoutMs });
}

/** The transcript store, built on first use: llm.transcript.store names it. */
export function defaultStore(prop, options = {}) {
  let built;
  return async () => {
    if (built === undefined) {
      const name = String(prop('llm.transcript.store', '') ?? '').toLowerCase();
      if (!name) {
        throw new AppException(503, MISSING_STORE);
      }
      if (!STORES.includes(name)) {
        throw new AppException(500, `llm.transcript.store must be one of: ${STORES.join(', ')}`);
      }
      built = name === STORE_MEMORY ? new MemoryStore() : await redisStore(prop, options);
    }
    return built;
  };
}

/** A store that cannot be reached is the deployment's problem, named as such. */
const storeFailure = (error) => new AppException(503,
  `transcript store unreachable - ${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`);

/** A content block as JSON, the way the SDK sends a returned block back: its enumerable fields
 * (the SDK keeps its tool-input buffer out of them). Stored, and later sent, exactly so. */
export const blockOf = (block) => JSON.parse(JSON.stringify(block));

// --- the transcript audit store (RFC-0012) --------------------------------------------------
//
// The working store's expiry covers the transaction; the audit store covers the record. Every turn
// is recorded, asynchronously: after the compare-and-set accepts a turn, llm.chat sends one local
// event to transcript.audit, a composable function of this process with ONE instance, so its
// mailbox orders the writes and the check of a conversation without a lock. The function reads the
// working record - the one place the content lives - and writes the rows the audit store lacks.
// The closing turn sends a second event behind its write, the integrity check, which repairs
// whatever a failed write left behind and only then releases the working record. A sweep sends a
// check for every record whose audited mark lags its turn count: the runs the loop stopped and
// the writes a dying process lost. A failure is logged by type and never refuses a turn. The
// Python twin writes the same rows from the same record.
//
// An audit store has open() (connect, at boot; a store that does not answer throws, and the sweep
// repairs later), close(), turns(conversation) (the Set of turn numbers it holds) and
// write(conversationRow, turnRows): the conversation row upserted and the turn rows inserted in
// one transaction, idempotent - a turn row that exists is left as it is, the conversation row's
// status, turn count, times and totals are brought up to date, the totals recomputed from the rows.

// the conversation row's token totals, recomputed from the turn rows on every write
export const TOKEN_COLUMNS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];

/** The reference semantics in memory, for the tests and the twins' parity - never a configured
 * store: an audit needs a durable, governed database. */
export class MemoryAuditStore {
  name = 'memory';

  constructor() {
    this.conversations = new Map(); // conversation -> row
    this.turnRows = new Map(); // conversation -> Map(turn -> row)
  }

  async open() {
    return undefined;
  }

  async close() {
    return undefined;
  }

  async turns(conversation) {
    return new Set(this.turnRows.get(conversation)?.keys() ?? []);
  }

  async write(conversation, turns) {
    const key = String(conversation.conversation);
    let held = this.conversations.get(key);
    if (held === undefined) {
      held = { ...conversation }; // INSERT
      this.conversations.set(key, held);
    } else { // ON CONFLICT DO UPDATE of what a turn changes; the first-turn snapshot stays
      for (const column of ['status', 'turns', 'updated_at', 'ended_at']) {
        held[column] = conversation[column];
      }
    }
    let rows = this.turnRows.get(key);
    if (rows === undefined) {
      rows = new Map();
      this.turnRows.set(key, rows);
    }
    for (const row of turns) {
      if (!rows.has(Number(row.turn))) { // ON CONFLICT DO NOTHING
        rows.set(Number(row.turn), { ...row });
      }
    }
    for (const column of TOKEN_COLUMNS) {
      held[column] = [...rows.values()].reduce((sum, row) => sum + Number(row[column]), 0);
    }
  }
}

// the statements the reference store runs, with pg's placeholders. JSON travels as text cast to
// jsonb and a UTC stamp as ISO-8601 text cast to timestamptz, so the Python twin runs the same
// statements with its own placeholders and no driver-specific wrapper
export const SQL_TURNS = 'SELECT turn FROM transcript_turn WHERE conversation = $1';
export const SQL_UPSERT_CONVERSATION = `INSERT INTO transcript (conversation, correlation_id, graph_id, node, model, status, turns,
  started_at, updated_at, ended_at, expires_at, system, tools)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz,
  $11::timestamptz, $12, $13::jsonb)
ON CONFLICT (conversation) DO UPDATE SET status = EXCLUDED.status, turns = EXCLUDED.turns,
  updated_at = EXCLUDED.updated_at, ended_at = EXCLUDED.ended_at`;
export const SQL_INSERT_TURN = `INSERT INTO transcript_turn (conversation, turn, trace_id, trace_path, correlation_id,
  started_at, ended_at, stop_reason, status, request_id, input_tokens, output_tokens,
  cache_creation_input_tokens, cache_read_input_tokens, request, response, calls)
VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9, $10, $11, $12, $13, $14,
  $15::jsonb, $16::jsonb, $17::jsonb)
ON CONFLICT (conversation, turn) DO NOTHING`;
export const SQL_TOTALS = `UPDATE transcript SET input_tokens = totals.input_tokens, output_tokens = totals.output_tokens,
  cache_creation_input_tokens = totals.cache_creation_input_tokens,
  cache_read_input_tokens = totals.cache_read_input_tokens
FROM (SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
  COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens
  FROM transcript_turn WHERE conversation = $1) AS totals
WHERE transcript.conversation = $2`;

/** JSON for a jsonb column, compact and as the record holds it; null stays NULL. */
const jsonText = (value) => (value === null || value === undefined ? null : JSON.stringify(value));

const conversationParams = (row) => [row.conversation, row.correlation_id, row.graph_id, row.node, row.model,
  row.status, row.turns, row.started_at, row.updated_at, row.ended_at, row.expires_at, row.system,
  jsonText(row.tools)];

const turnParams = (row) => [row.conversation, row.turn, row.trace_id, row.trace_path, row.correlation_id,
  row.started_at, row.ended_at, row.stop_reason, row.status, row.request_id, row.input_tokens,
  row.output_tokens, row.cache_creation_input_tokens, row.cache_read_input_tokens, jsonText(row.request),
  jsonText(row.response), jsonText(row.calls)];

/** The reference store: the pg package's pool. The function connects as a writer that may insert,
 * select and update the two tables and nothing else (schema/postgres.sql); people and the SQL
 * browser read. */
export class PostgresAuditStore {
  name = AUDIT_POSTGRES;

  constructor(pool) {
    this.pool = pool; // pg.Pool, or a recording fake in the tests
  }

  async open() {
    const client = await this.pool.connect();
    client.release();
  }

  async close() {
    await this.pool.end();
  }

  async turns(conversation) {
    const { rows } = await this.pool.query(SQL_TURNS, [conversation]);
    return new Set(rows.map((row) => Number(row.turn)));
  }

  async write(conversation, turns) {
    const key = String(conversation.conversation);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(SQL_UPSERT_CONVERSATION, conversationParams(conversation));
      for (const row of turns) {
        await client.query(SQL_INSERT_TURN, turnParams(row));
      }
      await client.query(SQL_TOTALS, [key, key]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

/** The pool from the llm.transcript.audit.postgres.* keys - the working store's connection set
 * under the audit's own prefix. Nothing connects until open(); the credential comes from the
 * environment, never from a file. */
export async function postgresAuditStore(prop, { importer = (name) => import(name), log = defaultLog } = {}) {
  let pg;
  try {
    pg = await importer('pg');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new AppException(503, MISSING_POSTGRES_SDK);
    }
    throw error;
  }
  const Pool = pg.Pool ?? pg.default?.Pool;
  const prefix = 'llm.transcript.audit.postgres.';
  const timeoutMs = wholeNumber(`${prefix}timeout.ms`, prop(`${prefix}timeout.ms`, '5000'), 1);
  const ssl = String(prop(`${prefix}ssl`, 'true')).toLowerCase() === 'true';
  const pool = new Pool({
    host: String(prop(`${prefix}host`, '127.0.0.1')),
    port: wholeNumber(`${prefix}port`, prop(`${prefix}port`, '5432'), 1),
    database: String(prop(`${prefix}database`, 'mercury')),
    user: prop(`${prefix}username`) || undefined,
    password: prop(`${prefix}password`) || undefined,
    // the twin of libpq's sslmode=require: the connection is encrypted and the server's certificate
    // is not verified, so a managed database's private CA works out of the box; sslmode=disable when false
    ssl: ssl ? { rejectUnauthorized: false } : false,
    max: 4,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    // the server-side bound on a statement too: a database that stalls (a paused container, a lock
    // held) frees the function's mailbox after the timeout instead of holding it for the outage's
    // length, as the live drive of 2026-11-17 showed a stopped one does by itself
    statement_timeout: timeoutMs
  });
  // the pool reports an idle client's lost connection as an event; without a listener Node would stop
  pool.on('error', (error) => log.warn(`transcript audit store - ${error.name}: ${error.message}`));
  return new PostgresAuditStore(pool);
}

/** The audit store, built on first use: llm.transcript.audit names it. */
export function defaultAudit(prop, options = {}) {
  let built;
  return async () => {
    if (built === undefined) {
      const name = String(prop('llm.transcript.audit', '') ?? '').toLowerCase();
      if (!name) {
        throw new AppException(503, MISSING_AUDIT);
      }
      if (!AUDITS.includes(name)) {
        throw new AppException(500, `llm.transcript.audit must be one of: ${AUDITS.join(', ')}`);
      }
      built = await postgresAuditStore(prop, options);
    }
    return built;
  };
}

let localPostOffice;
/** A local send over the in-process bus: no endpoint, the caller's trace inherited. */
const localSend = (route, body) => (localPostOffice ??= new PostOffice()).send(route, body);

/** An ISO-8601 UTC stamp moved by seconds (the conversation row's expires_at). */
export const plusSeconds = (stamp, seconds) => new Date(Date.parse(stamp) + seconds * 1000).toISOString();

/** The normalized calls of a tool_use response, for the person who queries. */
export function callsOf(blocks) {
  const calls = (Array.isArray(blocks) ? blocks : [])
    .filter((block) => isMap(block) && block.type === 'tool_use')
    .map((block) => ({ id: block.id, name: block.name, input: block.input }));
  return calls.length ? calls : null;
}

/** A turn row from the record: the turn's facts, the messages it sent before the model answered
 * (its request: the prompt, or the one message of tool results) and the assistant content blocks
 * it got back (its response), as the model exchanged them. */
export function turnRow(conversation, record, fact) {
  const [first, answer] = fact.messages;
  const usage = fact.usage ?? {};
  const content = record.messages[answer].content;
  const row = {
    conversation,
    turn: Number(fact.turn),
    trace_id: fact.trace_id ?? null,
    trace_path: fact.trace_path ?? null,
    correlation_id: fact.correlation_id ?? null,
    started_at: fact.started_at,
    ended_at: fact.ended_at,
    stop_reason: fact.stop_reason ?? null,
    status: fact.status,
    request_id: fact.request_id ?? null
  };
  for (const column of TOKEN_COLUMNS) {
    row[column] = Number(usage[column] ?? 0);
  }
  row.request = record.messages.slice(first, answer);
  row.response = content;
  row.calls = fact.status === 'tool_use' ? callsOf(content) : null;
  return row;
}

/** The conversation row from the record: the identity, the first-turn snapshot, the status and
 * the bounds. A record from before version 2 carries no facts: its row opens now. */
export function conversationRow(conversation, record, now, retentionS) {
  const facts = record.turns ?? [];
  const first = facts[0];
  const last = facts[facts.length - 1];
  const ended = record.closed && last !== undefined && Number(last.turn) === record.turn ? last : undefined;
  const startedAt = first ? String(first.started_at) : now;
  return {
    conversation,
    correlation_id: record.correlation_id ?? null,
    graph_id: record.graph_id ?? null,
    node: record.node ?? null,
    model: record.model,
    status: ended ? ended.status : 'open',
    turns: record.turn,
    started_at: startedAt,
    updated_at: now,
    ended_at: ended ? ended.ended_at : null,
    expires_at: plusSeconds(startedAt, retentionS),
    system: record.system ?? null,
    tools: record.tools ?? null
  };
}

/** A failure as a log may carry it: the type and the database's SQLSTATE (pg puts it in `code`,
 * with a `severity`), never the message of a database error, which may detail the failing row;
 * the first line of a connection failure or a configuration error, which quotes none. */
export function auditFailure(error) {
  const constructor = error?.constructor?.name;
  const name = constructor && constructor !== 'Object' ? constructor : (error?.name ?? 'Error');
  const database = error?.severity !== undefined || name === 'DatabaseError';
  const detail = database && error?.code ? `${name} sqlstate=${error.code}` : name;
  const quotesNoRow = !database && (error instanceof AppException || typeof error?.code === 'string'
    || error instanceof AggregateError || /timeout/i.test(name));
  const text = String(error?.message ?? '').trim();
  return quotesNoRow && text ? `${detail}: ${text.split('\n')[0]}` : detail;
}

/** A tool's output or error as tool_result text; JSON is written compactly, keys in order. */
const resultText = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

// --- the helper ------------------------------------------------------------------------

/**
 * The functions, wired to their dependencies: prop(key, default) reads a setting, backend()
 * returns the backend, store() the transcript store, audit() the transcript audit store,
 * send(route, body) a local drop-n-forget event, registry the function registry the audit
 * function joins at boot, newConversationId() a loop's reference, writer(event) the stream writer,
 * log the logger and trace(key, value) the trace annotation; loadAttachments(request) reads the
 * files a call names (in a worker thread) and pdfLibrary names the library that cuts a PDF. Tests
 * inject fakes.
 */
export function createLlmHelper({
  prop = (key, fallback) => appConfig().getProperty(key, fallback),
  backend = defaultBackend((key, fallback) => appConfig().getProperty(key, fallback)),
  store = defaultStore((key, fallback) => appConfig().getProperty(key, fallback)),
  audit = defaultAudit((key, fallback) => appConfig().getProperty(key, fallback)),
  send = localSend,
  registry = defaultRegistry,
  newConversationId = () => randomUUID().replaceAll('-', ''),
  writer = (event) => EventStreamWriter.fromRequest(event),
  log = defaultLog,
  trace = annotateTrace,
  loadAttachments = loadInWorker,
  pdfLibrary = PDF_LIBRARY
} = {}) {
  /** Precedence: the call's param, then the config key, then the built-in default. */
  const setting = (params, key, configKey, fallback) => params[key] ?? prop(configKey, fallback);

  // -- the request: validated in a fixed order, the same as the Python twin -------------

  function paramsOf(body) {
    if (body.params !== undefined && body.params !== null && !isMap(body.params)) {
      throw new AppException(400, 'params must be a map');
    }
    const params = { ...body.params };
    const unknown = Object.keys(params).filter((key) => !PARAMS.includes(key)).sort(byCodeUnit);
    if (unknown.length) {
      throw new AppException(400,
        `unsupported params: ${unknown.join(', ')} - supported: ${PARAMS.join(', ')}`);
    }
    return params;
  }

  function checkProvider(params) {
    const provider = String(setting(params, 'provider', 'llm.provider', DEFAULT_PROVIDER)).toLowerCase();
    if (!PROVIDERS.includes(provider)) {
      throw new AppException(400,
        `unknown LLM provider '${provider}' - this helper serves: ${PROVIDERS.join(', ')}`);
    }
  }

  function turnsOf(body) {
    if (!Array.isArray(body.messages) || !body.messages.length) {
      return [{ role: 'user', content: String(body.prompt) }];
    }
    return body.messages.map((turn, index) => {
      if (!isMap(turn) || !ROLES.includes(turn.role)) {
        throw new AppException(400, `messages[${index}].role must be one of: ${ROLES.join(', ')}`);
      }
      if (typeof turn.content !== 'string' || !turn.content) {
        throw new AppException(400, `messages[${index}].content must be a non-empty string`);
      }
      return { role: turn.role, content: turn.content };
    });
  }

  function systemOf(body) {
    if (body.system !== undefined && body.system !== null && typeof body.system !== 'string') {
      throw new AppException(400, 'system must be a string');
    }
    return body.system || undefined;
  }

  function effortOf(params) {
    const effort = params.effort || prop('llm.effort');
    if (effort === undefined || effort === null) {
      return undefined;
    }
    const level = String(effort).toLowerCase();
    if (!EFFORTS.includes(level)) {
      throw new AppException(400, `params.effort must be one of: ${EFFORTS.join(', ')}`);
    }
    return level;
  }

  function stopSequencesOf(params) {
    const stops = params.stop_sequences;
    if (stops === undefined || stops === null) {
      return undefined;
    }
    if (!Array.isArray(stops) || !stops.every((stop) => typeof stop === 'string')) {
      throw new AppException(400, 'params.stop_sequences must be a list of strings');
    }
    return stops.length ? stops : undefined;
  }

  function schemaOf(body, streaming) {
    if (body.schema === undefined || body.schema === null) {
      return undefined;
    }
    if (streaming) {
      throw new AppException(400, 'schema is not part of the streaming contract - use llm.chat');
    }
    if (!isMap(body.schema)) {
      throw new AppException(400, 'schema must be a JSON schema map');
    }
    // a closed schema is what a bounded verdict wants
    return { additionalProperties: false, ...body.schema };
  }

  /** The pages of a PDF to send, as ranges in the order named, with the text as written. A
   * mapping may carry a page number as a number. Whether a page exists is the document's to say,
   * when it is read. */
  function pagesOf(index, raw) {
    let text;
    if (typeof raw === 'string') {
      text = raw.replace(/\s+/g, '');
    } else if (typeof raw === 'number' && Number.isInteger(raw)) {
      text = String(raw);
    }
    const malformed = () => new AppException(400,
      `attachments[${index}].pages must name pages from 1, such as 13 or 1-3,7`);
    if (text === undefined || !PAGES.test(text)) {
      throw malformed();
    }
    const ranges = [];
    for (const part of text.split(',')) {
      const [first, last] = part.split('-');
      const low = Number(first);
      const high = Number(last ?? first);
      if (low < 1 || high < low) {
        throw malformed();
      }
      if (ranges.some(([heldLow, heldHigh]) => low <= heldHigh && heldLow <= high)) {
        throw new AppException(400, `attachments[${index}].pages names a page twice`);
      }
      ranges.push([low, high]);
    }
    return { pages: ranges, pagesText: text };
  }

  /** One attachment: a path, or a map with a path and the pages of a PDF. */
  function attachmentOf(index, entry) {
    let named = entry;
    let pages;
    if (isMap(entry)) {
      const unknown = Object.keys(entry).filter((key) => !ATTACHMENT_KEYS.includes(key)).sort(byCodeUnit);
      if (unknown.length) {
        throw new AppException(400, `attachments[${index}]: unsupported keys: ${unknown.join(', ')} - `
          + `supported: ${ATTACHMENT_KEYS.join(', ')}`);
      }
      named = entry.path;
      pages = entry.pages;
    } else if (typeof entry !== 'string') {
      throw new AppException(400, `attachments[${index}] must be a path or {path, pages}`);
    }
    if (typeof named !== 'string' || !named.trim()) {
      throw new AppException(400, `attachments[${index}].path must be a path inside ${ATTACHMENTS_ROOT}`);
    }
    return pages === undefined || pages === null ? { path: named } : { path: named, ...pagesOf(index, pages) };
  }

  /** The files a single call names (RFC-0016): the shape only. The files themselves are read by
   * attach(), after every other check of the request has passed. */
  function attachmentsOf(body) {
    const raw = body.attachments;
    if (raw === undefined || raw === null) {
      return [];
    }
    if (!Array.isArray(raw) || !raw.length) {
      throw new AppException(400, ATTACHMENTS_SHAPE);
    }
    const limit = wholeNumber(ATTACHMENTS_MAX_COUNT,
      prop(ATTACHMENTS_MAX_COUNT, String(DEFAULT_ATTACHMENTS_MAX_COUNT)), 1);
    if (raw.length > limit) {
      throw new AppException(400, `attachments: ${raw.length} files exceed ${ATTACHMENTS_MAX_COUNT} (${limit})`);
    }
    return raw.map((entry, index) => attachmentOf(index, entry));
  }

  function fallbacksEnabled() {
    const mode = String(prop('llm.fallbacks', 'default')).toLowerCase();
    if (mode !== 'default' && mode !== 'off') {
      throw new AppException(500, "llm.fallbacks must be 'default' or 'off'");
    }
    return mode === 'default';
  }

  /** Validate a request body into a request, or throw AppException(400). A loop turn after the
   * first (continuation) carries no turns of its own: the transcript holds them. */
  function prepare(body, { streaming, continuation = false }) {
    if (streaming && isMap(body) && LOOP_KEYS.some((key) => key in body)) {
      throw new AppException(400, STREAM_LOOP);
    }
    if (streaming && isMap(body) && 'attachments' in body) {
      throw new AppException(400, STREAM_ATTACHMENTS);
    }
    if (!isMap(body)
        || !(continuation || body.prompt || (Array.isArray(body.messages) && body.messages.length))) {
      throw new AppException(400, "missing 'prompt' or 'messages'");
    }
    const params = paramsOf(body);
    checkProvider(params);
    const model = String(setting(params, 'model', 'llm.model', DEFAULT_MODEL));
    const maxTokens = wholeNumber('params.max_tokens',
      setting(params, 'max_tokens', 'llm.max.tokens', String(DEFAULT_MAX_TOKENS)), 1);
    const timeoutMs = wholeNumber('params.timeout_ms',
      setting(params, 'timeout_ms', 'llm.timeout.ms', String(DEFAULT_TIMEOUT_MS)), 1);
    const maxRetries = wholeNumber('llm.max.retries',
      prop('llm.max.retries', String(DEFAULT_MAX_RETRIES)), 0);
    return {
      model,
      maxTokens,
      timeoutMs,
      maxRetries,
      messages: continuation ? [] : turnsOf(body),
      system: systemOf(body),
      effort: effortOf(params),
      stopSequences: stopSequencesOf(params),
      schema: schemaOf(body, streaming),
      attachments: attachmentsOf(body), // llm.chat only, never a loop turn
      fallbacks: fallbacksEnabled()
    };
  }

  // -- the loop request: one turn of an agent loop (RFC-0011), checked as the Python twin --

  /** The tools as the API takes them; the loop's catalog keeps the routes and approval marks. */
  function toolsOf(raw) {
    if (!Array.isArray(raw) || !raw.length) {
      throw new AppException(400, 'tools must be a non-empty list of {name, description, input_schema}');
    }
    const names = new Set();
    return raw.map((tool, index) => {
      if (!isMap(tool)) {
        throw new AppException(400, `tools[${index}] must be a map`);
      }
      const unknown = Object.keys(tool).filter((key) => !TOOL_KEYS.includes(key)).sort(byCodeUnit);
      if (unknown.length) {
        throw new AppException(400,
          `tools[${index}]: unsupported keys: ${unknown.join(', ')} - supported: ${TOOL_KEYS.join(', ')}`);
      }
      const { name, description, input_schema: inputSchema, strict } = tool;
      if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
        throw new AppException(400, `tools[${index}].name must match ^[a-zA-Z0-9_-]{1,128}$`);
      }
      if (names.has(name)) {
        throw new AppException(400, `tools[${index}].name '${name}' is not unique`);
      }
      names.add(name);
      if (typeof description !== 'string' || !description) {
        throw new AppException(400, `tools[${index}].description must be a non-empty string`);
      }
      if (!isMap(inputSchema)) {
        throw new AppException(400, `tools[${index}].input_schema must be a JSON schema map`);
      }
      if (strict !== undefined && strict !== null && typeof strict !== 'boolean') {
        throw new AppException(400, `tools[${index}].strict must be true or false`);
      }
      const entry = { name, description, input_schema: inputSchema };
      if (strict) {
        entry.strict = true;
      }
      return entry;
    });
  }

  function conversationOf(raw) {
    if (raw === undefined || raw === null) {
      return undefined;
    }
    if (typeof raw !== 'string' || !CONVERSATION_ID.test(raw)) {
      throw new AppException(400, 'conversation must be the reference a previous turn returned');
    }
    return raw;
  }

  /** The answers to the previous turn's calls: {id, output} or {id, error}. */
  function resultsOf(raw) {
    if (raw === undefined || raw === null) {
      return undefined;
    }
    if (!Array.isArray(raw)) {
      throw new AppException(400, 'results must be a list of {id, output} or {id, error}');
    }
    raw.forEach((result, index) => {
      if (!isMap(result)) {
        throw new AppException(400, `results[${index}] must be a map`);
      }
      const unknown = Object.keys(result).filter((key) => !['id', 'output', 'error'].includes(key)).sort(byCodeUnit);
      if (unknown.length) {
        throw new AppException(400,
          `results[${index}]: unsupported keys: ${unknown.join(', ')} - supported: id, output, error`);
      }
      if (typeof result.id !== 'string' || !result.id) {
        throw new AppException(400, `results[${index}].id must be a call id`);
      }
      if (Object.hasOwn(result, 'output') === Object.hasOwn(result, 'error')) {
        throw new AppException(400, `results[${index}] must carry either output or error`);
      }
    });
    return raw;
  }

  /** Seconds from a whole number or a duration such as 30m, 12h or 2d, or a 400 naming it. */
  function durationOf(name, value, minimum) {
    let text;
    if (typeof value === 'string') {
      text = value.trim();
    } else if (typeof value === 'number' && Number.isInteger(value)) {
      text = String(value);
    }
    const match = text === undefined ? null : DURATION.exec(text);
    const seconds = match ? Number(match[1]) * DURATION_SECONDS[match[2]] : -1;
    if (seconds < minimum) {
      throw new AppException(400, `${name} must be a duration such as 30m, 12h or 2d (seconds, s, m, h, d) `
        + `>= ${minimum}`);
    }
    return seconds;
  }

  /** Validate the loop fields of a turn, or throw AppException(400): tools, conversation, turn,
   * results, ttl, retention, then what a first turn and a later turn may carry. */
  function prepareLoop(body) {
    if (!('tools' in body)) {
      const loopField = LOOP_FIELDS.find((key) => key in body);
      throw new AppException(400, `${loopField} is a field of the loop contract - it needs tools`);
    }
    const tools = toolsOf(body.tools);
    const conversation = conversationOf(body.conversation);
    const turn = body.turn === undefined || body.turn === null ? undefined : wholeNumber('turn', body.turn, 0);
    const results = resultsOf(body.results);
    const ttlS = durationOf('ttl', body.ttl ?? prop('llm.transcript.ttl', DEFAULT_TRANSCRIPT_TTL), 1);
    const retentionS = durationOf('retention',
      body.retention ?? prop('llm.transcript.retention', DEFAULT_TRANSCRIPT_RETENTION), 0);
    if (conversation === undefined) {
      if (turn) {
        throw new AppException(400, 'turn must be 0 or absent on a first turn');
      }
      if (results !== undefined) {
        throw new AppException(400, 'results answer a previous turn - a first turn carries none');
      }
    } else {
      if (turn === undefined) {
        throw new AppException(400, 'turn is required with conversation - the turn count the record should hold');
      }
      if (present(body.prompt) || present(body.messages)) {
        throw new AppException(400, 'a later turn carries results, never prompt or messages - the transcript '
          + 'holds the conversation');
      }
    }
    return { tools, conversation, turn: turn ?? 0, results, ttlS, retentionS };
  }

  // -- one provider call, shared by both routes -----------------------------------------

  /** The SDK call for a request: the messages namespace, its params and request options.
   * llm.chat gets a deadline for the whole call (an abort signal); llm.stream does not. */
  function plan(request, provider, { deadline }) {
    const params = {
      model: provider.providerModel(request.model),
      max_tokens: request.maxTokens,
      messages: request.messages
    };
    if (request.system) {
      params.system = request.system;
    }
    if (request.tools !== undefined) {
      // a loop turn: tools and system render first and stay the same across turns, so one
      // marker caches them and the top-level one caches the conversation as it grows. No
      // stored block is ever marked - the transcript is sent back exactly as it was returned
      params.tools = request.tools;
      params.cache_control = { ...CACHE_CONTROL };
      if (request.system) {
        params.system = [{ type: 'text', text: request.system, cache_control: { ...CACHE_CONTROL } }];
      }
    }
    const output = {};
    if (request.schema !== undefined) {
      output.format = { type: 'json_schema', schema: request.schema };
    }
    if (request.effort) {
      output.effort = request.effort;
    }
    if (Object.keys(output).length) {
      params.output_config = output;
    }
    if (request.stopSequences) {
      params.stop_sequences = request.stopSequences;
    }
    const options = { timeout: request.timeoutMs, maxRetries: request.maxRetries };
    if (deadline) {
      // true: the whole allowance; a number: what the reading of the attachments left of it
      options.signal = AbortSignal.timeout(deadline === true ? request.timeoutMs : deadline);
    }
    // never on a loop turn: the record pins the model at the first turn, and a fallback would move
    // the conversation to another model whose replay rules edit the history
    const fallbacks = request.fallbacks && request.tools === undefined && provider.supportsFallbacks
      && FALLBACK_MODEL_PREFIXES.some((prefix) => request.model.startsWith(prefix));
    if (fallbacks) {
      return { namespace: 'beta.messages', options,
        params: { ...params, betas: [FALLBACKS_BETA], fallbacks: 'default' } };
    }
    return { namespace: 'messages', params, options };
  }

  const refusalOf = (details) => (details
    ? { category: details.category ?? null, explanation: details.explanation ?? null }
    : undefined);

  /** Run the call on the SDK's streaming transport. The transport never trips the SDK's
   * long-request guard, however large max_tokens is; llm.chat just takes the final message
   * while llm.stream forwards the token batches as they arrive. */
  async function complete(request, provider, onText, remainingMs) {
    const { namespace, params, options } = plan(request, provider,
      { deadline: onText === undefined && (remainingMs ?? true) });
    const api = namespace === 'beta.messages' ? provider.client.beta.messages : provider.client.messages;
    const messageStream = api.stream(params, options);
    if (onText !== undefined) {
      for await (const event of messageStream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta'
            && event.delta.text) {
          onText(event.delta.text);
        }
      }
    }
    const message = await messageStream.finalMessage();
    return {
      text: message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
      model: message.model,
      stopReason: message.stop_reason ?? '',
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      requestId: messageStream.request_id ?? message._request_id ?? undefined,
      refusal: refusalOf(message.stop_details),
      // every content block as the API returned it (thinking, text, tool_use), for a loop's record
      content: message.content.map(blockOf),
      cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0
    };
  }

  // -- outcomes: a reply with nothing usable is an error, never an empty success --------

  /** The parsed JSON for a schema request (undefined otherwise), or a 422 when the reply is
   * refused, empty, or cut off before it could be used. */
  function judge(request, done, hasContent) {
    if (done.stopReason === 'refusal' && (request.schema !== undefined || !hasContent)) {
      const category = done.refusal?.category;
      throw new AppException(422, 'LLM refused the request - stop_reason=refusal'
        + (category ? `, category=${category}` : ''));
    }
    if (!hasContent) {
      const hint = done.stopReason === 'max_tokens'
        ? ' (raise params.max_tokens or lower params.effort)' : '';
      throw new AppException(422, `LLM reply is empty - stop_reason=${done.stopReason}, `
        + `output_tokens=${done.outputTokens}${hint}`);
    }
    if (request.schema === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(done.text);
    } catch {
      const hint = done.stopReason === 'max_tokens'
        ? ' (the reply was cut off - raise params.max_tokens)' : '';
      throw new AppException(422, 'LLM reply is not valid JSON for the requested schema - '
        + `stop_reason=${done.stopReason}${hint}`);
    }
  }

  /** Usage rides the trace record, so telemetry shows what a call cost (never its text). */
  function annotateUsage(done) {
    trace('llm_model', done.model);
    trace('llm_stop_reason', done.stopReason);
    trace('llm_input_tokens', String(done.inputTokens));
    trace('llm_output_tokens', String(done.outputTokens));
    if (done.requestId) {
      trace('llm_request_id', done.requestId);
    }
  }

  // model and usage only - a prompt or a completion never reaches a log
  function summary(route, done, started) {
    log.info(`${route} model=${done.model} stop_reason=${done.stopReason} `
      + `input_tokens=${done.inputTokens} output_tokens=${done.outputTokens} `
      + `request_id=${done.requestId ?? 'none'} elapsed_ms=${Math.round(performance.now() - started)}`);
  }

  // -- one loop turn --------------------------------------------------------------------

  /** The append check: the record exists, is open, holds the turn the loop expects, and keeps
   * its model. */
  function checkTurn(conversation, record, loop, body) {
    if (record === undefined) {
      throw new AppException(404, `conversation ${conversation} not found - it ended or expired`);
    }
    if (record.closed) {
      throw new AppException(409, `conversation ${conversation} has ended - start a new one`);
    }
    if (record.turn !== loop.turn) {
      throw new AppException(409, `conversation ${conversation} holds turn ${record.turn}, not ${loop.turn} - `
        + 'a stale or duplicated turn');
    }
    const model = isMap(body.params) ? body.params.model : undefined;
    if (model !== undefined && model !== null && String(model) !== record.model) {
      throw new AppException(400, `conversation ${conversation} is pinned to model ${record.model}`);
    }
    return record;
  }

  /** The one user message that answers the last turn's calls, in call order. */
  function toolResults(pending, results) {
    if (results === undefined) {
      throw new AppException(400, `results required - the conversation waits for ${pending.length} tool result(s)`);
    }
    const byId = new Map();
    for (const result of results) {
      if (byId.has(result.id)) {
        throw new AppException(400, `results: duplicate id '${result.id}'`);
      }
      if (!pending.includes(result.id)) {
        throw new AppException(400,
          `results: unknown id '${result.id}' - the conversation waits for: ${pending.join(', ')}`);
      }
      byId.set(result.id, result);
    }
    const missing = pending.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new AppException(400, `results: missing id(s): ${missing.join(', ')}`);
    }
    const content = pending.map((id) => {
      const result = byId.get(id);
      return Object.hasOwn(result, 'error')
        ? { type: 'tool_result', tool_use_id: id, content: resultText(result.error), is_error: true }
        : { type: 'tool_result', tool_use_id: id, content: resultText(result.output) };
    });
    return { role: 'user', content };
  }

  /** The reply's outcome for the turn's stop reason: done, tool_use, refusal or cap. A cut-off
   * turn returns no calls, so none of its truncated calls can run. */
  function loopOutcome(request, done) {
    const stop = done.stopReason;
    if (stop === 'tool_use') {
      const calls = done.content.filter((block) => block.type === 'tool_use')
        .map((block) => ({ id: block.id, name: block.name, input: block.input }));
      if (!calls.length) {
        throw new AppException(502, 'LLM stop_reason=tool_use carried no tool call');
      }
      return { status: 'tool_use', calls };
    }
    if (DONE_STOPS.has(stop)) {
      const data = judge(request, done, done.text !== '');
      return request.schema !== undefined ? { status: 'done', data } : { status: 'done', text: done.text };
    }
    if (stop === 'refusal') {
      return { status: 'refusal', refusal: { category: done.refusal?.category ?? null } };
    }
    if (stop in CAPS) {
      return { status: 'cap', cap: CAPS[stop] };
    }
    throw new AppException(502, `LLM stop_reason=${stop} is not part of the loop contract`);
  }

  // -- the transcript audit store (RFC-0012): what a turn records and sends -----------------

  const auditConfigured = () => Boolean(prop('llm.transcript.audit'));
  const auditGraceS = () => durationOf('llm.transcript.audit.grace',
    prop('llm.transcript.audit.grace', DEFAULT_AUDIT_GRACE), 1);
  const auditRetentionS = () => durationOf('llm.transcript.audit.retention',
    prop('llm.transcript.audit.retention', DEFAULT_AUDIT_RETENTION), 0);
  const auditSweepMs = () => wholeNumber('llm.transcript.audit.sweep.ms',
    prop('llm.transcript.audit.sweep.ms', String(DEFAULT_AUDIT_SWEEP_MS)), 0);

  /** The business correlation id of the transaction: the trace context's, which the host fills
   * from the engine-managed tag at delivery, else the read-only header view of the same value. */
  function correlationId(headers) {
    return getTrace()?.myCorrelationId || headers.my_correlation_id || null;
  }

  /** A new conversation's record: the model pinned, the first turn's messages, and what the audit
   * rows need (record version 2) - the correlation id, the graph and the node the engines' loop
   * sends as headers (null when a caller sends none), the system prompt and the catalog once. */
  function firstRecord(request, loop, headers) {
    return transcript({
      model: request.model,
      messages: [...request.messages],
      turn: 0,
      pending: [],
      correlation_id: correlationId(headers),
      graph_id: headers[GRAPH_ID_HEADER] || null,
      node: headers[NODE_HEADER] || null,
      system: request.system ?? null,
      tools: loop.tools
    });
  }

  /** The facts of one turn, saved in the record inside the compare-and-set: the identity from
   * the trace context, the model call's UTC bounds, its outcome and usage, and where the turn's
   * request and response sit in the messages ([first request message, response]). */
  function turnFacts(turn, status, done, [startedAt, endedAt], headers, indexes) {
    const info = getTrace();
    return {
      turn,
      trace_id: info?.traceId ?? null,
      trace_path: info?.tracePath ?? null,
      correlation_id: correlationId(headers),
      started_at: startedAt,
      ended_at: endedAt,
      status,
      stop_reason: done.stopReason,
      request_id: done.requestId ?? null,
      usage: {
        input_tokens: done.inputTokens,
        output_tokens: done.outputTokens,
        cache_creation_input_tokens: done.cacheCreationInputTokens,
        cache_read_input_tokens: done.cacheReadInputTokens
      },
      messages: indexes
    };
  }

  /** How long the saved record lives. A run the model ended takes the retention; a run the loop
   * stops (a cut-off turn, or the loop's own limits) keeps its time to live and expires with it.
   * With an audit store, a closed record waits for its integrity check instead, which releases it
   * to the retention once the audit holds every turn (RFC-0012, section 4). */
  function recordTtl(loop, outcome, closed, audited) {
    if (audited && closed) {
      return auditGraceS();
    }
    const modelEnded = outcome.status === 'done' || outcome.status === 'refusal' || outcome.cap === 'context';
    return modelEnded ? loop.retentionS : loop.ttlS;
  }

  /** A local drop-n-forget event to transcript.audit over the in-process bus, the turn's trace
   * inherited so the write shows as the function's own execution. A failure to send is logged by
   * type and never refuses the turn: the sweep repairs what a lost event leaves behind. */
  async function auditSend(event) {
    let ack;
    try {
      ack = await send(AUDIT_ROUTE, event);
    } catch (error) {
      log.warn(`${AUDIT_ROUTE} event not sent - ${error?.name ?? 'Error'}`);
      return;
    }
    if (ack.hasError()) {
      log.warn(`${AUDIT_ROUTE} event not accepted - status=${ack.getStatus()}`);
    }
  }

  /** Tell transcript.audit, off the turn's path: the write of this turn and, behind it, the
   * integrity check when the turn closed the run - one mailbox, one worker, so the check can
   * never overtake the write it verifies. */
  async function notifyAudit(conversation, turn, closed) {
    await auditSend({ conversation, turn });
    if (closed) {
      await auditSend({ conversation, check: true });
    }
  }

  // -- a single call in the audit store (RFC-0015) ------------------------------------------
  //
  // A call without tools keeps no working record, so the audit had nothing to read. With
  // llm.transcript.audit.single on, the call becomes a conversation of ONE turn carried the way a
  // loop's turns are: a closed version 2 record saved under a new reference with the audit's
  // grace, and the one event a closed record needs, the check. transcript.audit is unchanged - the
  // check writes the two rows from the record and releases it, and the sweep re-sends a check that
  // failed. No content crosses the bus, and the reply never waits for the save.

  const auditSingleConfigured = () => auditConfigured()
    && String(prop(AUDIT_SINGLE, 'false')).toLowerCase() === 'true';

  /** A single call's status by the loop's table: a refusal, a reply cut off at a limit, else
   * done - the model's outcome, whatever the caller then received; the provider's own word stays
   * in stop_reason. */
  function singleStatus(stopReason) {
    if (stopReason === 'refusal') {
      return 'refusal';
    }
    return Object.hasOwn(CAPS, stopReason) ? 'cap' : 'done';
  }

  /** The closed record of a single call: the messages as sent and the assistant's content blocks
   * as returned, the model that answered (a server-side fallback may have), no tools - which a
   * loop's record never lacks, so the audit row tells the two apart - and the one turn's facts.
   * Retention zero: the check deletes the record once the audit holds the turn. */
  function singleRecord(headers, request, done, bounds) {
    const messages = request.messages.map((turn) => ({ ...turn }));
    return transcript({
      model: done.model,
      messages: [...messages, { role: 'assistant', content: done.content }],
      turn: 1,
      pending: [],
      closed: true,
      correlation_id: correlationId(headers),
      graph_id: headers[GRAPH_ID_HEADER] || null,
      node: headers[NODE_HEADER] || null,
      system: request.system ?? null,
      turns: [turnFacts(1, singleStatus(done.stopReason), done, bounds, headers, [0, messages.length])]
    });
  }

  // the saves in flight, so the shutdown can wait for them
  const singleSaves = new Set();

  /** Save the record under a new reference and send its check. Nothing here may fail the call:
   * a store that is missing or unreachable is logged by type, and that call is not audited. */
  async function saveSingle(record) {
    const conversation = newConversationId();
    try {
      const transcripts = await store();
      if (!(await transcripts.save(conversation, 0, record, auditGraceS()))) {
        // a new reference never meets a record; named for the day one does
        log.warn(`${AUDIT_ROUTE} single call not saved - conversation ${conversation} exists`);
        return;
      }
    } catch (error) { // off the call's path: logged, never raised
      log.warn(`${AUDIT_ROUTE} single call not saved - ${auditFailure(error)}`);
      return;
    }
    await auditSend({ conversation, check: true });
  }

  /** Record a call the model answered, off the call's path: the record is built here, where the
   * call's trace is, and saved by a promise the reply does not wait for. */
  function auditSingle(headers, request, done, bounds) {
    let saving;
    try {
      saving = saveSingle(singleRecord(headers, request, done, bounds));
    } catch (error) { // the audit is a side effect; the call answers
      log.warn(`${AUDIT_ROUTE} single call not recorded - ${error?.name ?? 'Error'}`);
      return;
    }
    const tracked = saving.catch(() => {}).finally(() => singleSaves.delete(tracked));
    singleSaves.add(tracked);
  }

  /** Wait for the saves in flight - the shutdown's drain, and the tests' seam. */
  async function auditSingleIdle() {
    while (singleSaves.size) {
      await Promise.allSettled([...singleSaves]);
    }
  }

  /** One model turn of an agent loop: load and check the record, append the tool results, call
   * the model, append its turn and its facts, save under the compare-and-set, and tell the audit
   * function when one is configured - off the turn's path. */
  async function loopTurn(headers, body) {
    if ('attachments' in body) {
      // a transcript keeps every turn, so it would have to keep the files or references whose
      // files may change between turns: a single call only (RFC-0016)
      throw new AppException(400, LOOP_ATTACHMENTS);
    }
    const loop = prepareLoop(body);
    let request = prepare(body, { streaming: false, continuation: loop.conversation !== undefined });
    const transcripts = await store();
    const audited = auditConfigured();
    let conversation;
    let record;
    let messages;
    let first;
    try {
      if (loop.conversation === undefined) {
        conversation = newConversationId();
        record = firstRecord(request, loop, headers);
        messages = [...record.messages];
        first = 0; // a first turn's request is every message it sent
      } else {
        conversation = loop.conversation;
        record = checkTurn(conversation, await transcripts.load(conversation), loop, body);
        messages = [...record.messages, toolResults(record.pending, loop.results)];
        first = record.messages.length; // the one message of tool results
      }
    } catch (error) {
      throw error instanceof AppException ? error : storeFailure(error);
    }
    request = { ...request, model: record.model, messages, tools: loop.tools };
    const started = performance.now();
    const startedAt = isoUtc();
    let done;
    try {
      done = await complete(request, await backend());
    } catch (error) {
      const mapped = failure(error, request.timeoutMs);
      if (mapped === undefined) {
        throw error;
      }
      log.warn(`llm.chat failed - status=${mapped.status} turn=${record.turn + 1}`);
      throw mapped;
    }
    const endedAt = isoUtc();
    const outcome = loopOutcome(request, done);
    const turn = record.turn + 1;
    const closed = outcome.status !== 'tool_use';
    const facts = turnFacts(turn, outcome.status, done, [startedAt, endedAt], headers, [first, messages.length]);
    const saved = transcript({
      ...record,
      messages: [...messages, { role: 'assistant', content: done.content }],
      turn,
      pending: (outcome.calls ?? []).map((call) => call.id),
      closed,
      retention: loop.retentionS,
      turns: [...record.turns, facts]
    });
    let written;
    try {
      written = await transcripts.save(conversation, record.turn, saved, recordTtl(loop, outcome, closed, audited));
    } catch (error) {
      throw storeFailure(error);
    }
    if (!written) {
      throw new AppException(409, `conversation ${conversation} moved on before turn ${turn} was saved - `
        + 'a duplicated turn');
    }
    if (audited) {
      await notifyAudit(conversation, turn, closed);
    }
    annotateUsage(done);
    trace('llm_status', outcome.status);
    trace('llm_turn', String(turn));
    trace('llm_cache_creation_input_tokens', String(done.cacheCreationInputTokens));
    trace('llm_cache_read_input_tokens', String(done.cacheReadInputTokens));
    // status, turn and usage only - no prompt, completion, tool argument or result reaches a log
    log.info(`llm.chat model=${done.model} status=${outcome.status} turn=${turn} stop_reason=${done.stopReason} `
      + `input_tokens=${done.inputTokens} output_tokens=${done.outputTokens} `
      + `cache_read_input_tokens=${done.cacheReadInputTokens} request_id=${done.requestId ?? 'none'} `
      + `elapsed_ms=${Math.round(performance.now() - started)}`);
    const reply = {
      ...outcome,
      conversation,
      turn,
      model: done.model,
      stop_reason: done.stopReason,
      usage: {
        input_tokens: done.inputTokens,
        output_tokens: done.outputTokens,
        cache_creation_input_tokens: done.cacheCreationInputTokens,
        cache_read_input_tokens: done.cacheReadInputTokens
      }
    };
    if (done.requestId) {
      reply.request_id = done.requestId;
    }
    return reply;
  }

  // -- the functions --------------------------------------------------------------------

  // -- attachments: the files a single call names (RFC-0016) --------------------------------

  let attachmentsRoot; // resolved on first use, and kept: the folder the links led to then

  const refusal = (error) => (error instanceof AttachmentError
    ? new AppException(error.status, error.message) : error);

  /** The one folder a request may name files in. Unset, every attachment is refused. */
  async function rootOf() {
    attachmentsRoot ??= await resolveRoot(prop(ATTACHMENTS_ROOT));
    return attachmentsRoot;
  }

  /** Read the files a call names and put them before the text of the last turn, which must be
   * the user's: the request the model gets, and the one the audit may keep, with a reference in
   * place of each file. */
  async function attach(request, provider) {
    const last = request.messages.at(-1);
    if (last.role !== 'user') {
      throw new AppException(400, "attachments go with the last turn, which must be the user's");
    }
    let loaded;
    try {
      const root = await rootOf();
      const maxBytes = wholeNumber(ATTACHMENTS_MAX_BYTES,
        prop(ATTACHMENTS_MAX_BYTES, String(DEFAULT_ATTACHMENTS_MAX_BYTES)), 1);
      loaded = await loadAttachments({
        specs: request.attachments, root, maxBytes, imageMaxEncoded: provider.imageMaxEncoded, library: pdfLibrary
      });
    } catch (error) {
      throw refusal(error);
    }
    const text = { type: 'text', text: last.content };
    const before = request.messages.slice(0, -1);
    return {
      request: { ...request, messages: [...before, { role: 'user', content: [...loaded.blocks, text] }] },
      recorded: { ...request, messages: [...before, { role: 'user', content: [...loaded.references, text] }] },
      count: loaded.blocks.length,
      size: loaded.size
    };
  }

  /** A piece of work under the call's deadline: at the deadline the caller has its 408, whatever
   * the work is still doing. */
  function withinDeadline(work, timeoutMs) {
    let timer;
    const late = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new AppException(408, `LLM request timed out after ${timeoutMs} ms`)),
        timeoutMs);
    });
    work.catch(() => {}); // a read that ends after the deadline has nobody waiting for it
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }

  /** A root that is configured and is not a folder is a deployment error: stop by name at start,
   * before a request finds it. */
  async function attachmentsBoot() {
    if (!prop(ATTACHMENTS_ROOT)) {
      return;
    }
    try {
      await rootOf();
    } catch (error) {
      log.error(`attachments cannot start - ${error.message}`);
      throw refusal(error);
    }
    log.info(`attachments ready - ${ATTACHMENTS_ROOT} is set`);
  }

  /**
   * Single-shot completion - the AI node a graph's graph.task or a flow's task calls.
   *
   * Input (map):
   *   prompt | messages   single-turn text, or conversation turns [{role, content}]
   *   system              optional system prompt
   *   schema              optional JSON schema -> structured output (the graph needs parseable
   *                       verdicts for decision routing; additionalProperties defaults to false)
   *   params              model, max_tokens, timeout_ms, effort, stop_sequences, provider
   *
   * Output (map): text | data, model, stop_reason, usage {input_tokens, output_tokens},
   * request_id; stop_details when the model refused.
   *
   * params.timeout_ms bounds the whole call, SDK retries included - the x-ttl pattern - and the
   * reading of the attachments. A reply that carries nothing usable (refused, empty, or a schema
   * reply cut off) is a 422.
   *
   * attachments (optional) names files for the model to look at, by reference inside
   * llm.attachments.root: a path, or {path, pages} for pages of a PDF (RFC-0016; README.md,
   * "Attachments"). Never on a loop turn.
   *
   * A request that carries `tools` is one turn of an agent loop (RFC-0011): conversation, turn,
   * results, ttl and retention come with it, and the reply carries status (done, tool_use,
   * refusal or cap), calls, conversation and turn. The transcript stays in this app's store;
   * see README.md, "The loop contract". The loop's x-graph-id and x-node headers are recorded
   * for the audit store, when one is configured (README.md, "The audit store").
   */
  async function chat(headers, body) {
    if (isMap(body) && LOOP_KEYS.some((key) => key in body)) {
      return loopTurn(headers, body);
    }
    const request = prepare(body, { streaming: false });
    const started = performance.now();
    const startedAt = isoUtc();
    let done;
    let attached;
    try {
      const provider = await backend();
      let remainingMs;
      if (request.attachments.length) {
        // one deadline covers the files and the model: a file that is refused is refused here,
        // before any token is spent
        attached = await withinDeadline(attach(request, provider), request.timeoutMs);
        remainingMs = Math.max(1, Math.ceil(request.timeoutMs - (performance.now() - started)));
      }
      done = await complete(attached?.request ?? request, provider, undefined, remainingMs);
    } catch (error) {
      const mapped = failure(error, request.timeoutMs);
      if (mapped === undefined) {
        throw error;
      }
      log.warn(`llm.chat failed - status=${mapped.status}`);
      throw mapped;
    }
    if (auditSingleConfigured()) {
      // before the reply is judged: a refusal, a cut-off reply and a reply that is a 422 below
      // were answered by the model and cost tokens, so they are recorded too. With attachments
      // the record keeps a reference to each file, never its bytes
      auditSingle(headers, attached?.recorded ?? request, done, [startedAt, isoUtc()]);
    }
    const data = judge(request, done, done.text !== '');
    annotateUsage(done);
    if (attached) {
      trace('llm_attachments', String(attached.count));
      trace('llm_attachment_bytes', String(attached.size));
      // the count and the bytes only - a path or a file's content never reaches a log
      log.info(`llm.chat attachments=${attached.count} bytes=${attached.size}`);
    }
    summary('llm.chat', done, started);
    const result = {
      model: done.model,
      stop_reason: done.stopReason,
      usage: { input_tokens: done.inputTokens, output_tokens: done.outputTokens }
    };
    if (request.schema !== undefined) {
      result.data = data;
    } else {
      result.text = done.text;
    }
    if (done.requestId) {
      result.request_id = done.requestId;
    }
    if (done.stopReason === 'refusal' && done.refusal) {
      result.stop_details = done.refusal;
    }
    return result;
  }

  /**
   * Streaming completion: the model's real token batches over the multi-shot reply contract -
   * a calling engine renders them progressively out its own HTTP edge (SSE).
   *
   * Same request surface as llm.chat minus `schema` (a verdict is a single-shot reply).
   * params.timeout_ms is the idle allowance between events, not a total deadline - a stream
   * runs as long as tokens keep flowing. The terminal event's trailing metadata carries
   * model, stop_reason, usage, request_id and the trace and business correlation ids. A
   * stream that ends with no token at all fails in-band with a 422.
   */
  async function stream(headers, event) {
    const out = writer(event);
    const started = performance.now();
    let request;
    let provider;
    try {
      request = prepare(event.body, { streaming: true });
      provider = await backend();
    } catch (error) {
      if (error instanceof AppException) {
        out.fail(error);
        return;
      }
      throw error;
    }
    const meta = {
      language: 'node.js',
      trace_id: getTrace()?.traceId ?? null,
      my_correlation_id: headers.my_correlation_id ?? null
    };
    let frames = 0;
    const batchLog = String(prop('llm.log.batches', 'false')).toLowerCase() === 'true';
    const forward = (text) => {
      if (frames === 0) {
        // the head rides the first token; a stream that never gets one fails cleanly
        out.first(200, TEXT_EVENT_STREAM);
      }
      out.write(text);
      frames += 1;
      if (batchLog) {
        // the diagnostics switch: a batch's number, size and arrival time - never its text
        log.info(`llm.stream batch=${frames} chars=${text.length} t_ms=${Math.round(performance.now() - started)}`);
      }
    };
    let done;
    const startedAt = isoUtc();
    try {
      done = await complete(request, provider, forward);
      if (auditSingleConfigured()) {
        // a stream the model completed is a single call like any other (RFC-0015)
        auditSingle(headers, request, done, [startedAt, isoUtc()]);
      }
      judge(request, done, frames > 0);
    } catch (error) {
      const mapped = failure(error, request.timeoutMs);
      if (mapped === undefined) {
        throw error;
      }
      log.warn(`llm.stream failed - status=${mapped.status} frames=${frames}`);
      out.fail(mapped);
      return;
    }
    annotateUsage(done);
    summary('llm.stream', done, started);
    const trailing = {
      model: done.model,
      stop_reason: done.stopReason,
      usage: { input_tokens: done.inputTokens, output_tokens: done.outputTokens },
      ...meta
    };
    if (done.requestId) {
      trailing.request_id = done.requestId;
    }
    if (done.stopReason === 'refusal' && done.refusal) {
      trailing.stop_details = done.refusal;
    }
    out.close(trailing);
  }

  /**
   * Health check speaking the engines' interface contract (type=info / type=health).
   *
   * Activated for the /health actuator endpoint by mandatory.health.dependencies in
   * resources/application.yml. It reports whether a call could be sent (a credential is
   * present) without reaching the model, so a probe never spends a token.
   */
  async function health(headers) {
    const provider = await backend();
    if (headers.type === 'info') {
      const info = {
        service: 'llm.helper',
        href: 'http://127.0.0.1',
        backend: provider.name,
        model: prop('llm.model', DEFAULT_MODEL)
      };
      if (provider.client.awsRegion) {
        info.region = provider.client.awsRegion; // which region a Bedrock call is signed for
      }
      if (provider.api) {
        info.api = provider.api; // which Bedrock surface answers
      }
      const transcriptStore = prop('llm.transcript.store');
      if (transcriptStore) {
        info.transcript_store = transcriptStore; // where a loop's transcripts are kept
      }
      const transcriptAudit = prop('llm.transcript.audit');
      if (transcriptAudit) {
        info.transcript_audit = transcriptAudit; // where every model turn is recorded for audit
      }
      return info;
    }
    const problem = await provider.credentialProblem();
    if (problem) {
      throw new AppException(503, problem);
    }
    return 'llm.helper is running fine';
  }

  // -- the audit function, its sweep and its boot (RFC-0012) --------------------------------

  /** One event: write what the audit store lacks of the conversation's record, then mark the
   * record audited. A check on a closed record releases it first, so the mark says the check is
   * done; a write of a closing turn leaves both to the check right behind it; an open record (a
   * run waiting for a tool result, a person or the loop's next turn) is only filled. */
  async function auditApply(conversation, check) {
    const transcripts = await store();
    const auditStore = await audit();
    const record = await transcripts.load(conversation);
    if (record === undefined) {
      log.warn(`${AUDIT_ROUTE} conversation=${conversation} no working record - expired or released`);
      return;
    }
    const held = await auditStore.turns(conversation);
    const facts = new Map((record.turns ?? []).map((fact) => [Number(fact.turn), fact]));
    const missing = [];
    for (let turn = 1; turn <= record.turn; turn += 1) {
      if (!held.has(turn)) {
        missing.push(turn);
      }
    }
    const rows = missing.filter((turn) => facts.has(turn)).map((turn) => turnRow(conversation, record, facts.get(turn)));
    await auditStore.write(conversationRow(conversation, record, isoUtc(), auditRetentionS()), rows);
    const unauditable = missing.filter((turn) => !facts.has(turn));
    if (unauditable.length) {
      // a record from before version 2: its earlier turns carry no facts (the one time the audit
      // is knowingly incomplete)
      log.warn(`${AUDIT_ROUTE} conversation=${conversation} turn(s) ${unauditable.join(',')} carry no facts - unaudited`);
    }
    let released = false;
    if (record.closed && check) {
      await transcripts.release(conversation, record.retention);
      released = true;
    }
    if (check || !record.closed) {
      await transcripts.markAudited(conversation, record.turn);
    }
    log.info(`${AUDIT_ROUTE} conversation=${conversation} turn=${record.turn} written=${rows.length} `
      + `check=${check} released=${released}`);
  }

  /**
   * The audit function (RFC-0012): registered at boot as a private route with ONE instance when
   * llm.transcript.audit is configured. Two events, both local and drop-n-forget from llm.chat -
   * {conversation, turn} after a compare-and-set accepted the turn, and {conversation, check: true}
   * behind the write of a closing turn (and from the sweep). A failure is logged by type - never a
   * prompt, a completion, an argument or a result - and the sweep repairs it.
   */
  async function transcriptAudit(_headers, body) {
    const event = isMap(body) ? body : {};
    const { conversation } = event;
    if (typeof conversation !== 'string' || !CONVERSATION_ID.test(conversation)) {
      log.warn(`${AUDIT_ROUTE} event without a conversation reference ignored`);
      return;
    }
    const check = Boolean(event.check);
    try {
      await auditApply(conversation, check);
    } catch (error) { // off the turn's path: logged by type, the sweep repairs
      log.warn(`${AUDIT_ROUTE} conversation=${conversation} ${check ? 'check' : 'write'} failed - ${auditFailure(error)}`);
    }
  }

  /** One sweep: a check event for every live record whose audited mark lags its turn count -
   * the runs the loop stopped, and the writes a dying process lost. On Redis one replica per
   * interval does it; the memory store sweeps its own process. The number of checks sent. */
  async function auditSweep() {
    const transcripts = await store();
    if (!(await transcripts.sweepLock(auditSweepMs()))) {
      return 0;
    }
    const lagging = await transcripts.unaudited();
    for (const conversation of lagging) {
      await auditSend({ conversation, check: true });
    }
    if (lagging.length) {
      log.info(`${AUDIT_ROUTE} sweep: ${lagging.length} record(s) behind their audit`);
    }
    return lagging.length;
  }

  let sweepTimer;
  let auditStoreOpened; // the store the boot built, closed at shutdown

  /** Start the audit when llm.transcript.audit is configured: register transcript.audit with one
   * instance, open the store and start the sweep. A driver that is not installed stops the
   * application by name (a deployment error); a database that does not answer is logged, and the
   * sweep repairs what the outage defers. */
  async function auditBoot() {
    if (!auditConfigured()) {
      return;
    }
    try {
      auditStoreOpened = await audit();
    } catch (error) {
      log.error(`transcript audit store cannot start - ${error.message}`);
      throw error;
    }
    if (auditSingleConfigured() && !prop('llm.transcript.store')) {
      // a single call's record waits in the working store for its check: a deployment error
      log.error(`transcript audit store cannot start - ${MISSING_SINGLE_STORE}`);
      throw new AppException(503, MISSING_SINGLE_STORE);
    }
    if (!registry.exists(AUDIT_ROUTE)) {
      registry.register(AUDIT_ROUTE, transcriptAudit, { instances: 1, isPrivate: true });
      log.info(`Loaded PRIVATE ${AUDIT_ROUTE}, instances=1 - audit store ${auditStoreOpened.name}`);
    }
    try {
      await auditStoreOpened.open();
      log.info(`transcript audit store ${auditStoreOpened.name} ready`);
    } catch (error) { // an outage, not a deployment error
      log.warn(`transcript audit store ${auditStoreOpened.name} not answering at start - ${auditFailure(error)}; `
        + 'the sweep repairs what the outage defers');
    }
    const sweepMs = auditSweepMs();
    if (sweepMs > 0 && sweepTimer === undefined) {
      sweepTimer = setInterval(() => {
        auditSweep().catch((error) => log.warn(`${AUDIT_ROUTE} sweep failed - ${auditFailure(error)}`));
      }, sweepMs);
      sweepTimer.unref?.(); // the sweep never keeps a stopping process alive
    }
  }

  async function auditShutdown() {
    if (sweepTimer !== undefined) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
    await auditSingleIdle(); // a single call's save in flight reaches the store before it closes
    const closing = auditStoreOpened;
    auditStoreOpened = undefined;
    if (closing !== undefined) {
      await closing.close();
    }
  }

  return {
    prepare, plan, chat, stream, health, transcriptAudit, auditSweep, auditBoot, auditShutdown,
    auditSingleIdle, singleSaves: () => singleSaves.size, attachmentsBoot,
    sweeping: () => sweepTimer !== undefined
  };
}

const helper = createLlmHelper();
preload('llm.chat', { instances: 50 }, helper.chat);
preload('llm.stream', { instances: 50, interceptor: true }, helper.stream);
preload('llm.health', { instances: 5, isPrivate: true }, helper.health);
// the audit starts inside the serving loop, before the host listens, when it is configured
platform.onStartup(helper.auditBoot);
platform.onStartup(helper.attachmentsBoot); // a configured root that is not a folder stops the start
platform.onCleanup(helper.auditShutdown);
