- [x] **OpenTelemetry forwarder lock-step and the v4.12.15 milestone — CLOSED 2026-09-23: v4.12.15 PUBLISHED.** PR #105 merge
  `13426732`, tag `v4.12.15` → `4c43ffe`, GitHub release 01:39Z, npm 2026-09-23T02:34:09Z (`latest`, 44 files; a first attempt failed
  404 on an expired token — npm answers an unauthenticated PUT with 404, `npm login` fixed it). Ships the forwarder (#101), the
  `llm.chat`/`llm.stream` AI nodes (#102), the four-runtime certification report (#103) and the span-kind rule (#104) — certified
  in the 2026-09-22 Dynatrace drive and confirmed in the UI; one number on all four runtimes (crates.io 12/12 01:57Z, PyPI 02:34Z).
  Lesson: the LLM provider, not the pipeline, decides which calls succeed — probe and pin the model per drive.
  origin: 2026-09-22-165807, 2026-09-22-194836; close 2026-09-23-004556.
  <!-- id: otel-forwarder-lockstep | created: 2026-09-22 | last_used: 2026-09-23 | uses: 3 | tier: active | origin: 2026-09-22-165807 -->
