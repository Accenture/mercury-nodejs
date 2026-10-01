/**
 * The LLM helper (examples/llm-helper/llm-helper.mjs) - token-free.
 *
 * One shared contract file, test/vectors/llm-helper-vectors.json (byte-identical in
 * mercury-python), drives every case below against a fake of the Anthropic SDK: the exact SDK
 * call, the reply map, the error contract and the streaming segments are pinned without
 * spending a token or needing a credential, and the Python twin runs the same file, so the two
 * helpers cannot drift apart. The tests after the vector runs pin what a vector cannot: token
 * batches are never held back, no prompt text reaches a log, the trace annotations, the health
 * route and the backend seam.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { AppException } from 'mercury-composable';
import {
  anthropicBackend, createLlmHelper, defaultBackend, failure
} from '../examples/llm-helper/llm-helper.mjs';

const VECTORS_FILE = new URL('./vectors/llm-helper-vectors.json', import.meta.url);
// the Python twin pins the same digest: change the file in both packs or in neither
const VECTORS_SHA256 = '1f4823d9259ed6ff26e96d044b5f6b3c7bc9b342cc8ad76047434c2d3a2b8fa0';
const VECTORS = JSON.parse(readFileSync(VECTORS_FILE, 'utf8'));
const CHAT_CASES = VECTORS.cases.filter((c) => c.route === 'llm.chat');
const STREAM_CASES = VECTORS.cases.filter((c) => c.route === 'llm.stream');

const NO_CREDENTIAL = 'Could not resolve authentication method. Expected one of apiKey, authToken, '
  + 'credentials, config, or profile to be set. Or for one of the "X-Api-Key" or "Authorization" '
  + 'headers to be explicitly omitted';

/** A real SDK error object, built the way the SDK builds one from a response. */
function statusError(spec) {
  const headers = new Headers(spec.request_id ? { 'request-id': spec.request_id } : {});
  const body = { type: 'error', error: { type: spec.type, message: spec.message } };
  return Anthropic.APIError.generate(spec.status, body, undefined, headers);
}

/** What client.messages.stream(...) returns: async-iterable events, finalMessage(), request_id. */
class FakeStream {
  constructor(provider, ledger, options) {
    this.provider = provider;
    this.ledger = ledger;
    this.options = options;
    this.request_id = undefined;
    this.opening = undefined;
  }

  /** Raises what the SDK raises on the first read, once. */
  ensureOpen() {
    this.opening ??= this.open();
    return this.opening;
  }

  async open() {
    const { kind } = this.provider;
    if (kind === 'hang') {
      await new Promise((resolve, reject) => {
        // AbortSignal.timeout() timers are unref'd, and a real server's listener keeps the
        // loop alive; this fake holds it open until the abort fires
        const keepAlive = setTimeout(() => {}, 10_000);
        const abort = () => {
          clearTimeout(keepAlive);
          this.ledger.cancelled = true;
          reject(new Anthropic.APIUserAbortError());
        };
        if (this.options.signal?.aborted) {
          abort();
        } else {
          this.options.signal?.addEventListener('abort', abort, { once: true });
        }
      });
    }
    if (kind === 'credential') {
      throw new Anthropic.AnthropicError(NO_CREDENTIAL);
    }
    if (kind === 'timeout') {
      throw new Anthropic.APIConnectionTimeoutError();
    }
    if (kind === 'connection') {
      throw new Anthropic.APIConnectionError({ message: 'Connection error.' });
    }
    if (kind === 'status' && !this.provider.after) {
      throw statusError(this.provider);
    }
    this.request_id = this.provider.request_id ?? null;
  }

  async* [Symbol.asyncIterator]() {
    await this.ensureOpen();
    const deltas = this.provider.deltas ?? [];
    const after = this.provider.after ?? 0;
    for (const [index, text] of deltas.entries()) {
      if (this.provider.kind === 'status' && index === after) {
        throw statusError(this.provider);
      }
      yield delta(text);
    }
    if (this.provider.kind === 'status' && after >= deltas.length) {
      throw statusError(this.provider);
    }
  }

  async finalMessage() {
    await this.ensureOpen();
    const { provider } = this;
    return {
      content: [{ type: 'text', text: provider.text ?? (provider.deltas ?? []).join('') }],
      model: provider.model,
      stop_reason: provider.stop_reason,
      usage: provider.usage,
      stop_details: provider.stop_details ?? null
    };
  }
}

const delta = (text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });

/** The backend the helper holds: a client with two messages namespaces, and a ledger. */
function fakeBackend(provider, { supportsFallbacks = true, apiKey = 'test-credential', make } = {}) {
  const ledger = { calls: [], cancelled: false };
  const namespace = (name) => ({
    stream(params, options) {
      ledger.calls.push({ namespace: name, params, options });
      return make ? make(provider, ledger, options) : new FakeStream(provider ?? {}, ledger, options);
    }
  });
  const client = {
    apiKey, authToken: null, credentials: null, messages: namespace('messages'),
    beta: { messages: namespace('beta.messages') }
  };
  return { ledger, backend: { ...anthropicBackend('anthropic', client), supportsFallbacks } };
}

class FakeWriter {
  head = null;
  segments = [];
  trailing = null;
  error = null;

  first(status, contentType) {
    this.head = [status, contentType];
  }

  write(segment) {
    this.segments.push(segment);
  }

  close(trailing) {
    this.trailing = trailing;
  }

  fail(error) {
    assert.ok(error instanceof AppException, String(error));
    this.error = error;
  }
}

const settings = (config = {}) => (key, fallback) => config[key] ?? fallback;
const silent = { info() {}, warn() {} };

function helperFor(c, extra = {}) {
  const { backend, ledger } = fakeBackend(c.provider, extra.backendOptions);
  const out = new FakeWriter();
  const helper = createLlmHelper({
    prop: settings(c.config), backend: () => backend, writer: () => out, log: silent,
    trace: () => {}, ...extra.deps
  });
  return { helper, ledger, out, backend };
}

function assertSdk(ledger, c) {
  const wanted = c.expect.sdk;
  if (wanted) {
    assert.equal(ledger.calls.length, 1);
    const [call] = ledger.calls;
    assert.equal(call.namespace, wanted.namespace);
    assert.deepEqual(call.params, wanted.params);
    assert.deepEqual({ timeout_ms: call.options.timeout, max_retries: call.options.maxRetries },
      wanted.options);
  } else if (c.provider === undefined) {
    assert.equal(ledger.calls.length, 0, 'a rejected request must not reach the provider');
  }
}

function assertError(error, wanted) {
  assert.ok(error instanceof AppException, 'an AppException was expected');
  assert.equal(error.status, wanted.status, error.message);
  for (const fragment of wanted.message_contains) {
    assert.ok(error.message.includes(fragment), `${JSON.stringify(fragment)} not in ${JSON.stringify(error.message)}`);
  }
}

// --- the shared contract: llm.chat -------------------------------------------------------

test('the vector file is the one the python twin runs', () => {
  const digest = createHash('sha256').update(readFileSync(VECTORS_FILE)).digest('hex');
  assert.equal(digest, VECTORS_SHA256, 'the shared vector file changed - update both packs');
  assert.equal(VECTORS.contract, 'llm-helper');
  assert.equal(VECTORS.version, 1);
  assert.equal(CHAT_CASES.length + STREAM_CASES.length, VECTORS.cases.length);
});

for (const c of CHAT_CASES) {
  test(`chat contract: ${c.name}`, async () => {
    const { helper, ledger } = helperFor(c);
    let result;
    let error;
    try {
      result = await helper.chat({}, c.body);
    } catch (e) {
      assert.ok(e instanceof AppException, String(e));
      error = e;
    }
    assertSdk(ledger, c);
    if (c.expect.error) {
      assertError(error, c.expect.error);
    } else {
      assert.equal(error, undefined, error?.message);
      assert.deepEqual(result, c.expect.result);
    }
  });
}

// --- the shared contract: llm.stream -----------------------------------------------------

for (const c of STREAM_CASES) {
  test(`stream contract: ${c.name}`, async () => {
    const { helper, ledger, out } = helperFor(c);
    await helper.stream(c.headers ?? {}, { body: c.body });
    const { expect } = c;
    assertSdk(ledger, c);
    assert.deepEqual(out.head, expect.head ?? null);
    assert.deepEqual(out.segments, expect.frames ?? []);
    if (expect.terminal) {
      assert.ok(out.trailing, 'the stream must close with trailing metadata');
      for (const [key, value] of Object.entries(expect.terminal)) {
        assert.deepEqual(out.trailing[key], value, key);
      }
      assert.equal(out.trailing.language, 'node.js');
    } else {
      assert.equal(out.trailing, null);
    }
    if (expect.error) {
      assertError(out.error, expect.error);
    } else {
      assert.equal(out.error, null, out.error?.message);
    }
  });
}

// --- progressive rendering: a token batch is never held back -----------------------------

test('each token batch reaches the caller before the next is produced', async () => {
  // The point of the streaming route is to deliver batches continuously. The fake model
  // produces batch k only after asserting that the caller already holds batches 0 to k-1 - a
  // helper that gathered the batches and sent them once would fail this test.
  const batches = ['Event-', 'driven ', 'architecture ', 'decouples ', 'producers.'];
  const out = new FakeWriter();
  class Paced extends FakeStream {
    async* [Symbol.asyncIterator]() {
      for (const [index, text] of batches.entries()) {
        assert.deepEqual(out.segments, batches.slice(0, index), `batch ${index} was produced early`);
        assert.equal(out.head !== null, index > 0, 'the head rides the first batch');
        await new Promise((resolve) => { setImmediate(resolve); }); // a network read yields to the loop
        yield delta(text);
      }
    }
  }
  const provider = {
    kind: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn', deltas: batches,
    usage: { input_tokens: 9, output_tokens: 11 }
  };
  const { backend } = fakeBackend(provider, { make: (p, l, o) => new Paced(p, l, o) });
  const helper = createLlmHelper({
    prop: settings(), backend: () => backend, writer: () => out, log: silent, trace: () => {}
  });
  await helper.stream({}, { body: { prompt: 'describe it' } });
  assert.equal(out.error, null, out.error?.message);
  assert.deepEqual(out.segments, batches, 'every batch is its own segment');
  assert.deepEqual(out.head, [200, 'text/event-stream']);
  assert.deepEqual(out.trailing.usage, { input_tokens: 9, output_tokens: 11 });
});

test('the chat route sends nothing to a stream writer', async () => {
  const provider = {
    kind: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn', deltas: ['a', 'b'],
    usage: { input_tokens: 1, output_tokens: 2 }
  };
  const { helper, out } = helperFor({ provider });
  const result = await helper.chat({}, { prompt: 'x' });
  assert.equal(result.text, 'ab');
  assert.deepEqual(out.segments, []);
  assert.equal(out.head, null);
});

// --- what a vector cannot say -------------------------------------------------------------

test('llm.chat carries a deadline signal and llm.stream does not', async () => {
  const provider = {
    kind: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn', deltas: ['ok'],
    usage: { input_tokens: 1, output_tokens: 1 }
  };
  const chat = helperFor({ provider });
  await chat.helper.chat({}, { prompt: 'x' });
  assert.ok(chat.ledger.calls[0].options.signal instanceof AbortSignal);
  const streaming = helperFor({ provider });
  await streaming.helper.stream({}, { body: { prompt: 'x' } });
  assert.equal(streaming.ledger.calls[0].options.signal, undefined,
    'a stream runs as long as tokens flow: no total deadline');
});

test('the deadline cancels the provider call', async () => {
  const { helper, ledger } = helperFor({ provider: { kind: 'hang' } });
  await assert.rejects(helper.chat({}, { prompt: 'x', params: { timeout_ms: 30 } }),
    (error) => error instanceof AppException && error.status === 408);
  assert.ok(ledger.cancelled, 'the abandoned call must be cancelled, not left running');
});

test('neither the prompt nor the reply reaches a log', async () => {
  const lines = [];
  const log = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const provider = {
    kind: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn', deltas: ['REPLY-MARKER-9023'],
    usage: { input_tokens: 7, output_tokens: 5 }, request_id: 'req_log_001'
  };
  const { helper } = helperFor({ provider }, { deps: { log } });
  await helper.chat({}, { prompt: 'PROMPT-MARKER-4471', system: 'SYSTEM-MARKER-1188' });
  await helper.stream({}, { body: { prompt: 'PROMPT-MARKER-4471' } });
  const text = lines.join('\n');
  assert.ok(text.includes('llm.chat model=claude-opus-5-5'));
  assert.ok(text.includes('llm.stream model=claude-opus-5-5'));
  assert.ok(text.includes('request_id=req_log_001'));
  for (const marker of ['PROMPT-MARKER-4471', 'REPLY-MARKER-9023', 'SYSTEM-MARKER-1188']) {
    assert.ok(!text.includes(marker), `${marker} reached a log`);
  }
});

test('batch timing is logged when asked, and never the text', async () => {
  const lines = [];
  const log = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const provider = {
    kind: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn',
    deltas: ['alpha-MARKER-1', 'beta-MARKER-2', 'gamma'], usage: { input_tokens: 3, output_tokens: 9 }
  };
  const { helper } = helperFor({ provider, config: { 'llm.log.batches': 'true' } }, { deps: { log } });
  await helper.stream({}, { body: { prompt: 'x' } });
  const batches = lines.filter((line) => line.includes('llm.stream batch='));
  assert.equal(batches.length, 3, batches.join('\n'));
  assert.match(batches[0], /^llm\.stream batch=1 chars=14 t_ms=\d+$/);
  assert.match(batches[2], /^llm\.stream batch=3 chars=5 t_ms=\d+$/);
  assert.ok(!lines.join('\n').includes('MARKER'));
});

test('batch timing is off by default', async () => {
  const lines = [];
  const log = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const provider = {
    kind: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn', deltas: ['a', 'b'],
    usage: { input_tokens: 1, output_tokens: 2 }
  };
  const { helper } = helperFor({ provider }, { deps: { log } });
  await helper.stream({}, { body: { prompt: 'x' } });
  assert.ok(!lines.join('\n').includes('llm.stream batch='));
});

test('usage rides the trace annotations', async () => {
  const seen = {};
  const provider = {
    kind: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn', deltas: ['ok'],
    usage: { input_tokens: 20, output_tokens: 4 }, request_id: 'req_trace_001'
  };
  const { helper } = helperFor({ provider }, { deps: { trace: (key, value) => { seen[key] = value; } } });
  await helper.chat({}, { prompt: 'x' });
  assert.deepEqual(seen, {
    llm_model: 'claude-opus-5-5', llm_stop_reason: 'end_turn', llm_input_tokens: '20',
    llm_output_tokens: '4', llm_request_id: 'req_trace_001'
  });
});

for (const [model, getsFallbacks] of [
  ['claude-opus-5-5', true], ['claude-opus-5', true], ['claude-fable-5-1', true],
  ['claude-sonnet-5-5', true], ['claude-sonnet-5', false], ['claude-opus-4-8', false],
  ['claude-haiku-4-5', false]
]) {
  test(`refusal fallbacks for ${model}: ${getsFallbacks}`, () => {
    const { helper, backend } = helperFor({});
    const request = helper.prepare({ prompt: 'x', params: { model } }, { streaming: false });
    const { namespace, params } = helper.plan(request, backend, { deadline: false });
    assert.equal(namespace === 'beta.messages', getsFallbacks);
    assert.equal('fallbacks' in params, getsFallbacks);
    assert.equal('betas' in params, getsFallbacks);
  });
}

test('a route without server-side fallbacks never sends them', () => {
  const { helper, backend } = helperFor({}, { backendOptions: { supportsFallbacks: false } });
  const request = helper.prepare({ prompt: 'x' }, { streaming: false });
  const { namespace, params } = helper.plan(request, backend, { deadline: false });
  assert.equal(namespace, 'messages');
  assert.equal('fallbacks' in params, false);
});

test('a backend can spell the model id its own way', () => {
  // the seam for a second route to the models: its model ids may carry a prefix
  const { helper, backend } = helperFor({});
  const prefixed = { ...backend, providerModel: (model) => `anthropic.${model}` };
  const request = helper.prepare({ prompt: 'x' }, { streaming: false });
  const { params } = helper.plan(request, prefixed, { deadline: false });
  assert.equal(params.model, 'anthropic.claude-opus-5-5');
});

test('the SDK failures map to the portable error contract', () => {
  assert.equal(failure(new Anthropic.APIUserAbortError(), 25).status, 408);
  assert.equal(failure(new Anthropic.APIConnectionTimeoutError(), 25).status, 408);
  assert.equal(failure(statusError({ status: 429, type: 'rate_limit_error', message: 'x' }), 25).status, 429);
  assert.equal(failure(new Error('something else entirely'), 25), undefined);
});

// --- the health route and the backend seam -----------------------------------------------

test('health reports the backend and the model', async () => {
  const { helper } = helperFor({});
  const info = await helper.health({ type: 'info' });
  assert.equal(info.service, 'llm.helper');
  assert.equal(info.backend, 'anthropic');
  assert.equal(info.model, 'claude-opus-5-5');
});

test('health is up when a credential is present', async () => {
  const { helper } = helperFor({});
  assert.equal(await helper.health({ type: 'health' }), 'llm.helper is running fine');
});

test('health is down without a credential', async () => {
  const { helper } = helperFor({}, { backendOptions: { apiKey: null } });
  await assert.rejects(helper.health({ type: 'health' }),
    (error) => error instanceof AppException && error.status === 503
      && error.message.includes('credential missing'));
});

test('the real client reports a credential it was given', () => {
  const backend = anthropicBackend('anthropic', new Anthropic({ apiKey: 'test-credential' }));
  assert.equal(backend.credentialProblem(), undefined);
});

test('an unknown backend is a 501 that names what is served', () => {
  const build = defaultBackend((key, fallback) => (key === 'llm.backend' ? 'bedrock' : fallback));
  assert.throws(build, (error) => error instanceof AppException && error.status === 501
    && error.message.includes("unknown LLM backend 'bedrock'")
    && error.message.includes('this helper serves: anthropic'));
});

test('the default backend is the Anthropic client, built once', () => {
  const build = defaultBackend((key, fallback) => fallback);
  const backend = build();
  assert.equal(backend.name, 'anthropic');
  assert.equal(backend.supportsFallbacks, true);
  assert.ok(backend.client instanceof Anthropic);
  assert.equal(build(), backend, 'the client is built once');
});
