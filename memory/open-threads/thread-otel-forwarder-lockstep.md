- [ ] **OpenTelemetry forwarder lock-step and the v4.12.15 milestone (Eric's plan, 2026-09-22).** This host's
  forwarder is MERGED (PR #101, `586c3f63`, 2026-09-22), as is the mercury-python twin (#33). The `llm.chat` /
  `llm.stream` demo nodes are MERGED (PR #102, `7ab3c621`, fetch-based, no SDK — Eric's ruling) and the four-runtime Dynatrace drive ran 2026-09-22 (this host's traces `888a3f72…`, `1232ab83…`; report on `docs/otel-certification-report`, PR pending). Remaining: Eric's Dynatrace confirmation, then v4.12.15 on all four repos (this package
  jumps from 4.12.1, adopting the Java number). origin: 2026-09-22-165807
  <!-- id: otel-forwarder-lockstep | created: 2026-09-22 | last_used: 2026-09-22 | uses: 1 | tier: working | origin: 2026-09-22-165807 -->
