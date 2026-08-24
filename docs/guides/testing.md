---
title: Testing Your Functions
summary: The test harness patterns this package uses on itself - fresh registries, real-HTTP
  host tests, and the golden wire-format vectors.
audience: [developer]
keywords: [testing, node test runner, fixtures, golden vectors, wire format]
---

# Testing Your Functions

*Write functions: test them the way this package tests itself.*

> **At a glance**
>
> - **What** — three proven layers: direct handler tests, in-process bus tests, and
>   real-HTTP host tests; plus the golden vectors that pin wire compatibility. All on
>   the built-in `node --test` runner — no test framework dependency.

## Layer 1 — the handler is just a function

```javascript
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('uppercase contract', async () => {
  const reply = await handler({}, { text: 'polyglot' });
  assert.deepEqual(reply, { text: 'POLYGLOT', language: 'node.js' });
});
```

## Layer 2 — through the bus, with a fresh registry

Register into a **fresh** `FunctionRegistry` per test (never the default one) and
close its bus on teardown — the pattern from this package's own `test/bus.test.ts`:

```javascript
import { FunctionRegistry, PostOffice, runWithTrace } from 'mercury-composable';

test('trace rides through', async () => {
  const registry = new FunctionRegistry();
  registry.register('my.function', handler);
  const po = new PostOffice(undefined, {}, registry);
  const reply = await runWithTrace(
    { traceId: 'trace-1', tracePath: 'TEST /unit', cid: 'cid-1', annotations: {} },
    () => po.request('my.function', { text: 'x' }, { timeoutMs: 5000 }));
  assert.equal(reply.getStatus(), 200);
  registry.bus.close();
});
```

This exercises `instances`, private routes, deadlines (assert the 408 envelope) and
trace propagation exactly as production will.

## Layer 3 — over real HTTP

Boot the host on an ephemeral port and speak the actual protocol
(`test/server.test.ts` pattern):

```javascript
import { EventApiServer } from 'mercury-composable';

const server = new EventApiServer(registry).createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
// ... fetch posts envelope bytes to /api/event, or new PostOffice(`http://127.0.0.1:${port}/api/event`)
await new Promise((resolve) => server.close(resolve));
```

Use this layer to pin transport behavior: 403 for private routes, 404 messages, the
`x-async` 202 acknowledgement, reserved-header hygiene, actuator shapes.

## Wire compatibility — the golden vectors

The codec is verified against the **golden conformance vectors shared with the Java
and Rust engines** (`test/vectors/vectors.json`). If you extend envelope handling,
run the vector suite — it is the cross-language contract.

## The project gate

```bash
npm test        # tsc + node --test (build and all suites)
```

The CI workflow runs it plus a strict documentation build on every push and pull
request.
