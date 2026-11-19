# Changelog

## Unreleased

### Added

1. **The built-in agent tools - files inside one workspace, the web inside an allowlist, the agent's knowledge graph
   inside one database, and a clock (RFC-0013 in mercury-composable), in lockstep with the Python pack (mercury-python
   #63 and #64).** `extensions/agent-tools/agent-tools.mjs` serves twelve composable functions an agent loop names in its
   tool catalog: `file.read`, `file.write` (`write: true`, `create` the default and refusing an existing file),
   `file.list`, `file.search` and `file.extract` (PDF through pdfjs-dist, Word through mammoth, HTML and text, with page
   markers) inside `tools.file.root` - every path relative to the root, resolved with symbolic links followed and
   refused outside it, hidden entries invisible unless `tools.file.hidden=true`; `web.fetch` and `web.crawl` inside
   `tools.web.allow` - https unless a host is listed with `http://`, the host resolved and every address checked against
   the loopback, private, link-local and multicast ranges before the request goes to the checked address (a pinned
   `lookup` on `node:http`), every redirect checked again, the body cut at `tools.web.max.bytes`, HTML reduced to
   readable text or Markdown by a small in-house tokenizer, a crawl same-host, breadth-first, `robots.txt` honoured by
   an in-house parser, bounded by pages, depth, an include prefix and a delay; `graph.schema`, `graph.query`,
   `graph.write` and `graph.ingest` over `neo4j-driver` in openCypher (`tools.graph.uri`; the reads register when the
   URI is set, the writers only with `tools.graph.write=true`, `DELETE` and `DROP` refused unless
   `tools.graph.delete=true`; every statement in a managed transaction with the configured timeout server-side; a query
   refused before sending when it carries a write clause outside a string or a comment; an ingest merging a model's
   extraction idempotently with every value a parameter and the relationship endpoints checked inside the transaction;
   the schema from Neo4j's or Memgraph's procedures); and `time.now`. A tool whose sandbox is not configured does not
   register; every refusal is a 400 naming the rule and the key. Each tool ships its catalog row as a constant, as a
   file under `extensions/agent-tools/catalog/` - byte for byte the Python pack's files, pinned by a test - and through
   `node agent-tools.mjs describe`, which also says what registers under the current configuration. `tools.health`
   reports the routes, the workspace, the allowed sites and the graph's address. neo4j-driver, mammoth and pdfjs-dist
   are dev dependencies of this repository, installed by the application that runs the graph tools or `file.extract`;
   the file, web and clock tools need nothing beyond the package. `dev/graph-up.sh` and `graph-down.sh` run Neo4j
   Community on Colima for development. Pinned by `test/agent-tools.test.mjs` (a temporary workspace with an escaping
   link, a fixture site served in-process, a fake graph backend, a PDF generated in the test and a Word fixture) and a
   live round trip against the development Neo4j when `TOOLS_GRAPH_TEST_URI` is set.

2. **The transcript audit store: a durable, queryable record of every model turn (RFC-0012 in mercury-composable), in
   lockstep with the Python pack (mercury-python #59).** The LLM helper's transcript store is a working store - its time
   to live is the transaction's, and `retention` deletes a record at the end of the run by default - so an audit had no
   store to ask. `llm.transcript.audit: postgres` adds one beside it. Every turn is recorded asynchronously, off the
   turn's path: after the compare-and-set accepted a turn, `llm.chat` sends one local event to `transcript.audit`, a
   private composable function of the helper's process with one instance, whose mailbox orders the writes and the
   end-of-run check of a conversation without a lock. The function reads the working record - version 2 now, carrying
   each turn's facts inside the same compare-and-set (trace id and path, correlation id, the UTC bounds of the model
   call, outcome, usage) with the system prompt, the catalog and the graph context stored once - and writes the rows
   PostgreSQL lacks: a conversation row (identity, status, turn count, times, token totals, the first-turn snapshot) and
   a turn row per model turn (the messages the turn sent as `request`, the assistant content blocks as `response`, the
   normalized `calls`), the provider's format as sent and as returned. A closing turn sends the integrity check behind
   its write: the turns the record holds are counted against the rows the store holds, the missing ones written, and
   only then is the working record released to the `retention` it carried (`0` deletes it); until then it waits with
   `llm.transcript.audit.grace` (`1d`). A sweep (`llm.transcript.audit.sweep.ms`, 60 s, one replica per interval on
   Redis) sends a check for every record whose audited mark - a third hash field beside `turn` and `record` - lags its
   turn count: the runs the loop stopped and the writes a dying process lost. A failed write is logged by type and
   SQLSTATE, never by content, and never refuses a turn. The `pg` package is the driver, a dev dependency here like the
   SDK and `redis` (`npm install pg`); a configured driver that is not installed stops the application by name, a
   database that does not answer at boot is logged and repaired by the sweep. `extensions/llm-helper/schema/postgres.sql`
   and `purge.sql` ship the reference schema and the purge, byte-identical with the Python pack (retention and purge are
   the installation's; `expires_at` is written from `llm.transcript.audit.retention`, `365d`), `dev/postgres-up.sh`,
   `postgres-down.sh` and `audit-purge.sh` the development setup on Colima with pgweb as the SQL browser. `llm.chat`
   records the loop's `x-graph-id` and `x-node` headers at the first turn; `llm.health` reports `transcript_audit`.
   Pinned by `test/transcript-audit.test.mjs` on the memory store and a recording fake of the connection pool, and a
   live test gated on `LLM_TRANSCRIPT_AUDIT_TEST_URL`; the shared loop vector file is unchanged, since the audit is a
   side effect of a turn and not part of the loop contract. **Upgrade note:** none without `llm.transcript.audit`. A
   record saved by the previous helper (version 1) continues under the new one; its turns before the upgrade carry no
   facts, and the check logs them as unaudited.

3. **Recipes for tools from existing MCP servers (RFC-0013 in mercury-composable, step 5), in lockstep with the Python
   pack.** `extensions/mcp-binding/resources/mcp-recipes.yml` holds one ready server-file entry for each server of the
   engines' page *Tools from MCP Servers* - the reference servers Git, Time, Fetch and Filesystem (`uvx` and `npx`,
   versions pinned), Neo4j's Cypher server, GitHub's hosted server and Playwright's browser - with every
   environment-specific value a `${NAME:default}` reference and every credential a reference without a default. The
   binding does not load the file; an entry is copied into `mcp-servers.yml` and its tools declared with `bind` as
   before. `test/vectors/mcp-recipes.json`, shared byte for byte with the Python pack, pins the input-schema digests of
   all seven servers (95 tools, read 2026-11-18 through both packs' `describe`, identical; GitHub's hosted server with a
   maintainer's token - 39 tools of its three default toolsets, 22 of them under the read-only header), and
   `test/mcp-recipes.test.mjs` loads the recipes file on every run and, with `MCP_RECIPES_LIVE=1`, starts each server
   through the binding's own client and compares the digests (GitHub's when `GITHUB_MCP_TOKEN` is set, in both modes),
   so a recipe that rots fails by name.

4. **Ask a person, the main flow (RFC-0014 in mercury-composable, build plan step 1), in lockstep with the Python
   pack.** `extensions/ask-person/ask-person.mjs` serves `person.ask`, the composable function a graph's hold path calls
   before it suspends for a person: the message names the graph (`graph_id`, `description`, `node`), the transaction
   (`correlation_id`, `turn`), the waiting `calls` as the loop returned them and the suspension's `ttl`; the function
   issues a signed, stateless ticket (`v1.<payload>.<mac>`, the canonical payload and its HMAC-SHA256 under
   `ask.ticket.key`, a previous key verifying after a rotation), builds the resume link and sends the whole message as
   one event to every route in `ask.channels` - the agent-question app's intake, a chat poster, a mail sender, a topic
   publisher - knowing nothing of what a route does with it; a channel that fails is logged by type and never fails the
   hold. `kind: advice` travels with no ticket and no link. The resume link opens the wait on the process's reply page,
   `GET /ask/{ticket}`, read from the engine by the reference graph's re-advice and never resuming; `POST /ask/reply`
   with `{ticket, decisions}` verifies the ticket, maps the graph id to the engine's entry through the `ask.graphs`
   allowlist, prefixes who decided and when to each tool call's note, sends the resume and returns the engine's outcome;
   an expired ticket is a 410 without a call to the engine. Who may answer is `ask.reply.auth`: `none` (development),
   `proxy` (the gateway's trusted header) or `oauth2` (an access token validated against the issuer's keys with `jose`,
   imported on first use), and a channel app's bearer with `decided_by`. The host gains `Platform.addRoutes` and
   `EventApiServer.createServer(routes)`: an extension mounts its own pages and streams after the host's paths and
   before the catch-all. Pinned by `test/vectors/ask-person-vectors.json` (72 cases, byte-identical with the Python pack
   - the ticket's HMAC reproduced from the file alone) and `test/ask-person.test.mjs` (97 tests). **Upgrade note:** none
   - `addRoutes` is additive.

5. **The agent-question app: a store-and-forward inbox for the person an agent asks (RFC-0014, build plan step 3), in
   lockstep with the Python pack.** `extensions/agent-question/agent-question.mjs` is a standalone application on the
   package and the first channel of the design; the main flow knows nothing of it. `agent.question.inbox` is the intake:
   a wait is upserted on `(graph_id, correlation_id, turn)` and an advice appended, the row committed before any push.
   The person's side runs under the host: `GET /questions/app` (the page), `GET /questions?since=<seq>` (the replay a
   reconnecting device calls first, with the cursor to continue from), `GET /questions/events` (the stream,
   `Last-Event-ID` the same cursor), `POST /questions/{id}/decide` (the automated click: `{ticket, decisions,
   decided_by}` to the link's own base under the app's bearer, the outcome recorded and broadcast; accepted →
   `answered`, nothing waiting → `expired`, refused or unreachable → `open`) and `POST /questions/{id}/seen`. A sweeper
   and every replay expire open waits past their expiry. The inbox is memory (development) or PostgreSQL
   (`question.inbox: postgres`, the `pg` driver, `schema/postgres.sql` and `purge.sql` byte-identical with the Python
   pack, `dev/schema-apply.sh` for the helper's development database). Who may use the page is `question.auth`: `none`,
   `proxy` or `oauth2`. Pinned by `test/vectors/agent-question-vectors.json` (30 cases, byte-identical - the reference
   inbox replayed on the scripted sequence lands on the same rows, ids and change sequence) and
   `test/agent-question.test.mjs` (48 tests; a live PostgreSQL gated on `AGENT_QUESTION_TEST_URL`). **Upgrade note:**
   none - a new application.

### Fixed

1. **The agent-question app keeps the first accepted decision when two devices decide one card at the same moment**
   (RFC-0014 step 5, the live drive of 2026-11-19), in lockstep with the Python pack. Both clicks pass the open check and
   reach the engine, which resumes at most once; the device that lost got `nothing waiting`, and the row took whichever
   outcome landed last - so a late 410 could overwrite the accepted decision and its operator. A decision's write now
   applies when the row is still open or when the engine accepted the decision (`state = 'answered'`), in the memory inbox
   and in `SQL_DECIDED` alike; a refused write answers the losing device with the row as it stands, and nothing is
   broadcast for it. The shared vectors are version 2 with the two-devices transition case, byte-identical with the Python
   pack and SHA-pinned. **Upgrade note:** none - the schema is unchanged.

### Changed

1. **`web.crawl` accepts a relative `include`**, in lockstep with the Python pack: a prefix that does not start with `/` matches
   anywhere in a link's path, since a model names a section as `guides/` as often as `/guides/` (the live drive of the
   Playground's `site-notes` graph showed a crawl returning the start page alone). The README's Event-over-HTTP example lists
   one route per entry - the engines' map takes no comma-separated list.

2. **CI runs the tests on Node 26, the current LTS, and the package's floor is `node >= 22`, the oldest maintained LTS
   (Eric, 2026-11-17: Node 20 is end of life).** The agent tools' directory walk is in-house (`compileGlob`): the in-house
   matcher reads a pattern as the Python pack's `Path.glob` does and never descends into a symbolic link.

2. **A `-D` override value is resolved with the same `${ENV_VAR:default}` substitution as a file value - the engines'
   change of the same day.** `AppConfig.get` returned an override as written, so a key moved from `application.yml` to
   a `-D` flag silently lost its substitution and a credential had to travel on the command line in clear. Now the value
   of a `-D` override (and of `appConfig().set`) - an environment variable with a default, or a reference to another
   configuration key - is resolved the way a file value is, at read time, so `-Dkey='${ENV_VAR}'` keeps the secret out
   of the process list and container `args` arrays, which do no shell expansion. In lockstep with the Python pack.
   **Upgrade note:** a `-D` value that relied on a literal `${...}` is now resolved, as a file value always was; an
   unresolved reference without a default is no value, as in a file.

2. **The transcript audit store's PostgreSQL pool sets a server-side `statement_timeout` from
   `llm.transcript.audit.postgres.timeout.ms`, beside the client's `query_timeout`.** The live drive of 2026-11-17
   (mercury-composable `docs/test-reports/transcript-audit-live-drive.md`) showed a stopped database failing a write by
   type within the connection timeout, as designed, but a paused one - a TCP black hole - holding the pooled connection's
   statement, and with it the audit function's mailbox, for the outage's length. The statement now times out on the
   server after the same `timeout.ms` as well, so a stalled database behaves like a stopped one: a logged failure,
   repaired by the sweep. In lockstep with the Python pack. **Upgrade note:** none.

## 4.12.30 (2026-11-16)

The catch-up round with the engines: the pack moves from 4.12.21 to 4.12.30, the number the Java engine released on
2026-11-05 and the Rust port caught up to (a version names content, not a cadence; a pack catches up when functionality
crosses from the engine to the language packs) - in lockstep with the Python pack. This release carries the pack's half
of the engines' agent loop (ADR-0033): `llm.chat` serves one model turn of `llm.run` with the transcript in the helper's
own store, in memory or on Redis (Added 2); the LLM helper reaches Claude through AWS Bedrock as well as the Claude API
(Added 1); and the new MCP binding, `extensions/mcp-binding/`, declares a tool of an MCP server as a composable function
with the digest of its input schema pinned in code (Added 3) - all driven live end to end from the Java engine through
this pack (`docs/test-reports/agent-loop-live-drive.md` and `agent-tool-use-live-drive.md` in the engine repository).
The host leaves the trace records a Java or Rust callee leaves, so a span lineage stays continuous from an engine into
this pack (Changed 4); `preload` takes route aliases (Added 4); the JSON log presentations label the emitting logger
`source` (Changed 5). The published package keeps its two runtime dependencies and no LLM or MCP SDK. **Upgrade notes:**
the LLM helper lives in `extensions/llm-helper/` (Changed 2), and the `resources` folder is resolved next to the
application file, never in the working directory (Changed 1).

### Added

1. **AWS Bedrock as the LLM helper's second backend (`llm.backend: 'bedrock'`).** The helper reaches the same Claude models
   through the SDK's Bedrock client (`@anthropic-ai/bedrock-sdk`, installed beside `@anthropic-ai/sdk`), signed with the AWS
   credential chain through IAM (`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, a profile, a role) or a Bedrock API key in
   `AWS_BEARER_TOKEN_BEDROCK` - no vendor API key, the platform-mediated access an enterprise security policy asks for. The
   region comes from `llm.aws.region` or `AWS_REGION`, and without one the helper answers `503 AWS region missing` instead of
   starting a call. A bare model id is sent with the `anthropic.` prefix and an id already spelled for Bedrock as written;
   server-side refusal fallbacks are never sent there (Bedrock offers none); a call whose credential chain is empty is a
   `503 AWS credential missing` by name. `llm.health` reports `region` beside `backend` and `model`, and its check resolves the
   credential chain the way a call would, without spending a token. Bedrock serves Claude on two surfaces and an account may
   be enabled for one only: `llm.aws.api` selects `mantle` (the default, the Anthropic-shaped endpoint with the prefixed ids)
   or `runtime` (the classic one, every model id sent as written - an inference profile id as the account lists it), and
   `llm.health` names the surface. Certified live on 2026-10-14 against an enterprise account, negative controls first (a
   wrong secret a 401 by name, no credential a 503 by name), then a chat reply, a structured verdict and a progressive stream
   on Haiku 4.5 through the runtime surface, from both packs and through the Java engine's shipped triage graph and streaming
   relay (the engines' `docs/test-reports/llm-helper-certification.md`, Scenario 8, and this pack's own report). The routes and the contract are unchanged: the shared
   vector file gains five Bedrock cases (68), byte-identical with the Python pack, and the Bedrock clients, their region and
   credential checks are pinned by unit tests. **Upgrade note:** none - the Claude API backend is the default and behaves as
   before; `llm.backend` now also accepts `bedrock`.
2. **The loop contract: `llm.chat` serves one model turn of the engines' agent loop (RFC-0011)** - the twin of
   mercury-python #47. A request that carries `tools` is a turn of `llm.run`, the agent loop of the Java and Rust engines,
   which dispatches each tool call to a composable-function route. The transcript stays in the helper's own store and the
   loop holds a reference to it: the first turn returns `conversation` and `turn`, a later turn sends them back with
   `results` (`[{id, output}]` or `[{id, error}]`), and the helper appends the one `tool_result` message, in call order, and
   the model's turn exactly as the API returned it, thinking blocks included. The reply carries `status` (`done`,
   `tool_use`, `refusal` or `cap`), `calls [{id, name, input}]`, the cache usage, and `cap` (`max_tokens` or `context`) for
   a cut-off turn, whose calls never run. A stale turn count, or a turn on a run that has ended, is a 409, and each write is
   a compare-and-set on the count, so a duplicated turn can never fork a conversation; an ended or expired one is a 404.
   The model is pinned at the first turn, server-side refusal fallbacks are never sent on a loop turn, and the helper
   places the cache breakpoints. `llm.transcript.store` names the store: `memory` for one process, `redis` for any number
   of replicas (the `redis` package, a dev dependency here like the SDK; one hash per conversation under
   `transcript:{conversation}` and the Python twin's Lua compare-and-set, so the two packs can share one Redis; a
   connection from the `llm.transcript.redis.*` keys, a command timeout and no offline queue). Every write sets the
   record's time to live to the turn's `ttl` (default `7d`), and a run the model ends takes `retention` (default `0`,
   which deletes the record). The shared `test/vectors/llm-loop-vectors.json` (66 cases), byte-identical with the
   Python pack, runs on the memory store, a Redis fake, and a live Redis when `LLM_TRANSCRIPT_REDIS_URL` names one.
   **Upgrade note:** a request without `tools` behaves as before. `tools`, `conversation`, `turn`, `results`, `ttl` and
   `retention` are now fields of the loop contract: on `llm.chat` they need `tools`, and on `llm.stream` any of them is a
   400. A loop turn needs `llm.transcript.store`; the sample configuration sets `memory`.

3. **The MCP binding: `extensions/mcp-binding/`, a composable function per MCP tool (RFC-0011 / ADR-0033, build plan
   step 4; the declaration shape of the engines' `draft-design-specs/agent-tool-use.md`, 2026-11-16)** - in lockstep with
   the Python pack. A library and a function host on the official MCP SDK (`@modelcontextprotocol/sdk`, a dev dependency
   of this repository and the app's own dependency outside it). A tool of an MCP server is declared where every route is
   declared, in the code: `const render = bind('mermaid', 'validate_and_render_mermaid_diagram', { schemaSha256: '5ae6…' })`
   names the server, the remote tool and the SHA-256 digest of its input schema in canonical JSON and returns the tool as
   an async function, and an ordinary `preload` function (`mermaid.render`) calls it - passing the arguments through,
   shaping them or adding behaviour around the call. A route names the capability, never the transport: a tool may start
   as an MCP tool and later be implemented another way, and the graph must not know. Servers are named in
   `resources/mcp-servers.yml`, each with what is environment-specific: its transport (`stdio` with a command this process
   starts, or `http` with a streamable HTTP URL), its credential references (`${VAR}` placeholders resolved from the
   environment at boot, never logged; a stdio subprocess gets the SDK's default environment plus the variables listed) and
   its call timeout. Boot connects every server a function binds a tool of, before the host listens, lists its tools and
   refuses to start - by name - when a bound server is not configured, a bound tool is missing or its schema no longer
   matches the pinned digest, so a server-side change stops a deploy instead of reaching a model at run time; a configured
   server nobody binds is not connected. A function's body is the tool's arguments (a map, else a 400); its reply is the
   server's structured content, else the text of its content blocks; a result marked `isError` is a 400 carrying the
   server's text (the agent loop returns it to the model as that call's error), a slow call a 408, a protocol failure a 502,
   a server not connected a 503. `node mcp-binding.mjs describe [server]` prints each tool's digest, the `bind` line to
   paste and a catalog row for the graph, for the developer to review: the model reads the graph's descriptions, never the
   server's. `mcp.health` reports each connected server and how many tools its functions bind. Out of the box the default
   server file names the public Mermaid Chart MCP endpoint and the extension's `mermaid.render` binds its one tool, so the
   binding starts and serves a tool with no credential. The shared vector file `test/vectors/mcp-binding-vectors.json`
   (version 2; the Python twin runs the same bytes) pins the digest, the verification of declared bindings and the result
   mapping; the rest of the tests drive a fixture MCP server of this repository over both transports. The first shape of
   this binding (built 2026-11-14, before any release) read a `tools` allowlist under each server and registered each
   tool's route at boot as an alias of a private `mcp.tool` function; it is gone, and a leftover `tools` key is refused by
   name. **With it, `Platform` gains `onStartup(callback)`, `onCleanup(callback)` and `shutdown()`** - async callbacks run
   before the host listens and at shutdown (SIGINT and SIGTERM are handled only when a cleanup callback is registered), the
   place for an extension's asynchronous boot work; the routes a callback registers are announced with the others.
   **Upgrade note:** none - nothing changes for an application that registers no callback.
4. **Route aliases: `preload` takes one route name or a comma-separated list** - in lockstep with the Python pack.
   `preload('hello.declarative, hello.world', { instances: 10 }, handler)` registers the same function under every name
   with the same `instances` and visibility - the Java engine's `@PreLoad(route = "a.b, c.d")` and the Rust port's
   `#[preload(route = "a.b, c.d")]`; before, the function took one name and a list failed as an invalid route name. The
   value is split on commas and whitespace as the Java engine splits it, empty segments are dropped, every name is
   validated and a repeated name counts once; a value with no name is refused with the engine's words (`missing service
   route(s)`). Each alias has its own mailbox and workers, its own line in the startup log and its own row in
   `/info/routes`, and a handler reads the name it was called as from `getTrace().route`, the engines' `my_route`.
   `FunctionRegistry.register` still takes one route, as the engines' `Platform.register` does; `splitRoutes` is
   exported beside `validateRoute`. The demo app shows it: `hello.world` is an alias of `hello.declarative`.
   **Upgrade note:** none - a single route name behaves as before.

### Changed

1. **The `resources` folder is the one next to the application file; the working directory is never searched.**
   `mercury-serve app.mjs` (`node dist/src/cli.js app.mjs` in this repository) reads `resources/application.yml`
   (`.yaml`, `.properties`) beside `app.mjs`, wherever the command runs from, and an application that starts the
   platform itself resolves the folder beside the script Node ran - the engines' classpath convention: the configuration
   travels with the application and does not depend on the launch directory. Before, the working directory was searched
   first and the application's folder only as a fallback, so a stray `resources/` in the launch directory could shadow
   the application's own. `--config <file>` still names another file; the companion `app-log-context.yaml` follows the
   same folder; `appConfig().source` is now the absolute path of the file found and `appConfig().resourcesDir` names the
   folder; the startup log reports `Configuration: <path>`. **Upgrade note:** an application that kept `resources/` in
   the working directory with its application file elsewhere passes `--config`, or moves the folder next to the file.
2. **The LLM helper graduates from an example to an extension: `extensions/llm-helper/`.** It is no longer a sample to copy
   but a function host an installation runs to give its engines an LLM, so it moves out of `examples/`, which keeps the
   demo app - in lockstep with the Python twin (mercury-python #46). The files, the routes, the contract and the
   configuration keys are unchanged; the npm package ships neither folder. **Upgrade note:** start it as
   `node dist/src/cli.js extensions/llm-helper/llm-helper.mjs` in this repository; a script or a deployment that names
   the old path changes it.
3. **The Scope allows one subprocess: an MCP server reached over stdio (2026-11-03)** - in lockstep with the Python twin
   (mercury-python #49). A function still runs in the pack's own process. The pack may run a stdio MCP server as its child
   process, which is the reason the MCP clients of the engines' agent loop (RFC-0011) live in the language packs and not
   in the engines. Nothing starts one yet: the stdio MCP binding is a later step. The README's Scope also says the LLM
   helper is an application on the package, whose `llm.chat` is a stateless chat or a loop turn with a configured
   transcript store. **Upgrade note:** none.
4. **Tracing: the host leaves the records a Java or Rust callee leaves, so a span lineage is continuous from an engine
   into the pack** - in lockstep with the Python twin. A live drive of the engines' agent loop through both packs
   (2026-11-14) found the pack legs absent from the trace: the calling engine's HTTP client leg is in `skip.rpc.tracing`
   by default and the host suppressed its own record for every RPC-served execution, so `llm.chat` and an MCP binding's
   route appeared only as time inside the engine caller's span. Now a traced call arriving at `/api/event` leaves
   `http.request` (`POST /api/event`, the edge's round trip, parented onto the caller's span - the envelope's span, else
   the `traceparent` header's; the backend's SERVER span), `event.api.service` (the ingress, parented onto the edge) and,
   for an RPC, the function's round-trip record with the responder's span and `round_trip`, parented onto the service -
   the records REST automation, `EventApiService` and `InboxBase` leave in the Java engine; a drop-n-forget or streaming
   function's own record parents onto the service; a refusal or a timeout leaves the edge record with its status. A reply
   now carries the responder's span (`WorkerHandler` parity), and the `PostOffice` records a local RPC round trip the
   way an engine inbox does. An untraced call records nothing. **Upgrade note:** a backend shows three more spans per
   traced call into the pack and one per traced local RPC; a dashboard that read the pack's response time off a
   function's span moves to the `http.request` edge record, as for the engines.
5. **The JSON log presentations label the emitting logger `source`, as the Java engine's JSON layout does** - in
   lockstep with the Python pack. A line written with `log.format=json` or `compact` carried the logger under `logger`
   (`"logger": "distributed.tracing"`), where the Java engine writes `source`; a polyglot installation that reads both in
   one aggregator now finds the field under one name. The value is unchanged (a logger's name, or an unnamed logger's
   call site as `name:line`), and so are `time`, `level`, `message` and `context`; the `text` presentation is untouched.
   **Upgrade note:** an aggregator query or dashboard field that read `logger` from this pack's JSON lines reads `source`.
6. **Code quality: the findings of a local SonarQube round (2026-11-16) in the package, the extensions and the test
   fixture, with no behaviour change** - in lockstep with the Python pack. Optional chains where a value was tested for
   `undefined` first; the protobuf writer's buffer is `readonly`; the span mapper writes a type tag, never
   `[object Object]` by accident, for a structure JSON cannot serialize; the bus awaits a handler inside its traced
   callback and reads a failure's status without a nested ternary; the fixture MCP server marks the promises it drops.
   The LLM helper's duration pattern uses `\d`, its done-stop set is a `Set`, `bedrockBackend(client, name, api)` takes
   its defaulted parameters last, and its sorts take an explicit comparator; the MCP binding's server parser is split by
   transport, its `describe` spells a tool's state without a nested ternary, it reads the server file's name as a
   string, and its sorts take the same comparator - one that keeps the code-unit order Python's `sorted()` gives, so the
   canonical JSON behind every shared digest is unchanged. **Upgrade note:** none - `bedrockBackend` is called by the
   helper itself (`backendFor`); an application that called it directly swaps the first two arguments.

7. **Code quality: the cognitive-complexity findings of a second local SonarQube round (2026-11-16), with no behaviour
   change** - in lockstep with the Python pack. The two functions above the threshold of 15 are split along their
   natural seams: the Event API host decodes the request body and delivers an RPC in helpers of their own, and the
   interceptor dispatch reads the caller's `accept` header itself; the OTLP response decoder reads the `partial_success`
   block and its fields in one helper each, the same shape as the Python twin. The span mapper, at the threshold's edge,
   takes the twin's split too: the start time, the status and the attributes apart. Every check runs in the order it did
   and writes the message it did, so the shared vector files pass unchanged. **Upgrade note:** none.

## 4.12.21 (2026-10-07)

The lock-step round with the engines: the pack moves from 4.12.15 to 4.12.21, the number the Java engine and the
Rust port ship in the same round (a version names content, not a cadence). This release carries the LLM helper app -
`llm.chat`, `llm.stream` and `llm.health` on the official Anthropic SDK, certified in front of both engines with real
Claude calls (`docs/test-reports/llm-helper-certification.md` in the engine repositories) - and the stricter contract
and the example layout that came with it; read the two READ notes under *Changed* before upgrading an example.

### Added

- The **LLM helper app** (`examples/llm-helper/`): a dedicated function host for the AI nodes of the
  agent-orchestration experiment, on the official Anthropic SDK (default model `claude-opus-5-5`).
  `llm.chat` answers once, with optional JSON-schema structured output returned parsed as `data`;
  `llm.stream` relays the model's token batches over the multi-shot reply contract, each batch
  forwarded the moment it is produced and never gathered; `llm.health` reports whether a call could
  be sent, with no network traffic. The contract, the `llm.*` configuration keys, the error contract
  and the backend seam (AWS Bedrock through IAM is the planned second route) are in its README.
- One shared contract file, `test/vectors/llm-helper-vectors.json`, byte-identical in mercury-python:
  63 cases (request validation, the exact SDK call, replies, errors, streaming) run against a fake
  of the SDK in each pack, so the two helpers cannot drift apart. No token is spent, no credential
  needed. A separate test fails if a token batch is held back.
- A reply that carries nothing usable is an error, never an empty success: a refusal with no text, an
  empty reply, or a structured reply cut off before it is valid JSON is a 422 that names the
  `stop_reason`, the tokens spent and what to raise. A stream that ends before its first token fails
  with a 422 instead of an empty 200.
- Server-side refusal fallbacks (`fallbacks: "default"`) on the models that support them, switchable
  with `llm.fallbacks=off`; `request_id` in every reply and terminal event; usage on the trace
  record (`llm_model`, `llm_stop_reason`, `llm_input_tokens`, `llm_output_tokens`, `llm_request_id`).
- `llm.log.batches` (off by default): log each streamed batch's number, size and arrival time, never its
  text, to tell the hop that holds batches back from the one that forwards them. The certification drive
  used it to show that every batch the helper forwarded reached the engine edge as its own frame. It
  also showed that the cadence of progressive rendering is the API's and differs by model: Haiku 4.5
  streams continuously, Opus 5.5 in bursts about every 600 ms (documented in the README).
- `@anthropic-ai/sdk` as a **dev dependency** (the helper's SDK, and the tests' error classes). The
  published package keeps its two runtime dependencies and stays free of any LLM SDK.

### Changed

- The AI nodes moved out of the demo and onto the SDK. `examples/demo-app/demo-app.mjs` is the minimal
  polyglot demo again, with no LLM code; `llm.chat` and `llm.stream` live in
  `examples/llm-helper/llm-helper.mjs` on the same default port (8087) with the same request surface, so
  a graph that names those routes (the `support-triage` graph) works unchanged. They spoke the provider
  REST APIs through `fetch` before; they use the official SDK now.
- **READ - each example app now lives in its own folder**, with its own README and its own `resources/`:
  `examples/demo-app/` and `examples/llm-helper/`. The demo moved from `examples/demo-app.mjs`, and its
  sample configuration from `examples/resources/application.yml` to
  `examples/demo-app/resources/application.yml`. Start it with
  `node dist/src/cli.js examples/demo-app/demo-app.mjs`; the routes and the default port are unchanged.
  The demo imports `mercury-composable` by name, as the helper does, so the same file runs from a copy
  outside this repository.
- **READ - the contract is stricter than the demo nodes were.** A `params` key outside `provider`,
  `model`, `max_tokens`, `timeout_ms`, `effort` and `stop_sequences` is a 400 (the demo forwarded any
  key to the provider); a `schema` on `llm.stream` is a 400 (it was ignored); on `llm.chat`,
  `params.timeout_ms` bounds the whole call, retries included; provider errors read
  `LLM provider error - {status} {type}: {message} (request_id …)`.

### Removed

- `examples/llm-nodes.mjs` and the Gemini provider: the helper serves Claude only, so
  `-Dllm.provider=gemini` is now a 400 that names what is served.

## 4.12.15 (2026-09-22)

The lock-step round with the engines: the pack moves from 4.12.1 to 4.12.15, the number the Java engine and the
Rust port ship in the same round (a version names content, not a cadence). Interop evidence for this release:
the four-runtime OpenTelemetry certification drive of 2026-09-22 — this host's forwarder and `llm.stream` node
under both engines' edges, one connected trace per request, confirmed in the backend UI
(`docs/test-reports/otel-dynatrace-certification.md`). Off by default; nothing to configure.

### Added

- The **OpenTelemetry trace forwarder** (`otel` namespace, `src/otel/`), the lock-step twin of the
  engines' `opentelemetry-forwarder` extension: with `otel.forwarding=true` the host hands every
  distributed-trace dataset it emits to the engines' extension route `distributed.trace.forwarder`,
  where the built-in forwarder maps it to one OpenTelemetry span carrying the host's exact W3C ids
  and exports it over OTLP/HTTP (protobuf) through the runtime's `fetch` - the same `otel.*` keys,
  span mapping, per-export credential headers, retry policy and failure diagnostics as the Java and
  Rust forwarders. No OpenTelemetry SDK and no new dependency: the encoder is the Rust port's
  hand-written OTLP writer, ported. Off by default.
- The **AI nodes** `llm.chat` and `llm.stream` (`examples/llm-nodes.mjs`, joined to the demo app) - the
  Node.js twins of the Python demo's AI nodes of the agent-orchestration experiment E0: provider-neutral
  LLM adapters (Gemini and Anthropic behind one contract; select with `params.provider` /
  `-Dllm.provider=gemini`) spoken over their REST APIs through the runtime's `fetch` - no SDK, no
  dependency. `llm.stream` relays the provider's real token stream over the multi-shot reply contract,
  so a calling engine renders it progressively out its own HTTP edge; the terminal metadata carries
  model, stop_reason, usage and the trace / business correlation ids. Credentials: `GEMINI_API_KEY`
  (or `GOOGLE_API_KEY`), `ANTHROPIC_API_KEY`. The default Gemini model is the stable alias
  `gemini-flash-latest`.
- The `distributed.trace.forwarder` extension route itself (`DISTRIBUTED_TRACE_FORWARDER`): a
  function an application registers under that name receives every emitted dataset (routed without
  a trace, so the forwarder's own execution emits none) - the engines' zero-tracing forwarder contract.

### Changed

- The forwarder's span kind now follows the engines' connected-span-tree rule: the record whose
  `service` is `http.request` - an engine edge's round-trip record - is the `SERVER` span, and every
  function execution is `INTERNAL` (a record's `from` no longer decides the kind). A host's own
  records are function executions, so a backend now shows them as `INTERNAL` hops under the
  calling engine's edge span.

- The demo `application.yml` carries the `otel.*` keys switched off, wired to the
  `OTLP_API_ENDPOINT`, `OTLP_AUTH_HEADER` and `OTLP_TOKEN` environment variables, so
  `-Dotel.forwarding=true` at run time is enough to export to a backend.

## 4.12.1 (2026-09-01)

The first npm publication of the composable line: `npm install mercury-composable`.
No functional change over 4.12.0 - this release carries the publication metadata
(corrected homepage, bugs URL, keywords) on the lock-step version line. The npm
version lineage resumes here: the name's earlier third-party versions were fully
unpublished upstream, and the legacy pre-composable 4.3.x line is retired.

## 4.12.0 (2026-08-30)

The progressive-rendering milestone release. The version aligns with the Mercury
Composable engine lock-step line (Java and Rust engines, Python and Node.js
language packs all at v4.12.0): token/event streaming end to end with full
OpenTelemetry lineage, business-correlation continuity and application log
context across all four runtimes - useful on its own, and the foundation for
the AI SDLC (agent, MCP and tool adapters as wrapper-side functions with
complete observability). (The npm lineage jumps from the legacy pre-composable
4.3.x line directly to 4.12.0.)

- **Event streaming** - the platform-wide multi-shot reply contract, both halves.
  Producer: `preload(route, { interceptor: true }, handler)` handlers receive the
  raw envelope and stream through `EventStreamWriter` (the engines' exact API -
  `first`, `write`, `writeNamed`, `close` with trailing metadata, `fail` with the
  standard error key-values); the `/api/event` host answers a caller that accepts
  `text/event-stream` with the platform's hybrid SSE dialect (envelope frames for
  the head, the terminals and non-text segments; raw frames for text tokens),
  refuses a non-accepting caller of a streaming function with the pinned 406, and
  keeps single-shot replies over the capable path byte-identical. Consumer:
  `PostOffice.stream()` (an async iterator yielding the same decoded envelopes an
  engine reply route receives, with the dialect conformance guards) and
  `PostOffice.streamTo()` (the relay form: forward your caller's reply address and
  segments flow through verbatim - engine-parity composition). Under it all, the
  primitive event bus gained the engines' reply_to mechanism: envelope-routed
  delivery to a LOCAL function or per-request reply sink - simple routing, no
  orchestration. Same keep-alive config key as the engines
  (`event.stream.keep.alive`). Engine-identical wire and messages
  (Java PR #299-#301 / Rust PR #216-#218 lineage; python twin same round).
- **Business correlation-id continuity** (the engines' PostOffice parity): the
  client stamps the current context's business correlation-id onto outbound
  events as the engine-managed `my_cid` tag, local bus deliveries inject the
  read-only `my_correlation_id` header view exactly like the HTTP host, and
  `getTrace()` / `runWithTrace()` (now exported) carry `myCorrelationId` - so
  the business correlation-id continues across engine⇄wrapper and
  wrapper⇄wrapper hops.
- **Span lineage** (the engines' telemetry model): every traced execution mints
  a 16-hex span with the caller's span (from the inbound envelope) as its
  parent, outbound events carry the current span so the next hop parents onto
  it (`PostOffice.touch` parity, W3C `traceparent` included), streaming
  segments carry the producer's span, and non-RPC executions emit the engines'
  distributed-trace dataset record on the `distributed.tracing` log stream -
  the same `{"trace": {...}, "annotations": {...}}` shape the Java engine
  logs, so stdout log-ingest agents stitch spans across all four runtimes.
  RPC round-trips are suppressed exactly like the engines (the new `rpc`
  envelope tag rides `request()` calls). `runWithTrace()` accepts `spanId`
  to parent onto an external OpenTelemetry span. Outbound events and stream
  segments also fill their sender with the executing function's route, and
  the `/api/event` host fills `event.api.service` for an anonymous caller -
  the engines' sender-attribution rules.
- **Application log context** (the engines' app-log-context feature, on by
  default via the packaged `default-log-context.yaml` - the engines' resource
  twin): with `log.format` json/compact, every log line inside a traced
  request carries a `context` block - cid (the business correlation-id),
  traceId, tracePath, spanId, parentSpanId, service, timestamp - so app logs
  and the distributed-trace records correlate end to end. Customize with
  `resources/app-log-context.yaml` (reserved `$tokens` or constants with
  `${ENV:default}`), opt out with `app.log.context=false`, and add
  per-request key-values with `updateContext()` (reserved keys guarded).
- Documentation site (mkdocs-material, the engine repo's theme): the three-layer theme
  reference, rationale/design foundations (including the anycast-vs-EventEmitter
  rationale), function-writing patterns, flow and knowledge-graph join chapters, a
  one-page AI agent guide with llms.txt, and configuration/HTTP references - published
  to https://accenture.github.io/mercury-nodejs/ by the new CI workflow, which also
  runs the quality gate (tsc + node --test) on every push and pull request.
- Host polish for engine parity: `GET /` serves the engines' minimal index page linking
  the actuator endpoints (embedded - no static file service by design); actuator JSON
  responses are pretty-printed (the engines' default-serializer presentation); unknown
  paths and non-GET methods answer the engines' error shape
  `{"status": 404, "message": "Resource not found", "type": "error"}`.
- Actuator endpoints `/info`, `/info/routes`, `/env`, `/health` and `/livenessprobe` -
  the engines' operational surface, for Kubernetes probes and one-dashboard monitoring
  of polyglot installations. Health check functions are normal registered functions
  speaking the engines' `type=info` / `type=health` interface contract, listed in
  `mandatory.health.dependencies` / `optional.health.dependencies` and called through
  the event bus. `/health` answers `UP` (200) / `DOWN` (400); `/livenessprobe` follows
  the most recent health outcome.
- `log.format` carries the engines' three presentations: `text` (default), `json`
  (pretty-printed) and `compact` (single-line JSONL for log aggregators). A sample
  `examples/resources/application.yml` demonstrates the resources convention and the
  well-known keys.
- Primitive in-process event bus - the single dispatch pipeline: one FIFO mailbox per
  route consumed by `instances` worker loops (the parameter is faithful); RPC deliveries
  are ttl-bounded with a dead-work skip; drop-n-forget returns the 202-shape ack. The
  HTTP host and the local side of PostOffice are thin ingress adapters over it. No spill
  tier and no queue cap by design - back-pressure belongs to the engines' flows/graphs;
  a leaf host fails fast by deadline. An in-flight RPC holds the process open (at most
  until its deadline); an idle bus holds nothing.
- PostOffice without an endpoint delivers locally (engine semantics): private routes are
  callable in-app while the wire keeps its 403; headers pass verbatim; the reply envelope
  shape is identical to the remote path.

Repository repurposed for the Mercury Composable **polyglot initiative** (August 2026):
instead of re-porting the full composable foundation, the fresh start is a lightweight
wrapper of the engines' Event-over-HTTP protocol.

- Lightweight Event-over-HTTP function host (`POST /api/event`) mirroring the engines'
  EventApiService semantics (x-ttl execution bound, x-async drop-n-forget with 202 ack,
  reserved header hygiene, `my_cid` → `my_correlation_id` injection, portable error
  contract, engine-identical error messages).
- Standard event envelope wire format codec, verified against the golden conformance
  vectors shared with the Java and Rust engines; compact format detected and rejected;
  int64 beyond 2^53 kept exact as BigInt.
- `preload()` function registry with instance-count concurrency limits and private routes.
- `PostOffice` thin client with the engines' relay HTTP contract (octet-stream, x-ttl,
  x-no-stream, trace headers) for calling engine or peer polyglot functions.
- Minimalist utilities in engine-consistent style: `AppConfig` (`${ENV:default}`
  substitution, runtime overrides), logging in the reference log4j2 presentation
  (`log.format=text|json`, `LOG_LEVEL`), and distributed-trace context (AsyncLocalStorage)
  with reply annotations.
- `mercury-serve` developer runner.

The previous Node.js port of the full framework (up to v4.3.28) remains available in the
git history.
