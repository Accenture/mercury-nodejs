- [x] **The MCP binding (RFC-0011 / ADR-0033 build plan step 4) — CLOSED 2026-11-16: released in 4.12.30.** Outcome:
  `extensions/mcp-binding/` built 2026-11-14 (#118, #119; the twin of mercury-python #51 and #52), reshaped 2026-11-16 to a
  `preload` function per tool bound in code through `bind(server, tool, { schemaSha256 })` (#122; the fact
  [[mcp-binding-function-per-tool]]), driven live against the public Mermaid Chart MCP server from the Java engine (the
  engines' `docs/test-reports/agent-tool-use-live-drive.md`); the release tag `v4.12.30` carries it - the npm artifact
  ships the package (`dist/src`) only, the extension runs from the repository with the SDK as a dev dependency. Lesson: a
  route names the capability, never the transport - a tool may start as an MCP tool and later be implemented another
  way, and the graph must not know. Origin: 2026-11-14-074701; the record in 2026-11-16-090525.md.
  → serves: vision-mercury-nodejs
  <!-- id: mcp-binding | created: 2026-11-14 | last_used: 2026-11-16 | uses: 4 | tier: archive-candidate | origin: 2026-11-14-074701 -->
