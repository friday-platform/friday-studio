# Workspace Creation Redesign — Few-Shot via Draft + Validator

## Problem Statement

Friday's workspace creation today is a one-shot operation: the user describes what they want, the chat invokes `workspace_create` with a full config, and the daemon either accepts it or returns a 422. When it fails — and it usually does on non-trivial workspaces — the chat sees an opaque error, falls back to bash + curl + raw YAML editing, and binary-searches its way to a working config one Zod error at a time. This is what real conversations look like in production, both in Ken's reported feedback and in actual chat transcripts on disk.

The deeper problems behind that surface symptom:

1. **No incremental path.** Workspace creation is all-or-nothing. The chat can't build a workspace piece by piece, validating each piece, the way a developer iterates on code with a fast feedback loop. Every retry starts from scratch.

2. **No feedback loop the LLM can read.** When `workspace_create` rejects a config, the chat gets a stringified Zod blob. The LLM has no compiler-like signal — no "agent X references undefined MCP tool Y" — so it does shotgun debugging.

3. **No way to workshop a flow live, then crystallize it.** Ken's example: he can chat with workspace-chat, get it to triage his inbox using MCP tools, and have it work great in the conversation. But there's no path from "this worked in chat" to "save this as a recurring job." The chat-driven flow and the config-driven flow are disconnected.

4. **Live workspace is fragile during construction.** Today's `update` endpoint replaces the entire config and destroys the runtime; if the chat writes a half-valid YAML and then the user closes the laptop, the workspace can be left unloadable.

5. **Tools-on-agents is a recurring failure mode.** The LLM frequently writes LLM-type job agents without declaring the MCP tools they need, because nothing in the loop catches the omission until runtime.

6. **The legacy blueprint flow (workspace-planner + fsm-workspace-creator + the blueprint compiler in `@atlas/workspace-builder`) is too heavy** for the current world where prepare-functions and code-actions have been removed. It exists, partially works, and adds latency without earning its keep.

## Solution

Replace the one-shot `workspace_create` flow with a few-shot design built around three primitives: **a draft mode that's opt-in for multi-step builds**, **a small set of narrow mutation tools** the chat can call individually, and **a high-quality validator the LLM uses as its compiler**.

The model:

- **Direct mode (default).** Each mutation writes to the live `workspace.yml`. The endpoint validates the full post-mutation config; if it would be invalid, the mutation is refused and the LLM sees field-level errors with paths. Used for atomic ops ("add Gmail," "rename agent," "change cron").

- **Draft mode (opt-in via `begin_draft`).** Mutations write to a sibling `workspace.yml.draft` file. Per-call validation is permissive (structural only); cross-entity reference checks happen at `validate_workspace` and `publish_draft`. Used for multi-step builds where intermediate states are legitimately incomplete (a job created before its agent because of dependency order, or a coherent crystallization of a chat flow into agent + job + signal as one logical unit).

- **The validator (`validate_workspace`) is the compiler.** Three layers — structural (Zod parse), reference integrity (named refs resolve, MCP tools exist on agents that use them, npm/pypi packages installable), and semantic warnings (dead signals, dead agents, LLM agent with no tools array, cron parse, HTTP signal collisions). The structural layer walks `ZodError.issues[]` and emits one `Issue` per Zod issue with `path: issue.path.join(".")` and `message: issue.message` — never string-coerces a `ZodError`. This is the most important single deliverable; without it, no other improvement matters.

- **The skill teaches the recipe and the runtime model.** `workspace-api` (existing) grows substantially: the draft workflow, the `connect_service` → `enable_mcp_server` → `upsert_*` → `validate` → `publish` ordering, the **reachability mental model** (chat → job → agent → MCP tool; signals trigger jobs; memory accessed by agents — agents declared without a wrapping job are unreachable), **full CRUD coverage** including delete with batch curl examples, a **stuck-recovery heuristic** (after 3+ unclear failures on the same op, isolate by building minimum viable config and adding sections one at a time), **tool-selection guidance** (curl the daemon API directly for CRUD; reach for claude-code only for genuine codebase exploration or multi-file edits), the workshop-crystallize pattern, and conversational suggestion examples.

The legacy blueprint flow is removed in cleanup. `connect_service` and the existing 8 MCP/credential tools (per the shipped MCP workspace management plan) stay and become draft-aware.

## User Stories

### Workspace creation (spec-then-build)

1. As a Friday user, I want to describe what I want my workspace to do in natural language and have it built reliably, so that I don't have to know the YAML schema.

2. As a Friday user, I want the chat to iterate on a failed configuration with field-level errors instead of starting from scratch, so that small mistakes don't cost me a full retry.

3. As a Friday user, I want the chat to add an MCP server to my workspace as a single conversational turn ("add Gmail"), so that simple operations don't require ceremony.

4. As a Friday user, I want a multi-step workspace build to land atomically, so that closing my laptop mid-build doesn't leave me with a broken workspace.

5. As a Friday user, I want to see what the chat has staged before it goes live, so that I can catch mistakes before the workspace runtime sees them.

### Workspace creation (workshop-then-crystallize)

6. As a Friday user, I want to interactively prove out a flow with the chat using real MCP tools, so that I can see the behavior I'm trying to automate before I commit to it.

7. As a Friday user, I want to say "save this as a recurring job at 7am" after a successful chat workshop and have the chat propose an agent + signal + job triple for me to approve, so that I don't have to translate from chat behavior to YAML myself.

8. As a Friday user, I want the chat to recognize when a workshopped flow needs structural changes to become autonomous (e.g., approval steps for actions it shouldn't take unattended) and design those, so that crystallization is more than transcription.

### Editing existing workspaces

9. As a Friday user, I want to add an agent to an existing workspace through chat without affecting any of my running jobs, so that I can extend a workspace incrementally.

10. As a Friday user, I want to remove an entity from my workspace and have the chat warn me if anything else references it, so that I don't accidentally break a job.

11. As a Friday user, I want to disable an MCP server in my workspace conversationally with the same draft semantics as other edits, so that the surface is uniform.

11a. As a Friday user, I want to delete a workspace (or several at once) by asking the chat in plain language, without the chat spawning a code-writing sub-agent for what should be a curl, so that simple cleanup is fast.

11b. As a Friday user, I want the chat to understand that an agent without a wrapping job is unreachable from any signal, so that it builds workspaces that actually run instead of producing orphan agents.

### LLM-driven feedback loops

12. As workspace-chat (the LLM), I want a tool that runs the full workspace validator and returns field-level errors with paths, so that I can iterate against a compiler-like signal instead of guessing at YAML shapes.

13. As workspace-chat, I want each mutation tool to return a diff of what changed, so that I can confirm my intent landed correctly before moving on.

14. As workspace-chat, I want the validator to catch the common mistakes I make — agent referencing a tool that isn't enabled, job referencing an undefined agent, LLM agent missing the `tools` array — so that I don't need to memorize the failure modes.

### MCP and credentials integration

15. As a Friday user, I want the chat to enable an MCP server, bind credentials, and reference its tools in an agent as one coherent flow, so that the prerequisite ordering is handled for me.

16. As a Friday user, I want MCP enable/disable operations to participate in draft mode when one exists, so that my staged workspace and live workspace don't diverge.

17. As a Friday user managing the MCP page in the UI while a draft exists, I want a clear indication that my changes will land in the draft, so that I'm not surprised by the publish gate.

### Operational and developer-facing

18. As a Friday developer, I want the legacy blueprint compiler chain removed, so that there's a single source of truth for how workspaces get built.

19. As a Friday developer, I want the new mutation endpoints to share validation with `/create` and `/update`, so that the same Zod schema gates every write path.

20. As a Friday developer, I want the draft file to live next to `workspace.yml` on disk, so that the daemon's loader naturally ignores it and recovery from partial state is just `rm`.

## Implementation Decisions

### High-level shape

- New mutation tools and lifecycle tools live on the `workspace-chat` agent.
- Draft state is a sibling file (`workspace.yml.draft`) to `workspace.yml`. The daemon loader only reads `workspace.yml`; drafts are invisible to the runtime.
- Direct mode mutations write to live and run full strict validation. Draft mode mutations write to draft with permissive structural validation; cross-entity validation happens at `validate_workspace` and `publish_draft`.
- The shipped MCP workspace management endpoints (`enable_mcp_server`, `disable_mcp_server`) become draft-aware: if a draft exists, they mutate the draft. Otherwise, they mutate live as today.
- `workspace-creator` (Python agent), `workspace-planner` (LLM blueprint pipeline), and `fsm-workspace-creator` (blueprint compiler shell) are deleted. The blueprint code in `@atlas/workspace-builder` is deleted; `validateWorkspaceConfig` and `validateFieldPath` are kept.
- The `workspace_create` tool on workspace-chat is removed in phase 2 after the new draft flow is proven.

### Module Boundaries

**`validateWorkspace` (library function in surviving slice of `@atlas/workspace-builder`)**

- **Interface:** `validateWorkspace(parsedConfig, registry) → Report`. `Report` shape: `{ status: "ok" | "warning" | "error", errors: Issue[], warnings: Issue[] }`. Each `Issue`: `{ code, path, message }` where `path` is dot-notation pointing into the config (e.g., `agents.email-triager.tools[2]`).
- **Hides:** The composition of three validation layers — Zod schema parsing, reference integrity (resolving every named ID across agents, signals, jobs, tools, resources, memory blocks, MCP packages), and semantic checks (dead entities, missing tools on LLM agents, cron parsing, HTTP collision detection). The MCP registry probe for npm/pypi resolution.
- **Trust contract:** A `status: "ok"` response means the workspace will load and start; runtime errors are not guaranteed gone, but no static check failed. Errors block publish; warnings do not. Every issue has a path the LLM (or human) can navigate to. **Implementation requirement: walk `ZodError.issues[]` and emit one `Issue` per Zod issue with `path: issue.path.join(".")` and `message: issue.message`. Never `String(zodError)` or `JSON.stringify(zodError)` — that's the exact failure mode the design exists to fix.** Idempotent and side-effect-free.

**Draft store (file + endpoint pair)**

- **Interface:** Six HTTP endpoints under `/api/workspaces/:id/draft`: `GET` (read), `POST /begin` (create from live), `POST /items/:kind` (upsert entity), `DELETE /items/:kind/:id` (remove entity), `POST /validate` (run validator), `POST /publish` (atomic swap), `DELETE` (discard).
- **Hides:** The on-disk file representation, the atomic-rename publish strategy, the per-kind Zod schema slicing, the call into `validateWorkspace`, the post-publish call to the existing `/update` endpoint to trigger runtime reload.
- **Trust contract:** Draft mutations never affect the live workspace until `POST /publish` succeeds. Publish is atomic — either the swap happens and the runtime reloads, or live stays untouched and errors come back. Discard is destructive and immediate. The daemon loader cannot accidentally pick up a draft.

**Mutation tools (`upsert_agent`, `upsert_signal`, `upsert_job`, `remove_item`)**

- **Interface:** Each `upsert_*` accepts a fully-typed entity matching the relevant Zod schema. `remove_item` accepts `{ kind, id }`. All return `{ ok, diff, structural_issues }`.
- **Hides:** Whether the write goes to live or draft (decided by file existence), the per-entity validation, the diff computation against prior state.
- **Trust contract:** A successful response means the entity is persisted with that exact shape. The diff reflects exactly what changed at the entity level. `structural_issues` blocks the write; cross-entity issues do not (they surface from `validate_workspace`).

**Lifecycle tools (`begin_draft`, `validate_workspace`, `publish_draft`, `discard_draft`)**

- **Interface:** All zero-argument or near-zero. `begin_draft` creates the draft from live. `validate_workspace` runs the validator on whatever's current (draft if exists, live otherwise). `publish_draft` validates and swaps. `discard_draft` deletes the draft.
- **Hides:** Endpoint routing, the live-vs-draft switch, the atomic-swap mechanics, the runtime reload trigger.
- **Trust contract:** `begin_draft` is idempotent (no-op if draft exists). `publish_draft` either succeeds entirely or returns errors and leaves both files intact. `validate_workspace` is read-only.

**Skill (`workspace-api`, extended)**

- **Interface:** A markdown skill auto-loaded by workspace-chat. New sections (in this order, because the LLM reads top-to-bottom): (1) reachability mental model, (2) recipe ordering, (3) full CRUD coverage with curl examples for delete and batch ops, (4) stuck-recovery heuristic, (5) tool-selection guidance, (6) draft workflow, (7) workshop-crystallize patterns, (8) conversational suggestion examples, (9) LLM-vs-Python decision matrix.
- **Hides:** The mental model of when to use direct vs. draft mode, the prerequisite ordering of credential setup before MCP enable before agent creation, the structural-shift problem in crystallization, the heuristic for when to escalate to claude-code vs. just curl.
- **Trust contract:** Following the skill produces working workspaces in few-shot. The reachability section is page-one because it's the failure mode underneath most other failures (LLM declares orphan agents because no one taught it the runtime model). The skill cross-references `mcp-workspace-management` for MCP scope — no overlap.

### Direct mode vs. draft mode behavior

| Aspect | Direct mode | Draft mode |
|---|---|---|
| Default state | Yes | Opt-in via `begin_draft` |
| Where mutations write | `workspace.yml` | `workspace.yml.draft` |
| Per-mutation validation | Full strict (entire post-mutation config) | Permissive structural (just that entity) |
| Cross-entity validation | At every mutation | At `validate_workspace` and `publish_draft` |
| Behavior on partial state | Refuses if invalid; LLM must order correctly | Allowed; intermediate state legitimately incomplete |
| Best for | Single atomic ops | Multi-entity coherent builds |
| MCP enable/disable | Writes live | Writes draft (existing tools, draft-aware) |

### Validator output format

```
{
  status: "ok" | "warning" | "error",
  errors: [{ code, path, message }],     // blocks publish
  warnings: [{ code, path, message }]    // doesn't block
}
```

`code` is a stable identifier (e.g., `unknown_agent_id`, `missing_tools_array`, `dead_signal`, `cron_parse_failed`). `path` is dot-notation into the config. `message` is plain English with the offending value or referenced ID inline.

### Tool surface on workspace-chat (post-design)

**Existing (unchanged):** `list_mcp_servers`, `search_mcp_servers`, `install_mcp_server`, `create_mcp_server`, `get_workspace_mcp_status`, `enable_mcp_server`, `disable_mcp_server`, `connect_service` — 8 tools.

**New:** `upsert_agent`, `upsert_signal`, `upsert_job`, `remove_item`, `validate_workspace`, `begin_draft`, `publish_draft`, `discard_draft` — 7 tools (validator counted once because it's used in both modes).

**Removed:** `workspace_create` and the bundled-agent-tools entries pointing at deleted legacy agents.

**Total:** 15 tools.

### Skill: reachability mental model (page one)

Before any tool guidance, the skill teaches the runtime model in two paragraphs:

> **Friday workspaces have a fixed call chain.** Signals trigger jobs. Jobs run agents. Agents call MCP tools (and read/write memory). Nothing else triggers anything else. An agent declared at the top level of `workspace.yml` without a wrapping job is unreachable from any signal — the runtime never invokes it. Memory is accessed by agents, not signals or jobs directly. Tools belong to agents (via the agent's `tools:` array), and the tools have to be enabled at workspace scope (in `tools.mcp.servers`) for the agent to use them.
>
> When you (workspace-chat) build a workspace, work back from the trigger: what signal fires this? What job does that signal start? What agents does that job invoke? What tools do those agents need? An orphan agent is a build error, not a stylistic choice.

This goes first because it's the failure mode underneath most other failures.

### Skill recipe (the ordering)

After the reachability model, the skill codifies:

1. Identify required MCP servers from the user's intent.
2. For each not yet enabled in this workspace: `enable_mcp_server`.
3. For each provider whose credentials aren't bound: `connect_service`.
4. Decide direct vs. draft mode based on the request shape (single vs. multi-entity).
5. If draft: `begin_draft`. Then `upsert_agent` / `upsert_signal` / `upsert_job` in dependency order (dependencies before dependents — agents before the jobs that invoke them, jobs before the signals that trigger them).
6. `validate_workspace` — fix errors, address warnings or accept them.
7. If draft: propose publishing in the chat ("I've drafted X, Y, Z — want me to publish?"), then `publish_draft` on confirmation.

### Skill: full CRUD coverage

The current skill documents create/update only. New section covers the full surface with curl examples:

- **List**: `GET /api/workspaces`
- **Get**: `GET /api/workspaces/:id` and `GET /api/workspaces/:id/config`
- **Update**: `POST /api/workspaces/:id/update`
- **Delete (single)**: `DELETE /api/workspaces/:id`
- **Delete (batch)**: a curl-loop or `xargs` example for "delete these three workspaces" requests, with explicit "double-check the IDs before running this loop" guidance.

The point is to remove every reason workspace-chat would default to spawning a sub-agent for daemon CRUD.

### Skill: stuck-recovery heuristic

If validation fails 3+ times on the same operation and the error path is unclear:

1. Stop iterating on the current shape.
2. Build the minimum viable config (just `version` + `workspace.name`) and confirm it validates.
3. Add one section at a time (signals, then agents, then jobs), validating after each.
4. The first section that breaks is the one to debug.

This is the binary-search debugging the LLM invents in the moment under pressure. Codifying it removes the panic.

### Skill: tool-selection guidance

For daemon CRUD: curl the API directly. The skill teaches the endpoint shapes (see CRUD section above).

For codebase exploration or multi-file edits: claude-code is the right tool.

For workspace-shape changes: the dedicated `upsert_*` / `validate_workspace` / draft tools are always preferable to either curl or claude-code.

The failure mode this prevents: workspace-chat reaching for claude-code as a panic button when uncertain, turning a 5-second curl into an 8-minute agent call.

### Workshop-crystallize section in skill

New worked example covering:

- The chat distills its own conversation into one prompt + a `tools:` array (no new tool needed; the model is good at this).
- The structural shift problem: interactive flows often need approval steps when made autonomous (worked example: separate `book-meeting` HTTP signal for human-approved actions).
- Draft mode is the default for crystallization — the user reviews the proposed agent+job+signal triple as a unit before publish.
- Conversational suggestion examples: when and how to organically propose "want me to save this?" without being dogmatic.

### LLM-vs-Python decision matrix in skill

Guidance only; no new tooling. Heuristic: reach for Python (`type: user`) when the work is mechanical (parsing, transforming, multipart, deterministic routing) or when the LLM-loop tax dominates the value. Reach for `llm` when the logic is "figure out what to do" rather than "execute this transform." Examples cite the pattern in existing Python agents (parse + one focused `generate_object` call). Python agent creation remains an out-of-flow step the user kicks off explicitly until evidence shows the chat-driven path is worth building.

### UI changes

The edit page reads `workspace.yml.draft` when it exists, falling back to live, with a small "Draft" label near the title. No diff view, no validation panel, no publish button in the UI for v1 — chat owns publish. The MCP page gets a one-line banner when a draft exists.

### Phasing

**Phase 1 (additive):** Build `validateWorkspace` and the draft endpoints. Add the 7 new tools alongside `workspace_create`. Update the skill. Edit page reads draft.

**Phase 2 (cutover):** Remove `workspace_create` from workspace-chat. Update skill to reference only the new flow. Validate against real workspaces.

**Phase 3 (cleanup):** Delete the three legacy agents. Delete the blueprint slice of `@atlas/workspace-builder`. Delete blueprint patch endpoints. Delete blueprint artifact handlers (after grep confirms zero refs).

### Data Isolation

Not applicable. Workspace configs are filesystem resources keyed by workspace ID; no user-scoped database tables are touched.

## Testing Decisions

What makes a good test here: tests should exercise external behavior (does the validator catch this kind of error? does publish atomically swap? does the chat's tool sequence produce a working workspace?), not internals (which Zod path was traversed, which file was opened first).

**Validator unit tests.** Cover every error code with a minimal failing fixture and assert the path and message. Cover every warning code likewise. Test that warnings don't block publish and errors do. Test that the layer composition is correct — structural errors short-circuit reference checks (no point chasing references in unparseable YAML). Use Ken's Inbox-Zero workspace as a known-good fixture; validation should be clean. **Specific anti-regression test: feed a config with multiple Zod issues at different paths (e.g., a missing required field on a signal AND a wrong type on an agent), and assert the validator returns N distinct `Issue` objects with correct paths — not one stringified blob containing all of them. This test exists because that exact failure was the documented root cause of 13 failed `workspace_create` attempts in a real chat transcript.**

**Draft endpoint integration tests.** Test the full lifecycle (begin → upsert → validate → publish) end-to-end against a real daemon. Test that publish is atomic — if validation fails mid-publish, both files are intact. Test that discard is immediate. Test that `begin_draft` is idempotent. Test that the daemon loader ignores `.draft` files on workspace registration. Test that `enable_mcp_server` writes to draft when one exists.

**Mutation tool tests.** Test each upsert tool with a valid entity (asserts persisted + diff returned) and an invalid one (asserts structural issue + no write). Test `remove_item` with present and absent IDs. Test that direct mode mutations refuse on cross-entity errors and surface them.

**Chat integration tests.** Test that a chat turn with "add Gmail to this workspace" reaches `enable_mcp_server` (existing test extended). Test that a multi-step build session reaches `begin_draft` first. Test that a publish turn surfaces the validator output if it fails. **Anti-regression test: ask the chat to "delete workspaces foo and bar" and assert it uses `DELETE /api/workspaces/:id` curls, not a spawned claude-code sub-agent.** **Anti-regression test: ask the chat to build a workspace from a one-line spec and assert it produces no orphan agents (every `upsert_agent` call is followed by an `upsert_job` that invokes that agent ID).**

**Architecture test.** Assert that no production code path imports from the deleted blueprint slice of `@atlas/workspace-builder` after phase 3.

**Smoke test against real workspaces.** Reproduce the actual transcript referenced in the design discussion (the Inbox-Zero spec-then-build flow) using the new tools end-to-end. Confirm fewer turns, no binary search on errors, no fallback to bash + curl.

## Out of Scope

- **Diff view UI** comparing live vs. draft. Defer until iteration shows the edit page's draft display isn't enough.
- **Validation panel UI** on the edit page. Defer.
- **Sidebar draft indicator** (badge or color change on workspaces with pending drafts). Defer.
- **Publish button in the UI.** Chat owns publish in v1.
- **Schema-flow validation** (job step N+1 input schema matches step N output schema). Identified as the highest-value future check, but no current evidence the LLM produces broken schema flows. Defer to v2.
- **`upsert_memory_block` and `upsert_resource` tools.** Rare; manual YAML editing covers the case until evidence shows the LLM struggles.
- **Python agent authoring sub-agent.** The transcript review showed no demand. Skill carries the LLM-vs-Python decision matrix; users invoke `writing-friday-agents` manually.
- **Explicit crystallization tool.** The chat reads its own session and produces upsert calls — no new tool needed.
- **Path-addressed mutations** (jq/JSON-pointer style). Covered-and-rejected: LLMs fumble path resolution at non-trivial rates.
- **Polymorphic single-tool mutation surface** (`upsert(kind, item)`). Covered-and-rejected: LLMs struggle with tagged unions in tool selection.
- **Snapshot + auto-rollback** as a draft alternative. Covered-and-rejected: rollback semantics get hairy across mutation sequences.
- **Workspace-level MCP server overrides** (transport/env customization per workspace). Already out-of-scope per the MCP plan.
- **Multi-server test chat** for verifying combinations. Already out-of-scope per the MCP plan.

## Further Notes

### Why direct mode is the default

The transcript review revealed that "spec-then-build" — user arrives with a fully formed intent, chat builds directly — is at least as common as "workshop-then-crystallize." Forcing every flow through draft + publish would impose ceremony on the common case. Direct mode + a great validator handles spec-then-build naturally; draft mode is the opt-in escape hatch for genuinely multi-step work where intermediate states must stay invalid.

### Why the validator is the single most important deliverable

Both the user-reported feedback and the actual transcript show that the LLM's failure mode is not lack of tooling — it's lack of compiler-like signal. The legacy `workspace_create` flow already had Zod validation; it failed because the errors surfaced as opaque 422s with stringified blobs. Field-level path-prefixed plain-English errors are the difference between fast few-shot loops and minute-of-debugging binary search. Every other piece of this design (drafts, mutation tools, the skill) feeds into and reacts to the validator. Build it well or none of the rest matters.

### Why no path-addressed mutations and no polymorphic upsert

Considered both as ways to reduce tool count. Path-addressed (`edit_path("agents.email-triager.prompt", value)`) was rejected because LLMs fumble path resolution and the failure modes are subtle (silently writing to the wrong nested key). Polymorphic (`upsert(kind, item)`) was rejected based on the user's empirical signal that LLMs struggle with tagged unions in tool selection. Per-entity upsert tools cost more system-prompt context but earn it back in reliability.

### Relationship to the MCP workspace management design

The shipped MCP plan (`docs/plans/2026-04-25-mcp-workspace-management-design.v5.md`) added the workspace-scoped MCP tools and the `mcp-workspace-management` skill. This design depends on those existing and extends them in one place: `enable_mcp_server` and `disable_mcp_server` endpoints become draft-aware. The two skills (`workspace-api` and `mcp-workspace-management`) cross-reference rather than overlap — workspace-api covers shape, mcp-workspace-management covers MCP scope.

### Why not bring back blueprints

The legacy blueprint flow (workspace-planner → fsm-workspace-creator → compiler/assembler in `@atlas/workspace-builder`) sidestepped validation by being heavily LLM-driven and producing structurally-correct YAML by construction. It worked but was slow (5+ LLM calls per plan), tied to the now-removed prepare-functions / code-actions infrastructure, and inflexible for incremental edits. The new design recovers what blueprints gave (reliable structural correctness) by other means — schema-tight mutation tools, a strong validator, and draft-mode atomicity — without the latency or the rigidity. If a future "fully one-shot for non-technical users" mode is needed, it can be added as a wizard layer over the same primitives.

### Risk concentration

The validator's new warning layer is where bugs will hide. The most important pre-ship test is running real workspaces (Ken's Inbox-Zero, the transcript-derived workspace) through the validator and confirming both the false-positive rate is low (no spurious warnings on working workspaces) and the false-negative rate is low (genuine bugs like missing tools-on-agents are caught).

### Why the skill update is bigger than it looks

The new tools and the validator are the architecture. The skill is where the LLM's judgment lives, and review of two real chat transcripts revealed the dominant failure mode is not lack of tools but lack of guidance: the LLM doesn't know agents need wrapping jobs, doesn't know how to delete workspaces, doesn't know when to escalate to claude-code, doesn't know how to recover when stuck, and doesn't know the prerequisite ordering. Each of those was the root cause of a measurable real-world failure. The nine sections above (reachability, recipe, full CRUD, stuck-recovery, tool-selection, draft workflow, workshop-crystallize, suggestion examples, LLM-vs-Python) each map to a specific observed failure. The skill grows by maybe 2x; that's the right size.
