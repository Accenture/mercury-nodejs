- [ ] **Re-verify invariants (due):** confirm `scope-wrapper-no-orchestration`, `wire-standard-golden-vectors-bigint`,
  `engine-consistent-conventions`, `stateless-functions-contract` and the Vision (`vision-mercury-nodejs`) still hold, or supersede
  any that don't (DECAY.md §9). The first re-verify: `last_invariant_check` was unset and 40 session files exist
  (`verify_invariants_every` 40). Context for the walk: `stateless-functions-contract` and the "no persistence" wording of
  `scope-wrapper-no-orchestration` (and the Vision's non-goals) are under [[contradiction-transcript-store-stateless]]; the
  Vision's versioning target is under [[vision-versioning-vs-java-number]]; the Vision's current-state line still says v4.12.1
  is on npm (4.12.21 is). Raised by the 2026-11-03 review; nothing confirmed or edited.
  <!-- id: reverify-invariants-20261103 | created: 2026-11-03 | last_used: 2026-11-03 | uses: 1 | tier: working | origin: 2026-11-03-005949 -->
