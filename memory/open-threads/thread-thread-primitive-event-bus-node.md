- [x] (feature — RATIFIED + IMPLEMENTED + **MERGED 2026-08-23 as
  [PR #87](https://github.com/Accenture/mercury-nodejs/pull/87), true merge `fa7b2bf`
  carrying branch head `329c931`; tree verified identical, branches deleted both ends;
  one PR with [[thread-actuator-endpoints-node]]**) **Primitive in-process event bus —
  the single dispatch pipeline.** `instances`/`isPrivate` faithful; deliver + publish
  only; the HTTP host and local PostOffice = thin ingress adapters. Durable rulings: NO
  spill tier / NO queue cap — back-pressure belongs to the engines' flows/graphs; an
  in-flight RPC's deadline timer is REFERENCED (pending work holds the process open), an
  idle bus holds no handles. Full design, pins and wire proofs: origin log.
  <!-- id: thread-primitive-event-bus-node | created: 2026-08-23 | last_used: 2026-08-24 | uses: 3 | tier: active | origin: 2026-08-23-024601 -->
