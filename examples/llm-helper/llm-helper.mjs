/**
 * The LLM helper - a dedicated polyglot function host for the AI nodes of the
 * agent-orchestration experiment: `llm.chat`, `llm.stream` and `llm.health`, on the
 * official Anthropic SDK. The engines stay LLM-free: a graph or a flow reaches these routes
 * through declarative Event-over-HTTP like any other function, so the certified model
 * decides control flow while the LLM advises within it.
 *
 * Run:  npm install --save-dev @anthropic-ai/sdk     (or: npm install @anthropic-ai/sdk)
 *       node dist/src/cli.js examples/llm-helper/llm-helper.mjs
 *
 * The credential comes from the environment (ANTHROPIC_API_KEY), never from a config file.
 * Settings live in resources/application.yml (or -Dkey=value): llm.backend, llm.model,
 * llm.max.tokens, llm.timeout.ms, llm.max.retries, llm.fallbacks, llm.effort. The contract,
 * the keys and the backend seam are documented in README.md next to this file. The Python
 * twin (mercury-python examples/llm-helper) speaks the same contract, and both are pinned by
 * one shared vector file.
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
import Anthropic from '@anthropic-ai/sdk';
import {
  AppException, annotateTrace, appConfig, EventStreamWriter, getLogger, getTrace, preload
} from 'mercury-composable';

const defaultLog = getLogger('llm-helper');

// --- the contract's defaults and limits ----------------------------------------------

export const DEFAULT_PROVIDER = 'anthropic';
export const DEFAULT_BACKEND = 'anthropic';
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_MAX_TOKENS = 16000;
export const DEFAULT_TIMEOUT_MS = 60000;
export const DEFAULT_MAX_RETRIES = 2;
export const PROVIDERS = [DEFAULT_PROVIDER];
export const BACKENDS = [DEFAULT_BACKEND];
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
// the SDK raises a plain error, before sending anything, when no credential resolves
const CREDENTIAL_ERROR = 'Could not resolve authentication method';

const isMap = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

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

/** Map a provider failure to AppException(status, message); undefined for anything else. */
export function failure(error, timeoutMs) {
  if (error instanceof AppException) {
    return error;
  }
  if (error instanceof Anthropic.APIUserAbortError
      || error instanceof Anthropic.APIConnectionTimeoutError) {
    return new AppException(408, `LLM request timed out after ${timeoutMs} ms`);
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
 * One way to reach Claude: the client, and what this route to the models supports.
 *
 * This is the seam for a second route to the same models - AWS Bedrock through IAM is the
 * planned one (see README.md, "Backends"): build its client in defaultBackend(), prefix the
 * model id in providerModel(), report no server-side fallbacks, and describe a missing
 * credential. Nothing else in this module knows which route answered.
 */
export function anthropicBackend(name = DEFAULT_BACKEND, client = new Anthropic()) {
  return {
    name,
    client,
    supportsFallbacks: true,
    providerModel: (model) => model,
    /** What is missing for a call to be sent, or undefined. No network traffic. */
    credentialProblem: () => (['apiKey', 'authToken', 'credentials'].some((key) => client[key])
      ? undefined : MISSING_CREDENTIAL)
  };
}

/** The backend, built on first use. Credentials resolve per call, so the app starts (and
 * reports its health) without one. */
export function defaultBackend(prop) {
  let built;
  return () => {
    if (built === undefined) {
      const name = String(prop('llm.backend', DEFAULT_BACKEND) || DEFAULT_BACKEND).toLowerCase();
      if (!BACKENDS.includes(name)) {
        throw new AppException(501,
          `unknown LLM backend '${name}' - this helper serves: ${BACKENDS.join(', ')}`);
      }
      built = anthropicBackend(name);
    }
    return built;
  };
}

// --- the helper ------------------------------------------------------------------------

/**
 * The three functions, wired to their dependencies: prop(key, default) reads a setting,
 * backend() returns the backend, writer(event) the stream writer, log the logger and
 * trace(key, value) the trace annotation. Tests inject fakes.
 */
export function createLlmHelper({
  prop = (key, fallback) => appConfig().getProperty(key, fallback),
  backend = defaultBackend((key, fallback) => appConfig().getProperty(key, fallback)),
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

  /** Validate a request body into a request, or throw AppException(400). */
  function prepare(body, { streaming }) {
    if (!isMap(body) || !(body.prompt || (Array.isArray(body.messages) && body.messages.length))) {
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
      messages: turnsOf(body),
      system: systemOf(body),
      effort: effortOf(params),
      stopSequences: stopSequencesOf(params),
      schema: schemaOf(body, streaming),
      fallbacks: fallbacksEnabled()
    };
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
    const fallbacks = request.fallbacks && provider.supportsFallbacks
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
      refusal: refusalOf(message.stop_details)
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
   */
  async function chat(_headers, body) {
    const request = prepare(body, { streaming: false });
    const started = performance.now();
    let done;
    try {
      done = await complete(request, backend());
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
      provider = backend();
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
   * present) without any network traffic, so a probe never spends a token.
   */
  async function health(headers) {
    const provider = backend();
    if (headers.type === 'info') {
      return {
        service: 'llm.helper',
        href: 'http://127.0.0.1',
        backend: provider.name,
        model: prop('llm.model', DEFAULT_MODEL)
      };
    }
    const problem = provider.credentialProblem();
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
