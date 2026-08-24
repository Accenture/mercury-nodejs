---
title: Design
summary: The wrapper anatomy - five small components, each mirroring an engine convention,
  the anycast bus (and why it is not EventEmitter), and the minimalist rulings.
audience: [architect, developer]
keywords: [design, event bus, anycast, eventemitter, postoffice, actuator, envelope, wire format]
---

# Design — The Wrapper Anatomy

*Foundations: what is inside, and why each piece earns its place.*

> **At a glance**
>
> - **What** — the five components of the function host and the design rulings behind
>   them: faithful `instances`/`isPrivate`, an anycast event bus (deliberately not
>   EventEmitter), fail-fast deadlines, and engine-identical operations.
> - **For** developers and reviewers who want the mental model before the API.

## Anatomy

```mermaid
flowchart TB
    subgraph Host [Node.js function host]
      direction TB
      A["/api/event<br/>(Event API host)"] --> B[EventBus<br/>per-route FIFO mailboxes]
      C[PostOffice<br/>local mode] --> B
      B --> W1[worker 1..N] --> F["preload function"]
      D[Actuator<br/>/info /health ...] -.probes via bus.-> B
    end
    E[Engine or peer] -- envelope bytes --> A
    F -- PostOffice remote mode --> X[another host or engine]
```

Five components, one dispatch pipeline:

| Component | Engine convention it mirrors |
|-----------|------------------------------|
| **Envelope codec** (`EventEnvelope`) | the [standard wire format](https://accenture.github.io/mercury-composable/guides/event-envelope-wire-format/), verified against golden vectors shared with both engines |
| **Event API host** (`POST /api/event`) | the engines' `event.api.service` semantics: `x-ttl` bounds execution, `x-async` is drop-n-forget, handler errors ride HTTP 200 inside the envelope |
| **Primitive event bus** | the engines' in-memory bus semantics: per-route FIFO, `instances` worker loops, deliver (RPC) and publish (drop-n-forget) — nothing else |
| **PostOffice** | the engines' `po.request`/`po.send` vocabulary — remote to any peer's `/api/event`, local through the same bus |
| **Actuator + index page** | the engines' operational surface: `/`, `/info`, `/info/routes`, `/env`, `/health`, `/livenessprobe`, pretty JSON, the same error signature |

## The rulings, and why

**`instances` and `isPrivate` are faithful, not decorative.** Each route has one FIFO
mailbox consumed by exactly `instances` worker loops — the parameter really is the
concurrency limit, as in the engines. `isPrivate: true` means what it means there too:
callable in-app through PostOffice, while the wire answers 403.

**The bus is an anycast work queue — deliberately *not* `EventEmitter`.** The
contract is: each delivery goes to **exactly one** of N workers and waits its FIFO
turn while all are busy. `EventEmitter` is a broadcast notifier — `emit()` invokes
*every* listener synchronously and buffers nothing — so a bounded-concurrency bus
would still need a queue in front of it, with the emitter demoted to a wake-up bell
(and `once()`-based bridging re-registers listeners per iteration and trips
`MaxListenersExceededWarning` right at the default `instances: 10`). The hand-built
mailbox is Node's missing `asyncio.Queue`, keeping the Python and Node.js twins
structurally identical. Two operations only:

- `deliver` — RPC bounded by the caller's ttl; a queued call whose caller already
  timed out is skipped, never wastefully executed (the dead-work check).
- `publish` — drop-n-forget, acknowledged with the engines' 202 shape.

**Process lifecycle is exact.** An idle bus holds no event-loop handles, so the
process can exit naturally; an in-flight RPC's deadline timer is deliberately
referenced — pending work holds the process open, at most until its deadline.

**No spill tier, no queue cap, fail fast by deadline.** Back-pressure belongs to the
tier that owns recovery — the engines' flows and graphs ([Rationale](rationale.md)).
A breach produces the standard `408` envelope (`Timeout for N ms`), identical to an
engine timeout, so flows handle both the same way.

**In-memory only.** In-flight events die with the process, exactly like the engines'
own in-memory bus; at-least-once behavior comes from flow-level retries, not from a
leaf journal.

## The scope fence

The package intentionally contains **no flows, no graphs, no persistence and no
pub/sub broadcast**. What it carries is deliberately minimal: functions, the primitive
bus, the thin client, and the engine-consistent utilities (configuration, logging,
trace). Divergence from an engine convention is treated as a bug, not a style choice.

## Where to go next

[Function Writing Patterns](function-patterns.md) turns this anatomy into day-to-day
code.
