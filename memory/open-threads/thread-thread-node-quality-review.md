- [x] (planned — Eric, 2026-08-23; **EXECUTED 2026-08-24 and MERGED same day as
  [PR #88](https://github.com/Accenture/mercury-nodejs/pull/88), true merge `2a0d8f8`
  carrying `a73332f` (17 commits, tree verified, branches deleted both ends);
  51/51 green throughout — 12 Sonar rules cleared incl. the shared asText
  (positive-narrowing lesson), two S3776 extractions, the linear call-site parse, and
  the EventEmitter rationale now in bus.ts's header; + the loose-ends round: engine-
  parity index page, pretty JSON, {status, message, type: error} host errors
  (`956c706`, 51/51); PENDING Eric's PR gate**)
  **Code quality review round for mercury-nodejs** — the node twin of the python quality round (mercury-python
  PR #16 class: IDE/Sonar screenshot-driven; node has so far received only preemptive
  mirrors of python findings, never its own review pass). After it: P4 on the polyglot
  initiative (docs chapter + examples demo on the engine repos, interop-report extension,
  ADR-0016 proposal, fresh CI workflows for both wrapper repos — these PRs ran only the
  agent-memory check). Review agenda item (Eric's parting question): document in bus.ts's
  header WHY the Mailbox is hand-built instead of EventEmitter — emitter = broadcast
  notifier (all listeners, no backlog, no anycast, MaxListeners warning at instances>10);
  the bus contract = anycast FIFO work queue with N bounded workers, i.e. node's missing
  asyncio.Queue — and bare-promise waiters keep the idle bus handle-free (the lifecycle
  ruling).
  <!-- id: thread-node-quality-review | created: 2026-08-23 | last_used: 2026-08-24 | uses: 2 | tier: active | origin: 2026-08-23-031920 -->
