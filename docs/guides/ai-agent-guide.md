---
title: AI Agent Guide
summary: The complete authoring grammar for Node.js polyglot functions on one page -
  contract, registration, config keys, endpoints and error rules, for deterministic generation.
audience: [ai-agent]
keywords: [ai agent, grammar, contract, deterministic, preload, postoffice]
---

# AI Agent Guide

**Purpose: generate a correct Node.js polyglot function from this page alone.**
Humans: the narrative versions live in [Function Writing Patterns](function-patterns.md)
and the [join chapters](join-event-script.md). Orchestration (flows, graphs) is
authored on the engine — use the
[engine AI guides](https://accenture.github.io/mercury-composable/guides/ai-developer-guide/).

## Pre-write checklist

1. Route name: lowercase `[a-z0-9._-]`, at least one period. Example: `order.enrich`.
2. Never block the event loop: async APIs only (`fs/promises`, `fetch`); no `*Sync`
   calls in handlers; no unbounded CPU loops.
3. Function is stateless. State belongs to the calling flow/graph.
4. Orchestration-shaped logic (sequencing, retries, branching) → STOP; author an
   Event Script flow or MiniGraph graph on the engine instead.

## The contract

```javascript
import { AppException, PostOffice, annotateTrace, getLogger, getTrace,
         platform, preload } from 'mercury-composable';

const log = getLogger('my-app');

preload('order.enrich', { instances: 10 },            // { isPrivate: true } -> in-app only
  async (headers, body) => {
    // 1. validate; intentional errors = throw new AppException(status, message)
    if (typeof body !== 'object' || body === null || typeof body.id !== 'string') {
      throw new AppException(400, "missing 'id'");
    }
    // 2. work (async I/O only)
    // 3. optional telemetry
    annotateTrace('source', 'node.js');               // rides back on the reply
    // 4. return the reply body (or an EventEnvelope for status/header control)
    return { id: body.id, enriched: true };
  });

await platform.run();
```

Rules:

- `headers: Record<string, string>`; `body: unknown` (any MsgPack value). Narrow
  `body` before use (`typeof`, `in`); never assume its shape.
- Return value = reply body (a promise is awaited). Return `EventEnvelope` only when
  setting status/headers.
- `throw new AppException(status, message)` → envelope status + message (portable
  error). Unexpected exception → 500 + message + stack. Never return HTTP-shaped
  objects like `{ status: 400 }`.
- `getTrace()` → `{ traceId, tracePath, cid, annotations }` or `undefined`.
- Reserved inbound header `my_correlation_id` = the caller's business correlation id
  (read-only). Never send headers named `my_*` or `x-event-api`.

## Composition (calling other functions)

```javascript
// local (same app; reaches isPrivate routes):
const reply = await new PostOffice().request('other.route', { ... }, { timeoutMs: 5000 });
// drop-n-forget: po.send(...) -> 202 ack envelope
// remote peer or engine:
const po = new PostOffice('http://host:8085/api/event');
```

- Always check `reply.getStatus()`; errors are envelopes, not exceptions.
- Local calls reach `isPrivate` routes; the wire cannot (403).
- For tests, pass a fresh registry: `new PostOffice(undefined, {}, registry)`.

## Run + configure

```bash
node dist/src/cli.js app.mjs               # config: resources/application.yml
node dist/src/cli.js app.mjs -Dkey=value   # runtime override (engine syntax)
```

Well-known keys (full table: [Configuration Reference](configuration-reference.md)):
`application.name`, `rest.server.port` (default 8085), `log.format`
(text|json|compact), `log.level`, `info.app.version`, `info.app.description`,
`show.env.variables`, `show.application.properties`,
`mandatory.health.dependencies`, `optional.health.dependencies`.

## Health check function (engine interface contract)

```javascript
preload('my.health', { instances: 5, isPrivate: true }, async (headers, _body) => {
  if (headers.type === 'info') {
    return { service: 'my.dependency', href: 'http://backend' };
  }
  return 'my.dependency is running fine';   // non-200 reply marks it DOWN
});
```

List the route in `mandatory.health.dependencies` (or `optional.…`).

## HTTP surface (served by the host, no code needed)

`POST /api/event` (envelope wire) · `GET /` `/info` `/info/routes` `/env` `/health`
`/livenessprobe`. Shapes: [HTTP Surface Reference](http-surface-reference.md).

## Engine-side wiring (for completeness; authored on the engine)

```yaml
# application.properties:  yaml.event.over.http=classpath:/event-over-http.yaml
event.http:
  - route: 'order.enrich'
    target: 'http://node-host:8087/api/event'
```

Flow task `process: 'order.enrich'` or graph node
`{"skill": "graph.task", "task": "order.enrich", ...}` (engines ≥ v4.11.11 for
graph.task). Details: [Join an Event Script Flow](join-event-script.md) ·
[Join a Knowledge Graph](join-knowledge-graph.md).

## DO / DON'T

| DO | DON'T |
|----|-------|
| async APIs (`fs/promises`, `fetch`) | `*Sync` calls or CPU loops on the loop |
| `throw new AppException(...)` | return `{ status: 400, ... }` objects |
| keep functions stateless | cache business state in module globals |
| compose one or two leaf helpers | re-implement flows/retries in Node.js |
| let deadlines fail fast (408 envelope) | swallow timeouts and hoard work |
