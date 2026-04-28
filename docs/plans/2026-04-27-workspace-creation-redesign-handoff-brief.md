# Workspace Creation Redesign — Handoff Brief

Date: 2026-04-27
Branch: feature/workspace-creation-redesign
Status: Phase 1 complete, 1 item remaining + 1 deferred

## What we've shipped

### Core infrastructure (DONE)
- `validateWorkspace` in `@atlas/config` with 3 layers: structural (Zod), reference integrity, semantic warnings
- Draft file operations: `begin_draft`, `publish_draft`, `discard_draft`, `validate_workspace`
- Upsert tools: `upsert_agent`, `upsert_signal`, `upsert_job`, `remove_item`
- Workspace-chat tool registration in `workspace-chat.agent.ts`

### MCP integration (DONE)
- `list_mcp_tools` — spins up server, returns exact tool names (new today)
- `enable_mcp_server` / `disable_mcp_server` — now accept optional `workspaceId` for cross-workspace ops (new today)
- `list_mcp_servers`, `search_mcp_servers`, `install_mcp_server`, `create_mcp_server`
- MCP enable/disable are draft-aware

### Skill updates (DONE)
- `workspace-api/SKILL.md` — full rewrite with reachability model, 7-step recipe, CRUD examples, gotchas
- Added `list_mcp_tools` guidance and cross-workspace `workspaceId` warnings
- **New `references/job-authoring.md`** — FSM shape cookbook, MCP tool naming rules, validation error decoder, runtime anti-patterns (6 sections, ~350 lines)
- **New `assets/minimal-job-template.yml`** — drop-in single-agent job template
- **New `assets/multi-step-job-template.yml`** — chained agent pipeline with `outputTo` → `inputFrom` wiring

### `list_mcp_tools` prefix fix (DONE)
- `list_mcp_tools` now returns `serverId/toolName` prefixed names (e.g. `google-gmail/search_gmail_messages`)
- Agents can copy tool names directly from `list_mcp_tools` output into `agents.*.config.tools` verbatim
- Eliminates the manual-prefixing step that caused repeated `unknown_tool` validation errors

### Tests (DONE)
- Validator unit tests (structural, reference, semantic layers)
- Draft endpoint integration tests
- Upsert tool tests (valid/invalid entities)
- New `list-mcp-tools.test.ts` (7 cases)
- Updated `enable-mcp-server.test.ts` + `disable-mcp-server.test.ts` (18 cases total)

---

## What remains

### 1. Validator: Resolve MCP tool names against draft configs [DONE]

**Problem:** Even with correct MCP config in the draft, `validate_workspace` returns `unknown_tool` errors because the validator cannot resolve tool names against unstarted MCP servers.

**Repro from transcript `chat_pwC2juu47H`:**
- Agent creates workspace `fragrant_yuzu`
- Agent enables `google-gmail` MCP (now works with `workspaceId`)
- Agent upserts agent with tools `["gmail_list_messages", "gmail_get_message", ...]`
- `validate_workspace` returns 7× `unknown_tool` errors
- Agent never publishes

**Shipped:**

1. **`packages/config/src/validate-workspace.ts`** — `checkToolReferences` now:
   - Accepts bare tool names (e.g. `search_gmail_messages`) when they exist in `registry.mcpTools[serverId]`
   - For prefixed tools (`serverId/toolName`), verifies the bare name exists in the server's resolved tool list when registry data is available
   - When registry data IS available for a server, prefixed tools are strictly verified (no fallback — `google-gmail/foobar` fails)
   - When registry data is NOT available, falls back to static acceptance for declared servers (backward compat)

2. **`apps/atlasd/routes/workspaces/draft-helpers.ts`** — `validateDraft` and `publishDraft` accept optional `Registry` parameter, passed through to `validateWorkspace`.

3. **`apps/atlasd/routes/workspaces/index.ts`** — `buildMcpToolRegistry(config)` helper probes all declared MCP servers via `createMCPTools` (5s timeout, best-effort). Called from draft validate and publish endpoints. Failed probes are logged and skipped — their tools fall back to static acceptance.

**Test coverage:** 4 new cases in `validate-workspace.test.ts`:
- prefixed tool passes when registry has the bare name
- prefixed tool fails when registry is missing the bare name
- bare tool name passes when registry includes it
- prefixed tool still passes via static fallback when no registry data

**Combined with the `list_mcp_tools` prefix fix**, the full flow now works:
- `list_mcp_tools` returns `google-gmail/search_gmail_messages` → agent uses verbatim → validator checks against probed tool list → passes
- If agent uses bare `search_gmail_messages` → validator checks `registry.mcpTools["google-gmail"]` → passes if the server was successfully probed
- `google-gmail/foobar` → fails because the probed tool list doesn't contain `foobar`

---

### 2. Build missing skills (3 skills)

The `workspace-api` skill is monolithic and covers the full recipe, but we need focused skills for specific failure modes observed in transcripts.

#### 2a. Skill: `building-friday-jobs` — DONE (folded into `workspace-api` skill)

**Shipped as `references/job-authoring.md` + `assets/minimal-job-template.yml` + `assets/multi-step-job-template.yml` inside `workspace-api/` instead of a standalone skill.**

Rationale: The workspace-api skill is already loaded when the LLM is creating or editing workspaces, which is exactly when it needs job authoring guidance. A separate skill would compete for trigger budget and create an unnecessary "which skill do I load?" decision. The material lives as reference docs within the workspace-api skill, discoverable via the SKILL.md's "Go deeper" section.

**Content shipped:**
- `references/job-authoring.md` (~350 lines): trigger contract, minimal valid job, MCP tool naming, FSM shape cookbook (single-agent, multi-step, conditional), validation error decoder, runtime anti-patterns, pre-publish checklist
- `assets/minimal-job-template.yml`: drop-in single-agent job (copy-paste, rename, publish)
- `assets/multi-step-job-template.yml`: chained pipeline with `outputTo` → `inputFrom` wiring

**Not covered (future if needed):** Guarded transitions with custom guard functions (the cookbook covers conditional branching but uses the built-in pattern; custom guard code is advanced).

#### 2b. Skill: `llm-vs-user-agents`

**Trigger:** When the LLM is choosing between `type: "llm"` and `type: "user"` for an agent.

**Content needed:**
- Decision matrix (already in `workspace-api/SKILL.md`)
- **Worked examples:**
  - "Parse 10,000 PDFs" → user (Python)
  - "Triage an email into categories" → llm
  - "Render map tiles" → hybrid (llm for design, user for rendering)
- How to register a user agent (brief, points to `writing-friday-agents` skill)
- Common mistake: using `llm` for deterministic transforms → slow and expensive

**Location:** `packages/system/skills/llm-vs-user-agents/SKILL.md`

#### 2c. Skill: `adding-tools-to-workspace` — PARTIALLY DONE

**Covered by `references/job-authoring.md` section 3 (MCP tool naming) + `list_mcp_tools` prefix fix.**

**Shipped:**
- `list_mcp_tools` now returns `serverId/toolName` prefixed names — agents copy verbatim
- `references/job-authoring.md` section 3: naming truth table, built-in vs MCP tools, `serverId/` prefix rule
- `workspace-api/SKILL.md` gotcha #5 updated: notes returned names are already prefixed

**Still needed if we want a standalone skill:** The full flow (list → enable → connect → add → validate) and common mistake patterns are covered in `workspace-api/SKILL.md` already. A separate skill may still be useful if we observe agents struggling with the tool-wiring flow specifically (not just during workspace creation). Defer until QA Checkpoint 3 shows a gap.

---

### 3. QA Checkpoint 3: End-to-end chat via agent-browser

**Goal:** Run the Inbox-Zero creation flow through the actual web client and verify:
1. Chat sends natural language intent
2. Tool calls appear in UI (list_mcp_tools, enable_mcp_server, upsert_agent, etc.)
3. Workspace appears in workspace list after publish
4. Firing a signal produces a completed session

**Prerequisites:**
- Daemon running on `localhost:8080`
- Web client running on `localhost:5200` (or wherever it's served)
- Gmail OAuth configured for `eric@tempest.team`
- `agent-browser` skill available

**Test script (from `docs/qa/plans/workspace-creation-redesign-cases.md` Case 10):**
```
1. Navigate to workspace-chat
2. Send: "I'd love to create a new workspace that works as a personal assistant
   to help me review my emails and get to inbox zero..."
3. Observe chat's tool calls:
   - list_mcp_servers (should show google-gmail as available)
   - list_mcp_tools({ serverId: "google-gmail" }) (should return tool names)
   - create_workspace({ name: "Inbox Zero" })
   - begin_draft({ workspaceId: "..." })
   - enable_mcp_server({ serverId: "google-gmail", workspaceId: "..." })
   - upsert_agent (triage-agent with verified tool names)
   - upsert_agent (reply-drafter)
   - upsert_job (triage_inbox)
   - upsert_job (draft_reply)
   - upsert_signal (triage-inbox-http)
   - upsert_signal (triage-inbox-cron)
   - upsert_signal (draft-reply-http)
   - validate_workspace → status: "ok" or only warnings
   - publish_draft
4. Verify workspace appears in list
5. Fire triage-inbox signal, poll session to completion
```

**Metrics to track:**
- Chat turns from intent to published workspace (target: ≤ 5)
- `run_code` bash/curl fallbacks (target: 0)
- `unknown_tool` validation errors (target: 0)
- `agent_claude-code` sub-agent spawns (target: 0)

**If it fails:** The failure mode tells us which gap remains. Most likely candidates:
- Validator still rejecting known-good tool names → Item 1 above
- LLM not calling `list_mcp_tools` before upsert → skill guidance gap
- LLM not passing `workspaceId` to `enable_mcp_server` → skill guidance gap (we just fixed the tool)

---

### 4. Phase 3 cleanup: Delete legacy workspace creation pipeline

**Blocked by:** QA Checkpoint 3 passing — we need confirmation the new flow replaces the old before deleting.

**What to delete:**
- `workspace_create` tool from workspace-chat (and its registration)
- `workspace-planner` agent
- `fsm-workspace-creator` agent
- `workspace-creator` Python agent
- Blueprint slice of `@atlas/workspace-builder` (the compiler/assembler)
- Blueprint patch endpoints in daemon
- Blueprint artifact handlers

**Verification before deletion:**
- Grep for imports from deleted modules across the codebase
- Run architecture test: assert no production code imports from blueprint slice
- Confirm `workspace_create` tool is not referenced in any skill docs

---

## Files the next agent will need to read

### For Item 1 (validator MCP resolution)
- `packages/config/src/validator.ts` — the validator implementation
- `apps/atlasd/routes/mcp-registry.ts` — the `GET /:id/tools` endpoint logic (reuse `createMCPTools` call)
- `packages/system/agents/workspace-chat/tools/list-mcp-tools.ts` — just shipped, shows the pattern
- `docs/plans/2026-04-27-workspace-creation-redesign-resolved.md` — validator design decisions (section on registry checks)

### For Item 2 (skills — mostly done, see 2a/2c above)
- `packages/system/skills/workspace-api/SKILL.md` — monolithic skill, now references job-authoring.md
- `packages/system/skills/workspace-api/references/job-authoring.md` — FSM cookbook, validation decoder, anti-patterns (just shipped)
- `packages/system/skills/workspace-api/assets/minimal-job-template.yml` — drop-in job template
- `packages/system/skills/workspace-api/assets/multi-step-job-template.yml` — pipeline job template
- `packages/system/agents/workspace-chat/tools/job-tools.ts` — FSM construction patterns
- `packages/system/agents/workspace-chat/tools/list-mcp-tools.ts` — tool discovery pattern (now returns prefixed names)
- `packages/system/skills/using-mcp-servers/SKILL.md` — MCP-specific skill (cross-reference)
- `packages/system/skills/writing-friday-agents/SKILL.md` — user-code agent authoring

### For Item 3 (QA)
- `docs/qa/plans/workspace-creation-redesign-cases.md` — full QA plan
- `packages/system/skills/qa-playground/SKILL.md` — browser automation skill
- `CONTEXT.md` — domain model reference

### For Item 4 (cleanup)
- `docs/plans/2026-04-27-workspace-creation-redesign-resolved.md` — phase 3 decisions
- Search for `workspace_create`, `workspace-planner`, `fsm-workspace-creator`, `workspace-creator` across codebase

---

## Key architectural decisions already made

1. **No blueprints.** The legacy planner/compiler/assembler pipeline is removed. Reliability comes from schema-tight mutation tools + strong validator + draft atomicity.

2. **Validator is the compiler.** Three layers: structural (Zod parse), reference integrity (named refs resolve), semantic warnings (dead signals, orphan agents, missing tools arrays). Errors block publish; warnings do not.

3. **Draft mode is opt-in.** `begin_draft` snapshots live config. Mutations write to `workspace.yml.draft`. `publish_draft` validates and atomically swaps. `discard_draft` deletes. Direct mode is default for single-entity edits.

4. **Per-entity upsert tools.** `upsert_agent`, `upsert_signal`, `upsert_job` — not a polymorphic `upsert(kind, item)`. LLMs struggle with tagged unions in tool selection.

5. **Tool names resolve against MCP registry.** The daemon's `GET /api/mcp-registry/:id/tools` endpoint already spins up the server and returns exact tool names. The new `list_mcp_tools` workspace-chat tool wraps this.

6. **Registry unavailability = system failure.** The validator refuses to proceed if it cannot reach the MCP/npm/pypi registry. No soft-fallback to warning.

---

## Transcript reference

The failure mode we're fixing is documented in:
- `chat_pwC2juu47H` (Inbox Zero failure) — available via daemon API at `http://localhost:5200/api/daemon/api/workspaces/user/chat/chat_pwC2juu47H`
- Root cause: agent couldn't enable Gmail MCP in new workspace, guessed tool names, validator rejected them, agent spent 6+ tool calls trying to introspect Python package internals

---

## Commands

```bash
# Run specific tests
deno task test packages/system/agents/workspace-chat/tools/list-mcp-tools.test.ts
deno task test packages/system/agents/workspace-chat/tools/enable-mcp-server.test.ts
deno task test packages/system/agents/workspace-chat/tools/disable-mcp-server.test.ts

# Type check
deno task typecheck

# Start daemon for QA
deno task atlas daemon start --detached

# Send test prompt
deno task atlas prompt "test your changes"
```
