# Vision — mercury-nodejs

> The north star: the target future state of this package. **Ratified by the maintainer
> (Eric) on 2026-08-22**, drafted with Claude Code from the ratified polyglot-initiative
> design (D0–D8 plus the same-day scope refinements: minimalist utilities, `resources/` +
> `-D` config parity). **Non-goals amended 2026-09-05 (Eric):** the primitive in-process
> event bus is in scope as dispatch, matching the 2026-08-23 invariant and the shipped
> bus. **Versioning amended 2026-11-03 (Eric):** the pack catches up with the Java engine when
> functionality crosses from the engine to the language packs, and carries the Java release
> number it caught up to. **Subprocesses allowed for stdio MCP 2026-11-03 (Eric).**
> Treated as `core` (never decays) but re-confirmed on the
> invariant-verification cadence — a vision can go stale. The **Blueprint** (Open Threads
> tagged `(blueprint)` in `continuity.md`) tracks the gap from Current State to here;
> Designs and Implementations trace back to this `id`. See `DECAY.md` §12.
>
> <!-- id: vision-mercury-nodejs | created: 2026-08-22 | last_used: 2026-08-22 | uses: 1 | tier: core -->

## Elevator statement

The **Node.js doorway into Mercury Composable**: a deliberately tiny Event-over-HTTP
wrapper that lets developers write functions in the language that genuinely earns its
place — while the engines own all orchestration.

## Current-state context

The Node.js member of the Mercury Composable polyglot initiative (August 2026): an Event
API host (`POST /api/event`), a thin `PostOffice` client, the standard event-envelope
codec (verified against the engines' shared golden vectors; int64 beyond 2⁵³ exact as
BigInt), engine-consistent minimalist utilities, a primitive in-process event bus, and
actuator endpoints. **v4.12.21 is on npm** (`npm install mercury-composable`, 2026-10-07; the
first publication was v4.12.1, 2026-09-01);
tests and golden vectors green; the previous full-framework port (≤ v4.3.28) lives in
git history only — it never occupied this name on the public registry.

**Type:** TypeScript/Node.js library — polyglot function host + client

## What it should become

- The **reference-quality wrapper** of the engines' documented wire format and
  `/api/event` contract — on npm, compatible by **protocol** ("implements the standard wire
  format") and numbered by the **Java release it caught up to**. The Java engine is the reference
  implementation. The pack catches up with it when functionality crosses from the engine to the
  language packs (telemetry, AI SDLC), so its number may trail Java further than the Rust port's,
  which catches up closely after each Java release (Eric, 2026-11-03).
- The **rapid-prototyping path**: `npm install` plus the `mercury-serve` one-liner; the
  TS/JS ecosystem loads once in a long-lived service.
- **Bidirectional and invisible in the architecture**: functions addressed from Event
  Script flows and MiniGraph tasks as if local (declarative map, zero caller code); the
  thin client calls engine or peer functions over the same protocol.
- An **engine-consistent developer experience**: the vocabulary mirror (`preload()`,
  `AppException`, `instances`) and the minimalist utilities (config, logging, telemetry —
  `resources/`, `${ENV:default}`, `-D` parity) so knowledge transfers across languages and
  nobody invents a second way to do foundational things.

## For whom

Developers on Mercury Composable systems who want JavaScript/TypeScript for specific
functions — the npm ecosystem, rapid prototyping — without leaving the composable
architecture; and the engine teams, who gain polyglot reach with zero engine coupling.

## Success criteria

- A function written here runs from an Event Script flow or MiniGraph task **unchanged**,
  addressed as if local.
- Wire compatibility is **continuously proven**: shared golden vectors green, plus the
  live interop gate against both engines on every release.
- The dev loop stays one-liner simple; cross-language trace continuity gives one log
  aggregation.

## Non-goals (what it must never become)

- **Never a composable foundation or full SDK** — no flows, no graphs, no persistence (in
  the package: the LLM helper's configurable transcript store is that application's,
  2026-11-03), no pub/sub broadcast, no orchestration (the ratified scope fence). A
  **primitive in-process event bus** (route mailboxes + workers — dispatch, not
  orchestration) is in scope and shipped; it must never grow spill, queue caps, or
  engine-style orchestration. In particular, **never a re-port of the full framework** —
  light by design is the point of the reboot.
- **Never subprocess or embedded-interpreter execution of a function** (Option A shelved;
  helper-style embedding explicitly not planned): a function runs in the pack's own process.
  **A subprocess is allowed for stdio MCP (Eric, 2026-11-03):** the pack may run an MCP server
  as its child process and talk to it over stdio. That is the reason the MCP client work moved
  from the engines to the packs (RFC-0011): no engine runs a child process.
- **Never released on the engine's cadence for its own sake**: a Java release with nothing that
  crosses to the language packs needs no pack release, and the pack never runs a version
  sequence of its own (amended 2026-11-03, Eric).
- **Not a license to scatter one application across processes** — polyglot where the
  language earns its place (the `kafka-mesh-opt-in` caution).

## Mental model

> Functions in your language; orchestration in the engines — one wire format keeps
> everyone honest.
