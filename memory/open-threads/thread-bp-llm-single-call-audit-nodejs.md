- [ ] **(blueprint) The audit of a single call in the LLM helper: RFC-0015 build plan step 2, the Node twin of
  mercury-python #81 (the maintainer, 2026-11-24: "Do this task here: Node twin of the single-call audit and
  attachments").** **BUILT 2026-11-24 as PR #144 (merge `c533dd0`, MERGED 2026-11-24):** with
  `llm.transcript.audit.single: true`, a call without `tools` on `llm.chat` or `llm.stream` saves a closed one-turn
  version 2 record under a new reference with the audit's grace and sends `{conversation, check: true}`;
  `transcriptAudit` is unchanged, the sweep repairs a failed write, the reply never waits for the save (`auditSingle`,
  `saveSingle`, `auditSingleIdle`).
  - **Proof:** `test/vectors/llm-audit-vectors.json`, byte for byte the Python pack's (25 cases through the save, the
    check event and the function behind its mailbox, all passing with no change to a case), and six tests; sixteen
    mutations each caught. One test first hung instead of failing under a mutation (the reply waiting for the save
    deadlocks it); it now races the reply against a timer.
  - **Defaults:** the Python step's, which are RFC-0015's open questions as proposed.
  - **Next:** the record of this step in RFC-0015's entry; the schema page in mercury-composable; the reader's
    filter on the kind of row in the agent-question backend and its UI; a live drive.
  → proposal: RFC-0015 (mercury-composable)
  → serves: vision-mercury-nodejs
  <!-- id: bp-llm-single-call-audit-nodejs | created: 2026-11-24 | last_used: 2026-11-24 | uses: 1 | tier: working | origin: 2026-11-24-064840 -->
