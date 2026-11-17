- [ ] **(blueprint) The essential built-in tools for agent loops in this pack - RFC-0013 build plan step 3, the Node twin
  of mercury-python's `extensions/agent-tools` (Eric: "proceed with essential tools", 2026-11-17; the spec is
  mercury-composable `draft-design-specs/agent-essential-tools.md`, settled, rulings R1-R16; the Python build's defaults
  are its sections 13 and 14).** **Step 3 BUILT 2026-11-17** as PR #130 (merge `b8aad9f`, MERGED 2026-11-17 - this pack's version 1 of the tools is
  complete; CI on Node 26, the floor `node >= 22`): `extensions/agent-tools/agent-tools.mjs`
  with the twelve routes - `file.read`, `file.write`, `file.list`, `file.search`, `file.extract` (pdfjs-dist, mammoth
  through the in-house HTML reader) inside `tools.file.root`; `web.fetch`, `web.crawl` inside `tools.web.allow` over
  `node:http` with a pinned `lookup` (the checked address, the TLS server name from the URL), an in-house HTML tokenizer
  and an in-house `robots.txt` parser; `graph.schema`, `graph.query`, `graph.write`, `graph.ingest` over `neo4j-driver`
  behind a transaction seam the tests fake; `time.now` on `Intl`. The catalog files are byte for byte the Python pack's
  (copied, pinned by a test against the constants generated from them), the rows in code; `describe`, `tools.health`,
  `resources/application.yml` (port 8090), `dev/graph-up.sh` / `graph-down.sh`, README. 55 tests in
  `test/agent-tools.test.mjs` mirroring the Python suite, and a live round trip on Neo4j 5 on Colima: PASSED. The Node
  binding's direct run already attached its hooks (no twin of the Python fix needed). Differences a reader should know:
  the HTML reader decodes the common named character references and every numeric one (Python's decodes all of HTML5's);
  a Word table renders through mammoth's HTML (cells separated by spaces, rows as blocks) where Python joins cells with
  ` | `; integers come back as JavaScript numbers (`disableLosslessIntegers`). The Playground's three graphs
  (mercury-composable #647, step 4) were driven live through this pack on 2026-11-17 - ingest, query and the supervised
  notes write all passed; the drive taught a relative `include` for the crawl (PR opened the same day, with the README's
  Event-over-HTTP snippet corrected to one route per entry). Next: nothing here until the recipes page (step 5, the engine's).
  → serves: vision-mercury-nodejs
  <!-- id: bp-agent-tools-nodejs | created: 2026-11-17 | last_used: 2026-11-17 | uses: 1 | tier: working | origin: 2026-11-17-111036 -->
