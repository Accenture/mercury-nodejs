# Continuity — mercury-nodejs

> Shared ground truth for project state across all agents and sessions.
> Update at the end of every session. Never delete — only archive (see `REVIEW.md`).
>
> Each fact carries a metadata footer in an HTML comment, maintained by the review
> ritual — invisible when rendered, read/written by agents:
> `<!-- id: kebab-id | created: YYYY-MM-DD | last_used: YYYY-MM-DD | uses: N | tier: active -->`
> See `.agent/schema.md` for the fields and `memory/decay-policy.md` for the windows.

---

## Project State

- **project:** mercury-nodejs (npm: `mercury-composable`)
- **status:** **v4.12.21 TAGGED 2026-10-07 (PR #110 merge `80d4889`, tag `v4.12.21` → `279e784` one memory commit past it, the version
  at the tag, the GitHub release published 02:36:40Z, CI green on the tag commit; the npm publication is Eric's next step - pending, not
  verified)** · **v4.12.15 on npm (published 2026-09-23 02:34Z; `npm install mercury-composable`; tag `v4.12.15` → `4c43ffe`, PR #105
  merge `13426732`, GitHub release 01:39Z — the lock-step round with both engines, adopting the Java number; the 4.12.15 line adds
  the OpenTelemetry forwarder (opt-in, no SDK), the `llm.chat`/`llm.stream` AI nodes and the SERVER-iff-`http.request` span-kind
  rule)**; Event-over-HTTP function host + thin client; engines own orchestration.
- **last_enabled:** 2026-08-22
- **last_review:** 2026-09-23 | through 2026-09-23-004556.md (cadence — 11 sessions since; archived 1 faded fact
  `stack-mercury-serve-node` + swept 5 completed threads past `archive_window` → 2026-Q3; tier changes via `refresh-metadata`;
  invariants not due (29 sessions, cadence 40, none yet); stalled none — no unchecked thread). Prior: 2026-09-05 | through 2026-09-05-210103
- **last_invariant_check:** (none yet)
- **repo:** ~/sandbox/mercury-nodejs (origin: github.com/Accenture/mercury-nodejs)

## Stack & Tools

> Canonical live home for the current stack — language version, dependencies, tool
> versions. `instructions.md` keeps only a high-level descriptor and points here.

- TypeScript ^5.6 (devDeps `typescript` + `@types/node` ^22), Node.js ≥ 20 (`engines`),
  compiled to `dist/` (ESM); npm package `mercury-composable` v4.12.15 (2026-09-23; the first publication v4.12.1 was
  2026-09-01; engine lock-step version line; build copies default-log-context.yaml
  into dist/src); scripts: `build`, `test`, `prepack`
  <!-- id: stack-typescript-esm | created: 2026-08-22 | last_used: 2026-09-22 | uses: 5 | tier: active | origin: 2026-08-22-171916 -->
- Runtime deps: `@msgpack/msgpack` (envelope codec), `yaml` (config) — deliberately minimal; dev dependency
  `@anthropic-ai/sdk` (the LLM helper app's SDK and the tests' error classes; the published package stays free of any
  LLM SDK — 2026-10-01, PR #106)
  <!-- id: stack-deps-msgpack-yaml | created: 2026-08-22 | last_used: 2026-09-22 | uses: 2 | tier: active | origin: 2026-08-22-171916 -->
## Architectural Invariants

> Hard constraints that must never change. These never decay (treated as `core`).

- **Wrapper only — no orchestration.** This package intentionally contains no flows, no
  graphs, no persistence and no pub/sub broadcast; orchestration lives in the Mercury
  engines. It provides functions, the primitive in-process event bus (route mailboxes +
  workers — dispatch, not orchestration; ratified 2026-08-23), and minimalist foundation
  utilities (README "Scope", amended with the bus).
  <!-- id: scope-wrapper-no-orchestration | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: core | origin: 2026-08-22-171916 -->
- **Standard wire format, proven by shared vectors.** The codec implements the standard
  event-envelope wire format, verified against the golden conformance vectors shared with
  the Java and Rust engines; the classic compact format is detected and rejected with a
  teaching error. **Int64 values beyond 2^53 are kept exact as BigInt** — never silently
  rounded to a JS number (CHANGELOG 0.1.0).
  <!-- id: wire-standard-golden-vectors-bigint | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: core | origin: 2026-08-22-171916 -->
- **Engine-consistent conventions.** Config keys, `${ENV_VAR:default}` substitution, `-D`
  runtime overrides, `resources/` layout, and the reference log presentation mirror the
  engines so a polyglot installation stays uniform — divergence here is a bug, not a style
  choice. Event API semantics mirror EventApiService (x-ttl bound, x-async 202
  drop-n-forget, reserved-header hygiene, engine-identical error messages).
  <!-- id: engine-consistent-conventions | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: core | origin: 2026-08-22-171916 -->
- **Functions are stateless.** Anything a handler must keep belongs to the caller's flow
  model or state machine; intentional errors travel as `AppException(status, message)` —
  the portable error contract.
  <!-- id: stateless-functions-contract | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: core | origin: 2026-08-22-171916 -->

## Key Decisions

- **Polyglot reboot (August 2026):** instead of re-porting the full composable foundation
  to Node.js, the fresh start rides the engines' Event-over-HTTP protocol — light by
  design; the previous port (≤ v4.3.28) remains in git history only (CHANGELOG 0.1.0).
  <!-- id: decision-polyglot-reboot | created: 2026-08-22 | last_used: 2026-09-05 | uses: 3 | tier: archive-candidate | origin: 2026-08-22-171916 -->
- **Consumer fork → `system/AGENTS.md` (2026-09-01):** root `AGENTS.md` routes contributors
  to `memory/PROTOCOL.md` and consumers to `system/AGENTS.md` (family pattern with the
  engine repos). README remains the human quick start.
  <!-- id: decision-consumer-fork-system-agents | created: 2026-09-05 | last_used: 2026-09-05 | uses: 1 | tier: archive-candidate | origin: 2026-09-05-205441 | supersedes: decision-consumer-fork-readme -->
- **First npm publication (2026-09-01):** `mercury-composable` v4.12.1 is live; the name
  was a fully-unpublished third-party tombstone (burned versions 3.4.3 / 5.0.8 / 5.0.9);
  Accenture 4.3.x never lived on the public registry under this name.
  <!-- id: decision-npm-first-publish-4-12-1 | created: 2026-09-05 | last_used: 2026-09-05 | uses: 1 | tier: archive-candidate | origin: 2026-09-05-205441 -->

- **The OpenTelemetry forwarder is a zero-dependency port of the Rust engine's hand-written OTLP encoder, attached
  at the engines' extension route (Eric, 2026-09-22; the mercury-python twin merged the same day).** `src/otel/`
  (the `otel` namespace): with `otel.forwarding=true` the bus routes every emitted trace dataset to
  `distributed.trace.forwarder` through the registry's envelope router — WITHOUT a trace, so the forwarder's own
  execution emits none — and the built-in forwarder (private, two workers; an application's own function on the
  route wins) maps it to one span with the host's exact W3C ids and exports it over OTLP/HTTP protobuf through the
  runtime's `fetch`, retrying transport failures and 408/429/502/503/504 on the SDK backoff and re-reading the
  credential headers per export. Same `otel.*` keys as Java/Rust/Python; deltas: `otel.exporter.otlp.connect.timeout`
  has no effect (one overall fetch timeout), scope `mercury-composable-nodejs`. Rejected: the OTel SDKs as an
  optional dependency (~ten packages against this package's two). Shipped: PR #101, merge `586c3f63` (2026-09-22).
  **Kind rule since 2026-09-22 (PR #104 MERGED, `5569357c`):** SERVER iff the record's `service` is `http.request` — an
  engine edge's round-trip record — and every function execution is INTERNAL; a record's `from` no longer decides the kind
  (the engines' connected-span-tree fix, mercury-composable/mercury `fix/connected-edge-spans`).
  <!-- id: otel-forwarder-nodejs | created: 2026-09-22 | last_used: 2026-09-22 | uses: 2 | tier: active | origin: 2026-09-22-165807 -->

- **The LLM helper is a dedicated function host on the Anthropic SDK: the engines stay LLM-free, the AI node is a bounded
  function, and one contract is proven by a vector file shared with the Python pack (Eric's rulings, 2026-10-01; PR #106, merge
  `d9adcae6`).** `examples/llm-helper/llm-helper.mjs` serves `llm.chat` (one answer, optional JSON-schema structured output
  returned as `data`), `llm.stream` (the model's token batches over the multi-shot reply contract) and `llm.health` (a credential
  check, no network traffic); it imports `mercury-composable` by name, so the same file runs from a copy outside the repository
  (verified against the packed package). Claude only: `examples/llm-nodes.mjs` (provider REST through `fetch`) and the Gemini
  provider are gone (the contract stays provider-neutral through `params.provider`, which accepts only `anthropic`). Default model
  `claude-opus-5-5` (`llm.model`), server-side refusal fallbacks on (`llm.fallbacks=off`), and a backend seam (`defaultBackend()`,
  `anthropicBackend()`) for the planned AWS Bedrock route (`llm-helper-bedrock-iam`). **The contract:** a `params` allowlist
  (`provider`, `model`, `max_tokens`, `timeout_ms`, `effort`, `stop_sequences`; anything else is a 400 and no sampling parameter is
  forwarded), a schema on `llm.stream` is a 400, **a reply that carries nothing usable is a 422 and never an empty success**, and
  every failure is an `AppException` whose message the Python twin repeats. **Progressive rendering is never buffered** (Eric's
  requirement): each batch leaves as its own segment the moment it arrives, a test pins it (the fake model refuses batch k until the
  caller holds batches 0..k-1), and the certified drives showed the helper and both engines add nothing (batches equal frames,
  4-10 ms offset). The cadence a viewer sees is the API's and depends on the model (Haiku 4.5 about 25 ms continuous, Sonnet 5.5
  about 350 ms bursts, Opus 5.5 about 600 ms bursts). **Opus 5.5 thinks first and thinking tokens count against `max_tokens`:** a
  few hundred can end with no text (the 422), so the engines' demos ask for 2000, the helper's default is 16000, and Haiku
  (`llm.model: claude-haiku-4-5`) is the documented choice for smooth rendering; the default STAYS Opus (Eric, 2026-10-01).
  **Proof:** `test/vectors/llm-helper-vectors.json` (byte-identical in mercury-python, 63 cases against SDK fakes) plus
  `test/llm-helper.test.mjs` (88 tests; the fake holds the event loop open, because `AbortSignal.timeout` timers are unref'd), and a
  live certification through the Java and Rust engines (`docs/test-reports/llm-helper-certification.md`: 124 model calls, every
  batch its own frame, every trace one tree). The Node SDK raises a plain `Error` (an `AnthropicError` on a stream) for a missing
  credential, before anything is sent; the helper maps it to a 503 by its text. No prompt or completion text reaches a log.
  <!-- id: llm-helper-app | created: 2026-10-01 | last_used: 2026-10-01 | uses: 1 | tier: working | origin: 2026-10-02-001255 -->

## Conventions

- Engine-mirrored configuration/logging/trace conventions (see the invariant above and
  `instructions.md`); GitHub flow with tests + a CHANGELOG entry per change
  (CONTRIBUTING.md).
  <!-- id: conv-github-flow-changelog | created: 2026-08-22 | last_used: 2026-09-22 | uses: 3 | tier: active | origin: 2026-08-22-171916 -->
- **Each example app lives in a folder of its own, with a README and its own `resources/` (Eric, 2026-10-01; PR #106).**
  `examples/demo-app/` (the minimal polyglot app: `hello.node`, `hello.declarative`, `hello.chain`, `hello.tokens`, the private
  `demo.suffix.helper` and `demo.health`) and `examples/llm-helper/`; run one as
  `node dist/src/cli.js examples/<app>/<file>.mjs` (the sample config is read from the `resources` folder next to the app file).
  The Python pack mirrors the layout (and keeps a `hello.sync.chain` that JavaScript has no need of). The demo and the helper
  share the default port 8087, so give one of them another with `-Drest.server.port` to run both. The demo stays provider-free and
  credential-free: no LLM code goes into it.
  <!-- id: examples-one-folder-per-app | created: 2026-10-01 | last_used: 2026-10-01 | uses: 1 | tier: working | origin: 2026-10-02-001255 -->

## Open Threads

> Open Threads live **one per file** in `memory/open-threads/` (`thread-<id>.md`;
> filename = the thread's fact id) so concurrent thread work never merge-conflicts
> (v4.39.0). List that directory to see them; unchecked `- [ ]` threads are the live
> workstreams and never decay. Mark a completed thread `- [x]` in its file and leave
> it — the review sweeps it to the archive once older than `archive_window` sessions.
> Don't archive by hand. See `.agent/schema.md`.


## User Preferences

(none recorded yet — record ONLY what the user explicitly states; never infer)

## Team / Members

(none recorded yet)
