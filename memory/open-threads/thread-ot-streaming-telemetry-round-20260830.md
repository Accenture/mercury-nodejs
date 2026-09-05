- [x] **Progressive-rendering round (streaming + telemetry).** Merged
  [PR #90](https://github.com/Accenture/mercury-nodejs/pull/90) (`40a9f8f` carrying
  `c0c28a6`); v4.12.0 lock-step. Lesson: tee (never swallow) stdout patches; detach
  worker loops from the creating caller's AsyncLocalStorage. origin: 2026-08-30-045557
  <!-- id: ot-streaming-telemetry-round-20260830 | created: 2026-08-30 | last_used: 2026-08-30 | uses: 2 | tier: active | origin: 2026-08-30-045557 -->
