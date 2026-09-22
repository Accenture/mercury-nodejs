/**
 * The AI nodes of the agent-orchestration experiment (E0) - the Node.js twins of the
 * Python demo's `llm.chat` and `llm.stream`: provider-neutral LLM adapters as plain
 * wrapper-side functions. The engine and this host stay LLM-free - a graph or flow
 * reaches these routes like any other function, so the certified graph decides control
 * flow while the model advises within it.
 *
 * Both providers are spoken over their REST APIs through the runtime's fetch - no SDK,
 * no dependency (the same ruling as the OpenTelemetry forwarder). Credentials come from
 * the environment: GEMINI_API_KEY (or GOOGLE_API_KEY) and ANTHROPIC_API_KEY.
 *
 * Provider selection: params.provider, else the llm.provider config key (e.g.
 * mercury-serve ... -Dllm.provider=gemini), else anthropic. The model per provider comes
 * from params.model, the llm.model config key, or LLM_DEFAULT_MODELS.
 *
 * llm.chat  - input (map): prompt | messages [{role, content}], system, schema (JSON
 *             schema -> structured output; additionalProperties defaults to false),
 *             params (provider, model, max_tokens, timeout_ms + provider pass-through).
 *             Output (map): text | data, model, stop_reason, usage {input_tokens,
 *             output_tokens}. Provider errors ride the envelope status.
 * llm.stream - the streaming AI node: the provider's real token stream relayed over the
 *             multi-shot reply contract, so a calling engine renders it progressively out
 *             its own HTTP edge (SSE). Same request surface minus schema (a schema
 *             verdict is a single-shot reply - use llm.chat). The terminal event's
 *             trailing metadata carries model, stop_reason, usage and the trace /
 *             business correlation ids.
 */
import {
  AppException, annotateTrace, appConfig, defaultRegistry, EventStreamWriter, getLogger,
  getTrace, SseParser
} from '../dist/src/index.js';

const log = getLogger('llm-nodes');

export const LLM_DEFAULT_PROVIDER = 'anthropic';
// gemini-flash-latest is the stable alias: a dated flash id stops being served when the
// provider retires it, the alias moves with it
export const LLM_DEFAULT_MODELS = { anthropic: 'claude-opus-5', gemini: 'gemini-flash-latest' };
export const LLM_DEFAULT_MAX_TOKENS = 16000;
export const LLM_DEFAULT_TIMEOUT_MS = 60000;
export const TEXT_EVENT_STREAM = 'text/event-stream';
// the provider endpoints (an environment override points a test double at them)
export const GEMINI_API_BASE = process.env.GEMINI_API_BASE ?? 'https://generativelanguage.googleapis.com/v1beta';
export const ANTHROPIC_API_BASE = process.env.ANTHROPIC_API_BASE ?? 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_ERROR_CHARS = 300;

/**
 * The shared request surface of the AI nodes: provider and model resolution
 * (params -> llm.provider/llm.model config -> defaults), token/time budgets and message
 * shaping. Throws AppException(400) for a malformed request.
 */
export function prepareRequest(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)
      || !(body.prompt || body.messages)) {
    throw new AppException(400, "missing 'prompt' or 'messages'");
  }
  const params = typeof body.params === 'object' && body.params !== null ? { ...body.params } : {};
  const config = appConfig();
  const provider = String(params.provider ?? config.getProperty('llm.provider') ?? LLM_DEFAULT_PROVIDER)
    .toLowerCase();
  delete params.provider;
  if (!(provider in LLM_DEFAULT_MODELS)) {
    throw new AppException(400, `unknown LLM provider '${provider}' - use one of `
      + `[${Object.keys(LLM_DEFAULT_MODELS).sort().join(', ')}]`);
  }
  const model = String(params.model ?? config.getProperty('llm.model') ?? LLM_DEFAULT_MODELS[provider]);
  delete params.model;
  const maxTokens = Number.parseInt(String(params.max_tokens ?? LLM_DEFAULT_MAX_TOKENS), 10);
  const timeoutMs = Number.parseInt(String(params.timeout_ms ?? LLM_DEFAULT_TIMEOUT_MS), 10);
  delete params.max_tokens;
  delete params.timeout_ms;
  const messages = Array.isArray(body.messages) && body.messages.length
    ? body.messages : [{ role: 'user', content: String(body.prompt) }];
  return { provider, model, maxTokens, timeoutMs, messages, system: body.system, params };
}

function apiKey(provider) {
  const key = provider === 'gemini'
    ? (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)
    : process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const name = provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
    throw new AppException(503, `LLM provider credential missing - set ${name} in the environment`);
  }
  return key;
}

function excerpt(text) {
  const collapsed = String(text ?? '').split(/\s+/).filter(Boolean).join(' ');
  return collapsed.length > MAX_ERROR_CHARS ? `${collapsed.slice(0, MAX_ERROR_CHARS)}...` : collapsed;
}

/** A provider's HTTP rejection as the portable error contract (status rides the envelope). */
function providerError(status, text) {
  if (status === 429) {
    return new AppException(429, `LLM provider rate limit - ${excerpt(text)}`);
  }
  return new AppException(status >= 400 && status <= 599 ? status : 502,
    `LLM provider error - HTTP ${status} ${excerpt(text)}`);
}

/** A transport failure (DNS, refused, timeout) before any provider answer. */
function unreachable(e) {
  const detail = e?.cause?.message ?? e?.message ?? String(e);
  return new AppException(503, `LLM provider unreachable - ${detail}`);
}

async function post(url, headers, body, timeoutMs) {
  try {
    return await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1000, timeoutMs))
    });
  } catch (e) {
    throw unreachable(e);
  }
}

/** The completed SSE events of a response body, as [eventName, data] pairs. */
async function* sseEvents(stream) {
  const parser = new SseParser();
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    for (const event of parser.feed(value)) {
      yield event;
    }
  }
  // a final event without a trailing blank line still dispatches
  for (const event of parser.feed(new Uint8Array([0x0a, 0x0a]))) {
    yield event;
  }
}

// ---- Gemini (REST: generateContent / streamGenerateContent?alt=sse) ----

export function geminiBody(request, schema) {
  const { messages, system, maxTokens, params } = request;
  const contents = messages
    .filter((turn) => typeof turn === 'object' && turn !== null)
    .map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(turn.content ?? '') }]
    }));
  // provider pass-through (e.g. temperature, thinkingConfig) wins verbatim
  const generationConfig = { maxOutputTokens: maxTokens, ...params };
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseJsonSchema = schema;
  }
  const body = { contents, generationConfig };
  if (system) {
    body.systemInstruction = { parts: [{ text: String(system) }] };
  }
  return body;
}

function geminiText(chunk) {
  const parts = chunk?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.map((p) => p?.text ?? '').join('') : '';
}

function geminiUsage(usage) {
  return {
    input_tokens: usage?.promptTokenCount ?? 0,
    output_tokens: usage?.candidatesTokenCount ?? 0
  };
}

async function geminiChat(request, schema) {
  const url = `${GEMINI_API_BASE}/models/${request.model}:generateContent`;
  const response = await post(url, { 'x-goog-api-key': apiKey('gemini') },
    geminiBody(request, schema), request.timeoutMs);
  const text = await response.text();
  if (!response.ok) {
    throw providerError(response.status, text);
  }
  const data = JSON.parse(text);
  return {
    text: geminiText(data),
    model: data.modelVersion ?? request.model,
    stop_reason: String(data?.candidates?.[0]?.finishReason ?? ''),
    usage: geminiUsage(data.usageMetadata)
  };
}

async function geminiStream(out, request, meta) {
  const url = `${GEMINI_API_BASE}/models/${request.model}:streamGenerateContent?alt=sse`;
  let usage;
  let finish = '';
  let version = request.model;
  try {
    const response = await post(url, { 'x-goog-api-key': apiKey('gemini') },
      geminiBody(request), request.timeoutMs);
    if (!response.ok) {
      out.fail(providerError(response.status, await response.text()));
      return;
    }
    out.first(200, TEXT_EVENT_STREAM);
    for await (const [, data] of sseEvents(response.body)) {
      const chunk = JSON.parse(data);
      const text = geminiText(chunk);
      if (text) {
        out.write(text);
      }
      // usage/finish arrive on the final chunk; the model version on any
      usage = chunk.usageMetadata ?? usage;
      finish = chunk?.candidates?.[0]?.finishReason ?? finish;
      version = chunk.modelVersion ?? version;
    }
  } catch (e) {
    out.fail(e instanceof AppException ? e : unreachable(e));
    return;
  }
  out.close({ model: version, stop_reason: String(finish), usage: geminiUsage(usage), ...meta });
}

// ---- Anthropic (REST: /messages, stream: true) ----

export function anthropicBody(request, schema, stream = false) {
  const { model, maxTokens, messages, system, params } = request;
  const body = { model, max_tokens: maxTokens, messages };
  if (system) {
    body.system = system;
  }
  if (schema) {
    body.output_config = { format: { type: 'json_schema', schema } };
  }
  if (stream) {
    body.stream = true;
  }
  return { ...body, ...params }; // provider pass-through wins verbatim
}

function anthropicHeaders() {
  return { 'x-api-key': apiKey('anthropic'), 'anthropic-version': ANTHROPIC_VERSION };
}

async function anthropicChat(request, schema) {
  const response = await post(`${ANTHROPIC_API_BASE}/messages`, anthropicHeaders(),
    anthropicBody(request, schema), request.timeoutMs);
  const text = await response.text();
  if (!response.ok) {
    throw providerError(response.status, text);
  }
  const data = JSON.parse(text);
  const block = Array.isArray(data.content) ? data.content.find((b) => b?.type === 'text' && b.text) : undefined;
  return {
    text: block?.text ?? '',
    model: data.model ?? request.model,
    stop_reason: String(data.stop_reason ?? ''),
    usage: { input_tokens: data?.usage?.input_tokens ?? 0, output_tokens: data?.usage?.output_tokens ?? 0 }
  };
}

async function anthropicStream(out, request, meta) {
  let model = request.model;
  let stopReason = '';
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const response = await post(`${ANTHROPIC_API_BASE}/messages`, anthropicHeaders(),
      anthropicBody(request, undefined, true), request.timeoutMs);
    if (!response.ok) {
      out.fail(providerError(response.status, await response.text()));
      return;
    }
    out.first(200, TEXT_EVENT_STREAM);
    for await (const [name, data] of sseEvents(response.body)) {
      const event = JSON.parse(data);
      const type = event.type ?? name;
      if (type === 'message_start') {
        model = event.message?.model ?? model;
        inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
      } else if (type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          out.write(event.delta.text);
        }
      } else if (type === 'message_delta') {
        stopReason = event.delta?.stop_reason ?? stopReason;
        outputTokens = event.usage?.output_tokens ?? outputTokens;
      } else if (type === 'error') {
        out.fail(new AppException(502, `LLM provider error - ${excerpt(event.error?.message ?? data)}`));
        return;
      }
    }
  } catch (e) {
    out.fail(e instanceof AppException ? e : unreachable(e));
    return;
  }
  out.close({ model, stop_reason: String(stopReason),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }, ...meta });
}

// ---- the functions ----

/** Register llm.chat and llm.stream (the default registry, or a test's own). */
export function registerLlmNodes(registry = defaultRegistry) {
  registry.register('llm.chat', async (_headers, body) => {
    const request = prepareRequest(body);
    let schema = typeof body.schema === 'object' && body.schema !== null && !Array.isArray(body.schema)
      ? body.schema : undefined;
    if (schema) {
      // structured output: a closed schema is what a bounded verdict wants, so
      // default additionalProperties to false when the caller omits it
      schema = { additionalProperties: false, ...schema };
    }
    const result = request.provider === 'gemini'
      ? await geminiChat(request, schema) : await anthropicChat(request, schema);
    annotateTrace('llm_model', String(result.model ?? ''));
    const { text, ...rest } = result;
    if (schema && text) {
      // both providers guarantee schema-constrained output as one JSON text
      return { ...rest, data: JSON.parse(text) };
    }
    return { ...rest, text };
  }, { instances: 50 });

  registry.register('llm.stream', async (headers, event) => {
    const out = EventStreamWriter.fromRequest(event, registry);
    let request;
    try {
      request = prepareRequest(event.body);
    } catch (e) {
      out.fail(e);
      return;
    }
    const info = getTrace();
    const meta = {
      language: 'node.js',
      trace_id: info?.traceId ?? null,
      my_correlation_id: headers.my_correlation_id ?? null
    };
    log.info(`Streaming tokens from ${request.model} via ${request.provider}`);
    if (request.provider === 'gemini') {
      await geminiStream(out, request, meta);
    } else {
      await anthropicStream(out, request, meta);
    }
  }, { instances: 50, interceptor: true });
}
