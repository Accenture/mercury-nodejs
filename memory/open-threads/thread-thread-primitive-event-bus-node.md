- [x] **Primitive in-process event bus.** Merged [PR #87](https://github.com/Accenture/mercury-nodejs/pull/87)
  (`fa7b2bf` carrying `329c931`) with the actuators. Dispatch only (deliver + publish);
  no spill / no queue cap. Lesson: idle bus holds no handles; in-flight RPC timers are
  referenced. origin: 2026-08-23-024601
  <!-- id: thread-primitive-event-bus-node | created: 2026-08-23 | last_used: 2026-08-24 | uses: 3 | tier: archive-candidate | origin: 2026-08-23-024601 -->
