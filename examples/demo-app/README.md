# Demo app

The minimal polyglot function host: six small functions that show what a Mercury engine can reach
over Event-over-HTTP and what a function host does with a call. Run it to watch a Node.js function
answer an engine, and copy it as the starting point for your own app. It never calls a model and needs
no credential; the LLM routes are a separate app, [`llm-helper`](../llm-helper/README.md).

```text
  caller ── REST ──> Java or Rust engine ── Event-over-HTTP ──> demo app
            flow, graph or service          POST /api/event      this app
```

The Python twin ([mercury-python `examples/demo-app`](https://github.com/Accenture/mercury-python))
offers the same routes, `hello.python` in place of `hello.node` and with one more, `hello.sync.chain`
(a plain `def` handler composing through the sync bridge, which JavaScript has no need of), with the
same behaviour.

## Run it

```bash
npm install
npm run build
node dist/src/cli.js examples/demo-app/demo-app.mjs
```

To use it outside this repository, copy `demo-app.mjs` and its `resources` folder into your project,
`npm install mercury-composable`, and run `npx mercury-serve demo-app.mjs` (the app imports
`mercury-composable` by name, so the same file works in both places).

The app listens on port 8087 (`rest.server.port` in `resources/application.yml`; `-Drest.server.port=8090`
overrides it). The [LLM helper](../llm-helper/README.md) defaults to 8087 as well, so give one of the two
another port when you run both on one machine. Map a route from the engine's `event-over-http.yaml`:

```yaml
event:
  http:
    - route: 'hello.node'
      target: 'http://127.0.0.1:8087/api/event'
```

Then call it from a flow or a graph task like any local function, or ad hoc from the package itself, as
the [getting-started guide](../../docs/guides/getting-started.md) shows:

```javascript
import { PostOffice } from 'mercury-composable';

const po = new PostOffice('http://127.0.0.1:8087/api/event');
const reply = await po.request('hello.node', { text: 'polyglot' }, { timeoutMs: 5000 });
console.log(reply.getStatus(), reply.body);
// 200 { text: 'POLYGLOT', language: 'node.js' }
```

## The functions

| Route | Visibility | What it shows |
|---|---|---|
| `hello.node` | public | The hello world: uppercases `text` and answers `{text, language}`. A body without a string `text` is a 400 `missing 'text'`, the portable error contract. It annotates the call's trace with `language`. |
| `hello.declarative` | public | Echoes the body and headers it received. The target of the engines' declarative Event-over-HTTP demos. |
| `hello.chain` | public | Local composition: calls the private `demo.suffix.helper` through the in-process bus and returns its reply. |
| `hello.tokens` | public | Streaming: paced messages over the multi-shot reply contract. See below. |
| `demo.suffix.helper` | private | Appends `!` to `text`. In-app only: the HTTP host answers 403 for a private route. |
| `demo.health` | private | A health check speaking the engines' interface contract (`type=info` and `type=health`). `/health` includes it through `mandatory.health.dependencies`. |

### Streaming

`hello.tokens` sends an introductory message at once, then `count` messages, each after `delay`
milliseconds, then the terminal event. Two optional headers set the pace: `delay` (default 500, clamped
to 50 to 5000) and `count` (default 5, clamped to 1 to 100). The terminal's trailing metadata echoes
`count`, `language`, `trace_id` and `my_correlation_id`, so a calling engine's edge shows both
continuity dimensions, the distributed trace and the business correlation id, end to end.

An engine consumes it progressively (`accept: text/event-stream` on the outbound event) and can render
it out its own HTTP edge, so this is the smallest engine-to-wrapper streaming demonstration. The Java
`lambda-example` and the Rust `hello-world` example drive it that way.

## Configuration

`resources/application.yml`, or `-Dkey=value` at run time.

| Key | Default | Meaning |
|---|---|---|
| `application.name` | `demo-app` | The identity in logs and on the actuator endpoints. |
| `info.app.description` | `Mercury Composable polyglot demo` | The description `/info` reports. |
| `rest.server.port` | `8087` | The Event API and actuator port. |
| `log.format` | `text` | `text`, `json` (pretty-printed) or `compact` (single-line JSONL). |
| `log.level` | `INFO` | The log level; the `LOG_LEVEL` environment variable wins. |
| `mandatory.health.dependencies` | `demo.health` | The health-check routes `/health` requires. |
| `show.env.variables`, `show.application.properties` | `LOG_LEVEL`; `application.name, rest.server.port` | The opt-in lists behind `/env`. Nothing is ever dumped wholesale. |
| `otel.forwarding` | `false` | Opt-in OpenTelemetry export. See below. |

To export the app's trace spans, run with `-Dotel.forwarding=true`. The endpoint and credential come from
the environment (`OTLP_API_ENDPOINT`, `OTLP_AUTH_HEADER`, `OTLP_TOKEN`, and optionally
`OTLP_SERVICE_NAME`), never from the file, and header names are logged, never values. The
[OpenTelemetry certification report](../../docs/test-reports/otel-dynatrace-certification.md) records a
run of this host against a live backend.

## What it does not do

It calls no model, holds no credential and keeps no state between calls. It is a demonstration of the
host's contracts, not a template for business logic.

## Tests

The demo has no unit tests of its own. The mechanisms it demonstrates are covered in `test/`: the local
bus and private routes in `test/bus.test.ts`, streaming in `test/event-stream.test.ts`. `hello.tokens`
was driven through both engines in the
[progressive-rendering interop report](../../docs/test-reports/progressive-rendering-interop.md).
