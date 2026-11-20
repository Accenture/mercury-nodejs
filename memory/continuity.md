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
- **status:** **4.12.30 PUBLISHED to npm 2026-11-16 and VERIFIED** (PR #125 merge `0591f15`, the tag `v4.12.30` on the merge
  commit, the GitHub release 09:11:45Z as Latest, CI green on the tag commit; published 09:28:42Z as `latest`, the tarball on
  the CDN at 09:33:48Z with the registry's sha1 and sha512; all 44 published files identical to a build of the tag from
  `git archive` - the 41 compiled files - and to the tag commit - `package.json`, README, LICENSE; two runtime dependencies,
  no LLM or MCP SDK). The 4.12.30 line carries the pack's half of the engines' agent loop (ADR-0033): the loop contract with
  the transcript stores, the Bedrock backend and the MCP binding (the catch-up [[pack-catch-up-4-12-25]], closed), in
  lockstep with the Python pack — the Node.js member of the Mercury Composable polyglot initiative: a lightweight
  Event-over-HTTP function host + thin client, repurposed August 2026.
- **last_enabled:** 2026-08-22
- **last_review:** 2026-11-19 | through 2026-11-19-075437.md (cadence — 16 sessions since 2026-11-13-030139; `refresh-metadata`
  refreshed 17 footers, tier changes 13; archived 1 faded fact `otel-forwarder-nodejs` (33; step 6: the window's two commits on
  its paths were quality sweeps with no behaviour change, and no window log reasons from its rule) - the other candidate,
  [[conv-resources-next-to-the-application-file]], is a declaration gap re-affirmed (the twins of 2026-11-19-074617 placed and
  loaded `resources` next to each module); swept 4 completed threads (bp-publish-interop-gate 33, llm-helper-bedrock-iam 26,
  otel-forwarder-lockstep 34, vision-versioning-vs-java-number 21) → 2026-Q4; invariants not due (19 of 40); stalled none;
  contradictions none; live facts 29 → 24. Smoke test not run.)
  Prior: 2026-11-13 | through 2026-11-13-030139.md (on command — 5 sessions since 2026-11-03-005949, not yet due; 3 footers
  refreshed, 2 tier changes; archived 0, swept 0; one stale statement corrected; invariants not due (3 of 40); live facts 20)
  Prior: 2026-11-03 | through 2026-11-03-005949.md (cadence — archived 3 faded facts, swept 3 threads; invariants DUE →
  [[reverify-invariants-20261103]]; one drift raised)
  Prior: 2026-09-23 | through 2026-09-23-004556.md (cadence — 11 sessions since; archived 1 faded fact
  `stack-mercury-serve-node` + swept 5 completed threads past `archive_window` → 2026-Q3; tier changes via `refresh-metadata`;
  invariants not due (29 sessions, cadence 40, none yet); stalled none — no unchecked thread) · 2026-09-05 | through 2026-09-05-210103
- **last_invariant_check:** 2026-11-03 | 2026-11-03-012600.md (COMPLETE - the first re-verify; Eric confirmed all four invariants and
  the Vision as walked in 2026-11-03-012056, two wordings refreshed, core stays 4; the next is due 40 sessions after this one)
- **repo:** ~/sandbox/mercury-nodejs (origin: github.com/Accenture/mercury-nodejs)

## Stack & Tools

> Canonical live home for the current stack — language version, dependencies, tool
> versions. `instructions.md` keeps only a high-level descriptor and points here.

- TypeScript ^5.6 (devDeps `typescript` + `@types/node` ^22), Node.js ≥ 20 (`engines`),
  compiled to `dist/` (ESM); npm package `mercury-composable` v4.12.30 (2026-11-16; the first publication v4.12.1 was
  2026-09-01; the Java release number it caught up to; build copies default-log-context.yaml
  into dist/src); scripts: `build`, `test`, `prepack`
  <!-- id: stack-typescript-esm | created: 2026-08-22 | last_used: 2026-11-16 | uses: 9 | tier: archive-candidate | origin: 2026-08-22-171916 -->
- Runtime deps: `@msgpack/msgpack` (envelope codec), `yaml` (config) — deliberately minimal; dev dependency
  `@anthropic-ai/sdk` (the LLM helper app's SDK and the tests' error classes; the published package stays free of any
  LLM SDK — 2026-10-01, PR #106) `pg` >=8 is a dev dependency since 2026-11-17 (the transcript audit store, like `redis` for the
  transcript store), and so are `neo4j-driver` >=6, `mammoth` and `pdfjs-dist` (the agent tools' knowledge-graph tools and
  `file.extract`, 2026-11-17), and `jose` >=6 (the ask-person reply page's and the agent-question app's `oauth2` mode,
  2026-11-19); the published package stays free of any database client and document library.
  <!-- id: stack-deps-msgpack-yaml | created: 2026-08-22 | last_used: 2026-11-19 | uses: 6 | tier: active | origin: 2026-08-22-171916 -->
## Architectural Invariants

> Hard constraints that must never change. These never decay (treated as `core`).

- **Wrapper only — no orchestration.** This package intentionally contains no flows, no
  graphs, no persistence and no pub/sub broadcast; orchestration lives in the Mercury
  engines. It provides functions, the primitive in-process event bus (route mailboxes +
  workers — dispatch, not orchestration; ratified 2026-08-23), and minimalist foundation
  utilities (README "Scope", amended with the bus). The LLM helper (`extensions/llm-helper/`) is an
  application on the package, not part of it, so its configurable transcript store leaves the
  package persistence-free (re-verified 2026-11-03).
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
  the portable error contract. **The LLM helper's `llm.chat` is configurable by design (Eric,
  2026-11-03):** a stateless chat, or, with `tools`, one turn of a multi-turn tool-use loop whose
  transcript lives in the configured transcript store (`llm.transcript.store`: `memory` for one
  process, `redis` shared by replicas; RFC-0011). That store is part of the function's configured
  contract, not an exception to this rule.
  <!-- id: stateless-functions-contract | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: core | origin: 2026-08-22-171916 -->

## Key Decisions

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
  **Extended 2026-10-14 (the AI SDLC epic's first sprint, Eric's direction; PR #111 merged `def1e3a`, the Python twin mercury-python #43 merged `c25ba35`, both 2026-10-14):**
  `llm.backend: 'bedrock'` reaches the same models through `AnthropicBedrockMantle` from `@anthropic-ai/bedrock-sdk` (imported only
  when selected; the backend builds asynchronously) - the AWS credential chain through IAM, or a Bedrock API key in
  `AWS_BEARER_TOKEN_BEDROCK`; the region from `llm.aws.region` or `AWS_REGION` (none: `503 AWS region missing`); a bare model id
  prefixed `anthropic.`, an id already spelled for Bedrock kept; no server-side fallbacks (Bedrock offers none); an empty credential
  chain `503 AWS credential missing` by name; `llm.health` reporting `region`. `backendFor(name, client)` holds a route's shape, and
  the vector harness installs its fake under the backend a case names (66 cases). The lock file is exempted from the secret guard
  (`.agent/secret-scan-ignore`: the package name `@aws-sdk/credential-providers` reads as a credential assignment). **Driven live 2026-10-14 (PR #112 merge `0ece23f`, the Python twin mercury-python #44 merge `03c5f57`, both MERGED 2026-10-14):** negative controls
  first, then chat, a structured verdict and a progressive stream on Haiku 4.5, and the Java engine's shipped triage graph and
  streaming relay in front of the helper - all through IAM, no vendor key. What the drive taught: Bedrock has TWO SURFACES an account
  may be enabled for separately, so `llm.aws.api` selects `mantle` (the default, the Anthropic-shaped endpoint, the `anthropic.`
  prefix) or `runtime` (the classic one, every model id sent as written - an inference profile id as the account lists it; its
  client's silent `us-east-1` fallback refused as the 503); model access is a one-time use case plus a per-model agreement, and a
  model generation can be gated at the account on top; the chain's `CredentialsProviderError` is the empty-credential signal;
  Bedrock sends no `request-id`. Closed [[llm-helper-bedrock-iam]].
  **2026-11-03 (Eric):** the helper graduates to `extensions/llm-helper/`, in lockstep with mercury-python #46; on branch
  `refactor/llm-helper-extension`, MERGED 2026-11-03 as #114 (merge `62958b5`). The Python twin also serves the agent loop's turns since
  mercury-python #47 (RFC-0011's loop contract, a transcript store, `llm-loop-vectors.json`); this pack's twin of it was built
  2026-11-03 on branch `feat/llm-chat-loop-contract` (`268dc7b`, PR #115): the same contract and messages, a `MemoryStore` and a
  `RedisStore` on the `redis` package with the Python twin's Lua script (a record one pack writes the other reads), the
  shared 66 cases green on memory, a Redis fake and a live Redis.
  <!-- id: llm-helper-app | created: 2026-10-01 | last_used: 2026-11-17 | uses: 7 | tier: active | origin: 2026-10-02-001255 -->

- **The MCP binding serves one composable route per allowlisted MCP tool, and the server cannot change a tool under the
  graph (RFC-0011 / ADR-0033 step 4; the Node.js twin built 2026-11-14, the same day as the Python one).**
  `extensions/mcp-binding/mcp-binding.mjs` on the official MCP SDK: servers by name in `resources/mcp-servers.yml` (`stdio`,
  a subprocess of this process with the SDK's default environment plus the listed `env` references; or `http`, a streamable
  HTTP URL with `headers`); `${VAR}` resolves at boot and is never logged; each allowlisted tool maps to a route and pins the
  SHA-256 of its input schema in canonical JSON (keys sorted, no spaces, Unicode kept - `canonical()` writes it by hand, the
  same bytes as the Python twin). Boot, before the host listens (`Platform.onStartup`), connects each server, lists its tools
  and refuses to start by name when a tool is missing or its schema changed; `describe` prints the digests and a catalog row
  the developer reviews, because the model reads the graph's descriptions, never the server's. A route's reply is the
  structured content else the blocks' text; `isError` is a 400 carrying the text (the loop returns it to the model), a
  timeout 408, a protocol failure 502, a lost connection 503. The pure half (digest, verification, result mapping) is pinned
  by `test/vectors/mcp-binding-vectors.json`, shared byte-identical with mercury-python; the transports by the fixture
  server `test/fixtures/mcp-test-server.mjs`. **The shape (2026-11-14, Eric's direction, the twin of mercury-python #52):**
  every bound route is an alias of ONE `preload` function, `mcp.tool` - private, bound to no tool - registered at boot with
  the server's `instances` through `registry.register`, the pack's counterpart of the engines' `Platform.register`; the
  function reads the route it was called as from `getTrace().route`, the pack's counterpart of the engines' read-only
  `my_route` header (the host strips `my_*` headers at ingress and adds none). A generic client - one route, the server and
  the tool encoded in the call - was suggested and set aside the same day: ADR-0033 rejects it as alternative (c), since the
  catalog cannot certify a target hidden in the call; the certifiable form is an optional `headers` map on the catalog row,
  an engine change in both engines, not taken. **How to apply:** a new MCP tool for an agent is a server entry and an allowlist
  row here plus a catalog row on the graph, never engine code; a schema change is a digest the developer re-reviews; a
  credential is a reference in the server file, resolved from this process's environment.
  <!-- id: mcp-binding-route-per-tool | created: 2026-11-14 | last_used: 2026-11-14 | uses: 1 | tier: superseded | superseded-by: mcp-binding-function-per-tool | origin: 2026-11-14-074701 -->

- **A tool of an MCP server is a composable function of the binding, declared in code (Eric's review 2026-11-16; the
  engines' `draft-design-specs/agent-tool-use.md`; supersedes the allowlist-row shape of 2026-11-14; the twin of the
  Python pack's reshaping).** `extensions/mcp-binding/mcp-binding.mjs` is a library and a function host:
  `bind(server, tool, { schemaSha256 })` declares a binding and returns the tool as an async function, and an ordinary
  `preload` function calls it - the extension's own `mermaid.render` binds the one tool of the public Mermaid Chart MCP
  endpoint named in the default server file, so the binding serves a tool out of the box. The server file keeps what is
  environment-specific (transport, command or URL, credential references, timeout) and refuses a `tools` allowlist by
  name; boot connects every server a function binds a tool of, lists its tools and stops the application by name when a
  bound server is not configured, a tool is not offered or its digest changed; a configured server nobody binds is not
  connected. `mcp.tool` is no longer a route; `mcp.health` stays. A route names the capability, never the transport: a
  tool may start as an MCP tool and later be implemented another way, and the graph must not know. The shared vectors
  are version 2 (`verify_cases` over declared bindings), byte-identical with the Python twin. **How to apply:** a new
  tool is a `bind` line, a few-line `preload` function, a catalog row on the graph and an Event-over-HTTP entry; a schema
  change is a digest re-reviewed next to the function; a new server is a server-file entry; never a route in a YAML file
  and never engine code.
  <!-- id: mcp-binding-function-per-tool | created: 2026-11-16 | last_used: 2026-11-19 | uses: 3 | tier: active | origin: 2026-11-16-044314 | supersedes: mcp-binding-route-per-tool -->

- **A traced call into the pack leaves the records a Java or Rust callee leaves, so a span lineage is continuous from an
  engine into the pack (2026-11-14, the twin of mercury-python #53; Eric's criterion: for OpenTelemetry to be certified,
  the span lineage ought to be continuous end to end).** The live drive of the engines' agent loop through both packs found
  the pack legs absent from the trace: the calling engine's `async.http.request` leg is in `skip.rpc.tracing` by default, and
  the host suppressed the worker-side record of every RPC-served execution with no callee-side record to replace it, so
  `llm.chat` and `diagram.render.mcp` showed only as time inside the engine's `llm.run` and `diagram.render`. Now `server.ts`
  records, for a traced call at `/api/event`, `http.request` (`POST /api/event`, the edge's round trip; parent the caller's
  span from the envelope, else the `traceparent` header; the backend's SERVER span), `event.api.service` (the ingress; parent
  the edge) and, for an RPC, the function's round-trip record (parent the service; the responder's span from the reply,
  `exec_time` and `round_trip`); the relayed envelope carries the service's span, so a drop-n-forget or streaming function
  parents onto it; a refusal or a timeout leaves the edge record with its status; an untraced call records nothing. `bus.ts`
  puts the execution's span on the reply (`WorkerHandler` parity) and `client.ts` records a local RPC round trip as
  `InboxBase` does; the worker-side record of an RPC-served execution stays suppressed. Re-driven the same day on the
  `diagram-assistant` graph: 20 records per run, every parent owned by a record (the engines'
  `docs/test-reports/agent-loop-trace-lineage.md`). PR #120 MERGED 2026-11-14 (merge `621bac6`). **How to apply:** the rule is who emits a record, never whether one
  exists - every traced execution leaves exactly one; before changing a host or client path, ask which side records it in
  the Java engine and mirror that side; a lineage check parses every record of the trace from every process and verifies
  each parent is a span some record owns.
  <!-- id: trace-records-engine-parity | created: 2026-11-14 | last_used: 2026-11-14 | uses: 1 | tier: archive-candidate | origin: 2026-11-14-115318 -->

- **The transcript audit store: every model turn recorded by a composable function behind a local event, off the
  turn's path, into PostgreSQL beside the working store - the Node twin of the Python pack's build (RFC-0012 in
  mercury-composable, Eric's rulings of 2026-11-17; built here as PR #126, MERGED 2026-11-17, merge `9d2d39778`, in lockstep with mercury-python #59).**
  `llm.transcript.audit: postgres` registers `transcript.audit` at boot - private, ONE instance, so its mailbox orders
  a conversation's writes and its check without a lock. The working record is version 2: beside the messages it
  carries each turn's facts (trace id and path, correlation id, UTC bounds, status, stop reason, request id, usage,
  `messages: [first request message, response]`), the first turn's system prompt, catalog, correlation id and the
  loop's `x-graph-id` and `x-node`, and the closing `retention`, all saved inside the compare-and-set; `transcript()`
  fills the defaults the Python dataclass has, so the JSON is the twin's field for field. After a compare-and-set
  accepted turn N, `llm.chat` sends `{conversation, turn: N}` through a local `PostOffice.send`; a closing turn adds
  `{conversation, check: true}` and the record waits with `llm.transcript.audit.grace` (`1d`) instead of `retention`.
  The function writes the rows the store lacks in one transaction (the conversation row upserted, the turn rows
  `ON CONFLICT DO NOTHING`, the totals recomputed from the turn rows), marks the record `audited` (a third hash field
  the compare-and-set never touches; a check releases a closed record to its `retention` first and marks it after, a
  closing write leaves both to its check, an open record is only filled); a sweep (`llm.transcript.audit.sweep.ms`,
  60 s, `SET NX PX` on `transcript:audit:sweep`, `scanIterator` pages) sends a check for every record whose mark lags.
  Failures are logged by type and SQLSTATE (pg's `code`), never by message, and never refuse a turn. `request` is the
  array of messages the turn sent, `response` the array of assistant blocks, `calls` the normalized tool calls; JSON
  travels as text cast to `jsonb`, stamps as text cast to `timestamptz`, with `$n` placeholders - the same statements
  as the Python pack. `pg` is a dev dependency; `ssl: true` is `{ rejectUnauthorized: false }`, libpq's `sslmode=require`
  twin. The schema files are byte-identical across the packs; retention and purge are the installation's. **How to
  apply:** a new audit fact is a field of the turn's facts in `turnFacts` and a column in both packs' schema and the
  published page, never a second key or a second write; anything the audit must know at the end of a run travels in
  the record; the shipped yml takes the database credential from `${ENV}` references (since #127 a `-D` value
  resolves them too). **Driven live 2026-11-17** (mercury-composable `docs/test-reports/transcript-audit-live-drive.md`): a
  full run and a resume of a Python-started conversation, the same rows from the same record; #129 added a server-side
  `statement_timeout` beside the client's `query_timeout`, because a paused database stalls a pooled statement where a
  stopped one fails it.
  <!-- id: transcript-audit-store-nodejs | created: 2026-11-17 | last_used: 2026-11-17 | uses: 4 | tier: active | origin: 2026-11-17-082942 -->

- **Ask a person, the main flow, is the Node twin of the Python pack's (RFC-0014 step 4; built here 2026-11-19 in lockstep
  with mercury-python #68).** `extensions/ask-person/ask-person.mjs` serves `person.ask`: the graph's hold path calls it before
  `graph.suspend` with the graph id, a description, the correlation id, the turn, the waiting calls and the suspension's ttl;
  the function issues the signed, stateless ticket (`v1.<payload>.<mac>`, canonical JSON, HMAC-SHA256, base64url - the same
  ticket from the same key as the Python pack, the shared file proves it), builds the resume link and sends one message event
  to every route in `ask.channels`, best effort; `kind: advice` has no ticket and no link. The reply page (`GET /ask/{ticket}`,
  the wait read by re-advice, never resuming) and endpoint (`POST /ask/reply`, the `ask.graphs` allowlist, `[who at time]` on
  each tool call's note) are mounted through the host's new `Platform.addRoutes` / `EventApiServer.createServer(routes)`;
  identity `none`, `proxy`, `oauth2` (`jose`), a channel app's bearer. Pinned by `test/vectors/ask-person-vectors.json` (72
  cases, byte-identical, SHA-pinned) and 97 tests. **How to apply:** the engine waits and the pack delivers and collects; a
  channel is a route in `ask.channels`; the vectors change in both packs or in neither.
  **Round 4 (Eric's sprint of 2026-11-20; PR #139, in lockstep with mercury-python #74):** the main flow keeps the
  question record - the main flow records and the channels deliver. `question.audit`, a private function of this process
  registered at boot with `ask.audit.instances` workers behind local requests, writes every wait and advice `person.ask`
  sends (before the channels are told) and every answer the reply endpoint brings back (the stamped decisions, who
  decided, when, the engine's outcome) to the `question` table of the audit database, order-independently: a wait
  upserts on its key unless an older message lands late, an advice appends with no state, the first accepted answer
  stands; a sweeper expires open waits. The contract is published - PostgreSQL out of the box (`ask.audit: postgres`,
  the pg driver, `schema/postgres.sql` version 2 byte-identical with the Python pack), memory for the tests (the
  default, with a boot warning), another database by the contract. Identity is `none` or `oauth2` - `proxy` removed,
  the field's installations use 3-legged SSO and OAuth 2.0 access tokens - and the reply page signs the person in by
  Authorization Code with PKCE (a shell, `GET /ask/config`, the wait read from `GET /ask/{ticket}/wait`). **How to
  apply (amended):** "keeping no store" means no state of the wait - the record is an audit log, never consulted to
  render a wait; the agent-question app reads it.
  <!-- id: ask-person-main-flow-node | created: 2026-11-19 | last_used: 2026-11-19 | uses: 1 | tier: working | origin: 2026-11-19-074617 -->
- **The agent-question app is the Node twin of the Python pack's first channel of RFC-0014 (step 4; built here 2026-11-19 in
  lockstep with mercury-python #70).** `extensions/agent-question/agent-question.mjs`, a standalone application on the package:
  `agent.question.inbox` upserts a wait on `(graph_id, correlation_id, turn)` and appends an advice, in memory or PostgreSQL
  (`pg`, the audit store's connection keys, `schema/postgres.sql` and `purge.sql` byte-identical with the Python pack, the
  change sequence `question_inbox_seq` as the replay cursor); the page, the replay `GET /questions?since=<seq>`, the stream
  `GET /questions/events` with `Last-Event-ID`, the automated click `POST /questions/{id}/decide` to the link's own base under
  the app's bearer, `seen`; states open, answered, expired, seen; a sweeper for expiry; identity as the main flow's. Pinned by
  `test/vectors/agent-question-vectors.json` (30 cases, byte-identical, SHA-pinned - the reference inbox replayed on the scripted
  sequence lands on the same rows, ids and change sequence) and 48 tests. **Driven live 2026-11-19 (RFC-0014 step 5, in the
  engines' `docs/test-reports/ask-a-person-live-drive.md`):** the Node twins carried a question, a decision, the advices and
  two devices on one card end to end behind the Java Playground; the first-decision rule found by the drive is in both
  packs - a decision's write applies when the row is still open or when the engine accepted it, so `answered` always wins
  and the losing device gets the row as it stands (vectors version 2, 31 cases). **How to apply:** the app never talks to the engine,
  only to the reply endpoint the link names; a row is never deleted by the app; the runtime's differences - `$n` placeholders,
  int8 as text, `jose` - stay inside the module, never in the contract.
  <!-- id: agent-question-app-node | created: 2026-11-19 | last_used: 2026-11-19 | uses: 1 | tier: working | origin: 2026-11-19-074617 -->

- **The host serves static web content from `resources/public` next to the application file - the engines' `public`
  folder (Eric, 2026-11-20; PR #138, in lockstep with mercury-python #73).** `static.html.folder` is honoured as the
  Java engine's key with the Rust engine's location as its default, under the resources rule
  ([[conv-resources-next-to-the-application-file]]): a GET or HEAD that no host path, extension route or function claims
  is answered with the file it names, `index.html` for a folder (so a folder's `index.html` replaces the embedded
  landing page at `/`), the content type from the engines' table by extension, an ETag with 304 on `If-None-Match`,
  `Cache-Control: no-cache` for HTML; a hidden segment, a link out of the folder or anything that is not a regular file
  is not found, in the engines' error shape; `file:` prefixes an absolute path, an empty value turns the service off;
  `AppConfig.appDir` names the application file's folder. Withdraws the 2026-08-24 note that the wrappers serve no
  static files: a pack application now ships a web front-end beside its functions as the engines' Playground does - the
  first is the agent-question app's React UI, built here and deployed into both packs' `resources/public`, served by
  each backend from its own origin, so no CORS ([[agent-question-react-ui]]). Not ported: the Java engine's
  static-content filter, its `no-cache-pages` list and its `mime.types` section. **How to apply:** a web bundle goes
  into `resources/public` next to the application file and nothing else is configured; a host path or an extension
  route always wins over a file of the same name; a relative folder is never the working directory's.
  <!-- id: static-content-resources-public-node | created: 2026-11-20 | last_used: 2026-11-20 | uses: 1 | tier: working | origin: 2026-11-20-075630 -->

## Conventions

- Engine-mirrored configuration/logging/trace conventions (see the invariant above and
  `instructions.md`); GitHub flow with tests + a CHANGELOG entry per change
  (CONTRIBUTING.md).
  <!-- id: conv-github-flow-changelog | created: 2026-08-22 | last_used: 2026-11-17 | uses: 7 | tier: active | origin: 2026-08-22-171916 -->
- **Each example app lives in a folder of its own, with a README and its own `resources/` (Eric, 2026-10-01; PR #106).**
  `examples/demo-app/` (the minimal polyglot app: `hello.node`, `hello.declarative`, `hello.chain`, `hello.tokens`, the private
  `demo.suffix.helper` and `demo.health`) and `examples/llm-helper/`; run one as
  `node dist/src/cli.js examples/<app>/<file>.mjs` (the sample config is read from the `resources` folder next to the app file).
  The Python pack mirrors the layout (and keeps a `hello.sync.chain` that JavaScript has no need of). The demo and the helper
  share the default port 8087, so give one of them another with `-Drest.server.port` to run both. The demo stays provider-free and
  credential-free: no LLM code goes into it. **2026-11-03 (Eric):** the LLM helper graduates from an example to an extension,
  `extensions/llm-helper/` (the same folder shape), so `examples/` holds the demo app - lockstep with mercury-python #46.
  <!-- id: examples-one-folder-per-app | created: 2026-10-01 | last_used: 2026-11-17 | uses: 3 | tier: active | origin: 2026-10-02-001255 -->

- **The `resources` folder is resolved next to the application file - the file `mercury-serve` is given, or the script Node ran
  - and the working directory is never searched (Eric's rule, 2026-10-14; PR #113 merge `f4132d4`).** The engines' classpath convention: the
  configuration travels with the application and does not depend on the launch directory. `AppConfig(path, argv, appDir)` resolves
  `resources/application.yml|yaml|properties` under `appDir`, defaulting to `mainScriptDir()` (`process.argv[1]`; `node -e` and a
  REPL have no script and load nothing); the CLI passes `path.dirname(appPath)`; `--config` names another file; the companion
  `app-log-context.yaml` lives in `resourcesDir`, the one folder beside an explicit file or next to the app; `source` is the
  absolute path found and the startup log reports `Configuration: <path>`. Found in the Python twin when a direct run started
  unconfigured during the Bedrock drive ([[llm-helper-app]]); pinned by subprocess tests that run from a decoy working directory.
  Lock-step with the Python pack (`__main__.__file__`, mercury-python #45 merge `a3c5a26`). Upgrade: a layout that kept `resources/` in the
  working directory with the app elsewhere passes `--config` or moves the folder.
  <!-- id: conv-resources-next-to-the-application-file | created: 2026-10-14 | last_used: 2026-11-19 | uses: 2 | tier: active | origin: 2026-10-14-015422 -->

- **The previous Node.js port's releases v4.2.40 to v4.3.28 live here as tags and GitHub releases; their branches are gone
  (Eric, 2026-11-13).** Before the August 2026 repurposing this repository held the previous Node.js port, whose releases
  were cut as `release/*` branches; tags began at `v4.12.0`. Each branch tip now has an annotated tag `vX.Y.Z`, the tagger
  date the release commit's, and a GitHub release titled with the tag, its notes the version's CHANGELOG section after a
  line saying it was published retroactively, not marked latest: 12 tags and releases, 16 of each in all, `v4.12.21`
  still Latest. The 12 branches and `doc/2025-11-15` (unmerged generated docs, no longer required) were then deleted;
  GitHub keeps only `main` and `gh-pages`. Twins: mercury-composable `historical-releases-tags-and-pages`, mercury
  `historical-releases-tags-and-pages-rust`. **How to apply:** find a legacy release by its tag or release page, never a
  branch; a release published after the fact passes `--latest=false`.
  <!-- id: historical-releases-tags-and-pages-nodejs | created: 2026-11-13 | last_used: 2026-11-13 | uses: 1 | tier: archive-candidate | origin: 2026-11-13-025101 -->

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
