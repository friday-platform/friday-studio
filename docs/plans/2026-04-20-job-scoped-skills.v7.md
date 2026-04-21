<!-- v7 - 2026-04-20 - Generated via /improving-plans from docs/plans/2026-04-20-job-scoped-skills.v6.md -->

# Job-scoped skills (additive model)

**Status:** draft · **Owner:** TBD · **Date:** 2026-04-20
**Depends on:** skills subsystem landed on `declaw` (≈ commit `e2714783fe`).

## Goal

Let a user assign skills at two levels in the same workspace:

1. **Workspace level** — baseline, visible to every job in the workspace.
2. **Job level** — extra skills visible **only** inside that specific job;
   other jobs in the same workspace do not see them.

Runtime visible-skill set for job X =
`global_unassigned ∪ workspace_assigned ∪ job_assigned(X)`.
Additive. Never narrows.

## v6 → v7 changes (co-located query audit)

v6 fixed Phase D's architectural claim but left the adapter's SQL
queries unexamined. A closer read found **five co-located correctness
bugs** — the shape of the migration adds a column, but every query
that today assumes "one assignment row per (skill, workspace)" breaks
silently once job-level rows exist.

v7 adds an explicit **Phase A.1.5: query audit** that walks every
existing `skill_assignments` query and applies the right filter. Also
resolves Open Q #1 by committing to a partial unique index for
NULL-uniqueness.

Specific fixes baked in:

- `listAssigned(workspaceId)` → adds `AND sa.job_name IS NULL`.
  Without this, workspace-wide surfaces (chat, conversation) see
  every job's private skills. Breaks isolation.
- `unassignSkill(skillId, workspaceId)` → adds `AND job_name IS NULL`.
  Without this, detaching at workspace level wipes all job-level
  rows for that skill too. Surprise destructive behavior.
- `listAssignments(skillId)` → adds `SELECT DISTINCT workspace_id`.
  Without this, a skill assigned at both workspace and job level
  returns duplicate workspace_ids to the caller.
- `assignSkill(skillId, workspaceId)` + new partial unique index so
  `INSERT OR IGNORE` actually dedupes workspace-level rows under
  NULL-distinct PK semantics.
- Migration copy explicitly projects `NULL AS job_name` when
  inserting into the rebuilt table.

Estimate unchanged at ~13 h — the audit adds 30 min to A.1 but the
individual query changes are one-line each.

## Current state (verified for v7)

- `skill_assignments` table with two-column PK `(skill_id, workspace_id)`.
- Rows populated only by `POST /install`, `POST /fork`, `POST /scoping/.../assignments`.
- `workspace.yml`'s `skills:` field is read directly by `runtime.ts:1713`
  for code agents with `useWorkspaceSkills: true`; does NOT write the DB.
- `deleteSkill(skillId)` cascades to all assignment rows (no fix needed).
- `listAssigned`, `unassignSkill`, `listAssignments`, `assignSkill` each
  assume one row per (skill, workspace) — broken by the migration.

## Semantics (unchanged)

| Layer | Meaning | Where |
| --- | --- | --- |
| Global (unassigned) | Zero `skill_assignments` rows → visible everywhere | Catalog `publish()` — no assignment |
| Workspace-level | `skill_assignments` row with `job_name IS NULL` | Scoping API (UI + CLI) |
| Job-level | `skill_assignments` row with `job_name = 'X'` | Scoping API (UI + CLI, `jobName` param) |

Rules:
1. Union, never narrow.
2. Per-job isolation.
3. `@friday/*` always-visible bypass unchanged.
4. Workspace-wide surfaces see workspace + global only.
5. Assignment requires a catalog skill.

## Design

### Phase A — Schema

#### A.1 Data model + migration

SQLite can't ALTER a PK in place. Use the existing
`dropLegacyAssignmentColumn` rebuild pattern.

**File: `packages/skills/src/local-adapter.ts`**

```sql
-- SCHEMA block (fresh installs)
CREATE TABLE IF NOT EXISTS skill_assignments (
  skill_id     TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  job_name     TEXT,                            -- NEW: NULL = workspace-level
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (skill_id, workspace_id, job_name)
);

-- v7: partial unique index to prevent duplicate workspace-level rows
-- under NULL-distinct PK semantics (resolves Open Q #1).
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_assignments_workspace_unique
  ON skill_assignments (skill_id, workspace_id)
  WHERE job_name IS NULL;

CREATE INDEX IF NOT EXISTS idx_skill_assignments_workspace_job
  ON skill_assignments (workspace_id, job_name);
```

```ts
private addJobNameColumn(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(skill_assignments)").all() as { name: string }[];
  if (cols.some((c) => c.name === "job_name")) return;

  db.exec(`
    BEGIN;
    CREATE TABLE skill_assignments_new (
      skill_id     TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      job_name     TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (skill_id, workspace_id, job_name)
    );
    INSERT INTO skill_assignments_new (skill_id, workspace_id, job_name, created_at)
      SELECT skill_id, workspace_id, NULL AS job_name, created_at FROM skill_assignments;
    DROP TABLE skill_assignments;
    ALTER TABLE skill_assignments_new RENAME TO skill_assignments;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_assignments_workspace_unique
      ON skill_assignments (skill_id, workspace_id)
      WHERE job_name IS NULL;
    CREATE INDEX IF NOT EXISTS idx_skill_assignments_workspace_job
      ON skill_assignments (workspace_id, job_name);
    COMMIT;
  `);
}
```

Note the explicit `NULL AS job_name` in the INSERT — the old table
has no such column, so be explicit rather than hoping the copy
propagates correctly.

#### A.1.5 Query audit — co-located fixes (v7: new)

Every existing query touching `skill_assignments` must be reviewed
for the new column. Without this, workspace-level queries silently
leak job-level rows and vice versa.

**Audit checklist — each query + one-line fix:**

| Line | Query | Today's intent | v7 fix |
| --- | --- | --- | --- |
| `listAssigned` (~483) | INNER JOIN on workspace_id | "skills assigned at workspace level" | Add `AND sa.job_name IS NULL` |
| `unassignSkill` (~506) | DELETE by skill+workspace | "detach workspace-level assignment" | Add `AND job_name IS NULL` |
| `listAssignments` (~516) | SELECT workspace_id | "workspaces this skill is in" | Add `SELECT DISTINCT workspace_id` |
| `assignSkill` (~498) | `INSERT OR IGNORE (skill_id, workspace_id)` | "create workspace-level row" | Unchanged SQL — partial unique index from A.1 provides dedup semantics |
| `listUnassigned` (~462) | `LEFT JOIN ... WHERE sa.skill_id IS NULL` | "skills with zero assignments" | Unchanged — "zero assignments anywhere" is correct; a skill that has only job-level rows is scoped, not global |
| `deleteSkill` (~442) | DELETE all rows for skill_id | cascade on skill delete | Unchanged — should still wipe all rows (workspace + job level) |

Why the implementer would miss these without this phase: each is a
one-line oversight in a query that today *works correctly*. The
A.1 migration makes these queries subtly wrong without any test
failing until a user exercises the exact pattern (job-level
assignment + workspace-wide read). Writing them down in the plan
lets the implementer run through the checklist mechanically.

#### A.2 `jobs.*.skills` config schema

**File: `packages/config/src/jobs.ts` — `JobSpecificationSchema`**
```ts
skills: z
  .array(SkillRefSchema)
  .optional()
  .describe(
    "Declarative intent: skills this job should have access to " +
    "beyond the workspace baseline. **Not auto-applied.** Use the " +
    "scoping API (UI or CLI) to actually assign. This field is " +
    "read-only at runtime today; future work may add YAML→DB sync.",
  ),
```

**File: `packages/fsm-engine/schema.ts`** — `LLMActionSchema.skills`
and `AgentActionSchema.skills` stay `@experimental`, runtime ignores.

#### A.3 `AgentSessionData` gets `jobName`

**File: `packages/agent-sdk/src/types.ts` — `AgentSessionDataSchema`**

```ts
jobName: z.string().optional(),       // present when session runs inside a job
```

Populated in Phase C.5; consumed in Phase C.3.

### Phase B — Assignment CRUD

**File: `packages/skills/src/local-adapter.ts`**

```ts
interface SkillStorageAdapter {
  // existing, updated in A.1.5:
  assignSkill(skillId, workspaceId): Promise<Result<void,string>>;   // (X, ws, NULL)
  unassignSkill(skillId, workspaceId): Promise<Result<void,string>>; // WHERE job_name IS NULL
  listAssigned(workspaceId): Promise<Result<SkillSummary[],string>>; // WHERE job_name IS NULL
  listAssignments(skillId): Promise<Result<string[],string>>;        // SELECT DISTINCT

  // NEW — job layer:
  assignToJob(skillId, workspaceId, jobName): Promise<Result<void,string>>;
  unassignFromJob(skillId, workspaceId, jobName): Promise<Result<void,string>>;
  listAssignmentsForJob(workspaceId, jobName): Promise<Result<SkillSummary[],string>>;
}
```

The three new methods are near-copies of the existing workspace-level
ones with `job_name = ?` in the WHERE clauses.

### Phase C — Runtime resolution

#### C.1 `resolveVisibleSkills` gets `jobName`

**File: `packages/skills/src/resolve.ts`**

```ts
export async function resolveVisibleSkills(
  workspaceId: string,
  storage: SkillStorageAdapter,
  opts?: { jobName?: string },
): Promise<SkillSummary[]>;
```

```ts
const [unassigned, workspaceLevel, jobLevel] = await Promise.all([
  storage.listUnassigned(),
  storage.listAssigned(workspaceId),                       // job_name IS NULL (A.1.5)
  opts?.jobName
    ? storage.listAssignmentsForJob(workspaceId, opts.jobName)
    : Promise.resolve({ ok: true, data: [] } as const),
]);
// dedupe union by skillId
```

#### C.2 `createLoadSkillTool` switches to `jobName`

Drop `jobFilter`; add `jobName?: string`. Defense-in-depth check
calls `resolveVisibleSkills(workspaceId, storage, { jobName })`.

#### C.3 Call-site audit — unchanged

| # | File:line | `jobName` source |
| --- | --- | --- |
| 1 | `core/agent-context/index.ts:106,178` | `sessionData.jobName` (A.3 adds) |
| 2-4 | workspace-chat + conversation | N/A — not job-scoped surfaces |
| 5 | `fsm-engine.ts:1171` | `this._definition.id` (already in scope) |

#### C.4 FSM engine reads `this._definition.id` directly

```ts
const jobName = this._definition.id;
const skills = workspaceId
  ? await resolveVisibleSkills(workspaceId, SkillStorage, { jobName })
  : [];
const { tool: loadSkill, cleanup } = createLoadSkillTool({ workspaceId, jobName });
```

#### C.5 workspace-runtime injects `jobName` into sessionData

`executeAgent` (`workspace/src/runtime.ts:1451`) has `job.name` in
scope. Inject when constructing the agent runner call.

### Phase D — Validation only

#### D.1 Parse-time + first-run warnings

Unresolved refs in `jobs.*.skills`:
```
jobs.nightly-report.skills[0] = "@foo/bar" — no such skill in the catalog.
This field is declarative only; no assignment will be created.
```

YAML populated but zero matching DB rows (fires once per job on
first run):
```
jobs.nightly-report.skills lists 2 skills but 0 matching assignments
exist in the DB. Use the Job Skills UI or a future CLI sync to apply.
```

#### D.2 Scoping API atomic body flip

**Before:**
```
POST /api/skills/scoping/:skillId/assignments
body: { workspaceIds: string[] }
```

**After (ships atomically with in-repo clients):**
```
POST /api/skills/scoping/:skillId/assignments
body: { assignments: { workspaceId: string; jobName?: string }[] }
```

`jobName` absent → `assignSkill(skillId, workspaceId)` — workspace-level.
`jobName` present → `assignToJob(skillId, workspaceId, jobName)` — job-level.

Delete endpoint adds optional segment:
```
DELETE /api/skills/scoping/:skillId/assignments/:workspaceId
DELETE /api/skills/scoping/:skillId/assignments/:workspaceId/:jobName   # NEW
```

No transition window — all consumers are in this monorepo.

### Phase E — UI

#### E.0 Stand up `/platform/:ws/jobs/:jobName` route

Only list page exists. Skeleton: ~1 h.

#### E.1 Job detail page — Skills section

Three sections:
- **Workspace-inherited** (grayed, read-only): `resolveVisibleSkills(workspaceId)`
- **Job-specific** (editable): `listAssignmentsForJob(workspaceId, jobName)` — scoping API
- **Always available** (grayed, read-only): `@friday/*` bypass set

Dual-assignment warn: non-blocking notice when a user adds a
job-specific assignment for a skill already workspace-level.

#### E.2 Workspace Skills page — per-job breakdown

New "Job-scoped" section grouped by `job_name`. Read-only; writes
via E.1.

### Phase F — Testing

#### F.1 Drift invariant — gating test (unchanged)

```ts
test.each([
  { jobName: undefined, expect: "workspace + global" },
  { jobName: "job-a",   expect: "workspace + global + job-a layer" },
  { jobName: "job-b",   expect: "workspace + global + job-b layer" },
])("prompt ⊆ tool allows: $expect", async ({ jobName }) => {
  const shown = await resolveVisibleSkills("ws-1", storage, { jobName });
  const { tool } = createLoadSkillTool({ workspaceId: "ws-1", jobName });
  // every shown skill must load; anything not shown (except @friday/*) must be rejected
});
```

#### F.2 Unit / integration / migration (v7: expanded)

- Adapter tests for `assignToJob` / `unassignFromJob` /
  `listAssignmentsForJob`.
- **v7 adds regression tests for the A.1.5 audit**:
  - `listAssigned` doesn't include job-level rows after a job-level
    assignment exists.
  - `unassignSkill` doesn't nuke job-level rows when called with
    workspace scope.
  - `listAssignments` returns distinct workspace_ids even when both
    workspace and job-level rows exist for the same (skill, ws).
  - `assignSkill` doesn't create duplicate workspace-level rows
    under repeated calls.
- Migration test: legacy-schema DB + run migration + assert schema
  + rows preserved with NULL job_name backfill + partial unique
  index in place.
- FSM integration: two jobs with different job-level assignments;
  each sees only its own.

#### F.3 QA plan entry

Extend `docs/testing/2026-04-20-skills-ui-qa-plan.v2.md`:
- **§3 smoke**: W-J-01..W-J-04 as in v6, plus:
  - W-J-05 workspace-level unassign doesn't wipe job-level rows
  - W-J-06 skill visible only in assigned job, not workspace chat
- **§4 chain 4.13** as in v6.

## Phases / rollout

| # | Scope | Estimate | Risk |
| --- | --- | --- | --- |
| A.1 | Migration (rebuild pattern + partial unique index) | 1.5 h | Med — migration subtle |
| A.1.5 | Query audit + fixes (3 one-line SQL changes) | 30 min | Low — mechanical checklist |
| A.2 | Config schema (`jobs.*.skills` + `@experimental`) | 45 min | Low |
| A.3 | `AgentSessionDataSchema` gains `jobName` | 15 min | Low |
| B | Adapter CRUD (assignToJob + unassignFromJob + list) | 1 h | Low |
| C.1 | `resolveVisibleSkills({jobName})` | 30 min | Low |
| C.2 | `createLoadSkillTool({jobName})` — retire `jobFilter` | 1 h | Med |
| C.3 | Two call sites thread `jobName` | 45 min | Low |
| C.4 | FSM engine reads `this._definition.id` | 10 min | Very low |
| C.5 | workspace-runtime injects `jobName` into sessionData | 20 min | Low |
| D.1 | Parse-time + first-run warnings | 45 min | Low |
| D.2 | Scoping API atomic body flip + client updates | 45 min | Low |
| E.0 | Stand up `/platform/:ws/jobs/:jobName` route | 1 h | Low |
| E.1 | Job detail page — Skills section (3 groups + warn) | 3 h | Med |
| E.2 | Workspace skills page — per-job breakdown | 1.5 h | Low |
| F.1 | Drift invariant (TDD scaffold first, gate after) | 1.5 h | Low |
| F.2 | Adapter + A.1.5 regressions + migration + integration | 1.5 h | Low |
| F.3 | QA chain + smoke tests | 45 min | Low |

**Total:** ~13 h (A.1.5 adds 30 min; F.2 up 30 min for audit tests;
roughly offset by cleaner signal during implementation).

**Ship order (4 PRs):**

1. **PR #1 — Schema stubs** (A.1 + A.1.5 + A.2 + A.3 + F.1 skeleton).
   A.1.5's filter fixes land here — pre-migration they're no-ops
   (no job_name column exists), post-migration they're protective.
2. **PR #2 — Job-level lands** (B + C + F.1 live + F.2). Behavior
   change. F.1 green required; F.2 regression tests are the gate
   for A.1.5 correctness.
3. **PR #3 — API + validation** (D.1 + D.2).
4. **PR #4 — UI** (E.0 + E.1 + E.2 + F.3).

PR #2 and #3 can run in parallel after PR #1 merges.

## Acknowledged non-goals (v6 — unchanged in v7)

### NG-1: `useWorkspaceSkills` code-agent path sees only workspace-level
`runtime.ts:1713` reads `config.workspace.skills` directly. Job-level
skills don't flow through this path. Follow-up: document the
limitation in agent metadata.

### NG-2: Blueprint-backed workspaces have a different save path
`config.ts:400-451` dual-path save. v7 doesn't touch YAML writes;
the scoping API is independent. Follow-up: integrate on future
YAML↔DB sync.

### NG-3: Two-way sync `workspace.yml` ↔ `skill_assignments`
Users hand-editing YAML get warnings (D.1) but no sync. Follow-up:
`atlas workspace apply --skills` command.

## Semantics clarifications (unchanged)

1. Workspace layer = outer VISIBILITY for workspace-wide surfaces.
2. Job layer = additive FOR THAT JOB ONLY.
3. A skill can be assigned at both levels — both rows exist.
4. Step-level (`action.skills`) is a no-op in v7.
5. Catalog presence required for assignment.

## Field-shape note (unchanged)

`workspace.yml` uses objects for workspace-level `skills:` and bare
strings for job-level `jobs.*.skills:`.

## Deferred follow-ups (unchanged)

- Step-level filter reactivation
- `@friday/*` opt-out per job
- "Skill not in scope" debug event
- Agent-level skills
- Version pinning on assignments

## Open questions

1. **~~`@db/sqlite` NULL-in-PK behavior~~** (resolved in v7)
   Partial unique index `idx_skill_assignments_workspace_unique`
   sidesteps the question. Whether NULLs are distinct or not in
   the composite PK, the partial index enforces uniqueness of
   `(skill_id, workspace_id)` rows where `job_name IS NULL`. Fresh
   installs and migrated installs both get the same behavior.

2. **Simultaneous scoping API writes** — PK + partial index reject
   duplicates; partial-success response already covers this.
   Verify test case in F.2.

3. **Ad-hoc runtime-dispatched jobs not in YAML** — resolver returns
   workspace-level only. Matches today's behavior; test in F.2.
