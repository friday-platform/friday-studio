# Job-scoped skills — v7 Review Report

**Reviewed:** 2026-04-20
**Input:** `docs/plans/2026-04-20-job-scoped-skills.v7.md`
**Output:** `docs/plans/2026-04-20-job-scoped-skills.v8.md`
**Prior reviews:** v1–v6 review reports.

## TL;DR

v7 promised to be mechanically implementable; one concrete bug
survived. Single fix: the legacy defense-in-depth in
`load-skill-tool.ts:207` is too permissive for the additive model.
v8 replaces it with a `resolveVisibleSkills`-based check. One-line
logic change, one new regression test.

Review honored the "name a failing test" bar set in v6.

## Context Gathered

- Read `load-skill-tool.ts:200-212`. The defense-in-depth gate uses
  `listAssignments(skillId)` + `.includes(workspaceId)`. Pre-additive
  this meant "workspace is in the assignment list" which was a
  complete visibility check. Post-additive it means only "workspace
  is mentioned in ANY assignment row for this skill" — which is
  looser than what `resolveVisibleSkills({jobName})` returns.
- Traced all `listAssignments` callers:
  - `workspaces/index.ts:2040` — classified-skills display
  - `skills.ts:444` — scoping GET route display
  - `load-skill-tool.ts:207` — security gate ← **the bug**
- Confirmed F.1 tests the resolver path but not the legacy
  listAssignments gate; they're independent code.
- Verified the fix direction: `resolveVisibleSkills(workspaceId,
  {jobName})` already returns the correct additive set per v7 Phase
  C.1. Using `.some(matchRef)` on its result gives the same
  visibility the prompt block shows. Clean single-source-of-truth.

## Ideas Proposed (1)

### 1. Legacy defense-in-depth uses wider visibility than the additive resolver

Concrete failing test: skill assigned only at `job-a` level
(`skill_assignments` row `(X, ws, 'job-a')` only). From workspace
chat or peer job `job-b`:

- `resolveVisibleSkills(ws, {})` correctly excludes X (no
  workspace-level row for X).
- Prompt's `<available_skills>` correctly excludes X.
- BUT `listAssignments(X)` with v7's DISTINCT fix returns `['ws']`.
- Defense check at line 208: `assignments.data.includes('ws')` →
  true → check passes → skill loads.

Hallucinated or injection-driven `load_skill("@ns/X")` succeeds
despite X being scoped to job-a only.

**Fix (v8):** replace line 207's listAssignments-based check with
a `resolveVisibleSkills(workspaceId, {jobName})` + `.some(match)`
check. Unifies the two accept-paths; F.1 invariant now covers
everything.

### Rejected / Not Adopted

No other ideas proposed. Confined the pass to a single concrete
finding; avoided gold-plating.

## What v7 Missed That v8 Doesn't

v7 Phase A.1.5 audited queries for workspace-level semantics
(`AND job_name IS NULL`) and Phase C.2 wired resolver into the
tool's accept. But it didn't audit the tool's EXISTING
listAssignments-based gate which predates the additive model.
Two accept-paths + resolver change = drift.

Lesson carried: when adding a column to a table, audit both
(a) all queries on that table (v7's A.1.5) AND (b) all callers
that make visibility decisions based on those queries' results
(v8's new coverage).

## Caveats & Tradeoffs

- **Two calls now go through `resolveVisibleSkills`** — once for
  the prompt block, once for the tool's gate. Same query, same
  results, called twice per action. If that's a measurable latency
  hit, memoize within the session (scope: ~5 lines). Probably
  unnecessary since the queries are small.
- **Error message shifts from "workspace" to "context"** because a
  skill could be in the workspace but not in this job's layer.
  Minor user-facing wording change; low-risk.
- **Legacy `listAssignments` callers at `workspaces/index.ts:2040`
  and `skills.ts:444`** are unchanged — they're display-only and
  the v7 DISTINCT fix makes them correct for the UI use case
  (show "assigned to workspaces [ws]" without duplicates).

## Unresolved Questions (carried forward)

1. **~~`@db/sqlite` NULL-in-PK~~** resolved in v7.
2. **Simultaneous scoping API writes** — test in F.2.
3. **Ad-hoc runtime-dispatched jobs not in YAML** — test in F.2.

None new in v8.

## Overlap with Prior Reviews

- v1 ideas — filter-model, obsolete
- v2 ideas — documented or deferred
- v3 ideas — integrated in v4
- v4 ideas — integrated in v5
- v5 ideas — integrated in v6
- v6 ideas — integrated in v7
- v7 ideas (this pass) — one bug, one fix, integrated in v8

## Process Reflection

v8 is what honoring the "name a failing test" bar looks like. I
proposed one idea, not five. No gold-plating filler. The one idea
is a concrete bug that F.2 in v8 would fail against v7's
implementation and pass against v8's.

If v9 is ever requested, the same bar applies: name a failing test
that demonstrates the bug. Otherwise it's not worth the review
round-trip; move to implementation.
