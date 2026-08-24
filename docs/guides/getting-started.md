---
title: Getting Started
summary: A running Node.js function in five minutes - hosted, probed, and called from a
  Mercury engine flow.
audience: [developer]
keywords: [quick start, preload, mercury-serve, event over http]
---

# Getting Started

*Guide: from zero to a Node.js function an engine can orchestrate.*

> **At a glance**
>
> - **What** — install the package, write one function, serve it, call it — first from
>   a client script, then from a real engine flow.
> - **Time** — about five minutes.

## 1. Install

```bash
git clone https://github.com/Accenture/mercury-nodejs.git
cd mercury-nodejs
npm ci && npm run build
```

*(Pre-release: the package installs from source until the npm release.)*

## 2. Write a function

A function is a plain handler registered under a **route name** — the only address the
rest of the system will ever know it by.

```javascript
// app.mjs
import { AppException, platform, preload } from './dist/src/index.js';

preload('hello.node', { instances: 10 }, async (headers, body) => {
  if (typeof body !== 'object' || body === null || typeof body.text !== 'string') {
    throw new AppException(400, "missing 'text'");
  }
  return { text: body.text.toUpperCase(), language: 'node.js' };
});

await platform.run();
```

The [Function Writing Patterns](function-patterns.md) guide covers the full contract.

## 3. Configure (the engines' convention)

```yaml
# resources/application.yml
application.name: 'hello-app'
rest.server.port: 8087
```

Configuration lives in a `resources` folder, exactly like the engines, and any key can
be overridden at run time with the engines' `-D` syntax.

## 4. Serve it

```bash
node dist/src/cli.js app.mjs        # or the mercury-serve bin once installed
```

```text
2026-08-24 10:15:30.123 INFO  mercury.server - Loaded PUBLIC hello.node, instances=10
2026-08-24 10:15:30.124 INFO  mercury.server - hello-app - Event API service started on port 8087
```

Open <http://127.0.0.1:8087/> — the host serves the engines' familiar index page, and
the same actuator endpoints (`/info`, `/health`, `/livenessprobe`, …) your operations
team already monitors on engine apps.

## 5. Call it from an engine

One declarative entry in the engine application tells it where the route lives —
`application.properties`:

```properties
yaml.event.over.http=classpath:/event-over-http.yaml
```

`event-over-http.yaml`:

```yaml
event.http:
  - route: 'hello.node'
    target: 'http://127.0.0.1:8087/api/event'
```

Any Event Script task or MiniGraph `graph.task` node that names `hello.node` now
executes your Node.js function — trace context, correlation id and error contract
carried end to end. [Join an Event Script Flow](join-event-script.md) walks through a
complete flow; [Join a Knowledge Graph](join-knowledge-graph.md) does the same for a
graph.

## 6. Or call it from a script

The host speaks the engines' Event API protocol, so the natural ad-hoc client is the
package itself:

```javascript
import { PostOffice } from './dist/src/index.js';

const po = new PostOffice('http://127.0.0.1:8087/api/event');
const reply = await po.request('hello.node', { text: 'polyglot' }, { timeoutMs: 5000 });
console.log(reply.getStatus(), reply.body);
// 200 { text: 'POLYGLOT', language: 'node.js' }
```

## Next

- The **why**: [Rationale — Externalized Functions](rationale.md)
- The **how, in depth**: [Function Writing Patterns](function-patterns.md)
- The **wiring**: [Join an Event Script Flow](join-event-script.md)
