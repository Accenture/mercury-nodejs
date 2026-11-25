- [x] **(blueprint) The React UI - the one front-end of the agent-question app, maintained here for both packs (Eric,
  2026-11-19).** CLOSED 2026-11-20: built as `extensions/agent-question-ui/` and MERGED (PR #141, merge `344b34f07`;
  the bundle in mercury-python #76, `5cc9fccaf`) - four panels including the actuator menu, PKCE, the release script
  deploying into both packs, the Keycloak development issuer, the device-side `seen` - and driven live through both
  backends and a Keycloak issuer the same day (mercury-composable `docs/test-reports/agent-question-ui-live-drive.md`,
  PR #661, open at close). Lesson: a long-lived response needs an explicit end when the application stops - the hosts
  gained `Platform.onShutdown` / `on_shutdown` ([[platform-on-shutdown-hook-node]]). Follow-up outside this thread: the
  reply page's own sign-in against an issuer. The narrative: logs 2026-11-19-094720 to 2026-11-20-094734.
  → serves: vision-mercury-nodejs
  <!-- id: agent-question-react-ui | created: 2026-11-19 | last_used: 2026-11-20 | uses: 5 | tier: archive-candidate | origin: 2026-11-19-094720 -->
