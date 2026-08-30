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
- **status:** v4.12.0 merged to main (the progressive-rendering milestone, engine lock-step
  version line, jumping the npm lineage past the legacy 4.3.x; GitHub release v4.12.0 published 2026-08-30; npm package publish still pending) —
  the Node.js member of the Mercury Composable polyglot initiative: a lightweight
  Event-over-HTTP function host + thin client, repurposed August 2026 (the previous
  full-framework port, up to v4.3.28, lives in git history and on npm)
- **last_enabled:** 2026-08-22
- **last_session:** 2026-08-30 | agent: Claude Code (2026-08-30-053007)
- **last_review:** (none yet)
- **last_invariant_check:** (none yet)
- **repo:** ~/sandbox/mercury-nodejs (origin: github.com/Accenture/mercury-nodejs)

## Stack & Tools

> Canonical live home for the current stack — language version, dependencies, tool
> versions. `instructions.md` keeps only a high-level descriptor and points here.

- TypeScript ^5.6 (devDeps `typescript` + `@types/node` ^22), Node.js ≥ 20 (`engines`),
  compiled to `dist/` (ESM); npm package `mercury-composable` v4.12.0 (merged 2026-08-30,
  engine lock-step version line; npm publish pending; build copies
  default-log-context.yaml into dist/src); scripts: `build`, `test`, `prepack`
  <!-- id: stack-typescript-esm | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: working | origin: 2026-08-22-171916 -->
- Runtime deps: `@msgpack/msgpack` (envelope codec), `yaml` (config) — deliberately minimal
  <!-- id: stack-deps-msgpack-yaml | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: working | origin: 2026-08-22-171916 -->
- Developer runner: `mercury-serve` (`node dist/src/cli.js app.mjs --port <n>`), with the
  engines' `-D` runtime-override syntax; trace context rides AsyncLocalStorage
  <!-- id: stack-mercury-serve-node | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: working | origin: 2026-08-22-171916 -->

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
  design; the previous port (≤ v4.3.28) remains in git history and on npm (CHANGELOG 0.1.0).
  <!-- id: decision-polyglot-reboot | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: working | origin: 2026-08-22-171916 -->
- **Two-audience root fork (Eric, 2026-08-22):** root `AGENTS.md` routes contributors to
  `memory/PROTOCOL.md` and consumers (developers writing polyglot functions — the "AI
  grammar" path) to `README.md`, which carries the quick start, function contract, and
  wire-format guide.
  <!-- id: decision-consumer-fork-readme | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: working | origin: 2026-08-22-171916 -->

## Conventions

- Engine-mirrored configuration/logging/trace conventions (see the invariant above and
  `instructions.md`); GitHub flow with tests + a CHANGELOG entry per change
  (CONTRIBUTING.md).
  <!-- id: conv-github-flow-changelog | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: working | origin: 2026-08-22-171916 -->

## Open Threads

- [x] (P4 docs — **SHIPPED and LIVE 2026-08-24**, same day as plan ratification)
  **Documentation site "Composable for Node.js"** — structural twin of the python site
  (engine Material theme; 13 files; AI agent guide + llms.txt); live at
  accenture.github.io/mercury-nodejs. [PR #89](https://github.com/Accenture/mercury-nodejs/pull/89)
  merge `5ccf355` carrying `c565940` (tree verified, branches deleted); ci.yml maiden
  run green. Lesson: this repo's Pages source still pointed at the legacy
  `doc/2025-11-15` branch — a rebooted repo's Pages config outlives the reboot; Eric
  flipped it to `gh-pages`/root. Relates [[bp-publish-interop-gate]].
  origin: 2026-08-24-152858
  <!-- id: thread-docs-site-node | created: 2026-08-24 | last_used: 2026-08-24 | uses: 1 | tier: working | origin: 2026-08-24-152858 -->

- [x] (feature — RATIFIED + IMPLEMENTED + **MERGED 2026-08-23 as
  [PR #87](https://github.com/Accenture/mercury-nodejs/pull/87), true merge `fa7b2bf`
  carrying branch head `329c931`; tree verified identical, branches deleted both ends;
  one PR with [[thread-actuator-endpoints-node]]**) **Primitive in-process event bus —
  the single dispatch pipeline.** `instances`/`isPrivate` faithful; deliver + publish
  only; the HTTP host and local PostOffice = thin ingress adapters. Durable rulings: NO
  spill tier / NO queue cap — back-pressure belongs to the engines' flows/graphs; an
  in-flight RPC's deadline timer is REFERENCED (pending work holds the process open), an
  idle bus holds no handles. Full design, pins and wire proofs: origin log.
  <!-- id: thread-primitive-event-bus-node | created: 2026-08-23 | last_used: 2026-08-23 | uses: 1 | tier: working | origin: 2026-08-23-024601 -->

- [x] (feature — Eric's directive, IMPLEMENTED + **MERGED 2026-08-23 in the same
  [PR #87](https://github.com/Accenture/mercury-nodejs/pull/87) as the bus**)
  **Actuator endpoints — the engines' operational surface for Kubernetes PODs.**
  /info, /info/routes, /env, /health, /livenessprobe; health check functions speak the
  engines' `type=info`/`type=health` contract through the bus; UP 200 / DOWN 400;
  liveness follows the last health outcome. Byte-symmetric with the python twin except
  the runtime block. Detail: origin log. Relates [[thread-primitive-event-bus-node]].
  <!-- id: thread-actuator-endpoints-node | created: 2026-08-23 | last_used: 2026-08-23 | uses: 1 | tier: working | origin: 2026-08-23-031920 -->

- [x] (planned — Eric, 2026-08-23; **EXECUTED 2026-08-24 and MERGED same day as
  [PR #88](https://github.com/Accenture/mercury-nodejs/pull/88), true merge `2a0d8f8`
  carrying `a73332f` (17 commits, tree verified, branches deleted both ends);
  51/51 green throughout — 12 Sonar rules cleared incl. the shared asText
  (positive-narrowing lesson), two S3776 extractions, the linear call-site parse, and
  the EventEmitter rationale now in bus.ts's header; + the loose-ends round: engine-
  parity index page, pretty JSON, {status, message, type: error} host errors
  (`956c706`, 51/51); PENDING Eric's PR gate**)
  **Code quality review round for mercury-nodejs** — the node twin of the python quality round (mercury-python
  PR #16 class: IDE/Sonar screenshot-driven; node has so far received only preemptive
  mirrors of python findings, never its own review pass). After it: P4 on the polyglot
  initiative (docs chapter + examples demo on the engine repos, interop-report extension,
  ADR-0016 proposal, fresh CI workflows for both wrapper repos — these PRs ran only the
  agent-memory check). Review agenda item (Eric's parting question): document in bus.ts's
  header WHY the Mailbox is hand-built instead of EventEmitter — emitter = broadcast
  notifier (all listeners, no backlog, no anycast, MaxListeners warning at instances>10);
  the bus contract = anycast FIFO work queue with N bounded workers, i.e. node's missing
  asyncio.Queue — and bare-promise waiters keep the idle bus handle-free (the lifecycle
  ruling).
  <!-- id: thread-node-quality-review | created: 2026-08-23 | last_used: 2026-08-23 | uses: 1 | tier: working | origin: 2026-08-23-031920 -->

> Mark completed items `- [x]` and leave them in place — the review sweeps them to
> the archive once older than `archive_window` sessions. Don't archive them by hand.

- [x] (feature — **MERGED 2026-08-30 as
  [PR #90](https://github.com/Accenture/mercury-nodejs/pull/90) true merge `40a9f8f`
  carrying `c0c28a6`; tree verified; v4.12.0 milestone, all four repos lock-step)
  **The progressive-rendering round: event streaming (engines' envelope-mode SSE
  contract, reply_to bus mechanism, stream/streamTo consumers), business
  correlation-id continuity, full span lineage with the engines' distributed-trace
  dataset on stdout, app-log-context with the packaged default template, sender
  attribution.** Lessons: tee (never swallow) process.stdout patches - the test
  runner's records ride it; detach worker loops from the creating caller's
  AsyncLocalStorage; RPC legs emit no dataset (engine parity).
  origin: 2026-08-30-045557.
  <!-- id: ot-streaming-telemetry-round-20260830 | created: 2026-08-30 | last_used: 2026-08-30 | uses: 1 | tier: working | origin: 2026-08-30-045557 -->

- [ ] **(blueprint) Publish behind the interop gate.** The wrapper is complete and green
  and now versioned **v4.12.0 on main** (the milestone merge, 2026-08-30 — the version
  aligns with the engine lock-step line and clears the legacy npm 4.3.x history,
  resolving the version-story question), with the interop gate green (the
  progressive-rendering interop report). The Vision's "releasable on its own cadence" is
  unmet until it ships to npm; publishing itself stays Eric-gated (ownership, cadence,
  supply-chain posture; design P5/D6). → serves: vision-mercury-nodejs
  <!-- id: bp-publish-interop-gate | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: working | origin: 2026-08-22-173136 -->

- [x] **(vision-bootstrap)** Vision ratified by Eric, 2026-08-22 — drafted from the
  ratified polyglot design (D0–D8 + same-day refinements): tiny Event-over-HTTP wrapper,
  engines own orchestration, protocol-compat releases, the scope fence (incl. never a
  full-framework re-port) as non-goals. First Blueprint gap derived (publish behind the
  interop gate). Detail: 2026-08-22-173136.
  <!-- id: ot-vision-bootstrap | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: working | origin: 2026-08-22-171916 -->
- [ ] **Dedicated consumer AI surface (optional).** The root fork points consumers at
  `README.md` for now (Eric, 2026-08-22). If the team wants a dedicated version-matched
  surface later (family pattern: mercury-composable's `system/AGENTS.md`), author it and
  retarget the fork's consumer link.
  <!-- id: ot-consumer-surface | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: working | origin: 2026-08-22-171916 -->

## User Preferences

(none recorded yet — record ONLY what the user explicitly states; never infer)

## Team / Members

(none recorded yet)
