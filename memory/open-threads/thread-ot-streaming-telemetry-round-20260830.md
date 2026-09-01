- [x] (feature — **MERGED 2026-08-30 as
  [PR #90](https://github.com/Accenture/mercury-nodejs/pull/90) true merge `40a9f8f`
  carrying `c0c28a6`; tree verified; v4.12.0 milestone, all four repos lock-step)
  **The progressive-rendering round: event streaming (engines' envelope-mode SSE
  contract, reply_to bus mechanism, stream/streamTo consumers), business
  correlation-id continuity, full span lineage with the engines' distributed-trace
  dataset on stdout, app-log-context with the packaged default template, sender
  attribution.** Lessons: tee (never swallow) process.stdout patches - the test
  runner's records ride it; detach worker loops from the creating caller's
  AsyncLocalStorage; RPC legs emit no dataset (engine parity).
  origin: 2026-08-30-045557.
  <!-- id: ot-streaming-telemetry-round-20260830 | created: 2026-08-30 | last_used: 2026-08-30 | uses: 2 | tier: active | origin: 2026-08-30-045557 -->
