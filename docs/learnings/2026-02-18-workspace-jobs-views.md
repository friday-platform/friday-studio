# Team Lead Learnings — Workspace Jobs Views

Branch: `david/tem-3698-show-workspace-jobs-and-provide-their-own-views`
Date: 2026-02-18

## Observations

- Two teammates independently took different approaches to integration extraction: Leela correctly traced per-job (job → agents → MCP servers → credentials), while Ferox took a shortcut with workspace-wide credentials applied to all jobs. When the spec says "filter to providers referenced by the job's agents' MCP servers," teammates may skip the filtering step if it seems complex. Be explicit in task descriptions about per-entity vs. global extraction.
- Both teammates noted pre-existing TS2589 errors — one from Hono deep type instantiation in client/v2/mod.ts, another from recursive z.lazy() types in workspaces/index.ts. These are known gotchas (documented in CLAUDE.md) but caused confusion about whether their changes were clean.
- Leela used `as Parameters<typeof extractCredentials>[0]` to work around a type mismatch — the "no `as` assertions" rule needs reinforcement. The fix was to use the proper imported type directly.
- Agent `config.tools` is `string[]` of MCP server IDs (matching keys in `tools.mcp.servers`). Initial confusion: thought agents couldn't reference MCP servers, but `examples/telephone/workspace.yml` line 66 confirms `tools: ["filesystem-context"]` references MCP servers. Per-job filtering IS possible.
- `Array.split(":")` destructuring like `const [type, entityId] = path.split(":")` makes later elements `string | undefined`. Must guard before passing to `Set.has()` or `Array.includes()`. Ferox missed this, caught by deno check.
