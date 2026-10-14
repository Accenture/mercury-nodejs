---
title: Test Report — The LLM helper in the Node.js host
summary: This pack's view of the live LLM helper certification of 2026-10-01 - the Node.js helper
  (llm.chat, llm.stream, llm.health on the Anthropic SDK) behind the Java and Rust engines with real
  Claude calls - the token-free proof, the live results, and what the Node.js SDK needed.
layer: reference
audience: [developer, architect]
keywords: [llm helper, llm.chat, llm.stream, claude, anthropic, streaming, certification, test report]
---

# Test Report — The LLM helper in the Node.js host

*This pack's view of the live certification of 2026-10-01 (UTC). The full report — all four engine and host
pairs, the three layers, the progressive-rendering evidence and the findings — is the
[engine report](https://accenture.github.io/mercury-composable/test-reports/llm-helper-certification/), which the
Rust engine's docs carry too. The helper is
[`examples/llm-helper`](https://github.com/Accenture/mercury-nodejs/tree/main/examples/llm-helper); its README holds the contract.*

## Verified without a credential

- **88 helper tests, no token spent** (the whole suite: 182). `test/llm-helper.test.mjs` runs a fake of the Node.js SDK
  that builds the SDK's own error objects, so the status codes and messages are the real ones.
- **One contract, shared with the Python twin.** `test/vectors/llm-helper-vectors.json` is byte-identical in both packs (SHA-256 `1f4823d9…8fa0`, pinned by
  a test in each) and holds 63 cases: 22 request validations, 29 chat outcomes and 12 stream outcomes, each fixing the exact SDK
  call, the reply or the error, and the segments. A change that drifts one helper away from the other fails a case.
- **The tests can fail.** A helper mutated to gather the token batches and send them at the end fails the sentinel test (the
  fake model refuses to produce batch *k* until the caller holds batches 0 to *k*-1) and the vector for tokens delivered before a
  mid-stream error; a helper whose default model is changed fails 13 cases. The unmutated helper passes all of them.
- **Static checks:** `npm test` (build and every suite) 182 passed; `@anthropic-ai/sdk` is a dev dependency, so the published package keeps its two runtime dependencies.

## Verified live

Behind the Java engine and behind the Rust engine, the Node.js helper answered every scenario: 40 results per pair and no
failed check, across a streaming service (Layer 1), an Event Script flow (Layer 2) and two graphs (Layer 3), on
`claude-opus-5-5` and, where a request named it, `claude-haiku-4-5`.

| Progressive stream | Helper batches | Edge frames | Offset, median / spread | Longest gap |
|---|---|---|---|---|
| Java → Node.js, Opus 5.5 | 51 | 51 | 11 / 5 ms | 924 / 925 ms |
| Java → Node.js, Haiku 4.5 | 81 | 81 | 10 / 6 ms | 181 / 178 ms |
| Rust → Node.js, Opus 5.5 | 55 | 55 | 5 / 5 ms | 1125 / 1124 ms |
| Rust → Node.js, Haiku 4.5 | 96 | 96 | 3 / 4 ms | 303 / 302 ms |

Every batch the helper forwarded reached the engine's HTTP edge as its own frame, within a few milliseconds and without drift:
nothing is gathered or sent once. The long gaps are the API's own pacing, the same at both ends; Haiku 4.5 streams continuously
(a batch about every 25 ms) while Opus 5.5 arrives in bursts about every 600 ms. Credential states, measured on the real SDK:
an invalid key gave Anthropic's 401 with its request id through Rust on all three layers and through Java on the graph, and no credential gave 503 when this pack's helper was called directly. The same message came from both helpers, through every layer. All traces that touched this helper rebuild
as one connected tree.

## Verified live on AWS Bedrock (2026-10-14)

The helper's second backend (`llm.backend: 'bedrock'`), driven against an enterprise AWS account in `us-east-1` with temporary IAM
credentials - a key pair and a session token - in the helper's environment and no vendor key anywhere. Negative controls first.

| Step | Result |
|---|---|
| A corrupted secret | `401 LLM provider error - 401 authentication_error: The request signature we calculated does not match ...` |
| No credential at all | health `503 AWS credential missing`; the call the same 503 |
| `llm.chat`, Haiku 4.5 | `200`, `ready`, 14 input / 4 output tokens |
| `llm.chat` with a schema | `{"verdict": "bug", "confidence": 0.95}`, 218 / 17 |
| `llm.stream` | 4 batches, the first after 714 ms, `eof` with usage 20 / 23 |
| Java engine, the shipped `support-triage` graph | `question` → `answered`, 242 / 24 |
| Java engine, the streaming relay | 4 `data` frames, then `done` with usage, the trace id and the correlation id |

Every call ran on `us.anthropic.claude-haiku-4-5-20251001-v1:0` through the classic runtime surface (`llm.aws.api: 'runtime'`): the
account was enabled for that surface and not for the Anthropic-shaped one the SDK prefers, and for Haiku 4.5 and not for the newer
model generation. The full account of the surfaces and the gates is Finding 7 of the
[engine report](https://accenture.github.io/mercury-composable/test-reports/llm-helper-certification/).

## What the Node.js SDK needed on Bedrock

- **The Bedrock clients are a package of their own**, `@anthropic-ai/bedrock-sdk` (`AnthropicBedrockMantle`, `AnthropicBedrock`),
  imported only when the backend is selected, so the Claude API backend starts without it and the backend builds asynchronously.
- **An empty credential chain is the chain's own `CredentialsProviderError`**, as thrown or as the cause of the SDK's connection
  error; the helper maps either to `503 AWS credential missing`. The health check resolves `fromNodeProviderChain` the way a call
  would, so a probe tells a missing credential from a present one without spending a token.
- **The classic client would quietly fall back to `us-east-1`** when no region is named; the helper names the gap instead
  (`503 AWS region missing`), the same answer the Anthropic-shaped client gives by itself.
- **A Bedrock API key is held as the classic client's auth token**, so the health check counts either field as a credential.
- **The reply carries no request id:** Bedrock sends no `request-id` header the helper reads.

## What the Node.js SDK needed

- **No credential is not an API error.** `@anthropic-ai/sdk` raises a plain `Error` (an `AnthropicError` on a stream) before anything
  is sent, so the helper maps it by its text to a 503 `LLM provider credential missing - set ANTHROPIC_API_KEY in the environment`.
  `llm.health` reports it from the client's `apiKey`, `authToken` and `credentials`, with no network traffic.
- **A typed error carries what the message needs.** `status`, `type`, `requestID` and the parsed body; its own `message` wraps the raw JSON,
  so the helper builds the same `{status} {type}: {message} (request_id …)` text as the Python helper from the structured fields.
- **A stream exposes `request_id`**, read after `finalMessage()`; every reply and terminal event carries it.
- **The deadline is an abort signal** (`AbortSignal.timeout`) passed with the request, so the SDK cancels the call; a stream gets none,
  because `timeout_ms` is its idle allowance. A test fake that waits on the signal must hold the event loop open itself: those timers
  are unref'd, which a running server never notices.
- **The types still carry sampling parameters**, but the current models reject them, so the contract refuses them, as in the Python helper.
  `fallbacks: 'default'` is typed on the beta namespace and the API accepted it on Opus 5.5.

## Reproduce

```bash
npm install && npm run build
node --test test/llm-helper.test.mjs                          # token-free
export ANTHROPIC_API_KEY=...                                  # live: the credential reaches the helper only
node dist/src/cli.js examples/llm-helper/llm-helper.mjs -Dlog.format=compact -Dllm.log.batches=true
```

The commands for the engines, the deploy folder and the `curl` calls for each layer are in the
[engine report](https://accenture.github.io/mercury-composable/test-reports/llm-helper-certification/#reproduce).
