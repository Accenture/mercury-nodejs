- [x] **Code quality review round.** Merged [PR #88](https://github.com/Accenture/mercury-nodejs/pull/88)
  (`2a0d8f8` carrying `a73332f`); 12 Sonar findings cleared. Lesson: Mailbox is not
  EventEmitter — anycast FIFO + bounded workers, node's missing asyncio.Queue.
  origin: 2026-08-23-031920
  <!-- id: thread-node-quality-review | created: 2026-08-23 | last_used: 2026-08-24 | uses: 2 | tier: archive-candidate | origin: 2026-08-23-031920 -->
