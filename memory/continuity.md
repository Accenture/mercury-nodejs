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
- **status:** **v4.12.1 PUBLISHED to npm 2026-09-01** (`npm install mercury-composable` —
  the first public package of the composable line; tag v4.12.1; the name was a
  fully-unpublished third-party tombstone, reclaimed per npm policy; the legacy
  pre-composable 4.3.x line lives in git history only, NOT on the registry) — the
  Node.js member of the Mercury Composable polyglot initiative: a lightweight
  Event-over-HTTP function host + thin client, repurposed August 2026
- **last_enabled:** 2026-08-22
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
  <!-- id: stack-typescript-esm | created: 2026-08-22 | last_used: 2026-08-30 | uses: 3 | tier: active | origin: 2026-08-22-171916 -->
- Runtime deps: `@msgpack/msgpack` (envelope codec), `yaml` (config) — deliberately minimal
  <!-- id: stack-deps-msgpack-yaml | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: archive-candidate | origin: 2026-08-22-171916 -->
- Developer runner: `mercury-serve` (`node dist/src/cli.js app.mjs --port <n>`), with the
  engines' `-D` runtime-override syntax; trace context rides AsyncLocalStorage
  <!-- id: stack-mercury-serve-node | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: archive-candidate | origin: 2026-08-22-171916 -->

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
  <!-- id: decision-polyglot-reboot | created: 2026-08-22 | last_used: 2026-08-22 | uses: 2 | tier: archive-candidate | origin: 2026-08-22-171916 -->
- **Two-audience root fork (Eric, 2026-08-22):** root `AGENTS.md` routes contributors to
  `memory/PROTOCOL.md` and consumers (developers writing polyglot functions — the "AI
  grammar" path) to `README.md`, which carries the quick start, function contract, and
  wire-format guide.
  <!-- id: decision-consumer-fork-readme | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: archive-candidate | origin: 2026-08-22-171916 -->

## Conventions

- Engine-mirrored configuration/logging/trace conventions (see the invariant above and
  `instructions.md`); GitHub flow with tests + a CHANGELOG entry per change
  (CONTRIBUTING.md).
  <!-- id: conv-github-flow-changelog | created: 2026-08-22 | last_used: 2026-08-24 | uses: 2 | tier: active | origin: 2026-08-22-171916 -->

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
