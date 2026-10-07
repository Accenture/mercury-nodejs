- [ ] **Next pack release: catch up to the Java number and carry the LLM helper.** The pack is published at 4.12.15 while the
  engines shipped 4.12.20. `main` holds, unreleased, the LLM helper app (`examples/llm-helper`, PR #106), the demo-app move, the
  `@anthropic-ai/sdk` dev dependency and the stricter `llm.chat` / `llm.stream` contract (two READ items in the CHANGELOG's
  Unreleased section). The release is tagged at the Java number it catches up to, never an intermediate one; Eric decides when,
  and tag and publish are his steps. **Prepared 2026-10-07 (Eric: "the right time for release v4.12.21 for the 4 repos"):**
  `release/4.12.21` (head `5ddcc9e`) carries the bump and the CHANGELOG cut `## 4.12.21 (2026-10-07)`; `npm test` 182/0; the PR
  #110 MERGED 2026-10-07 02:16:19Z as merge `80d4889` (identical to the branch head outside `memory/`, CI green). **TAGGED 2026-10-07 (Eric): tag → `279e784`, the GitHub release published 02:36:40Z, verified.** Next, Eric's gate: npm publish, then
  verify the registry (the version, the published time, the artifact against the tag) and close. Was: tag `v4.12.21`, `npm publish`.
  → serves: vision-mercury-nodejs
  <!-- id: pack-catch-up-release | created: 2026-10-01 | last_used: 2026-10-01 | uses: 1 | tier: working | origin: 2026-10-02-001255 -->
