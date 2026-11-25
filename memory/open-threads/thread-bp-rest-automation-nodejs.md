- [ ] **(blueprint) REST automation in the pack: `rest.yaml` as the router of a Node application, so a field utility app is
  built and deployed as an engine application is (RFC-0018 in mercury-composable, raised as its PR #674 and MERGED 2026-11-25; the
  Vision amended by Eric, 2026-11-24).** Investigated 2026-11-24 in the Python pack (its log 2026-11-24-233943): viable with no new dependency -
  the host already has the one server on `node:http`, the Event API edge with its trace records, the actuators,
  static content, the mounted routes, the bus with per-call timeouts and the streaming sink; REST automation is a
  routing table and a request model in front of them, ingress and not orchestration. The previous port at tags
  v4.2.40 to v4.3.28 (`src/system/rest-automation.ts`, `src/util/routing.ts`, `src/models/async-http-request.ts`, on
  Express, body-parser, cookie-parser and busboy) is a reading aid for the parser and the request model, never a
  dependency source. The proposed shape: `rest.automation: true` (off by default), `resources/rest.yaml` under the
  resources rule, the host's paths as the default entries, the Rust port's subset for version 1, `flow`, the HTTP
  relay and the dual service refused by name, `upload` and the content-type extras deferred; proof by the shared
  `rest-automation-vectors.json` byte-identical with the Python pack, the engines' `rest-automation.json` as a fixture
  and the Rust port's 33 tests as the checklist. Build order when the shape is ruled: the Python pack first, this
  twin from the same vector file, the README and the engines' polyglot guide, a live drive. First adopters
  afterwards: the hand-mounted routes of the agent-question app and the ask-person flow.
  → proposal: RFC-0018 (mercury-composable)
  → serves: vision-mercury-nodejs
  <!-- id: bp-rest-automation-nodejs | created: 2026-11-24 | last_used: 2026-11-24 | uses: 1 | tier: working | origin: 2026-11-24-235244 -->
