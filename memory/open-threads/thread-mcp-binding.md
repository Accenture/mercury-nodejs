- [ ] **The MCP binding (RFC-0011 / ADR-0033 build plan step 4): `extensions/mcp-binding/`, built 2026-11-14; PR #118 MERGED 2026-11-14 (merge `f283a7e`).**
  The extension, the `Platform` startup and cleanup hooks, the SDK as a dev dependency, the shared vector file (sha256
  `4bacc319…`, the same bytes as mercury-python) and 46 tests over both transports. The engine-side drive ran the same day
  with an MCP tool in a graph's catalog (mercury-composable #626 and #627, the `diagram-assistant` example on the public
  Mermaid server). The `preload` shape - every bound route an alias of the one function `mcp.tool`, the twin of
  mercury-python #52 - is PR #119, MERGED 2026-11-14 (merge `ffadfcf`). Next: the pack's catch-up release
  carries it ([[pack-catch-up-4-12-25]]). Fact: [[mcp-binding-route-per-tool]].
  → serves: vision-mercury-nodejs
  **Reshaped 2026-11-16 (Eric's review; the engines' `draft-design-specs/agent-tool-use.md`; in lockstep with the Python
  pack):** a `preload` function per tool bound in code through `bind(server, tool, { schemaSha256 })`, no generic route,
  the server file servers-only, the extension's own `mermaid.render` out of the box; the shared vectors version 2 (49
  tests; the boot and a render driven live against the Mermaid server). Then the Playground calls `mermaid.render`.
  PR #122 MERGED 2026-11-16 (merge `5157070`); the twin of mercury-python #55 (merge `cf216f3`); the engines' PR #630
  carries the design spec and the Playground's `mermaid.render`. Fact: [[mcp-binding-function-per-tool]].
  <!-- id: mcp-binding | created: 2026-11-14 | last_used: 2026-11-14 | uses: 1 | tier: working | origin: 2026-11-14-074701 -->
