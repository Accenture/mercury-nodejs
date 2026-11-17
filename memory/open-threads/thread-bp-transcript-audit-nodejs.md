- [ ] **(blueprint) The transcript audit store in the LLM helper: RFC-0012 build plan step 2, the Node twin in lockstep
  with the Python pack (mercury-python #59, merged 2026-11-17).** Built 2026-11-17 on `feat/transcript-audit-store`,
  PR #126 MERGED 2026-11-17 (merge `9d2d39778`): record version 2 with each turn's facts, the store protocol's audit half on the memory and Redis
  stores, the `transcript.audit` function with one instance behind two local events (the write after every
  compare-and-set, the check behind a closing write), the sweep, PostgreSQL on `pg` (a dev dependency),
  `schema/postgres.sql` and `purge.sql` byte-identical with the Python pack, the `dev/` scripts on Colima with pgweb,
  28 tests and a live test; verified live on the container. Open: the engines' `x-graph-id` and
  `x-node` (step 3); the `order-assistant` drive through this helper (step 4). The engines' memory tracks the design
  under `transcript-audit-store` (RFC-0012, settled 2026-11-17; the schema page is mercury-composable #639).
  → serves: vision-mercury-nodejs
  <!-- id: bp-transcript-audit-nodejs | created: 2026-11-17 | last_used: 2026-11-17 | uses: 1 | tier: working | origin: 2026-11-17-082942 -->
