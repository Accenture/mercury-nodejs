- [ ] **The MCP binding (RFC-0011 / ADR-0033 build plan step 4): `extensions/mcp-binding/`, built 2026-11-14; PR #118 MERGED 2026-11-14 (merge `f283a7e`).**
  The extension, the `Platform` startup and cleanup hooks, the SDK as a dev dependency, the shared vector file (sha256
  `4bacc319…`, the same bytes as mercury-python) and 46 tests over both transports. The engine-side drive ran the same day
  with an MCP tool in a graph's catalog (mercury-composable #626 and #627, the `diagram-assistant` example on the public
  Mermaid server). The `preload` shape - every bound route an alias of the one function `mcp.tool`, the twin of
  mercury-python #52 - is PR #119 from branch `refactor/mcp-binding-preload` (opened 2026-11-14). Next: the pack's catch-up release
  carries it ([[pack-catch-up-4-12-25]]). Fact: [[mcp-binding-route-per-tool]].
  → serves: vision-mercury-nodejs
  <!-- id: mcp-binding | created: 2026-11-14 | last_used: 2026-11-14 | uses: 1 | tier: working | origin: 2026-11-14-074701 -->
