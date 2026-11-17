/**
 * The fakes the LLM helper's tests share: the SDK's stream and client under the shape of a
 * backend, the stream writer, a settings reader and a silent logger. test/llm-helper.test.mjs
 * (the contract) and test/transcript-audit.test.mjs (the audit store) import them.
 */
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { AppException } from 'mercury-composable';
import { backendFor } from '../../extensions/llm-helper/llm-helper.mjs';

export const NO_CREDENTIAL = 'Could not resolve authentication method. Expected one of apiKey, authToken, '
  + 'credentials, config, or profile to be set. Or for one of the "X-Api-Key" or "Authorization" '
  + 'headers to be explicitly omitted';

/** A real SDK error object, built the way the SDK builds one from a response. */
export function statusError(spec) {
  const headers = new Headers(spec.request_id ? { 'request-id': spec.request_id } : {});
  const body = { type: 'error', error: { type: spec.type, message: spec.message } };
  return Anthropic.APIError.generate(spec.status, body, undefined, headers);
}

/** What client.messages.stream(...) returns: async-iterable events, finalMessage(), request_id. */
export class FakeStream {
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
      // a loop turn's blocks (thinking, text, tool_use), else the one text block
      content: provider.content ? structuredClone(provider.content)
        : [{ type: 'text', text: provider.text ?? (provider.deltas ?? []).join('') }],
      model: provider.model,
      stop_reason: provider.stop_reason,
      usage: provider.usage,
      stop_details: provider.stop_details ?? null
    };
  }
}

export const delta = (text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });

/** The backend the helper holds: a client with two messages namespaces, and a ledger, under
 * the shape of the backend the case names (the Claude API by default). */
export function fakeBackend(provider, { supportsFallbacks, apiKey = 'test-credential', make, name = 'anthropic', api = 'mantle' } = {}) {
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
  const shape = backendFor(name, client, api);
  return { ledger, backend: supportsFallbacks === undefined ? shape : { ...shape, supportsFallbacks } };
}

export class FakeWriter {
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

export const settings = (config = {}) => (key, fallback) => config[key] ?? fallback;
export const silent = { info() {}, warn() {}, error() {} };
