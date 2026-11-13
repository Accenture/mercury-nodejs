- [x] **AWS Bedrock through IAM as the LLM helper's second backend. CLOSED 2026-10-14.** Built in PR #111 (merged `def1e3a`) and
  driven live the same day through IAM and no vendor key, negative controls first; PR #112 (merged `0ece23f`) carries the surface
  switch `llm.aws.api` and the report. Lesson: an account may be enabled for one Bedrock surface and one model generation only,
  and the classic client's quiet region fallback is refused rather than inherited. origin: 2026-10-02-001255.
  → serves: vision-mercury-nodejs
  <!-- id: llm-helper-bedrock-iam | created: 2026-10-01 | last_used: 2026-10-16 | uses: 3 | tier: archive-candidate | origin: 2026-10-02-001255 -->
