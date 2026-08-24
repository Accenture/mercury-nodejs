---
title: Function Writing Patterns
summary: The coding patterns for externalized functions - the handler contract, the
  non-blocking rule, errors, trace context, private functions and composition.
audience: [developer, ai-agent]
keywords: [preload, handler, async, AppException, trace, private, postoffice]
---

# Function Writing Patterns

*Write functions: the day-to-day patterns, with the reasons attached.*

> **At a glance**
>
> - **What** — the `(headers, body)` contract, the portable error contract, trace
>   context, private functions, and composition through PostOffice.
> - **Rule of thumb** — handlers may be `async` or plain functions; either way, never
>   block the event loop — Node's ecosystem is non-blocking by design.

## The contract

A function is a handler registered under a route name:

```javascript
import { preload } from 'mercury-composable';

preload('my.function', { instances: 10 }, async (headers, body) => {
  return { ok: true };
});
```

- **Input** — the same two-part input as an engine `TypedLambdaFunction`:
  `headers: Record<string, string>` and `body: unknown` (any MsgPack value).
- **Output** — return the reply body, an `EventEnvelope` for full control of status
  and reply headers, or a promise of either — the bus awaits the result.
- **Route names** — lowercase letters, digits, period, hyphen, underscore, with at
  least one period (`hello.node`, not `HelloNode`).
- **Statelessness** — anything a handler must keep belongs to the caller's flow model
  or graph state machine, never to module globals.

## One style: non-blocking

Unlike Python — whose wrapper bridges two library ecosystems — the Node.js world is
uniformly promise-shaped, so there is exactly one handler style. A plain function
works (its return value is awaited like any other), but the rule that matters is:

!!! warning "Never block the event loop"
    The loop hosts every route, the Event API and the actuators. Prefer the async
    APIs (`fs/promises`, `fetch`) over `*Sync` variants, and keep CPU-heavy work out
    of function hosts — or behind a worker-thread pool you manage explicitly.

```javascript
import { readFile } from 'node:fs/promises';

preload('template.render', { instances: 10 }, async (_headers, body) => {
  const template = await readFile('templates/welcome.txt', 'utf-8');
  return { text: template.replace('{name}', String(body?.name ?? 'guest')) };
});
```

## Errors — one portable contract

Throw `AppException(status, message)` for intentional errors:

```javascript
import { AppException } from 'mercury-composable';

throw new AppException(400, "missing 'text'");
```

On the wire this becomes a normal envelope with status 400 and the message as body —
the flow's exception handler or the graph's `error.*` contract receives it exactly as
it would from an engine function. An unexpected exception becomes status 500 with the
message and a stack trace, mirroring the engines. Handler-level errors always ride
HTTP 200; only transport-level failures (unknown route, private target, timeout,
undecodable envelope) surface as HTTP status codes.

## Trace context

Every delivery runs under its caller's trace:

```javascript
import { annotateTrace, getTrace } from 'mercury-composable';

const info = getTrace();            // { traceId, tracePath, cid, annotations } or undefined
annotateTrace('model', 'v3');       // rides back on the reply envelope
```

Outside a hosted function (batch jobs, tests), establish context explicitly:

```javascript
import { runWithTrace } from 'mercury-composable';

const reply = await runWithTrace(
  { traceId: 'trace-1', tracePath: 'BATCH /nightly', cid: 'order-42', annotations: {} },
  () => po.request('my.function', { ... }, { timeoutMs: 5000 }));
```

## Private functions and composition

`isPrivate: true` marks a function callable **in-app only** — the HTTP host answers
403 for it, while a local `PostOffice` (no endpoint) reaches it through the bus:

```javascript
preload('demo.suffix.helper', { instances: 10, isPrivate: true },
  async (_headers, body) => { ... });

// composition through the bus (local mode: no endpoint)
const reply = await new PostOffice().request('demo.suffix.helper', body,
  { timeoutMs: 5000 });
```

!!! warning "Composition is for leaf-side helpers"
    A public function calling a private formatter is healthy. A function that
    sequences three other functions with retries is a flow wearing a disguise —
    write it as Event Script or a graph instead ([Rationale](rationale.md)).

## Calling remote peers

The same PostOffice, given an endpoint, calls any engine or peer host with the
engines' relay contract (octet-stream envelope, `x-ttl`, trace headers):

```javascript
const po = new PostOffice('http://peer:8085/api/event');
const reply = await po.request('hello.python', { text: 'hi' }, { timeoutMs: 5000 });
```

The reply envelope is authoritative in every mode: inspect `reply.getStatus()`.
