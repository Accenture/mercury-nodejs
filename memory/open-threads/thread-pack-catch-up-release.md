- [x] **Next pack release: catch up to the Java number and carry the LLM helper — CLOSED 2026-10-07, released and verified.**
  Outcome: v4.12.21, from 4.12.15 (the Java number of the round), carrying the LLM helper app: PR #110 merge `80d4889`, tag →
  `279e784` (one memory commit past the merge, the version at the tag, the GitHub release published 02:36:40Z), npm 02:43:40Z -
  `mercury-composable` 4.12.21 as `latest`, `package.json` and the README identical to the tag, all 41 compiled files identical to a
  build of the tag, dependencies only `@msgpack/msgpack` and `yaml`. Lesson: a pack's published artifact is checked against its tag,
  and against a build of the tag when the shipped files are not tracked. Origin: 2026-10-02-001255.md; the record in
  2026-10-07-012440.md.
  → serves: vision-mercury-nodejs
  <!-- id: pack-catch-up-release | created: 2026-10-01 | last_used: 2026-10-01 | uses: 1 | tier: working | origin: 2026-10-02-001255 -->
