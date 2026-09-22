---
title: Test Report — OpenTelemetry Certification, four runtimes
summary: Permanent record of the live four-runtime OpenTelemetry drive of 2026-09-22 - the
  Java and Rust engines rendering Gemini tokens progressively through this host's llm.stream
  and its Python twin, every application forwarding its spans to Dynatrace, one trace per request.
layer: reference
audience: [developer, architect]
keywords: [opentelemetry, otlp, dynatrace, distributed trace, llm.stream, test report]
---

# Test Report — OpenTelemetry Certification, four runtimes

*The live drive of 2026-09-22 (UTC) that certified this host's
[OpenTelemetry forwarder](../guides/config-logging-actuators.md#distributed-tracing-the-opentelemetry-forwarder-opt-in)
in company: the Java and Rust engines' Playground edges rendering real Gemini tokens progressively,
the tokens produced by this host's `llm.stream` AI node (and by the Python host's twin), every
application forwarding its spans to the same Dynatrace tenant under its own service name — one trace
per request across an engine and a polyglot function host. The twin record on the engines is
Scenario 8 of their `otel-dynatrace-certification` reports.*

## What was driven

The forwarder exists on all four runtimes: the Java `opentelemetry-forwarder` module, the Rust port's
`mercury-opentelemetry-forwarder`, and the two zero-dependency ports of the Rust OTLP encoder merged
that day — this host (PR #101) and the Python host (mercury-python #33). The maintainer's scenario is
the agent-orchestration experiment E0 stretched across them: `POST /api/llm/stream` on an engine's
Playground relays its reply lane into the event-over-http mapped `llm.stream` on a host, and the
provider's token batches re-render progressively out the engine's edge; `POST
/api/graph/support-triage` runs the E0 graph whose `llm.chat` node is a `graph.task` on the host.

This host ran `node dist/src/cli.js examples/demo-app.mjs` on `:8087` with `-Dotel.forwarding=true`,
`-Dotel.service.name=mercury-otel-cert-node`, `-Dllm.provider=gemini -Dllm.model=gemini-3.6-flash`,
the OTLP endpoint and credential from the environment (`OTLP_API_ENDPOINT`, `OTLP_AUTH_HEADER`,
`OTLP_TOKEN` — the demo `application.yml` wiring) and `GEMINI_API_KEY`; its `llm.stream` and
`llm.chat` (PR #102) speak Gemini over its REST API through `fetch`. The Java Playground (4.12.14,
`:8085`) and the Rust Playground (its E0 twin, `:8090`) forwarded as `mercury-otel-cert-java` and
`mercury-otel-cert-rust`; the Python host (`:8086`) as `mercury-otel-cert-python`. Every request
carried a caller-set `traceparent`.

## The traces through this host

| Edge → this host | Trace | `llm.stream` span start (UTC) | Token frames | Outcome |
|------------------|-------|-------------------------------|--------------|---------|
| **Java → Node** | `888a3f721907d31a9b0ec9836b2e580a` | 17:32:46.862Z | 2 + `done` | `STOP`, 39 output tokens, 5.7 s |
| **Rust → Node** | `1232ab83511f3402a519e65a80e1a144` | 17:34:56.602Z | 3 + `done` | `STOP`, 8.0 s |

The graph verdict through this host: Rust → Node `6077f5f3f9d64eb4f3bd9984f0804dca` (17:35:09Z,
action `bug-filed`). The `done` frame of each stream carried the model, `stop_reason`, usage and the
trace and business correlation ids — the continuity is self-documenting in the edge's output. (The
Python twin carried the other two pairings: Java → Python `c90af9e36d8dbd3c2390db240b406d3a`,
Rust → Python `a9686f1f87327466e46cc451ff34b319`.)

**The lineage, read from both sides' own datasets.** The engine's relay span is the parent of this
host's `llm.stream` span, and this host's span is the parent of the engine's reply-lane deliveries —
the same ids in two applications' logs:

```text
Java → Node   888a3f72…   java   llm.stream.relay             a79d434676214868
                          node   llm.stream                   3a89fa459f452bce  (parent a79d…, 5.7 s)
                          java   async.http.response.stream.0 bc9e32cf33d2f8af  (parent 3a89…)
                          java   async.http.response.stream.0 b424a08c58e611eb  (parent 3a89…)
Rust → Node   1232ab83…   rust   llm.stream.relay             bb0901151c32ebc2
                          node   llm.stream                   f26d329038c33432  (parent bb09…, 8.0 s)
                          rust   async.http.response.stream.0 84e8fb662b27cb96  (parent f26d…)
                          rust   async.http.response.stream.0 b292edc64bb18f87  (parent f26d…)
```

**Exports.** Zero export failures in this host (and in every other application) in every run — five
drives, 24 LLM calls. This host exported 1–2 spans per round: its `llm.stream` executions. The
graph's `llm.chat` is an RPC leg, which folds into the caller's span on every runtime, so no span is
exported for it here — the engines' own rule, and the same one the `distributed.tracing` log follows.

## Observations

- **The provider, not the pipeline, decided which calls succeeded.** Gemini answered `503 This model
  is currently experiencing high demand` on roughly half the calls across the drives, `429
  RESOURCE_EXHAUSTED` once, and `gemini-2.5-flash` proved retired (`no longer available to new users`,
  its 404 text recommending `gemini-3.6-flash`, which then answered); the stable alias
  `gemini-flash-latest` — the demo's default — was the one under demand, so the drives pinned
  `gemini-3.6-flash` with `-Dllm.model`. Every failure was itself a trace: this host rendered the
  provider's status through the portable error contract (`LLM provider error - HTTP 503 ...`), the
  edge returned it, and the forwarders exported those spans too.
- **The current flash models think before they answer.** A 200-token budget was spent entirely on
  reasoning (`stop_reason: MAX_TOKENS`, `output_tokens: 0`, an empty stream); 1000 tokens rendered two
  or three token frames and a `STOP`. A streaming AI node's budget is a certification setting, not a
  default — `params.max_tokens` (or a `thinkingConfig` pass-through) sets it per call.
- **What remains:** the backend's view — the maintainer's Dynatrace lookup of the traces above, each
  expected to show two services with the parentage the datasets assert, this host's spans under the
  instrumentation scope `mercury-composable-nodejs`.
