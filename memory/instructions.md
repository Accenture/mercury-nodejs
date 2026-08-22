# Agent Instructions — mercury-nodejs

## What This Project Is

The **Node.js member of the Mercury Composable polyglot initiative** (repurposed August
2026): instead of re-porting the full composable foundation, this fresh start is a
deliberately **lightweight wrapper of the engines' Event-over-HTTP protocol**, so decoupled
JavaScript/TypeScript functions are orchestrated by the Mercury Composable engines (Java,
and the official Rust port) from Event Script flows and MiniGraph knowledge graphs — with
no orchestration code in Node.js at all. It provides an Event API host (`POST /api/event`),
a thin `PostOffice` client, the standard event-envelope wire-format codec, and the engines'
minimalist utilities (config, logging, distributed-trace context via AsyncLocalStorage).
Orchestration stays in the engines by design. The previous full-framework Node.js port (up
to v4.3.28) lives in git history and on npm.

**Type:** Library — polyglot function host + client (npm package `mercury-composable`)
**Primary language:** TypeScript (compiled to `dist/`; ESM)
**Framework / stack:** Node http host, MsgPack envelope codec — see continuity `## Stack & Tools`

> High-level only. The precise dependency list and current versions live in
> `memory/continuity.md` → `## Stack & Tools` (the live source of truth) — keep this
> section enduring and don't duplicate them here.

## Repository Structure

- `src/` — the package: `server.ts` (Event API host), `client.ts` (`PostOffice`),
  `envelope.ts` (wire-format codec), `registry.ts` (`preload()`), `config.ts`
  (`AppConfig`), `log.ts`, `trace.ts` (AsyncLocalStorage context), `exceptions.ts`
  (`AppException`), `cli.ts` (`mercury-serve`), `index.ts` (public API).
- `test/` — the test suite; golden conformance vectors shared with the Java and Rust
  engines prove wire compatibility.
- `examples/demo-app.mjs` — minimal runnable function app.
- Root `README.md` — the consumer-facing guide (quick start, function contract,
  configuration, wire compatibility); the root `AGENTS.md` fork routes consumers there.

## How an engine calls a function here (the wiring)

Zero caller code: an engine application's declarative **`yaml.event.over.http` map** binds
a route name (e.g. `hello.node`) to this app's `POST /api/event` URL (config-substituted
per environment). Any Event Script task or MiniGraph `graph.task` node naming that route
then executes the Node.js function registered here with `preload(route, ...)` exactly as
if it were local, with trace context carried end to end.

## Two audiences, two paths

Root `AGENTS.md` forks readers: **contributors** follow `memory/PROTOCOL.md` (this memory
layer); **consumers** — developers writing polyglot functions against this package — start
at `README.md` and never load contributor memory.

## Conventions Observed

- **Engine consistency is the house style:** configuration keys (`application.name`,
  `rest.server.port`, `log.format`, `log.level`), `${ENV_VAR:default}` substitution,
  `-D` runtime overrides, `resources/` config layout, and the Java reference engine's log
  presentation are all mirrored deliberately — a polyglot installation must stay uniform.
- Intentional errors throw `AppException(status, message)` — the portable error contract
  on the wire; handlers are stateless.
- Contribution flow (CONTRIBUTING.md): standard GitHub flow, write tests, update
  `CHANGELOG.md` with each change.

## Tone & Style

- Be concise unless detail is explicitly requested.
- Prefer prose over bullet lists for explanations.
- When suggesting code changes, match the existing style and patterns in this repo.
- Always check `memory/continuity.md` for prior decisions before suggesting
  architectural changes.

## Core Rules

1. Never modify files outside the project scope without asking.
2. Follow the existing code style — do not reformat files unnecessarily.
3. When in doubt about a pattern or convention, ask rather than assume.
4. Record all significant decisions in the session log and continuity file.
5. If you see a TODO, open thread, or obvious issue, note it in continuity.md.

## Testing

`npm test` (see `package.json`); wire-format changes must stay green against the golden
conformance vectors shared with the Java and Rust engines — they are the cross-engine
compatibility contract, not ordinary fixtures. Build with `npm run build` (tsc).

## CI / CD

No package build/test workflow yet (pre-release). The agent-memory advisory CI floor
(`.github/workflows/agent-memory.yml`) is installed; it checks the memory layer only.

## Editing These Instructions

Only modify this file if the user explicitly asks to change the project
description, rules, or conventions. Treat it as stable configuration.
