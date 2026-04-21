# Job-scoped skills — v2 Review Report

**Reviewed:** 2026-04-20
**Input:** `docs/plans/2026-04-20-job-scoped-skills.v2.md`
**Output:** `docs/plans/2026-04-20-job-scoped-skills.v3.md`
**Prior reviews:** `reviews/2026-04-20-job-scoped-skills-v1-review-report.md`

## TL;DR

v3 is a **pivot**, not a refinement. The user rejected v2's core
semantic model (whitelist/narrowing). v3 rebuilds the plan around
additive/union semantics: the job layer is **extra skills private to
that job**, not a filter on the workspace layer.

## Context Gathered

- Verified `SkillStorageAdapter` interface and `skill_assignments`
  table shape in `packages/skills/src/local-adapter.ts`. Confirmed
  today's PK is `(skill_id, workspace_id)` — a `job_name` column is
  additive, not a breaking change.
- Confirmed `SignalWithContext._context` (fsm-engine) and
  `sessionData` (core/agent-context) are the two context carriers that
  need a new `jobName` field; both are plain objects where adding one
  optional field is ~5 lines each.
- Checked `SkillEntrySchema` vs `SkillRefSchema` — `workspace.yml`
  uses objects for the workspace-level list, bare strings for the new
  job-level list. Accepted as-is in v3; documented as intentional
  rather than unified.
- Verified `@friday/*` bypass logic in `load-skill-tool.ts:80-87` — still
  coherent under additive semantics (always-visible is orthogonal to
  layer model).
- Checked that `@db/sqlite` respects the SQL standard "NULL is
  distinct in unique constraints" — relevant for the PK extension in
  Phase A.1. Flagged as Open Q2 for implementation-time verification.

## Ideas Proposed (5, from v2 pass — pre-pivot)

Proposed **before** the user's model clarification. Status after
pivot noted.

### Integrated into v3 semantics sections (or superseded)

- **E — Clarify workspace/job layering as outer/inner subset**
  Superseded by the pivot itself. v3's Semantics table explicitly
  models this as layers that UNION, not intersect. No more
  "outer/inner" ambiguity.

- **C — F.1 uses inline fixtures**
  Adopted directly. v3's Phase F.1 specifies "Fixtures: inline in the
  test file. 3-5 skills across (unassigned-global / workspace-level /
  job-a-only / job-b-only / @friday/*) exercise every branch. No new
  fixture directory."

- **D — Runtime backstop warning**
  Adopted as Phase D.2's "Runtime backstop: if resolveVisibleSkills
  returns zero job-level rows for a workspace whose YAML clearly
  declares some, log a warning once at first use."

### Demoted to notes / follow-ups

- **A — Workspace/job `skills:` field-shape mismatch**
  Kept as v3 "Field-shape note" section. Documented as intentional
  (workspace level supports inline defs; job level is pure
  assignment). Not unifying — would be a breaking change.

- **B — Debug UX for blocked loads**
  Under v2 this was "when the filter blocks a load, emit an event."
  Under v3 there's no filter — but an analogous gap exists: when
  `load_skill(X)` is rejected because X isn't in the resolved set,
  the LLM sees a bare error. Moved to "Deferred follow-ups" section
  as a distinct feature with its own acceptance criteria.

## The Pivot (the actual v2→v3 change)

The user's clarification was unambiguous:

> "workspace skills should be available for all jobs in workspace but
> there should be also job specific skill not available in the rest of
> the workspace"

That's **additive**, not whitelist. Two very different architectures:

| Aspect | v2 (whitelist) | v3 (additive) |
| --- | --- | --- |
| Visible to job X | `workspace ∩ job.skills` | `global ∪ workspace ∪ job.skills` |
| Job can narrow workspace? | Yes (the whole point) | No |
| Job can add a private skill? | No (skill must be workspace-assigned first) | **Yes** (the whole point) |
| Data model | Add a `skills: string[]` field to job config; filter in memory | Add `job_name` column to `skill_assignments`; union on query |
| `load-skill-tool.ts` `jobFilter` | Keep and wire up | **Remove** — subsumed by union resolver |
| Step-level filter | Wire up (new codepath) | Defer (schema kept, runtime ignores) |

The data-model change is the big one. v2 required no DB migration; v3
does. Migration is trivial (nullable column, PK extension) but it's
still a schema change that needs ordering.

## Call-Site Audit — Simpler in v3

v2's Phase C had to thread a filter through 5 call sites, each with
different job-context shapes. v3's narrower audit:

| # | File:line | Needs `jobName`? |
| --- | --- | --- |
| 1 | `packages/core/src/agent-context/index.ts:106,178` | Yes (sessionData.jobName) |
| 2 | `workspace-chat/compose-context.ts:41` | No — workspace chat isn't a job |
| 3 | `workspace-chat/workspace-chat.agent.ts:510` | No — ditto |
| 4 | `conversation.agent.ts:727` | No — user-scoped, not job-scoped |
| 5 | `fsm-engine.ts:1171` | Yes (_context.jobName) |

Only **two** sites need threading in v3, vs. all five in v2. Big win
from the "only job contexts pass jobName" model — makes the blast
radius obvious.

## Caveats & Tradeoffs

- **DB migration required.** v2 had no schema change; v3 adds a
  column to `skill_assignments`. Low-risk (nullable, PK extends) but
  production-only-if-not-SQLite environments need a migration step.
  Atlas runs SQLite today, so the `CREATE TABLE IF NOT EXISTS` +
  column-add path already works.

- **Step-level filter is now a dead schema field.** `LLMActionSchema.
  skills` and `AgentActionSchema.skills` stay in the schema (parsing
  doesn't break existing configs) but have no runtime effect in v3.
  Mildly confusing if someone sets it expecting it to work. Mitigated
  by an `@experimental` doc comment. Stronger alternative: remove the
  field entirely. Didn't do that because (a) no one is using it and
  (b) removal would require all .svelte/.ts files that reference
  `action.skills` to update or purge usages. Scope creep.

- **UI E.1 assumes a job-detail route exists.** Open Q1. If it
  doesn't, scope grows by ~1 h to stand one up.

- **Duplicate semantics for "assigned":** workspace-level assignment
  AND job-level assignment can both exist for the same (skill,
  workspace). `resolveVisibleSkills` dedupes by skillId. No ambiguity
  at the read path, but the UI has to show it clearly (skill X is
  "workspace-level" AND "in job-a" — both rows, same skill, both
  editable independently).

## Unresolved Questions (carried forward)

1. `/platform/:ws/jobs/:jobName` route existence — unverified.
   Phase E.1 assumes it; if absent, +1 h.

2. SQLite NULL-in-PK behavior under the specific `@db/sqlite`
   binding — standard SQL says distinct, needs a sanity test at
   implementation time.

3. Scoping-route API shape: `POST /api/skills/scoping/:skillId/assignments`
   — extend body with optional `jobName`, or new
   `POST .../assignments/:jobName` — decide at Phase B.

4. Reconcile-on-save transaction boundary: removing a skill from
   workspace-level and adding it to job-level simultaneously must not
   leave a window where neither row exists. Single SQLite transaction.

## Overlap with Prior Reviews

v1 review proposed five changes; v3 supersedes or absorbs all of
them:

- v1-1 (call-site audit 3→5) — still valid, enumerated in v3 Phase C.3
- v1-2 (`filterVisibleSkills` helper) — obsolete; no filter in v3
- v1-3 (F.1 drift invariant) — kept, adapted to additive semantics
- v1-5 (split Phase B into LLM / agent) — still valid in v3 (still two
  paths through the codebase), enumerated in Phase C.3/C.4
- v1-4 (empty-filter UX marker) — obsolete; no empty-filter state in v3

## Implementation Note for v3

If implementation proceeds, the natural ordering is:

1. Land A (schema + config) as its own PR — purely additive, zero
   runtime behavior change.
2. Land B+C together (CRUD + resolver + tool + call-site threading)
   as the "functionality is live" PR. Gate with F.1 in the same PR.
3. Land D (reconcile + validation) as a follow-on.
4. Land E1+E2 (UI) last, once the API surface is stable.

Writing F.1 first as a TDD guide (fails today because resolver has no
`jobName`, passes once Phase C.1 lands) is recommended but optional.
