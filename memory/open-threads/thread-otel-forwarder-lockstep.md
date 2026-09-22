- [ ] **OpenTelemetry forwarder lock-step and the v4.12.15 milestone (Eric's plan, 2026-09-22).** This host's
  forwarder is MERGED (PR #101, `586c3f63`, 2026-09-22), as is the mercury-python twin (#33). The `llm.chat` /
  `llm.stream` demo nodes are MERGED (PR #102, `7ab3c621`, fetch-based, no SDK — Eric's ruling) so a
  Rust or Java edge can render Gemini tokens progressively through this host; then the four-runtime Dynatrace
  certification (one trace per request, Eric confirming in the UI) and v4.12.15 on all four repos (this package
  jumps from 4.12.1, adopting the Java number). origin: 2026-09-22-165807
  <!-- id: otel-forwarder-lockstep | created: 2026-09-22 | last_used: 2026-09-22 | uses: 1 | tier: working | origin: 2026-09-22-165807 -->
