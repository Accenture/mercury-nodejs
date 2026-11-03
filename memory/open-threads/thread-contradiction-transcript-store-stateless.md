- [ ] **Contradiction: the LLM helper's transcript store against `stateless-functions-contract` (and the wording of
  `scope-wrapper-no-orchestration`) - the same tension as mercury-python's thread of this id, which carries the proposed
  amendment.** The invariant says a function keeps nothing and anything it must keep belongs to the caller's flow model or
  state machine; RFC-0011's rulings 9 and 27 (Eric, 2026-10-28) put an agent loop's transcript in a store the pack owns,
  and the loop contract builds it in `extensions/llm-helper/` (branch `feat/llm-chat-loop-contract`). The package
  (`dist/src`) stays persistence-free, and the handler keeps no in-process state (any replica serves any turn). One ruling
  from Eric settles both packs; not edited until then.
  <!-- id: contradiction-transcript-store-stateless | created: 2026-11-03 | last_used: 2026-11-03 | uses: 1 | tier: working | origin: 2026-11-03-004721 -->
