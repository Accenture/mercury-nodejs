- [x] **Actuator endpoints.** Merged in the same [PR #87](https://github.com/Accenture/mercury-nodejs/pull/87)
  as the bus: /info, /info/routes, /env, /health, /livenessprobe. Lesson: health
  functions speak `type=info`/`type=health` through the bus; liveness follows last
  health. origin: 2026-08-23-031920
  <!-- id: thread-actuator-endpoints-node | created: 2026-08-23 | last_used: 2026-08-24 | uses: 2 | tier: archive-candidate | origin: 2026-08-23-031920 -->
