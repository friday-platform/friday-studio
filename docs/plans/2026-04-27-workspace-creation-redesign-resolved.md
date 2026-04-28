# Workspace Creation Redesign — Resolved Decisions

Date: 2026-04-27
Base: `docs/plans/2026-04-27-workspace-creation-redesign-design.md`

## Decisions

### 1. Primary customer
**LLM (workspace-chat) is the primary customer; the user is the beneficiary.** The root failure mode is the LLM lacking compiler-like signals, not the user lacking UI. All design choices optimize for LLM iteration speed and reliability.

### 2. Registry checks (MCP tool existence, npm/pypi installability)
**Registry unavailability = system failure.** The validator refuses to proceed if it cannot reach the MCP/npm/pypi registry. No soft-fallback to warning. This avoids the "network blip let a broken workspace through" failure mode.

### 3. `remove_item` cross-entity behavior
- **Direct mode:** `remove_item` refuses if the entity is referenced by other entities. Returns structured errors naming the dependents.
- **Draft mode:** `remove_item` is permissive — broken references are allowed during drafting and surface at `validate_workspace` / `publish_draft`.

### 4. Validator layer interaction
**Collect all issues, no short-circuit between reference and semantic layers.** Structural errors short-circuit (unparseable objects have no identity), but reference and semantic layers run independently. A broken tool ref and an unreachable agent on the same entity are both reported.

### 5. Diff format
**Structured field-level diff per entity.** Format: `{ fieldName: { from, to }, tools: { added: [...], removed: [...] } }`. Not text/unified diff. The LLM confirms intent by reading `tools.added: ["slack"]` — no parsing `+` lines.

### 6. Publish atomicity
**Filesystem rename only. No backup-and-rollback.** Simple > complex. If `/update` fails after rename, live config is updated but runtime hasn't reloaded. On daemon restart it loads the new config. Accept this edge case.

### 7. `enable_mcp_server` without credentials
**Fail fast with structured hint.** Returns 400 with `{ error: "credentials_required", provider: "google", hint: "call connect_service('google')" }`. The LLM recovers in one turn. No separate pre-flight discovery step.

### 8. `begin_draft` snapshot semantics
**Snapshot at creation time; publish is blind overwrite.** If live changes after draft creation, publish stomps them. The skill documents: "draft is a fork, not a branch." No merge logic in v1.

### 9. Upsert tool interface
`upsert_agent({ id: "email-triager", config: { type: "llm", ... } })` — `id` is a separate top-level param; `config` matches the Zod schema exactly. Same pattern for `upsert_signal` and `upsert_job`.

### 10. Job upsert — full FSM only
**No simplified linear job abstraction.** `upsert_job` takes the full `JobSpecificationSchema` including FSM. The LLM generates the full FSM JSON. No auto-expansion from a "steps" shorthand. This keeps the tool surface uniform and avoids a second job-construction abstraction.

### 11. `workspace_create` fate
**Dropped entirely.** Not deprecated, not shimmed. The chat uses `create_workspace` (thin) → `begin_draft` → `upsert_*` → `publish_draft` for all new workspace creation.

### 12. MCP server startup in draft mode
**Deferred to publish.** `enable_mcp_server` writes the MCP config to the draft file but does not start the server process. Startup happens at `publish_draft` when the draft becomes live. The validator checks tool existence against the registry without needing the server live.

### 13. Skill structure
**One monolithic skill with a hyper-condensed cheat sheet at top (~60 lines).** The skill starts with: reachability mental model → 7-step recipe → direct-vs-draft decision tree → tool-selection guidance. Full CRUD examples, workshop-crystallize patterns, and LLM-vs-Python matrix live below. Not split into two skills.

### 14. Direct vs. draft coexistence
**Mutually exclusive.** If `workspace.yml.draft` exists, ALL mutations write to the draft. Direct mode is blocked. The draft is a lock on live. Publish or discard to return to direct mode.

### 15. `@atlas/workspace-builder` fate
**Validator moves to `@atlas/config`; package deleted.** The `validateWorkspace` function lives next to `WorkspaceConfigSchema`. After phase 3, `@atlas/workspace-builder` is fully removed. `FSMBuilder` and helpers move to wherever FSM construction lives (likely `@atlas/fsm-engine`).

### 16. Tool count
**17 tools total (8 existing + 9 new).** Acceptable. The 9 new tools have distinct, non-overlapping names. No merging of `publish_draft`/`discard_draft` into a polymorphic `end_draft`.

### 17. Phasing
**Big-bang swap in Phase 1.** No compatibility shim, no canary. Old `workspace_create` is removed atomically with the new tools/endpoints/skill. The anti-regression test safety net: real workspaces (Ken's Inbox-Zero, transcript-derived workspace) run through the new validator before go-live.

### 18. New workspace creation path
**Thin `create_workspace` stays.** Creates an empty workspace with just `version` + `workspace.name`. Returns runtime ID. Then `begin_draft` → upserts → publish. `begin_draft` does NOT have a `create_if_missing` flag — creation and editing are separate intents.

## Tool Surface (final)

**Existing (8):**
1. `list_mcp_servers`
2. `search_mcp_servers`
3. `install_mcp_server`
4. `create_mcp_server`
5. `get_workspace_mcp_status`
6. `enable_mcp_server`
7. `disable_mcp_server`
8. `connect_service`

**New (9):**
9. `create_workspace` (thin: name only)
10. `upsert_agent`
11. `upsert_signal`
12. `upsert_job`
13. `remove_item`
14. `begin_draft`
15. `validate_workspace`
16. `publish_draft`
17. `discard_draft`

## Open / Not Resolved in This Session

- Exact `remove_item` interface shape for `kind` values (string enum?)
- Whether draft endpoints are new Hono sub-routers or reuse existing config mutation infrastructure
- Validator `Issue` type exact fields (beyond `code`, `path`, `message`)
- Whether `validate_workspace` tool returns just the report or also a human-readable summary
- Draft file location: same directory as `workspace.yml` or a `.draft/` subdirectory?
- Edit page "Draft" label design (out of scope for this plan, but needs UI ticket)

## Next Steps

1. Write `CONTEXT.md` at repo root (this is the first domain-model session for Friday)
2. Implement `validateWorkspace` in `@atlas/config`
3. Implement draft file operations + 6 HTTP endpoints
4. Implement 9 new tools on workspace-chat
5. Rewrite `workspace-api` skill
6. Run anti-regression tests against Ken's workspaces
7. Phase 3: delete legacy agents + `@atlas/workspace-builder`
