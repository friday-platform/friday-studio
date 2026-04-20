# Skills Scoping, Context Inspector, and skills.sh On-Demand Install

**Status:** Draft
**Date:** 2026-04-20
**Owner:** lcf

Covers four related asks:

- **D.1** Per-workspace and per-job skill scoping (P1)
- **A.4** Debug/inspector panel for active context (P1)
- **New:** Pull skills from [skills.sh](https://skills.sh/) on demand
- **New:** System-level skills — auto-provisioned built-ins (like the system workspace), including a meta skill for authoring new skills that follows the agentskills.io + Anthropic best practices

---

## Current State

### Skills architecture

- **Storage:** `MdSkillAdapter` writes to `{root}/skills/{workspaceId}/{name}/draft.md` — frontmatter + markdown body. Workspace-keyed on disk already.
  - `packages/adapters-md/src/md-skill-adapter.ts:96-234`
- **Schema:** `SkillFrontmatterSchema` at `packages/skills/src/skill-md-parser.ts:10-86`. Passthrough — accepts unknown fields (useful for adding scoping without breaking changes).
- **Resolution:** `resolveVisibleSkills(workspaceId, storage)` at `packages/skills/src/resolve.ts:17-45` already unions global (unassigned) + workspace-assigned skills via a `skill_assignments` mechanism.
- **Surfacing to LLM:** workspace-chat injects `<available_skills>` XML block into system prompt (`packages/system/agents/workspace-chat/workspace-chat.agent.ts:280-328, 510-512`), then `load_skill` tool fetches bodies on demand. Defense-in-depth workspace check at `packages/skills/src/load-skill-tool.ts:164-169`.
- **HTTP API:** `apps/atlasd/routes/skills.ts` has CRUD + publish + upload. No install-from-URL endpoint.
- **Job level:** does **not** exist. `workspace.yml` jobs don't declare skill dependencies.

### Playground UI

- **Two distinct inspectors:**
  - Chat inspector drawer in the chat view (Cmd+Shift+D, tabs include Waterfall + Timeline — commits `f7cea17780`, `6a4b4274dc`).
  - Standalone `/inspector/+page.svelte` for session deep-dive.
  - Neither has a "Context" tab.
- **Skills page:** `tools/agent-playground/src/routes/platform/[workspaceId]/skills/+page.svelte` — read-only list, literal empty-state message: "Assign skills or collections via the API".
- **Workspace edit:** raw YAML CodeMirror at `/platform/[workspaceId]/edit/`. No structured skills form.
- **No skills.sh integration** anywhere in the repo.

### skills.sh

- Public, unauthenticated HTTP API.
- `GET https://skills.sh/api/search?q=&limit=` — fuzzy search, returns `{skills: [{id, skillId, name, installs, source}]}`.
- `GET https://skills.sh/api/download/{owner}/{repo}/{slug}` — returns `{files:[{path, contents}], hash: "<sha256>"}`. Single round-trip, no git clone.
- Same `SKILL.md` + YAML frontmatter spec we use ([agentskills.io](https://agentskills.io)).
- No versioning in the API (HEAD of default branch); git URLs can pin `#ref`.
- Fallbacks: `.well-known/agent-skills/index.json`, GitHub trees API, git clone.
- Audit endpoint: `https://add-skill.vercel.sh/audit?source=<owner/repo>&skills=<csv>` — security metadata before install.

---

## Plan

### D.1 — Workspace + Job Scoping

#### D.1.a Workspace scoping — close the UI gap (data layer already exists)

1. **Binding API.** Add `POST /skills/{namespace}/{name}/assignments` and `DELETE` for removal. Body `{workspaceId}`. Writes to existing `skill_assignments` table. Read endpoint already exists.
2. **Playground Skills page rework** (`tools/agent-playground/src/routes/platform/[workspaceId]/skills/+page.svelte`):
   - Current list → split into **Assigned to this workspace** / **Global (available)** / **Other workspaces** sections.
   - Attach/detach buttons (with confirmation). Optimistic update via `skillQueries.workspaceSkills`.
   - Keep YAML editor in sync: writing `skills:` list in `workspace.yml` reconciles with DB assignments on save (or vice versa — pick one as source of truth; I'd make DB authoritative and generate the YAML block).
3. **workspace.yml schema stays as-is** — `skills: [{name}]`. Already supported.

#### D.1.b Job-level scoping — new

4. **Schema extension** in `@atlas/fsm-engine` job schema: optional `skills: string[]` on a job step (list of `@namespace/name`). Empty = explicitly none; absent = inherit workspace skills.
5. **Runtime enforcement.** When the workspace-chat agent (or any job LLM action) resolves its visible skills, pass the current job's `jobName` and intersect against `job.skills`. Touch points:
   - `packages/system/agents/workspace-chat/workspace-chat.agent.ts:510` — take a `jobFilter: string[] | null` arg.
   - `packages/fsm-engine/` LLM action path — thread the same filter.
   - Defense-in-depth in `load_skill` tool: pass jobFilter into the scope check at `load-skill-tool.ts:164-169`.
6. **Use case for C.1:** workspace-creator's job step says `skills: ['@tempest/workspace-config-authoring']` → chat on other jobs never sees it.

### A.4 — Inspector: Active-Context Tab

Target the **chat inspector drawer** (not the session `/inspector/` route). Files involved: `apps/web-client` chat page + drawer component from commits `f7cea17780`, `6a4b4274dc`.

1. **New "Context" tab** alongside Waterfall / Timeline.
2. **Data it shows** (all derivable from existing queries):
   - **Workspace:** id + name (already in chat-provider).
   - **Active agent:** from message metadata (we already stamp `provider` + `modelId` per turn; add `agentId` + `jobName` to `MessageMetadata` at `packages/agent-sdk/src/messages.ts:269-281`).
   - **Active skills:** hit `/api/workspaces/{id}/skills` + filter by job. Show which are "loaded" (read from `load_skill` tool calls in the current turn's parts).
   - **Active tools:** enumerate tool parts from the last assistant turn + the `AtlasTools` registry.
   - **Model chain:** show resolved `platformModels.get("conversational")` + (once implemented) fallback chain.
3. **Live updates:** subscribe to the chat message stream; recompute on every turn. No new endpoints required — all data is already on the client once message metadata carries `agentId`/`jobName`.
4. **Dev-mode toggle** per original note: env-gate via `import.meta.env.DEV` initially; graduate to a settings checkbox.

### skills.sh — On-Demand Install

1. **Daemon-side proxy + installer.** New route `POST /skills/install` with body `{source: "owner/repo/slug" | "skills.sh-url" | "github-url", workspaceId?: string}`.
   - Resolve via skills.sh JSON download (fast path).
   - Verify sha256 from response.
   - Write to workspace storage via existing `SkillStorageAdapter.create()`.
   - If `workspaceId` provided, auto-assign.
   - **Security:** optionally hit `https://add-skill.vercel.sh/audit?...` and surface flags before accepting. Gate behind a config flag (`ATLAS_ALLOW_REMOTE_SKILLS=true`) initially — remote instructions are prompt-injection surface.
2. **Playground "Browse skills" modal.**
   - Search box → `GET /api/daemon/skills/search?q=...` (new thin proxy to skills.sh) → result list with installs count + source.
   - Click → preview (fetch via install endpoint in dry-run mode → show frontmatter + first N lines of body).
   - "Install to this workspace" button → hit `/skills/install` with `workspaceId`.
3. **Update / pin.** For v1, no pinning — just re-install to update. Add a "Remote origin" field to frontmatter (`source: skills.sh/owner/repo/slug`) so we can later diff and surface update prompts.
4. **Skip for v1:** private skills, auth, version pinning, update notifications.

### System-Level Skills (Auto-Provisioned)

Today there's a system **workspace** bootstrapped on first run (`KERNEL_WORKSPACE_ID = "system"`, memory at `~/.atlas/memory/system/`). There are no system **skills**. Every user starts empty and has to author from scratch.

Goal: ship a small, curated set of **built-in skills** that provision automatically on first-run, analogous to the system workspace. These are globally available (unassigned to any workspace), version-controlled in the repo at `packages/system/skills/`, and loaded by the daemon at startup if missing from `SkillStorage`.

#### Bootstrap mechanism

1. **Source location:** `packages/system/skills/<name>/SKILL.md` (+ optional `references/`, `scripts/`, `assets/`).
2. **Loader:** on daemon start, walk `packages/system/skills/`; for each entry, check via `SkillStorage.get("@system/<name>")`; if missing or `version < bundled.version`, `create()` or bump.
3. **Ownership:** namespaced `@system/…`, immutable via the skills HTTP API (read-only for users). Users can fork into their own namespace.
4. **Visibility:** unassigned → visible to every workspace by default. Individual workspaces can opt out by adding an explicit deny-assignment (new table row: `skill_exclusions`) — out of scope for v1.
5. **Versioning:** bumped in repo via same `skill-publisher` flow; daemon reconciles on boot.

#### Built-in skills to ship (v1)

| Skill | Purpose |
|-------|---------|
| `@system/authoring-skills` | **Meta skill.** Teaches agents (and Claude) how to write new skills following agentskills.io + Anthropic best practices. See rules below. |
| `@system/creating-workspaces` | How to scaffold a new workspace: schema for `workspace.yml`, agent/job/signal shape, credential wiring, test-drive loop via `friday-cli`. Extracted from existing workspace-creator agent prompts + `COMPREHENSIVE_ATLAS_EXAMPLE.yml`. |
| `@system/creating-jobs` | How to add a new job to an existing workspace: FSM states/transitions, LLM actions, code actions, `outputType` rules, signal wiring. Pairs with C.1. |
| `@system/creating-agents` | How to write a Python/WASM Friday agent using `friday_agent_sdk` — overlaps heavily with existing `.claude/skills/writing-friday-agents/`, so port that into `@system/` namespace. |
| `@system/writing-workspace-configs` | Field-by-field reference for `workspace.yml` frontmatter, validation rules, common pitfalls (kernel ID, skill references, tool allowlists). |

Stretch: `@system/debugging-fsm`, `@system/integrating-mcp-server`, `@system/writing-evals`.

#### `@system/authoring-skills` — full draft at `docs/plans/drafts/authoring-skills/`

This is the meta skill. It must itself exemplify the rules it teaches. Full content drafted at `docs/plans/drafts/authoring-skills/` — ready for review and to move to `packages/system/skills/authoring-skills/` once approved. Layout:

```
authoring-skills/
├── SKILL.md                           # 162 lines — entry point, checklist, gotchas
├── references/
│   ├── frontmatter.md                 # name + description spec, good/bad examples
│   ├── control-calibration.md         # high/medium/low freedom with calibration examples
│   ├── patterns.md                    # gotchas, templates, checklists, validation loops,
│   │                                  #   plan-validate-execute, examples, conditional workflow
│   ├── scripts.md                     # when to bundle, execute vs read, solve-don't-punt,
│   │                                  #   justify constants, dependencies, MCP tool refs
│   ├── evaluation.md                  # eval-first workflow, Claude-A/B loop, trace reading
│   └── anti-patterns.md               # full anti-pattern catalogue
└── scripts/
    └── lint_skill.py                  # runs on publish — self-validates the meta skill
```

Pulled from:
- <https://agentskills.io/skill-creation/best-practices>
- <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices>

Self-lint status: passes clean (SKILL.md 162 lines / well under 5000 tokens, all references have `## Contents` TOCs, reference depth = 1, no first-person descriptions, no backslash paths, no un-quoted time-sensitive prose).

**Summary of rules the meta skill enforces** (full detail in the drafted files):

**Frontmatter contract** (validated via extended `SkillFrontmatterSchema`):

- `name`: lowercase letters/numbers/hyphens only, ≤64 chars, no `anthropic` / `claude` substrings. Prefer **gerund form** (`processing-pdfs`, `analyzing-spreadsheets`, `creating-workspaces`). Avoid vague (`helper`, `utils`, `tools`).
- `description`: ≤1024 chars, **third person**, includes **what** the skill does **and when** to use it. No XML tags. Triggers skill selection — highest-leverage field.
- No time-sensitive language.

**Body rules:**

- ≤500 lines, ≤5000 tokens for `SKILL.md` itself. Overflow moves to `references/` one level deep.
- **Start from real expertise** — extract from a completed hands-on task, not LLM-general synthesis.
- **Add what the agent lacks, omit what it knows.** Default assumption: Claude is smart. "Would the agent get this wrong without this line?" If no, cut.
- **Design coherent units.** Scoped too narrow → overhead. Too broad → unactivatable.
- **Calibrate control** to task fragility:
  - High freedom: multiple valid approaches → describe intent, let agent pick.
  - Medium freedom: preferred pattern → pseudocode with params.
  - Low freedom: fragile / must-sequence → exact command, "do not modify".
- **Defaults not menus.** Pick one tool, mention alternative briefly. Never "pypdf or pdfplumber or PyMuPDF or…".
- **Procedures not declarations.** Teach the approach, not a one-off answer.
- **Gotchas section** is the highest-value content. Concrete corrections (e.g. "`users` table uses soft deletes — always add `WHERE deleted_at IS NULL`"), not platitudes.
- **Templates, checklists, validation loops, plan-validate-execute** — use the pattern that fits.
- **Bundle scripts** in `scripts/` when the agent would otherwise reinvent the same logic. Scripts solve, don't punt. No voodoo constants — document every magic number.
- **Forward slashes only** in paths (`references/guide.md`, never `references\guide.md`).
- **Reference depth ≤1** from `SKILL.md`. Claude may partial-read nested files and miss content.
- **Reference files >100 lines** must include a table of contents at the top.
- **MCP tools always fully qualified:** `ServerName:tool_name`.
- **Consistent terminology** — one term per concept throughout (e.g. always "field", never mix with "box"/"element").
- **Old patterns** in a `<details>` block; no "before August 2025" prose.

**Evaluation-first authoring** (the skill should teach this workflow):

1. Run target tasks without any skill → identify specific failures.
2. Write ≥3 evaluation cases capturing the gap.
3. Baseline without skill.
4. Write minimal skill to close the gap.
5. Iterate against evals + observe execution traces — not just final outputs.

**Claude-A / Claude-B loop** (two-agent development pattern): author with one instance, test with a fresh instance, feed observations back.

#### Validation tooling

To enforce the rules, add a **linter** at `packages/skills/src/skill-linter.ts` that runs on publish (`POST /skills/:namespace/:name`):

- Parse frontmatter → schema check (name regex, reserved words, description length + third-person heuristic).
- Token-count `SKILL.md` body → warn >5000, error >8000.
- Line-count → warn >500, error >800.
- Walk referenced links → flag depth >1, flag broken refs.
- Flag backslash paths, `I can…` / `You can…` openings in description, time-sensitive phrases.
- Report via `{warnings: [...], errors: [...]}` in the publish response.

Playground: surface lint output in the skill-edit view and in skills.sh import preview.

#### Interaction with other pieces

- **D.1.a:** `@system/*` skills are unassigned → always globally visible. No special-case code.
- **A.4 Context tab:** show a "System" badge on `@system/*` skills so users distinguish built-ins from their own.
- **skills.sh import:** run the same linter on imported skills; surface warnings before install so users know what they're getting.

---

## Suggested Phasing

| Phase | Scope | Rationale |
|-------|-------|-----------|
| **1** | Plumbing: workspace assignment API endpoints + `MessageMetadata` extensions (`agentId`, `jobName`) | Low risk, unblocks both D.1 and A.4 |
| **2** | UI for D.1.a: assigned/global split + attach/detach in playground | Closes the biggest UX gap (literal "use API" message) |
| **3** | A.4 Context tab | Depends on Phase 1 metadata |
| **4** | skills.sh installer (daemon route + browse modal), gated by `ATLAS_ALLOW_REMOTE_SKILLS` | Isolated; independent of D.1.b |
| **5** | D.1.b Job scoping: schema + runtime filter | Coordinated changes across `fsm-engine` + workspace-chat; save for last |
| **6** | System skills bootstrap: `packages/system/skills/` loader + ship `@system/authoring-skills`, `@system/creating-workspaces`, `@system/creating-jobs`, `@system/creating-agents`, `@system/writing-workspace-configs` | Depends on Phase 1 (assignment plumbing) for globally-visible behavior to work cleanly |
| **7** | Skill linter + publish-time validation | Supports Phase 6 (meta skill must be enforceable) + Phase 4 (validate imports) |

---

## Open Questions

- **YAML vs DB source of truth** for workspace skill assignments — currently both can exist. Pick one to avoid drift.
- **skills.sh trust model** — these are arbitrary remote instructions. Do we want an install-time "review diff" UX, or a post-install sandbox (skill can't auto-execute, only describe)?
- **Job-level opt-in vs opt-out** — does `skills: []` on a job mean "no skills" or "inherit workspace"? Proposed: **absent = inherit, `[]` = explicitly none**.
- **Per-user skills** vs per-workspace — relevant when we start multi-user. Out of scope for P1 but worth flagging in the schema now.
- **System skill immutability** — make `@system/*` strictly read-only, or allow user override via fork? Proposed: read-only in place, fork-to-edit (copies into user namespace).
- **Port existing `.claude/skills/` content** (writing-friday-agents, parity-plan-context, friday-cli) into `@system/`? They're the best source material we have. Risk: duplication if the `.claude/` ones stay for Claude Code sessions. Likely want both, synced from a shared source.
- **Linter strictness** — warnings vs errors on publish. Proposed: errors on frontmatter schema violations, warnings on length/style heuristics.

---

## Key File Reference

| Component | File | Lines |
|-----------|------|-------|
| Storage interface | `packages/agent-sdk/src/skill-adapter.ts` | 59–68 |
| MD adapter | `packages/adapters-md/src/md-skill-adapter.ts` | 96–234 |
| Schema | `packages/skills/src/skill-md-parser.ts` | 10–86 |
| Workspace resolution | `packages/skills/src/resolve.ts` | 17–45 |
| Load-skill tool | `packages/skills/src/load-skill-tool.ts` | 61–218 |
| HTTP API | `apps/atlasd/routes/skills.ts` | 69–471 |
| System prompt injection | `packages/system/agents/workspace-chat/workspace-chat.agent.ts` | 280–328, 510–512 |
| Composition | `packages/system/agents/workspace-chat/compose-context.ts` | 77–95, 17–45 |
| Message metadata | `packages/agent-sdk/src/messages.ts` | 269–281 |
| Playground skills page | `tools/agent-playground/src/routes/platform/[workspaceId]/skills/+page.svelte` | 1–100 |
| Playground workspace layout | `tools/agent-playground/src/routes/platform/[workspaceId]/+layout.svelte` | 66–114 |
| Skill queries (client) | `tools/agent-playground/src/lib/queries/skill-queries.ts` | 112 |

## Related Docs

- `docs/plans/2026-01-12-user-skills.md` — earlier skills thinking (check for overlap)
