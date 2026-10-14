- [x] **AWS Bedrock through IAM as the LLM helper's second backend. CLOSED 2026-10-14.** Built in PR #111 (merged `def1e3a`) and
  driven live the same day with Eric's temporary IAM credentials and no vendor key: negative controls first (401 and 503 by
  name), then chat, a structured verdict and a progressive stream on Haiku 4.5 through the classic runtime surface, and the Java
  engine's shipped triage graph and streaming relay in front of the helper; PR #112 (merged `0ece23f`) carries the surface switch `llm.aws.api`
  and the report. Lesson: an account may be enabled for one Bedrock surface and one model generation only - the gates are the
  per-model agreement, the one-time use case and the account's own enablement - and the classic client's quiet region fallback
  is refused rather than inherited. origin: 2026-10-02-001255.
  → serves: vision-mercury-nodejs
  <!-- id: llm-helper-bedrock-iam | created: 2026-10-01 | last_used: 2026-10-01 | uses: 1 | tier: working | origin: 2026-10-02-001255 -->
