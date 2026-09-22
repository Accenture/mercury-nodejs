- [ ] **OpenTelemetry forwarder lock-step and the v4.12.15 milestone (Eric's plan, 2026-09-22).** This host's
  forwarder is on `feat/otel-forwarder` (3c3388b, PR pending); the mercury-python twin is merged (#33). Remaining
  here: `llm.chat` / `llm.stream` demo nodes (fetch-based Gemini and Anthropic streaming, no SDK — Eric's ruling)
  so a Rust or Java edge can render Gemini tokens progressively through this host; then the four-runtime Dynatrace
  certification (one trace per request, Eric confirming in the UI) and v4.12.15 on all four repos (this package
  jumps from 4.12.1, adopting the Java number). origin: 2026-09-22-165807
  <!-- id: otel-forwarder-lockstep | created: 2026-09-22 | last_used: 2026-09-22 | uses: 1 | tier: working | origin: 2026-09-22-165807 -->
