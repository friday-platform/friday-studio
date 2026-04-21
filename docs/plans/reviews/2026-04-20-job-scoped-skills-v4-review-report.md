# Job-scoped skills — v4 Review Report

**Reviewed:** 2026-04-20
**Input:** `docs/plans/2026-04-20-job-scoped-skills.v4.md`
**Output:** `docs/plans/2026-04-20-job-scoped-skills.v5.md`
**Prior reviews:**
- `reviews/2026-04-20-job-scoped-skills-v1-review-report.md`
- `reviews/2026-04-20-job-scoped-skills-v2-review-report.md`
- `reviews/2026-04-20-job-scoped-skills-v3-review-report.md`

## TL;DR

v5 is a hardening pass. Semantic model (additive, union) is settled
and unchanged. Five concrete fixes caught in review, all accepted:
one correctness-critical (A.1 migration pattern) + one user-visible
behavior gap (YAML declarative semantics) + one missing feature
(job-removal cascade) + one process upgrade (F.1 as gate) + one
simplification (drop API transition window).

## Context Gathered

- Verified `local-adapter.ts:77-104` — the adapter already has a
  table-rebuild migration pattern (`dropLegacyAssignmentColumn`) used
  for an earlier PK change. Any PK alteration must follow that
  pattern; a naked `CREATE TABLE IF NOT EXISTS` in the SCHEMA block
  does nothing on upgraded installs.
- Re-read existing workspace-level `skills:` reconciliation to
  confirm: today's daemon treats `workspace.yml` as source of truth
  (declarative) for the workspace-level layer. Extending this to
  job-level should match; anything else would be a semantic
  inconsistency in the same YAML doc.
- Checked in-repo consumers of `POST /api/skills/scoping/:skillId/assignments`:
  two callers, both in this monorepo (playground + CLI). No external
  public API consumers identified. Transition window isn't needed —
  atomic flip is safe.
- Confirmed `AgentSessionDataSchema` still has no `jobName`
  (unchanged since v3/v4 review).
- Read existing workspace.yml reconcile flow (daemon
  `apps/atlasd/routes/workspaces/…`). Today it replaces workspace-
  level `skills:`; no current code path prunes DB rows for removed
  jobs (because there's no job-level concept yet). v5's D.3 cascade
  is genuinely new, not an "add this to existing logic."

## Ideas Proposed (5, all accepted)

### 1. A.1 migration pattern — CORRECTNESS CRITICAL

**Problem:** v4's A.1 showed `CREATE TABLE IF NOT EXISTS
skill_assignments (..., PRIMARY KEY (skill_id, workspace_id,
job_name))`. For fresh installs, fine. For existing installs (every
deployment today), CREATE TABLE IF NOT EXISTS is a no-op because the
table exists with the OLD schema. SQLite can't ALTER a PK in place.
Result: no migration happens, every assignment path breaks on first
use.

**Fix:** v5 adds a dedicated `addJobNameColumn(db)` method that
follows the existing `dropLegacyAssignmentColumn` rebuild pattern:
CREATE `skill_assignments_new` with new schema, INSERT from old,
DROP old, RENAME. Wrap in BEGIN/COMMIT. Detect by checking
`PRAGMA table_info` for the `job_name` column (idempotent).

**Impact:** This was a silent breakage on first use in prod. Fix is
required before A.1 can ship.

### 2. D.2 YAML↔DB sync direction — explicit declarative semantics

**Problem:** v4's Phase D.2 said "reconcile both layers" without
specifying whether YAML is the source of truth. User could reasonably
interpret either way.

**Fix:** v5 Phase D.2 states "workspace.yml is the source of truth
for assignments. On save, job-level rows in the DB for that job are
replaced with the YAML list." Matches the existing workspace-level
behavior — internal consistency in one YAML doc.

Concrete reconcile algorithm spelled out: compute `to_add` and
`to_remove` diffs from YAML vs DB, run as one SQLite transaction.

### 3. D.3 Job-removal cascade — new phase

**Problem:** If a user deletes the entire `jobs.nightly-report:`
block from workspace.yml, the DB keeps its
`skill_assignments(…, 'nightly-report')` rows forever. Orphan data;
no hard breakage but accretive clutter and confusing to debug.

**Fix:** v5 Phase D.3: on save, compute
`orphaned_jobs = db_jobs − declared_jobs` and call
`deleteAllJobAssignments(workspaceId, jobName)` for each. Inside the
same transaction as D.2. Log each cascade at info level so the
deletion isn't silent.

New adapter methods (Phase B): `listJobNamesForWorkspace` +
`deleteAllJobAssignments`.

### 4. F.1 as TDD gate — non-optional

**Problem:** v4 said "Writing F.1 first as a TDD scaffold … would
help." The word "would" is license to skip it under schedule
pressure. The test is the invariant — without it, a future refactor
can silently break prompt ≡ tool.

**Fix:** v5 promotes F.1 to gating PR #2: skeleton lands in PR #1
(passes trivially because no job layer exists yet), turns live in PR
#2, must stay green in every future PR touching the resolver, tool,
or call-site threading. Upgraded from "nice to have" to "required
green."

### 5. API body transition window — dropped, atomic flip

**Problem:** v4 said "backend supports both body shapes during a
transition window." Required dual-path code + a deprecation tracker.
But all API consumers (playground UI, CLI) live in this monorepo and
ship together; no external consumers.

**Fix:** v5 flips atomically in one PR. Backend accepts only the new
shape (`{ assignments: [...] }`); in-repo clients update in the same
PR. Saves ~30 min of transition glue. Explicit verification step:
grep `scoping/.*/assignments` across the monorepo to confirm no
external caller before merge.

## Other v4 → v5 Adjustments

- **A.1 estimate bumped** from 45 min → 1.5 h to cover the rebuild
  migration + its dedicated test. Migration code is subtle; rushing
  it causes production incidents.
- **B estimate bumped** from 1 h → 1.5 h for the two new cascade
  helpers.
- **D.2 estimate bumped** from 1 h → 1.5 h now that the diff algorithm
  is specified.
- **D.3 added** as its own 45-min phase.
- **F.1 estimate bumped** from 1 h → 1.5 h to cover writing the
  skeleton in PR #1 + turning live in PR #2.
- **F.2 gains a migration test** — populate a legacy-schema DB, run
  migration, assert rows preserved + backfilled.
- **Total:** ~16 h (up from v4's ~14.5 h).

## Caveats & Tradeoffs

- **Migration rebuild briefly holds a table-lock.** For the size of
  `skill_assignments` (small — one row per assignment), negligible.
  Would matter if this were `skills` or `sessions`.
- **Transition-free API flip** assumes no external consumers. Before
  PR #3 merges, do a fresh repo grep for `scoping/.*/assignments`.
  If a new caller shows up, decide: (a) migrate it in the same PR or
  (b) reintroduce a transition window for that specific caller.
- **Declarative YAML semantics** means editing the UI can briefly
  disagree with YAML until the next save. Today's workspace-level
  behavior has this property; extending it to job-level is
  consistent. Users comfortable with one will understand the other.
- **Cascade deletion logs at info level** — not warn, not error. A
  user who deletes a job on purpose doesn't want a warn spam. A user
  who accidentally deletes a job won't see the warning spam either.
  Net-net: info level is right; a separate admin tool could recover
  accidental deletes from git history of workspace.yml.

## Unresolved Questions (carried forward)

1. **`@db/sqlite` NULL-in-PK behavior** — (carried from v3). v5 spells
   out the exact test SQL to run at implementation time.
2. **Reconcile ↔ simultaneous API writes** — new open question in v5.
   If the UI scoping route is writing at the same moment as a
   `workspace.yml` save reconciles, both hit `skill_assignments`.
   Both paths should acquire the same transaction. Needs audit at D.2
   implementation time.
3. **Ad-hoc runtime-dispatched jobs not in YAML** — also new in v5.
   v5 assumes such jobs see workspace-level only (no `jobs.X.skills`
   to consult). Should be fine but worth a test case in F.2.

## Overlap with Prior Reviews

### v1 ideas (filter-model era — all obsolete or absorbed)

### v2 ideas
- A (field-shape): documented in v3/v4/v5
- B (debug UX): deferred follow-up
- C (F.1 inline fixtures): adopted
- D (runtime backstop): present as D.4
- E (layering clarity): superseded by pivot

### v3 ideas
All five integrated in v4 (schema/session, engine simplification,
scoping API, UI dual-assign, UI @friday).

### v4 ideas (this pass)
All five landed in v5 (migration rebuild, declarative semantics,
cascade, F.1 gate, atomic API flip).

## Implementation Note for v5

The plan is mature enough to execute. Ship order:

1. **PR #1** — Schema stubs (A.1 + A.2 + A.3 + F.1 skeleton).
   Additive; F.1 passes trivially. Migration shipped dark — no caller
   uses job_name yet, but the column exists and backfills on upgrade.
2. **PR #2** — Job-level lands (B + C + F.1 live + F.2 unit).
   Behavior change. F.1 gate required.
3. **PR #3** — YAML + scoping API (D.1 + D.2 + D.3 + D.4 + atomic
   API flip).
4. **PR #4** — UI (E.0 + E.1 + E.2 + F.3).

PRs #2 and #3 could run in parallel — #3 has no behavioral change
visible to users until #4 lands a UI, and #2's runtime depends only
on `job_name` being in the schema (PR #1 provides it). Parallelism
saves ~2 days if both developers are available.

## Final read

Five review passes in, the plan now covers:
- Semantics (additive, clear, tested)
- Data model (with a correct migration path)
- Runtime (2-site call audit, simple engine change)
- Config (declarative reconcile, cascade, backstop warn)
- API (atomic flip, no transition glue)
- UI (3 sections, warn on redundant, @friday visibility)
- Tests (gating drift invariant + unit + migration + integration)

I don't see further architecturally-significant changes. Further
review passes should focus on implementation-time questions rather
than plan-space changes. If v6 is requested, my recommendation is to
time-box it and resist the urge to gold-plate.
