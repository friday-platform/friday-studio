<!-- v2 - 2026-04-20 - Generated via /improving-plans from docs/plans/2026-04-20-skills-scoping-and-inspector.md -->

# Skills Scoping, Context Inspector, On-Demand Install, and System Skills

**Status:** Draft v2
**Date:** 2026-04-20
**Owner:** lcf
**Supersedes:** `2026-04-20-skills-scoping-and-inspector.md`

Covers four related asks:

- **D.1** Per-workspace and per-job skill scoping (P1)
- **A.4** Debug/inspector panel for active context (P1)
- **New:** Pull skills from [skills.sh](https://skills.sh/) on demand
- **New:** System-level skills auto-provisioned on first run, with a meta `authoring-skills` skill that enforces the Anthropic + agentskills.io best practices

**What v2 changes:** corrects several v1 claims about what's already built (assignment API, skills.sh client, frontmatter schema), moves the Context tab target to the playground (the actual location of the chat inspector), adds a trust-tier model for skills.sh, distillation-based seeding for system skills, a content-hash reconciliation mechanism for the bootstrap loader, an explicit fork-to-edit endpoint, and load-time lint events surfaced in the Context tab.

---

## Current State (verified against live code)

### Skills stack — more built than v1 claimed

- **Storage:** `SkillStorageAdapter` at `packages/skills/src/storage.ts:10-42`. Full CRUD, versioning, disabled flag, archive blobs, and assignment operations (`listUnassigned`, `listAssigned`, `assignSkill`, `unassignSkill`, `listAssignments`).
- **Schema:** `SkillFrontmatterSchema` at `packages/skills/src/skill-md-parser.ts:10-26` already enforces the Anthropic spec — `description` max 1024, `noXmlTags` refinement, passthrough `catchall` for unknown fields.
- **Resolution:** `resolveVisibleSkills(workspaceId, storage)` at `packages/skills/src/resolve.ts:17-45` unions unassigned + assigned.
- **Surfacing to LLM:** `workspace-chat.agent.ts:280-328, 510-512` injects `<available_skills>` block; `load_skill` tool with defense-in-depth workspace check at `packages/skills/src/load-skill-tool.ts:164-169`.
- **HTTP API:** `apps/atlasd/routes/skills.ts`:
  - CRUD + publish + upload + version delete ✅
  - **Assignment endpoints already wired** (`POST/GET/DELETE /scoping/:skillId/assignments`, keyed by `skillId`, supports 207 partial success) ✅
  - File-level read/write (`GET/PUT /:namespace/:name/files/*`) ✅
- **skills.sh client:** `SkillsShClient` at `packages/skills/src/skills-sh-client.ts` — search + download + 1-hour TTL cache + `OFFICIAL_ORGS` priority sort. **Install wiring + UI are the gaps.**
- **Namespaces:** validated by `NamespaceSchema` + `RESERVED_WORDS` in `@atlas/config`. `system` may be reserved — v2 uses **`@atlas`** as the bundled namespace pending verification.
- **Job-level scoping:** does not exist. `workspace.yml` jobs don't declare skill dependencies.

### Playground UI

- **Chat inspector** (target for Context tab): `tools/agent-playground/src/lib/components/chat/chat-inspector.svelte` + `tools/agent-playground/src/lib/inspector-state.svelte.ts`. Opened with Cmd+Shift+D. Existing tabs: Waterfall, Timeline. Effects already gated on panel-open (commit `d174102a6c`).
- **Standalone session inspector:** `tools/agent-playground/src/routes/inspector/+page.svelte` — out of scope for A.4.
- **Skills page:** `tools/agent-playground/src/routes/platform/[workspaceId]/skills/+page.svelte` — read-only list. Literal empty-state: "Assign skills or collections via the API."
- **Skill queries (client):** `tools/agent-playground/src/lib/queries/skill-queries.ts` — `catalog()`, `detail(ns, name)`, `files`, `fileContent`, `workspaceSkills(workspaceId)`. No assignment mutations yet.

### First-run bootstrap precedent

`packages/workspace/src/first-run-bootstrap.ts` defines `ensureDefaultUserWorkspace(manager)`: check `manager.find({id})`, write template, register. The system-skills loader uses the same shape (check `SkillStorage.get`, publish if missing/stale).

### skills.sh (external)

- `GET https://skills.sh/api/search?q=&limit=` + `GET /api/download/{owner}/{repo}/{slug}`. Unauthenticated.
- Audit: `https://add-skill.vercel.sh/audit?source=<owner/repo>&skills=<csv>`.
- Same SKILL.md + YAML frontmatter spec (agentskills.io).
- No versioning in API — HEAD of default branch.

---

## Plan

### D.1 — Workspace + Job Scoping

#### D.1.a Workspace scoping — wire existing API into the UI

The data layer and HTTP endpoints exist. The gap is the playground UI and the reconciliation story with `workspace.yml`.

1. **Playground Skills page rework** (`tools/agent-playground/src/routes/platform/[workspaceId]/skills/+page.svelte`):
   - Split display into three sections: **Assigned to this workspace**, **Global (unassigned, auto-visible)**, **Other workspaces (available to assign here)**.
   - Attach/detach buttons hit the existing endpoints. Optimistic update via a new `skillQueries.assignments(skillId)` and `workspaceSkills` invalidation.
   - Each section label shows counts.
2. **New client mutations** in `tools/agent-playground/src/lib/queries/skill-queries.ts`:
   - `assign(skillId, workspaceId)` → `POST /scoping/:skillId/assignments` with `{workspaceIds: [workspaceId]}`.
   - `unassign(skillId, workspaceId)` → `DELETE /scoping/:skillId/assignments/:workspaceId`.
3. **`workspace.yml` reconciliation.** Choose **DB as authoritative**. On YAML save (via the workspace edit view), diff the `skills:` list against current assignments and apply differences; emit a reconciliation report visible in the save response (`{added: [...], removed: [...]}`). YAML's `skills:` is then a read-mostly projection of DB state rather than a second source of truth.

#### D.1.b Job-level scoping

4. **Schema extension** in `packages/fsm-engine/` job-step schema: optional `skills: string[]` (list of `@namespace/name`). Semantics:
   - Absent → inherit workspace-level skill visibility.
   - `[]` → explicit empty (job sees no workspace-assigned skills, only global `@atlas/*`).
   - Populated → intersection of (workspace-visible ∪ `@atlas/*`) with the list.
5. **Runtime enforcement.** Thread a `jobFilter: string[] | null` through the LLM-action path:
   - `packages/system/agents/workspace-chat/workspace-chat.agent.ts:510` — accept `jobFilter`.
   - `packages/fsm-engine/` LLM action → pass the current step's `skills`.
   - `createLoadSkillTool` → accept `jobFilter`; the existing defense-in-depth check (`load-skill-tool.ts:164-169`) gains a second intersection against `jobFilter`.
6. **`@atlas/*` skills are always visible to all jobs** — they're the system library; opting out of them is handled by `allowed-tools` or agent design, not by job filter.

### A.4 — Context tab on the chat inspector (playground)

1. **Target** `tools/agent-playground/src/lib/components/chat/chat-inspector.svelte`. Add a **Context** tab alongside Waterfall + Timeline.
2. **Data shown** (one section per row):
   - **Workspace:** id + name, from chat context.
   - **Active agent + job:** derived from `MessageMetadata.agentId` + `jobName`. Requires extending `MessageMetadata` at `packages/agent-sdk/src/messages.ts:269-281` — nested agents surface as tool-progress events; the outermost wins.
   - **Model chain:** `platformModels.get("conversational")` + fallback chain (once runtime fallback lands — separate plan).
   - **Active skills:** from `skillQueries.workspaceSkills`, filtered by current job. Each row shows: name, description, `@system` badge (if applicable), disabled state, **lint warnings** (from idea #5).
   - **Loaded skills this turn:** inspect `load_skill` tool calls in the latest assistant turn's parts.
   - **Active tools:** enumerate tool parts + merge with `AtlasTools` registry for names not yet called.
3. **Live updates.** Re-derive on message changes; reuse the existing `panel open` gate to skip computation when hidden (commit `d174102a6c` pattern).
4. **Visibility gate.** `import.meta.env.DEV` for v1; graduate to a settings checkbox in a follow-up.

### skills.sh — On-Demand Install with Trust Tiers

The `SkillsShClient` class already handles network + caching. Remaining work: an install route, a browse UI, and a trust model.

1. **Trust tiers.** Three-tier model using the existing `isOfficialSource()` helper:
   - **Auto-install** — source matches `OFFICIAL_ORGS`. Install happens without confirmation; audit info fetched and surfaced post-install.
   - **Review-required** — source is any other GitHub repo. Install modal shows diff preview (frontmatter + first N lines of each file) before the user clicks Install.
   - **Disabled** — `ATLAS_ALLOW_REMOTE_SKILLS=false` blocks both tiers and hides the Browse UI.
2. **Install route** — `POST /skills/install` with `{source: "owner/repo/slug" | skills.sh URL | github URL, workspaceId?}`:
   - Resolve via `SkillsShClient.download()`.
   - Verify sha256 hash from the response.
   - Parse `SKILL.md` via existing `parseSkillMd`.
   - Run the linter (see next section) — warnings allowed; errors block with a structured response.
   - Publish via `SkillStorage.publish()` under namespace `@remote/<owner>-<repo>` (or user-chosen).
   - Record origin in frontmatter: `source: skills.sh/<owner>/<repo>/<slug>`, `source-hash: <sha256>`.
   - If `workspaceId` given and tier is `auto-install` or user confirmed, call `SkillStorage.assignSkill`.
3. **Search proxy** — `GET /api/daemon/skills/search?q=&limit=` thin wrapper on `SkillsShClient.search()`. Returns pre-sorted by `sortByOfficialPriority` with a `tier: "official" | "community"` flag per entry.
4. **Playground "Browse skills" modal** — attach from the Skills page header + via a new `+ Add skill` entry in the page chrome:
   - Search input → proxy endpoint.
   - Results grouped by tier (Official first, collapsible).
   - Click → preview modal: frontmatter + body head + audit report if available.
   - Install button → `POST /skills/install` with the current `workspaceId`. Optimistically invalidate `workspaceSkills` + `catalog`.
5. **Skip for v1:** version pinning, update notifications, private skills, auth. These land once we have telemetry on what users actually install.

### System-Level Skills (`@atlas/*`, auto-provisioned)

**Why `@atlas` not `@system`:** `system` may conflict with `RESERVED_WORDS`. `@atlas` is the product namespace and reads naturally. Verified before merge.

#### Bootstrap mechanism

1. **Source location:** `packages/system/skills/<name>/SKILL.md` (+ optional `references/`, `scripts/`, `assets/`).
2. **Content-hash reconciliation.** Build step computes sha256 over each skill directory (SKILL.md + references/* + scripts/*) and writes `source-hash: <sha256>` into the bundled frontmatter. At daemon boot:
   - For each bundled skill, compute the current hash.
   - `SkillStorage.get("atlas", name)` — compare stored `source-hash` frontmatter field.
   - Mismatch → republish with new hash. Match → no-op (idempotent).
3. **Loader:** new function `ensureSystemSkills()` in `packages/system/skills/bootstrap.ts`, called from the same init path that runs `ensureDefaultUserWorkspace`.
4. **Ownership.** Bundled skills live under namespace `@atlas`. Publish succeeds via the normal API with a `createdBy: "system"` user marker. Write endpoints for `@atlas/*` reject non-system callers (middleware check against the namespace + user).
5. **Visibility.** Unassigned → visible everywhere. Always.

#### Built-in skills to ship (v1)

| Skill | Authoring method | Source material |
|-------|------------------|-----------------|
| `@atlas/authoring-skills` | **Hand-written** (the meta skill must exemplify its own rules). Full draft at `docs/plans/drafts/authoring-skills/`. | agentskills.io + Anthropic best practices. |
| `@atlas/creating-workspaces` | **Distilled** via `skill-distiller` agent → curated. | `COMPREHENSIVE_ATLAS_EXAMPLE.yml` + `fsm-workspace-creator` agent prompts + `docs/integrations/*`. |
| `@atlas/creating-jobs` | **Distilled**. | FSM engine schema + existing workspace.yml examples + `fast-self-modification` skill. |
| `@atlas/creating-agents` | **Distilled**. | `.claude/skills/writing-friday-agents/` (existing Claude-Code skill — good source, but not ported literally; regenerated to match the live SDK). |
| `@atlas/writing-workspace-configs` | **Distilled**. | `packages/workspace/src/schema.ts` + `COMPREHENSIVE_ATLAS_EXAMPLE.yml` + common-pitfalls gotchas from recent commits. |

Stretch: `@atlas/debugging-fsm`, `@atlas/integrating-mcp-server`, `@atlas/writing-evals`.

#### The meta skill — `@atlas/authoring-skills`

Full drafted content at `docs/plans/drafts/authoring-skills/` — ready to move to `packages/system/skills/authoring-skills/` once approved.

```
authoring-skills/
├── SKILL.md                           # 162 lines, self-lints clean
├── references/
│   ├── frontmatter.md                 # field spec + good/bad description examples
│   ├── control-calibration.md         # high/medium/low freedom with per-section calibration
│   ├── patterns.md                    # gotchas, templates, checklists, validation loops,
│   │                                  #   plan-validate-execute, examples, conditional workflow
│   ├── scripts.md                     # when to bundle, execute vs read, solve-don't-punt,
│   │                                  #   justify constants, dependencies, MCP tool refs
│   ├── evaluation.md                  # eval-first workflow, Claude-A/B loop, trace reading
│   └── anti-patterns.md               # full anti-pattern catalogue
└── scripts/
    └── lint_skill.py                  # runs on publish + at load time (fast pass)
```

Rules enforced (full detail in drafted files, pulled from <https://agentskills.io/skill-creation/best-practices> and <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices>):

**Frontmatter:** name lowercase/hyphens/≤64 chars / gerund preferred / no `anthropic`-`claude` substrings; description ≤1024 chars, third person, `Use when …` clause, no XML tags.

**Body:** ≤500 lines / 5000 tokens SKILL.md; move overflow to `references/` one level deep; gotchas section highest-ROI; calibrate control (high / medium / low freedom) per section; defaults not menus; procedures not declarations; consistent terminology; old patterns in `<details>` block, no time-sensitive prose.

**Scripts:** solve don't punt; justify every constant; declare dependencies; forward slashes only; `ServerName:tool_name` format for MCP.

**Evaluation:** write ≥3 cases before polishing; baseline without skill; Claude-A/B loop; read execution traces.

#### Distillation workflow for `creating-*` skills

Rather than hand-writing, use the existing `skill-distiller` agent:

1. Create a workspace with a signal that invokes `skill-distiller` with source artifacts.
2. Distiller produces a `skill-draft` artifact.
3. Human reviews, adjusts, promotes via `create_skill` tool.
4. Run `lint_skill.py` on the promoted skill.
5. Export → check the `SKILL.md` + references into `packages/system/skills/<name>/`.
6. Build step computes `source-hash`; loader provisions on next boot.

This practises the meta-skill's own advice (start from real artifacts, iterate via Claude-A/B) and demonstrates the tooling users will use for their own skills.

#### Fork-to-edit

Users can't modify `@atlas/*` directly, but can fork.

1. **Endpoint:** `POST /skills/@atlas/:name/fork` with `{targetNamespace?: string, workspaceId?: string}`.
   - Default `targetNamespace`: the caller's personal namespace (derived from user ID).
   - Copies the skill (all files + frontmatter minus `source-hash`) into the new namespace with a fresh `skillId`.
   - If `workspaceId` given, atomically: unassigns the workspace from the original, assigns to the fork. Single transaction.
2. **UI:** "Fork" button on `@atlas/*` skills in the playground detail page. Confirm dialog explains "this workspace will switch from using the system skill to your copy."
3. **Drift notification:** if the upstream `@atlas/*` skill updates after fork (new `source-hash`), surface a diff prompt in the Context tab. Users can pull updates by re-forking (overwrite) or ignore.

#### Validation tooling (single linter, two entry points)

Implementation: `packages/skills/src/skill-linter.ts` + `scripts/lint_skill.py` (matching rules, two languages — TS for server, Python for the bundled meta-skill script).

**Rules:**

- Frontmatter schema (already enforced by `SkillFrontmatterSchema`).
- Body line count: warn >500, error >800.
- Body token count (approx chars/4): warn >5000, error >8000.
- Reference depth: walk markdown links from SKILL.md; warn on depth >1; error on broken refs.
- Reference file line count: warn >100 without a `## Contents` heading.
- Description checks: third-person heuristic (`I can …`, `You can …` patterns), presence of "Use when …" clause (warning).
- Path style: error on `\\`-separated paths outside fenced code blocks.
- Reserved name substrings (`anthropic`, `claude`) in `name` field: error.

**Publish-time:** runs in `POST /:namespace/:name` → returns `{warnings: [], errors: []}` in response. Errors block publish.

**Load-time:** runs fast pass (frontmatter + budget only; skip reference walks) in `createLoadSkillTool` when a skill is loaded via `load_skill`. Warnings are emitted as `skill-lint-warning` data events:

```json
{"type": "skill-lint-warning", "skillId": "...", "warnings": [...]}
```

Context tab consumes these and renders a small badge on affected skills.

**Skills.sh import:** runs publish-time rules during `POST /skills/install`.

#### Interaction with other pieces

- **D.1.a:** `@atlas/*` unassigned → globally visible. No special code.
- **D.1.b:** `@atlas/*` always visible regardless of job `skills:` filter.
- **A.4:** `@atlas` badge shown next to skill names in the Context tab. Lint warnings surfaced inline.
- **skills.sh import:** lints imported skills; warnings shown in install preview; errors block.

---

## Suggested Phasing

| Phase | Scope | Rationale |
|-------|-------|-----------|
| **0** | Verification + document what's already built (assignment API, skills.sh client, frontmatter schema). Write onboarding note to `docs/learnings/`. | Prevents duplication; team-wide signal that the plumbing exists. |
| **1** | `MessageMetadata` extensions (`agentId`, `jobName`). Thread through workspace-chat + fsm-engine. | Low risk, unblocks A.4. |
| **2** | D.1.a UI: playground Skills page rework + client mutations + YAML reconciliation on save. | Closes biggest UX gap (literal "use API" message). |
| **3** | A.4 Context tab in `chat-inspector.svelte`. Dev-mode-gated. | Depends on Phase 1 metadata + Phase 2 query hooks. |
| **4** | Skill linter (`skill-linter.ts`). Publish-time + load-time entry points. | Self-contained, supports Phases 5 & 6. |
| **5** | skills.sh installer: `POST /skills/install`, search proxy, Browse modal with trust tiers. `ATLAS_ALLOW_REMOTE_SKILLS` flag. | Leans on existing `SkillsShClient`. |
| **6** | System skills bootstrap: content-hash reconciliation + `ensureSystemSkills()`. Ship `@atlas/authoring-skills` (hand) + the four distilled skills. | Depends on Phase 4 (meta skill must self-lint). |
| **7** | D.1.b Job scoping: schema + runtime filter. | Coordinated changes across `fsm-engine` + workspace-chat; least urgent, most risk. |
| **8** | Fork-to-edit endpoint + UI. | Only matters once users try to modify `@atlas/*`. |

---

## Open Questions

- **`@atlas` namespace availability.** Verify against `RESERVED_WORDS` before implementation.
- **`workspace.yml` ↔ DB drift.** If a user edits `skills:` in YAML but also edits via UI, which wins? Proposal in D.1.a: DB authoritative, YAML reconciled on save. Reconfirm with team.
- **Fork drift semantics.** What to show when original bumps after fork? Inline diff? Pull-to-update button? Ignore and call it a fork?
- **Linter-rule bikeshedding.** Initial rules are heuristic (third-person detection is fragile). Start strict on schema, lenient on style; revise based on false-positive rate from real skills.
- **Distillation quality gate.** Who reviews the distilled `creating-*` skills before commit? Proposal: same review gate as any other repo change; distiller is a draft-producer, not a publisher.
- **Per-user skills** (non-workspace). Deferred until multi-user becomes concrete, but the `namespace/name` model can already express it (`@user-<id>/*`).
- **Nested agent identity in A.4.** Which `agentId` when a turn involves sub-agents? Proposal: outermost; tool-progress events carry nested identity separately.

---

## Key File Reference

| Component | File | Lines |
|-----------|------|-------|
| Storage adapter interface | `packages/skills/src/storage.ts` | 10–42 |
| Frontmatter schema + parser | `packages/skills/src/skill-md-parser.ts` | 10–86 |
| Assignment-aware visibility | `packages/skills/src/resolve.ts` | 17–45 |
| Load-skill tool | `packages/skills/src/load-skill-tool.ts` | 61–218 (defense-in-depth at 164–169) |
| skills.sh client | `packages/skills/src/skills-sh-client.ts` | 1–201 |
| HTTP API routes | `apps/atlasd/routes/skills.ts` | 69–471 (assignments at 87–137) |
| Bootstrap precedent | `packages/workspace/src/first-run-bootstrap.ts` | 1–34 |
| System prompt injection | `packages/system/agents/workspace-chat/workspace-chat.agent.ts` | 280–328, 510–512 |
| Skill composition | `packages/system/agents/workspace-chat/compose-context.ts` | 17–45, 77–95 |
| Message metadata | `packages/agent-sdk/src/messages.ts` | 269–281 |
| Playground chat inspector (A.4 target) | `tools/agent-playground/src/lib/components/chat/chat-inspector.svelte` | — |
| Playground inspector state | `tools/agent-playground/src/lib/inspector-state.svelte.ts` | — |
| Playground Skills page | `tools/agent-playground/src/routes/platform/[workspaceId]/skills/+page.svelte` | 1–100 |
| Playground skill queries | `tools/agent-playground/src/lib/queries/skill-queries.ts` | 45–126 |
| skill-distiller agent | `packages/system/agents/skill-distiller/` | — |
| Meta skill draft | `docs/plans/drafts/authoring-skills/` | — |

## Related Docs

- `docs/plans/2026-01-12-user-skills.md` — first generation of the skills stack (workspace-scoped, draft-then-promote). Current architecture has moved to namespace/name + assignments, but `skill-distiller` remains the distillation pathway used in Phase 6.
- `docs/plans/reviews/2026-04-20-skills-scoping-and-inspector-v1-review-report.md` — review that produced this v2.
