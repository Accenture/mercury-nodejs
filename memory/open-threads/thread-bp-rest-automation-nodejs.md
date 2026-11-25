- [ ] **(blueprint) REST automation in the pack: `rest.yaml` as the router of a Node application, so a field utility app is
  built and deployed as an engine application is (RFC-0018 in mercury-composable, raised as its PR #674 and MERGED 2026-11-25; the
  Vision amended by Eric, 2026-11-24).** Investigated 2026-11-24 in the Python pack (its log 2026-11-24-233943): viable with no new dependency -
  the host already has the one server on `node:http`, the Event API edge with its trace records, the actuators,
  static content, the mounted routes, the bus with per-call timeouts and the streaming sink; REST automation is a
  routing table and a request model in front of them, ingress and not orchestration. The previous port at tags
  v4.2.40 to v4.3.28 (`src/system/rest-automation.ts`, `src/util/routing.ts`, `src/models/async-http-request.ts`, on
  Express, body-parser, cookie-parser and busboy) is a reading aid for the parser and the request model, never a
  dependency source. The proposed shape: `rest.automation: true` (off by default), `resources/rest.yaml` under the
  resources rule, the host's paths as the default entries, the Rust port's subset for version 1, `flow`, the HTTP
  relay and the dual service refused by name, `upload` and the content-type extras deferred; proof by the shared
  `rest-automation-vectors.json` byte-identical with the Python pack, the engines' `rest-automation.json` as a fixture
  and the Rust port's 33 tests as the checklist. Build order when the shape is ruled: the Python pack first, this
  twin from the same vector file, the README and the engines' polyglot guide, a live drive. First adopters
  afterwards: the hand-mounted routes of the agent-question app and the ask-person flow.
  - **Step 2 BUILT 2026-11-25 (the Node twin, started by the maintainer after the Python pack's #83, #84 and #86
    merged; branch `claude/rest-automation-b7c805`, raised as PR #146 and MERGED 2026-11-25, merge `109c506`):** `src/rest-routing.ts`
    (the parser with the engines' messages and the pack's refusals by name, the default entries, the matching with
    the engines' precedence, `keep` over `drop`, `parseTimeout`, the body dispatch, query and cookie parsing, the
    `Accept` negotiation, the rendering and the response mapping), `src/async-http-request.ts` (`AsyncHttpRequest`,
    `UploadedFile`, exported), `src/rest-automation.ts` (the edge on `node:http` in front of the host's paths, an
    extension's routes and the static folder: the match, the `/` fallback, 405, the preflight, the built-in services
    through `Actuator.byService`, the request preparation, authentication, the RPC and the interceptor sink, SSE and
    chunked streams, upload through the runtime's `Response.formData()` with the raw body capped at the bound plus
    the parts' headroom, the static-content filter and no-cache pages, the bare 404). The vector file copied byte for
    byte (version 2, 129 cases, SHA-pinned), 51 tests mirroring the Python checklist, the demo's `hello.rest`, the
    helper's `llm.upload` with `test/llm-upload.test.mjs`, README, CHANGELOG Added 12 and 13; `npm test` green.
  - **Defaults set without a ruling (mirrored from the Python pack, plus the Node twin's own):** the edge decodes the
    path and keeps the query string as the Python edge receives it (`&`, `=`, `+` escapes kept); the built-in
    `event.api.service` is not raced against the entry's timeout (its own `x-ttl` bounds it), the actuators are; a
    multipart body past the bound plus 1 MiB is a 413 before parsing; the `yaml` package reads `rest.yaml` as
    YAML 1.1 with duplicate keys tolerated, PyYAML's reading.
  - **First adopters BUILT 2026-11-25 (Eric: "please refactor the hand-mounted routes with rest.yaml"; branch
    `feat/rest-first-adopters`, raised as PR #147 and MERGED 2026-11-25, merge `387a15d`):** the ask-person reply page and endpoint and the agent-question
    browser side are `rest.yaml` entries of their applications, each a private function reading the `AsyncHttpRequest`
    map; `Platform.addRoutes` is no longer used by either. The stream is an interceptor behind `stream: true` with a
    no-body heartbeat segment (the edge writes nothing for it, renews its idle allowance, and its drop closes the
    writer - a core change in `EventStreamWriter`). Defaults set without a ruling: the functions reply with the exact
    bytes as text with a content type (a map body would be pretty-printed with its nulls omitted, and the React UI
    reads nulls); the SSE `id:` line is gone (the UI keeps its cursor from the row's `seq`); the stream's instances
    200 bound the devices; the entries' timeouts exceed the apps' engine and reply timeouts. The Python twins' refactor
    was in flight the same hour with a shape of its own; it merged as mercury-python #87.
  - **ALIGNED to the Python shape 2026-11-25 (Eric: "Python PR merged, please align the Node shape"; branch
    `refactor/first-adopters-python-shape`, raised as PR #148):** the route names `ask.config`/`ask.page`/
    `ask.wait`/`ask.reply` and `question.config`/`question.list`/`question.events`/`question.decide`/`transcript.list`/
    `transcript.show`; the entries' `authentication` functions `ask.identity`, `ask.reply.identity` and
    `question.identity` leaving `who`/`via` in the session map (a refusal the engines' standard error body; the
    ticket's `expired` and the engine's `nothing-waiting` bodies unchanged); the stream opening its head at once with
    a day's idle allowance and following the feed off the worker (10 instances), the entry's `X-Accel-Buffering: no`
    header block; the rest.yaml files copied from the Python pack. Two host changes mirrored: a keep-alive comment that
    cannot be written ends a stream and closes its sink (`CLIENT_GONE` from `nextSegment`, both edges), and
    `EventStreamWriter.connected` over `EventBus.hasSink`; the writer still closes on a dropped segment (Node only,
    a superset). The exact-bytes replies and the dropped `id:` line were already the same decision in both packs.
  - **Next:** a live drive of the Node edge through an engine with the trace lineage checked; the engines' polyglot
    guide; the Python twins' first adopters.
  → proposal: RFC-0018 (mercury-composable)
  → serves: vision-mercury-nodejs
  <!-- id: bp-rest-automation-nodejs | created: 2026-11-24 | last_used: 2026-11-25 | uses: 4 | tier: working | origin: 2026-11-24-235244 -->
