/**
 * The AI nodes (examples/llm-nodes.mjs): the provider-neutral request surface, the two
 * REST dialects (Gemini, Anthropic) through a fake fetch, the portable error contract,
 * and the streaming relay - token-free, the twin of the Python demo's llm tests.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EventEnvelope, FunctionRegistry, PostOffice, streamSignal } from '../dist/src/index.js';
import {
  ANTHROPIC_API_BASE, GEMINI_API_BASE, LLM_DEFAULT_MODELS, anthropicBody, geminiBody,
  prepareRequest, registerLlmNodes
} from '../examples/llm-nodes.mjs';

process.env.GEMINI_API_KEY = 'gemini-test-key';
process.env.ANTHROPIC_API_KEY = 'anthropic-test-key';

const registry = new FunctionRegistry();
registerLlmNodes(registry);
const po = new PostOffice(undefined, {}, registry);

// ---- a fake fetch: records the calls, answers the scripted responses ----
const realFetch = globalThis.fetch;
const calls = [];
let responses = [];
before(() => {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : undefined });
    const next = responses.shift();
    if (!next) throw new TypeError('fetch failed');
    return next;
  };
});
after(() => {
  globalThis.fetch = realFetch;
  registry.bus.close();
});

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function sse(events) {
  const text = events.map(([name, data]) =>
    (name ? `event: ${name}\r\n` : '') + `data: ${JSON.stringify(data)}\r\n\r\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function reset() {
  calls.length = 0;
  responses = [];
}
async function collect(body, headers) {
  const events = [];
  for await (const event of po.stream('llm.stream', body, { headers, timeoutMs: 5000, cid: 'cid-llm' })) {
    events.push(event);
  }
  return events;
}

test('the request surface: defaults, overrides and refusals', () => {
  const request = prepareRequest({ prompt: 'hi' });
  assert.equal(request.provider, 'anthropic');
  assert.equal(request.model, LLM_DEFAULT_MODELS.anthropic);
  assert.equal(request.maxTokens, 16000);
  assert.equal(request.timeoutMs, 60000);
  assert.deepEqual(request.messages, [{ role: 'user', content: 'hi' }]);
  const gemini = prepareRequest({ messages: [{ role: 'user', content: 'x' }],
    params: { provider: 'Gemini', model: 'gemini-pro-x', max_tokens: 50, timeout_ms: 700, temperature: 0.2 } });
  assert.equal(gemini.provider, 'gemini');
  assert.equal(gemini.model, 'gemini-pro-x');
  assert.equal(gemini.maxTokens, 50);
  assert.equal(gemini.timeoutMs, 700);
  assert.deepEqual(gemini.params, { temperature: 0.2 }, 'the budget keys leave the pass-through');
  assert.throws(() => prepareRequest({}), /missing 'prompt' or 'messages'/);
  assert.throws(() => prepareRequest({ prompt: 'x', params: { provider: 'nope' } }), /unknown LLM provider 'nope'/);
});

test('the provider bodies', () => {
  const request = prepareRequest({ prompt: 'classify', system: 'be terse',
    params: { provider: 'gemini', max_tokens: 20, thinkingConfig: { thinkingBudget: 0 } } });
  const body = geminiBody(request, { type: 'object' });
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'classify' }] }]);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'be terse' }] });
  assert.equal(body.generationConfig.maxOutputTokens, 20);
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 }, 'pass-through wins');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseJsonSchema, { type: 'object' });
  const turns = prepareRequest({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
    params: { provider: 'gemini' } });
  assert.equal(geminiBody(turns).contents[1].role, 'model', 'assistant turns map onto the model role');
  const claude = anthropicBody(prepareRequest({ prompt: 'x', system: 's', params: { max_tokens: 9 } }),
    { type: 'object' }, true);
  assert.equal(claude.max_tokens, 9);
  assert.equal(claude.system, 's');
  assert.equal(claude.stream, true);
  assert.deepEqual(claude.output_config, { format: { type: 'json_schema', schema: { type: 'object' } } });
});

test('llm.chat via Gemini: request shape and the output contract', async () => {
  reset();
  responses.push(json(200, {
    candidates: [{ content: { parts: [{ text: 'Hello ' }, { text: 'there' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 }, modelVersion: 'gemini-flash-009'
  }));
  const reply = await po.request('llm.chat', { prompt: 'say hi', system: 'friendly',
    params: { provider: 'gemini', max_tokens: 30 } }, { timeoutMs: 5000 });
  assert.equal(reply.getStatus(), 200, String(reply.body));
  assert.deepEqual(reply.body, { text: 'Hello there', model: 'gemini-flash-009', stop_reason: 'STOP',
    usage: { input_tokens: 7, output_tokens: 2 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${GEMINI_API_BASE}/models/${LLM_DEFAULT_MODELS.gemini}:generateContent`);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'gemini-test-key');
  assert.equal(calls[0].body.generationConfig.maxOutputTokens, 30);
  assert.deepEqual(calls[0].body.systemInstruction, { parts: [{ text: 'friendly' }] });
  assert.equal(reply.annotations?.llm_model, 'gemini-flash-009', 'the model is annotated on the trace');
});

test('llm.chat structured output parses the schema-constrained JSON', async () => {
  reset();
  responses.push(json(200, {
    candidates: [{ content: { parts: [{ text: '{"label":"bug","reason":"crash"}' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
  }));
  const reply = await po.request('llm.chat', { prompt: 'classify', params: { provider: 'gemini' },
    schema: { type: 'object', properties: { label: { type: 'string' } } } }, { timeoutMs: 5000 });
  assert.equal(reply.getStatus(), 200, String(reply.body));
  assert.deepEqual(reply.body.data, { label: 'bug', reason: 'crash' });
  assert.equal(reply.body.text, undefined, 'a schema verdict is data, not text');
  assert.equal(calls[0].body.generationConfig.responseJsonSchema.additionalProperties, false,
    'a closed schema by default');
});

test('llm.chat via Anthropic: request shape and the output contract', async () => {
  reset();
  responses.push(json(200, { content: [{ type: 'text', text: 'Hi!' }], model: 'claude-opus-5-20260101',
    stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 1 } }));
  const reply = await po.request('llm.chat', { prompt: 'say hi', params: { max_tokens: 12 } }, { timeoutMs: 5000 });
  assert.equal(reply.getStatus(), 200, String(reply.body));
  assert.deepEqual(reply.body, { text: 'Hi!', model: 'claude-opus-5-20260101', stop_reason: 'end_turn',
    usage: { input_tokens: 4, output_tokens: 1 } });
  assert.equal(calls[0].url, `${ANTHROPIC_API_BASE}/messages`);
  assert.equal(calls[0].init.headers['x-api-key'], 'anthropic-test-key');
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].body.max_tokens, 12);
  assert.equal(calls[0].body.model, LLM_DEFAULT_MODELS.anthropic);
});

test('provider rejections ride the envelope status', async () => {
  reset();
  responses.push(json(429, { error: { message: 'quota exceeded' } }));
  const limited = await po.request('llm.chat', { prompt: 'x' }, { timeoutMs: 5000 });
  assert.equal(limited.getStatus(), 429);
  assert.match(String(limited.body), /LLM provider rate limit/);
  responses.push(json(500, 'boom'));
  const failed = await po.request('llm.chat', { prompt: 'x' }, { timeoutMs: 5000 });
  assert.equal(failed.getStatus(), 500);
  assert.match(String(failed.body), /LLM provider error - HTTP 500/);
  // no response scripted: the fake throws like a dead network
  const unreachable = await po.request('llm.chat', { prompt: 'x' }, { timeoutMs: 5000 });
  assert.equal(unreachable.getStatus(), 503);
  assert.match(String(unreachable.body), /LLM provider unreachable/);
  const bad = await po.request('llm.chat', { nothing: true }, { timeoutMs: 5000 });
  assert.equal(bad.getStatus(), 400);
});

test('llm.stream via Gemini relays each token batch and closes with the metadata', async () => {
  reset();
  responses.push(sse([
    [undefined, { candidates: [{ content: { parts: [{ text: 'Hello' }] } }], modelVersion: 'gemini-flash-009' }],
    [undefined, { candidates: [{ content: { parts: [{ text: ' world' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }]
  ]));
  const events = await collect({ prompt: 'greet', params: { provider: 'gemini' } }, { my_correlation_id: 'biz-7' });
  assert.equal(calls[0].url, `${GEMINI_API_BASE}/models/${LLM_DEFAULT_MODELS.gemini}:streamGenerateContent?alt=sse`);
  assert.equal(events.length, 3, '2 token batches + eof');
  assert.equal(streamSignal(events[0]), 'data');
  assert.equal(events[0].getStatus(), 200);
  assert.equal(events[0].headers['content-type'], 'text/event-stream');
  assert.equal(events[0].body, 'Hello');
  assert.equal(events[1].body, ' world');
  const eof = events[2];
  assert.equal(streamSignal(eof), 'eof');
  assert.equal(eof.body.model, 'gemini-flash-009');
  assert.equal(eof.body.stop_reason, 'STOP');
  assert.deepEqual(eof.body.usage, { input_tokens: 5, output_tokens: 2 });
  assert.equal(eof.body.language, 'node.js');
  assert.equal(eof.body.my_correlation_id, 'biz-7');
});

test('llm.stream via Anthropic speaks the same contract', async () => {
  reset();
  responses.push(sse([
    ['message_start', { type: 'message_start', message: { model: 'claude-opus-5-20260101', usage: { input_tokens: 3 } } }],
    ['content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }],
    ['content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: ' there' } }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
    ['message_stop', { type: 'message_stop' }]
  ]));
  const events = await collect({ prompt: 'greet' });
  assert.equal(calls[0].body.stream, true);
  assert.deepEqual(events.slice(0, 2).map((e) => e.body), ['Hi', ' there']);
  const eof = events[2];
  assert.equal(streamSignal(eof), 'eof');
  assert.equal(eof.body.model, 'claude-opus-5-20260101');
  assert.equal(eof.body.stop_reason, 'end_turn');
  assert.deepEqual(eof.body.usage, { input_tokens: 3, output_tokens: 2 });
});

test('llm.stream failures arrive in-band', async () => {
  reset();
  const bad = await collect({ nothing: true });
  assert.equal(bad.length, 1);
  assert.equal(streamSignal(bad[0]), 'exception');
  assert.equal(bad[0].getStatus(), 400);
  responses.push(json(401, { error: 'bad key' }));
  const rejected = await collect({ prompt: 'x', params: { provider: 'gemini' } });
  assert.equal(streamSignal(rejected[0]), 'exception');
  assert.equal(rejected[0].getStatus(), 401);
  assert.match(String(rejected[0].body?.message ?? rejected[0].body), /LLM provider error/);
});

test('a missing credential is a 503 that names the variable', async () => {
  reset();
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try {
    const reply = await po.request('llm.chat', { prompt: 'x', params: { provider: 'gemini' } }, { timeoutMs: 5000 });
    assert.equal(reply.getStatus(), 503);
    assert.match(String(reply.body), /GEMINI_API_KEY/);
  } finally {
    process.env.GEMINI_API_KEY = saved;
  }
  assert.equal(calls.length, 0, 'no request without a credential');
  assert.ok(EventEnvelope, 'envelope type available to tests');
});
