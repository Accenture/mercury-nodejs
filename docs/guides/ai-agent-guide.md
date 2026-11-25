---
title: AI Agent Guide
summary: The complete authoring grammar for Node.js polyglot functions on one page -
  contract, registration, config keys, endpoints and error rules, for deterministic generation.
audience: [ai-agent]
keywords: [ai agent, grammar, contract, deterministic, preload, postoffice, rest automation, rest.yaml]
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
- The route is one name or a comma-separated list: aliases of one function, same
  `instances` and visibility; `getTrace().route` is the name it was called as.
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

## REST automation (serve HTTP from `rest.yaml`, no engine needed)

Opt in with `rest.automation: true` in `resources/application.yml`; the router is
`resources/rest.yaml` next to the application file, in the engines' grammar
([REST grammar](https://accenture.github.io/mercury-composable/guides/rest-automation/rest-grammar/),
[`rest-automation.json`](https://accenture.github.io/mercury-composable/guides/rest-automation/rest-automation.json)).
Narrative: [REST Automation](rest-automation.md).

Pre-write checklist for an entry:

1. `service` is a function route of **this** application. Never `flow:` or
   `service: http.flow.adapter` (flows run in the engines), never an `http(s)://` relay,
   never a list of services — each is refused at load by name.
2. `methods` from `GET PUT POST DELETE HEAD PATCH` (`OPTIONS` is auto-added); `url` with
   `{param}` segments or a trailing `*`; `timeout` 1 s–5 min (30 s default).
3. The function reads `new AsyncHttpRequest(body)` — never the bare HTTP body — and replies
   with a value, an `EventEnvelope` (status, headers) or an `AppException` (the standard
   error body). A `null` the client must see → serialize the JSON yourself and set
   `content-type: application/json`.
4. `authentication: '<route>'` names a function that returns `true` (its reply headers
   become `request.sessionInfo(...)`) or throws `AppException(401, ...)`.
5. `stream: true` → an `interceptor: true` function writing through `EventStreamWriter`;
   `upload: true` → a `POST` entry, the files in `request.files()`, within
   `rest.upload.max.bytes`.
6. Register the functions behind entries `isPrivate: true` when the edge is their only caller.
7. A `cors:` or `headers:` value must match an `id` in the same file.

```yaml
# resources/rest.yaml
rest:
  - service: "order.enrich.rest"
    methods: ['POST']
    url: "/api/orders/{id}/enrich"
    timeout: 15s
    tracing: true
```

```javascript
import { AppException, AsyncHttpRequest, EventEnvelope, preload } from 'mercury-composable';

preload('order.enrich.rest', { instances: 10, isPrivate: true }, async (_headers, body) => {
  const request = new AsyncHttpRequest(body);
  const orderId = request.pathParameter('id');
  const payload = request.body;                              // the parsed JSON body
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new AppException(400, 'the body must be a JSON map');
  }
  return new EventEnvelope().setStatus(200).setBody({ id: orderId, enriched: true });
});
```

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
| a `rest.yaml` entry for an HTTP path | mount a `node:http` route (`Platform.addRoutes` is the escape hatch for a WebSocket) |
