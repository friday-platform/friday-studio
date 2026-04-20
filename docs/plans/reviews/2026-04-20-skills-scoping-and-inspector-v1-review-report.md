# Review Report — v1

**Plan:** `docs/plans/2026-04-20-skills-scoping-and-inspector.md`
**Reviewer:** /improving-plans
**Date:** 2026-04-20

## Context Findings (v1 drift from current code)

The v1 plan was written without verifying several claims against the live repo. Corrections:

| v1 claim | Reality |
|---|---|
| "Add `POST /skills/{namespace}/{name}/assignments` and `DELETE`" (D.1.a step 1) | **Already exists** at `apps/atlasd/routes/skills.ts:87-137` — `POST/GET/DELETE /scoping/:skillId/assignments`, keyed by stable `skillId` not `namespace/name`. Supports 207 partial-success on bulk assigns. |
| "New route `POST /skills/install`" (skills.sh section) | Partially exists — `SkillsShClient` at `packages/skills/src/skills-sh-client.ts` already handles search, download, TTL cache, and official-org priority sort. Install wiring + UI are the real gaps. |
| "`SkillFrontmatterSchema` at `packages/skills/src/skill-md-parser.ts:10-86`" | Correct location, but the schema **already enforces** the Anthropic spec (description max 1024, `noXmlTags` refinement, passthrough via `catchall`). No "extension" needed. |
| Inspector panel target is "web-client chat page" | **Wrong app.** Chat inspector is the **playground** at `tools/agent-playground/src/lib/components/chat/chat-inspector.svelte`. Web-client chat is a separate surface. |
| Bootstrap mechanism is new-to-design | Template exists: `ensureDefaultUserWorkspace` in `packages/workspace/src/first-run-bootstrap.ts` — system-skills loader should mirror the shape. |
| `@system` namespace availability | Not verified. `RESERVED_WORDS` check runs on namespace input; `system` may be blocked. v2 must confirm or pick a safe alternative (`@atlas`?). |

## Analysis of 5 new ideas

### 1. Skills.sh trust tiers — leverage `OFFICIAL_ORGS`

- **Agree.** `isOfficialSource()` already exists in `skills-sh-client.ts` with a curated list (anthropics, vercel, microsoft, google, openai, github, supabase, official).
- **Approach chosen for v2:** three tiers — official auto-install with audit surfaced, community requires diff-review UI, env flag (`ATLAS_ALLOW_REMOTE_SKILLS`) disables entire feature.
- **Alternative considered:** single flag for everything (v1's approach). Rejected — crude UX for a feature that has trust-graded inputs.
- **Alternative considered:** require click-through for everything. Rejected — friction on known-safe sources hurts adoption.

### 2. Distill system skills rather than hand-writing

- **Agree strongly.** The v1 plan already notes `skill-distiller` and `fsm-workspace-creator` exist but doesn't use them.
- **Approach chosen for v2:** hand-write only `@system/authoring-skills` (meta skill, must exemplify its own rules). For the other 4 (`creating-workspaces`, `creating-jobs`, `creating-agents`, `writing-workspace-configs`) — feed existing artifacts (`COMPREHENSIVE_ATLAS_EXAMPLE.yml`, agent prompts, `.claude/skills/writing-friday-agents/`) through skill-distiller → curate → commit.
- **Alternative considered:** distill the meta skill too. Rejected — it must embody the rules; easier to author than post-edit.
- **Alternative considered:** hand-write all five. Rejected — skips eval-first practice and duplicates material already in the distiller's training path.

### 3. Version reconciliation via content hash

- **Agree — real design gap in v1.** Bundled `version` from repo and stored `version` (auto-increment int) are not comparable.
- **Approach chosen for v2:** compute sha256 over SKILL.md + all reference files at build time; emit as `source-hash` in frontmatter. Daemon republishes only on hash mismatch. Idempotent and transparent.
- **Alternative considered:** semver in bundled frontmatter. Rejected — humans forget to bump; hash is automatic.
- **Alternative considered:** mtime-based comparison. Rejected — fragile across worktree checkouts and CI caches.

### 4. Fork-to-edit endpoint + atomic reassignment

- **Agree — v1 says "fork-to-edit" without any flow.**
- **Approach chosen for v2:** `POST /skills/@system/:name/fork` (returns `{skillId}` of new `@user/:name`) + atomic reassignment of caller's workspace from original to fork.
- **Alternative considered:** keep both assigned. Rejected — duplicate skill visible in chat, confusing.
- **Alternative considered:** require manual unassign + re-assign. Rejected — three API calls for one conceptual action is poor API design.
- **Open question:** what if multiple workspaces share the original? Fork-and-reassign only affects the caller's workspace; others keep the original. OK.

### 5. Load-time lint + Context-tab events

- **Agree.** Plan's linter-on-publish misses drift caused by file-PUT edits (`PUT /:namespace/:name/files/*` already exists in `skills.ts:207`).
- **Approach chosen for v2:** fast lint pass (frontmatter + body budget only; skip reference-depth walks) inside `createLoadSkillTool`. Non-fatal; emits `skill-lint-warning` data events consumed by the Context tab.
- **Alternative considered:** fail loading on any lint error. Rejected — breaks skills that have only-warnings; changes runtime semantics.
- **Alternative considered:** server-side only, no UI signal. Rejected — the whole point of A.4 is observability; this is cheap information to surface.

## Overlap with prior art

`docs/plans/2026-01-12-user-skills.md` documents the first generation of the skills stack (workspace-scoped, draft-then-promote flow via `skill-distiller` agent, `useWorkspaceSkills` flag on agents). The current architecture has moved to `namespace/name` with `skill_assignments`, but the distillation agent is still present and usable — idea #2 leans on it.

## Unresolved questions carried to v2

- **`@system` vs `@atlas` namespace.** The `RESERVED_WORDS` check may block `system`. v2 picks `@atlas` as the namespace for bundled skills pending verification.
- **Agent identity in A.4 metadata.** Plan proposes stamping `agentId` into `MessageMetadata`. For multi-agent turns (e.g. workspace-chat spawning sub-agents), which agent's ID wins? Proposal: the outermost (what the user sees); nested agent calls surface via tool-progress events.
- **`workspace.yml` `skills:` reconciliation on save.** v1 says "DB authoritative, generate YAML". How does that interact with manual YAML edits? v2 adds: on YAML save, diff `skills:` against DB assignments; apply differences; log reconciliation report.
- **Skills disabled vs unassigned vs excluded.** DB has `disabled` flag + assignments. Plan mentions `skill_exclusions` table. Three boolean-ish states risk confusion; v2 defers exclusions until there's a concrete use case and a user who asks for "deny this specific skill in this workspace".

## Phase rework

v1 phases 1-7 in v2 become 6 phases after collapsing plumbing-already-exists work. New phase 0 = "verify and document what already exists"; this is real work since several team members may assume endpoints need to be built.
