- [ ] **(blueprint) Attachments on a single `llm.chat` call in the LLM helper: RFC-0016 build plan step 2, the Node
  twin of mercury-python #82 (the maintainer, 2026-11-24: "Do this task here: Node twin of the single-call audit and
  attachments").** **BUILT 2026-11-24 as PR #145 (merge `d8713c0`, MERGED 2026-11-24), on top of PR #144 of
  [[bp-llm-single-call-audit-nodejs]]:** the field and its shape in `llm-helper.mjs`; the reading in a new module
  beside it, `attachments.mjs` - the one root, the kind by the
  first bytes, the limits, the pages cut, the reference with the source file's size and SHA-256 - run in a worker
  thread of its own (`loadInWorker`), because a hash, base64 and a PDF's cut are CPU work on an event loop that
  carries every stream; the call's deadline covers the reading and the model gets what is left of it.
  - **The maintainer's choice (2026-11-24):** `@cantoo/pdf-lib` (MIT, the maintained fork of pdf-lib) as the optional
    package that cuts pages and tells an encrypted PDF - a devDependency here, installed where pages are used. Asked
    with pdf-lib (unchanged since 2022) and deferring pages as the alternatives.
  - **Proof:** `test/vectors/llm-attachments-vectors.json` and the eight fixture files, byte for byte the Python
    pack's (48 cases, all passing with no change to a case or a message), and seven tests in
    `test/llm-attachments.test.mjs`; thirty-three mutations each caught.
  - **Where the twin differs from Python, by its runtime:** a worker thread where Python uses a thread of its pool;
    the 503 for a missing library names the npm package; `pdfjs-dist`, already here for the agent tools, only reads
    and was not enough.
  - **Not done:** a live call (no token was spent); the measurement of a PDF cut beside a running stream, which the
    worker thread answers by construction but nothing has measured.
  - **Next:** the record of this step in RFC-0016's entry; the schema page in mercury-composable; a live drive on
    both backends.
  → proposal: RFC-0016 (mercury-composable)
  → serves: vision-mercury-nodejs
  <!-- id: bp-llm-attachments-nodejs | created: 2026-11-24 | last_used: 2026-11-24 | uses: 1 | tier: working | origin: 2026-11-24-064840 -->
