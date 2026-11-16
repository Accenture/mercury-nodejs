- [ ] **Next pack release: catch up to the Java number (4.12.30 as of 2026-11-13) with the Bedrock backend, its two surfaces and the
  resources-folder rule.** HELD on 2026-10-14 until the higher AI models were available on Bedrock; **the hold was LIFTED on
  2026-10-29 (Eric, recorded in mercury-composable): the Claude API backend serves every current model, so the pack releases
  when its work is ready** and adopts whatever Java number is current then (every port adopts the Java number on catch-up).
  Content on main since 4.12.21: PRs #111, #112 and #113 (the Python twins: mercury-python #43, #44, #45), and since
  2026-11-03 #114 (the helper's move to `extensions/`, the twin of mercury-python #46) and #115 (the loop contract, the twin
  of mercury-python #47; merge `d6a0bd9`, 2026-11-03). Since 2026-11-14: #118 to #120 (the MCP binding and the trace records, [[mcp-binding]] and
  [[trace-records-engine-parity]]) and, 2026-11-16, #121 (route aliases in `preload` and the JSON log `source` label,
  the Java engine's shapes; the twin of mercury-python #54) and #122 (the MCP binding's function-per-tool shape, the
  twin of mercury-python #55), and #123 (the code-quality round of the local SonarQube scan, the twin of mercury-python #56) and #124 (the
  cognitive-complexity findings of the same scan, the twin of mercury-python #57). The previous catch-up's close record is [[pack-catch-up-release]]. **PREPARED 2026-11-16 as 4.12.30 on branch `release/4.12.30`** (the version in
  `package.json`, the lock's two root entries, `src/version.ts` and the README, the CHANGELOG section, `npm test` green;
  the Python twin in lockstep); Eric's gates: PR, merge, tag, npm. **MERGED and TAGGED 2026-11-16:** PR #125 (opened by Claude Code at Eric's request) merge
  `0591f15` 09:10:04Z, the tag `v4.12.30` on the merge commit, the GitHub release 09:11:45Z as Latest, CI green; the npm
  publication PENDING at 09:16Z.
  → serves: vision-mercury-nodejs
  <!-- id: pack-catch-up-4-12-25 | created: 2026-10-14 | last_used: 2026-11-13 | uses: 7 | tier: working | origin: 2026-10-14-015422 -->
