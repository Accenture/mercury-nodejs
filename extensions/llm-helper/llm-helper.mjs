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
 * llm.transcript.retention and the llm.transcript.redis.* connection keys. The contract, the keys and the backends are documented in
 * README.md next to this file. The Python twin (mercury-python extensions/llm-helper) speaks
 * the same contract, and both are pinned by shared vector files.
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
  AppException, annotateTrace, appConfig, EventStreamWriter, getLogger, getTrace, preload
} from 'mercury-composable';

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
const DURATION = /^([0-9]+)([smhd]?)$/;
const DURATION_SECONDS = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
export const DEFAULT_TRANSCRIPT_TTL = '7d';
export const DEFAULT_TRANSCRIPT_RETENTION = '0';
export const STORE_MEMORY = 'memory';
export const STORE_REDIS = 'redis';
export const STORES = [STORE_MEMORY, STORE_REDIS];
// the store's key prefix, so a Redis ACL can confine this app's user to ~transcript:*
export const TRANSCRIPT_PREFIX = 'transcript:';
const DONE_STOPS = ['end_turn', 'stop_sequence'];
// a turn cut off by a limit: the loop names which one in its envelope
const CAPS = { max_tokens: 'max_tokens', model_context_window_exceeded: 'context' };
const CACHE_CONTROL = { type: 'ephemeral' };
const MISSING_STORE = 'transcript store not configured - set llm.transcript.store '
  + '(redis, or memory for a single process)';
const MISSING_REDIS_SDK = 'The redis transcript store needs redis - npm install redis';
const STREAM_LOOP = 'tools and the loop fields are not part of the streaming contract - use llm.chat';

const isMap = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
// a value Python reads as true: a non-empty list or map, a non-empty string, a non-zero number
const present = (value) => (Array.isArray(value) ? value.length > 0
  : isMap(value) ? Object.keys(value).length > 0 : Boolean(value));

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
export function bedrockBackend(name = BEDROCK_BACKEND, client, api = AWS_API_MANTLE) {
  return {
    name,
    client,
    api,
    supportsFallbacks: false,
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
  return name === BEDROCK_BACKEND ? bedrockBackend(name, client, api) : anthropicBackend(name, client);
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
// conversation, and every write sets the record's time to live. The record's JSON is the Python
// twin's, field for field.

export const recordJson = (record) => JSON.stringify({
  v: 1, model: record.model, turn: record.turn, pending: record.pending, closed: record.closed,
  messages: record.messages
});

export function recordFrom(text) {
  const { model, turn, pending, closed, messages } = JSON.parse(text);
  return { model, turn, pending, closed, messages };
}

/** One process: for development and tests. A second replica cannot see these records. The
 * clock reads seconds. */
export class MemoryStore {
  name = STORE_MEMORY;

  constructor({ clock = () => performance.now() / 1000 } = {}) {
    this.clock = clock;
    this.records = new Map(); // conversation -> [expiry, turn, record]
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
      this.records.set(conversation, [this.clock() + ttlS, record.turn, recordJson(record)]);
    }
    return true;
  }
}

// one script, one key: atomic on a standalone server and safe on a cluster - the Python twin's
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

/** A hash per conversation under transcript:{conversation}: the turn count and the record. The
 * client (the redis package) connects on the first command, and again after it gave up
 * reconnecting; a client that needs no connect (a test double) is used as given. */
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

/** A tool's output or error as tool_result text; JSON is written compactly, keys in order. */
const resultText = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

// --- the helper ------------------------------------------------------------------------

/**
 * The three functions, wired to their dependencies: prop(key, default) reads a setting,
 * backend() returns the backend, store() the transcript store, newConversationId() a loop's
 * reference, writer(event) the stream writer, log the logger and trace(key, value) the trace
 * annotation. Tests inject fakes.
 */
export function createLlmHelper({
  prop = (key, fallback) => appConfig().getProperty(key, fallback),
  backend = defaultBackend((key, fallback) => appConfig().getProperty(key, fallback)),
  store = defaultStore((key, fallback) => appConfig().getProperty(key, fallback)),
  newConversationId = () => randomUUID().replaceAll('-', ''),
  writer = (event) => EventStreamWriter.fromRequest(event),
  log = defaultLog,
  trace = annotateTrace
} = {}) {
  /** Precedence: the call's param, then the config key, then the built-in default. */
  const setting = (params, key, configKey, fallback) => params[key] ?? prop(configKey, fallback);

  // -- the request: validated in a fixed order, the same as the Python twin -------------

  function paramsOf(body) {
    if (body.params !== undefined && body.params !== null && !isMap(body.params)) {
      throw new AppException(400, 'params must be a map');
    }
    const params = { ...body.params };
    const unknown = Object.keys(params).filter((key) => !PARAMS.includes(key)).sort();
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
      const unknown = Object.keys(tool).filter((key) => !TOOL_KEYS.includes(key)).sort();
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
      const unknown = Object.keys(result).filter((key) => !['id', 'output', 'error'].includes(key)).sort();
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
      options.signal = AbortSignal.timeout(request.timeoutMs);
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
  async function complete(request, provider, onText) {
    const { namespace, params, options } = plan(request, provider, { deadline: onText === undefined });
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
    if (DONE_STOPS.includes(stop)) {
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

  /** One model turn of an agent loop: load and check the record, append the tool results, call
   * the model, append its turn, and save under the compare-and-set. */
  async function loopTurn(body) {
    const loop = prepareLoop(body);
    let request = prepare(body, { streaming: false, continuation: loop.conversation !== undefined });
    const transcripts = await store();
    let conversation;
    let record;
    let messages;
    try {
      if (loop.conversation === undefined) {
        conversation = newConversationId();
        record = { model: request.model, messages: [...request.messages], turn: 0, pending: [], closed: false };
        messages = [...record.messages];
      } else {
        conversation = loop.conversation;
        record = checkTurn(conversation, await transcripts.load(conversation), loop, body);
        messages = [...record.messages, toolResults(record.pending, loop.results)];
      }
    } catch (error) {
      throw error instanceof AppException ? error : storeFailure(error);
    }
    request = { ...request, model: record.model, messages, tools: loop.tools };
    const started = performance.now();
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
    const outcome = loopOutcome(request, done);
    const turn = record.turn + 1;
    const saved = {
      model: record.model,
      messages: [...messages, { role: 'assistant', content: done.content }],
      turn,
      pending: (outcome.calls ?? []).map((call) => call.id),
      closed: outcome.status !== 'tool_use'
    };
    // a run the model ended takes the retention; a run the loop stops (a cut-off turn, or the
    // loop's own limits) keeps its time to live and expires with it
    const modelEnded = outcome.status === 'done' || outcome.status === 'refusal' || outcome.cap === 'context';
    let written;
    try {
      written = await transcripts.save(conversation, record.turn, saved, modelEnded ? loop.retentionS : loop.ttlS);
    } catch (error) {
      throw storeFailure(error);
    }
    if (!written) {
      throw new AppException(409, `conversation ${conversation} moved on before turn ${turn} was saved - `
        + 'a duplicated turn');
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
   * params.timeout_ms bounds the whole call, SDK retries included - the x-ttl pattern. A reply
   * that carries nothing usable (refused, empty, or a schema reply cut off) is a 422.
   *
   * A request that carries `tools` is one turn of an agent loop (RFC-0011): conversation, turn,
   * results, ttl and retention come with it, and the reply carries status (done, tool_use,
   * refusal or cap), calls, conversation and turn. The transcript stays in this app's store;
   * see README.md, "The loop contract".
   */
  async function chat(_headers, body) {
    if (isMap(body) && LOOP_KEYS.some((key) => key in body)) {
      return loopTurn(body);
    }
    const request = prepare(body, { streaming: false });
    const started = performance.now();
    let done;
    try {
      done = await complete(request, await backend());
    } catch (error) {
      const mapped = failure(error, request.timeoutMs);
      if (mapped === undefined) {
        throw error;
      }
      log.warn(`llm.chat failed - status=${mapped.status}`);
      throw mapped;
    }
    const data = judge(request, done, done.text !== '');
    annotateUsage(done);
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
    try {
      done = await complete(request, provider, forward);
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
      return info;
    }
    const problem = await provider.credentialProblem();
    if (problem) {
      throw new AppException(503, problem);
    }
    return 'llm.helper is running fine';
  }

  return { prepare, plan, chat, stream, health };
}

const helper = createLlmHelper();
preload('llm.chat', { instances: 50 }, helper.chat);
preload('llm.stream', { instances: 50, interceptor: true }, helper.stream);
preload('llm.health', { instances: 5, isPrivate: true }, helper.health);
