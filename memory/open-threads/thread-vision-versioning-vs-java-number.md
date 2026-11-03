- [ ] **Drift: the pack's version line doesn't serve `vision-mercury-nodejs`'s versioning target.** The Vision says the pack is
  "versioned by protocol compatibility", "never coupled to engine releases", and lists as a non-goal being "versioned beyond
  protocol compatibility". In practice the pack carries the Java release number it caught up to (4.12.0 from 0.1.0 on
  2026-08-30, then 4.12.1, 4.12.15, 4.12.21; `stack-typescript-esm`'s "engine lock-step version line"; [[pack-catch-up-4-12-25]]
  adopts the Java number current at release), while still releasing when its work is ready. Resolve (Eric): amend the Vision's
  wording, or reconcile it with the practice. Raised by the 2026-11-03 review's contradiction scan; no fact edited.
  <!-- id: vision-versioning-vs-java-number | created: 2026-11-03 | last_used: 2026-11-03 | uses: 1 | tier: working | origin: 2026-11-03-005949 -->
