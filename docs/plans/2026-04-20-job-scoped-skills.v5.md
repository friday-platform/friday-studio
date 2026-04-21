<!-- v5 - 2026-04-20 - Generated via /improving-plans from docs/plans/2026-04-20-job-scoped-skills.v4.md -->

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

## v4 → v5 changes

Five fixes, all concrete:

- **A.1 migration pattern corrected** — SQLite can't ALTER a PK in
  place. Existing installs need a table rebuild. v5 follows the
  existing `dropLegacyAssignmentColumn` rebuild pattern in
  `local-adapter.ts`; v4's bare `CREATE TABLE IF NOT EXISTS` would
  have silently broken every upgrade.
- **D.2 spells out declarative semantics** — `workspace.yml` is the
  source of truth for assignments. On save, job-level DB rows are
  reconciled to match the YAML list (removing a line deletes the
  row).
- **D.3 adds job-removal cascade** — when a whole job block is
  deleted from YAML, its orphan `skill_assignments` rows get pruned.
- **F.1 is a gating test** — written first as a TDD scaffold,
  required green in every PR that touches the resolver or tool.
- **Scoping API migration atomic** — dropped the transition window.
  All clients ship in one PR, backend flips in one PR.

## Current state (unchanged from v3/v4)

1. **`skill_assignments` table** (`packages/skills/src/local-adapter.ts:37`).
   Composite PK `(skill_id, workspace_id)` today.
2. **`resolveVisibleSkills(workspaceId, storage)`** returns
   `global_unassigned ∪ workspace_assigned`.
3. **`createLoadSkillTool({ workspaceId })`** — rejects catalog
   skills outside the resolved-visible set. `jobFilter` is dead code;
   v5 removes it.

## Semantics (unchanged)

| Layer | Meaning | Where |
| --- | --- | --- |
| Global (unassigned) | Zero `skill_assignments` rows → visible everywhere | Catalog `publish()` — no assignment |
| Workspace-level | `skill_assignments` row with `job_name IS NULL` | `workspace.yml` top-level `skills:` + Workspace Skills UI |
| Job-level | `skill_assignments` row with `job_name = 'X'` | `workspace.yml` `jobs.X.skills:` + Job Skills UI |

Rules unchanged from v3/v4:
1. Union, never narrow.
2. Per-job isolation.
3. `@friday/*` always-visible bypass.
4. Workspace-wide surfaces (chat, conversation) see workspace + global only.
5. Job assignment FK to an existing catalog skill; no "ghost" refs.

## Design

### Phase A — Schema

#### A.1 Data model + migration (v5: follow the rebuild pattern)

SQLite can't change a primary key in place — you have to rebuild the
table, copy rows, rename, drop the old one. `local-adapter.ts`
already has this pattern in `dropLegacyAssignmentColumn` (around line
82). Follow it.

**File: `packages/skills/src/local-adapter.ts`** — add a new
migration method that runs exactly once:

```ts
// SCHEMA block — new installs get this directly.
CREATE TABLE IF NOT EXISTS skill_assignments (
  skill_id     TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  job_name     TEXT,                            -- NEW: NULL = workspace-level
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (skill_id, workspace_id, job_name)
);
CREATE INDEX IF NOT EXISTS idx_skill_assignments_workspace_job
  ON skill_assignments (workspace_id, job_name);
```

```ts
// Migration for existing installs — called from getDb() after SCHEMA.
// Detect: table exists AND has no job_name column AND has non-zero rows.
// Action: rebuild with new PK, copy rows, drop old.
private addJobNameColumn(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(skill_assignments)").all() as { name: string }[];
  if (cols.some((c) => c.name === "job_name")) return; // already migrated

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
      SELECT skill_id, workspace_id, NULL, created_at FROM skill_assignments;
    DROP TABLE skill_assignments;
    ALTER TABLE skill_assignments_new RENAME TO skill_assignments;
    CREATE INDEX IF NOT EXISTS idx_skill_assignments_workspace_job
      ON skill_assignments (workspace_id, job_name);
    COMMIT;
  `);
}
```

Wire into `getDb()` right after `this.db.exec(SCHEMA)` — same spot
the legacy-column dropper runs. Idempotent (detects `job_name`
existence and early-returns). Wrap in transaction so partial failure
leaves the old table intact.

**Open Q (still)**: verify that `@db/sqlite` treats `NULL` as
distinct in the new PK. Standard SQL says yes. Test at implementation
time with:
```sql
INSERT INTO skill_assignments(skill_id, workspace_id, job_name) VALUES ('s','w',NULL);
INSERT INTO skill_assignments(skill_id, workspace_id, job_name) VALUES ('s','w',NULL);  -- should fail
INSERT INTO skill_assignments(skill_id, workspace_id, job_name) VALUES ('s','w','job-a'); -- should succeed
INSERT INTO skill_assignments(skill_id, workspace_id, job_name) VALUES ('s','w','job-b'); -- should succeed
```
If the binding collapses NULLs → swap PK to `(skill_id, workspace_id, COALESCE(job_name, ''))` via generated column.

#### A.2 `jobs.*.skills` config schema

**File: `packages/config/src/jobs.ts` — `JobSpecificationSchema`**
```ts
skills: z
  .array(SkillRefSchema)
  .optional()
  .describe(
    "Skills assigned to this job. Adds to the workspace-level skills — " +
    "every job sees workspace skills; this list is additional and " +
    "private to this job (not visible to other jobs in the same " +
    "workspace). `@friday/*` is always available.",
  ),
```

**File: `packages/fsm-engine/schema.ts`** — `LLMActionSchema.skills`
and `AgentActionSchema.skills` stay in the schema as
`@experimental`. Runtime ignores in v5.

#### A.3 `AgentSessionData` gets `jobName`

**File: `packages/agent-sdk/src/types.ts` — `AgentSessionDataSchema`**
Add `jobName: z.string().optional()` — present when the session runs
inside a job. Consumed in Phase C.3.

### Phase B — Assignment CRUD

**File: `packages/skills/src/local-adapter.ts`**

```ts
interface SkillStorageAdapter {
  // existing, unchanged — target job_name IS NULL row:
  assignSkill(skillId, workspaceId): Promise<Result<void,string>>;
  unassignSkill(skillId, workspaceId): Promise<Result<void,string>>;

  // NEW — job layer:
  assignToJob(skillId, workspaceId, jobName): Promise<Result<void,string>>;
  unassignFromJob(skillId, workspaceId, jobName): Promise<Result<void,string>>;
  listAssignmentsForJob(workspaceId, jobName): Promise<Result<SkillSummary[],string>>;

  // NEW — for job-removal cascade (Phase D.3):
  listJobNamesForWorkspace(workspaceId): Promise<Result<string[],string>>;
  deleteAllJobAssignments(workspaceId, jobName): Promise<Result<void,string>>;
}
```

The last two are needed for cascade reconciliation; they only query
rows where `job_name IS NOT NULL`.

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

Logic:
```ts
const [unassigned, workspaceLevel, jobLevel] = await Promise.all([
  storage.listUnassigned(),
  storage.listAssigned(workspaceId),                       // job_name IS NULL
  opts?.jobName
    ? storage.listAssignmentsForJob(workspaceId, opts.jobName)
    : Promise.resolve({ ok: true, data: [] } as const),
]);
// union with dedupe by skillId
```

#### C.2 `createLoadSkillTool` switches to `jobName`

Drop `jobFilter`; add `jobName?: string`. Internal defense-in-depth
check calls `resolveVisibleSkills(workspaceId, storage, { jobName })`.

#### C.3 Call-site audit — two live, three N/A

| # | File:line | `jobName` source |
| --- | --- | --- |
| 1 | `packages/core/src/agent-context/index.ts:106,178` | `sessionData.jobName` (A.3 adds it) |
| 2 | `workspace-chat/compose-context.ts:41` | N/A — workspace chat |
| 3 | `workspace-chat/workspace-chat.agent.ts:510` | N/A — ditto |
| 4 | `conversation.agent.ts:727` | N/A — user-scoped |
| 5 | `fsm-engine.ts:1171` | `this._definition.id` (already in scope) |

#### C.4 FSM engine — use `this._definition.id` directly

```ts
const jobName = this._definition.id;
const skills: SkillSummary[] = workspaceId
  ? await resolveVisibleSkills(workspaceId, SkillStorage, { jobName })
  : [];
const { tool: loadSkill, cleanup } = createLoadSkillTool({ workspaceId, jobName });
```

No `_context.jobName` plumbing; one-line read of instance state.

#### C.5 workspace-runtime injects `jobName` into sessionData

`executeAgent` (`workspace/src/runtime.ts:1451`) already has `job.name`
in scope (logged at line 1464). Thread it into the sessionData that
the orchestrator builds when invoking an agent. A.3 makes the field
typed; C.5 populates it.

### Phase D — `workspace.yml` reconciliation

#### D.1 Parse-time validation

- `SkillRefSchema` on each `jobs.*.skills[k]` entry (format).
- If the ref doesn't resolve to a catalog skill at parse time, emit a
  **warning** (not error). The job will fail to load the skill at
  runtime, but config can ship decoupled from assignment state.

#### D.2 Declarative reconciliation (v5: explicit)

`workspace.yml` **is the source of truth** for assignments.

On save, for each job `X` declared in `jobs:`:
1. `current = listAssignmentsForJob(workspaceId, X)` → DB rows
2. `desired = jobs.X.skills[] ?? []` → YAML list
3. Compute diff:
   - `to_add = desired − current.map(skillRef)` → `assignToJob()`
   - `to_remove = current.map(skillRef) − desired` → `unassignFromJob()`
4. Run all diff ops in one SQLite transaction. Partial failure rolls
   back — no intermediate state where the job sees a partial set.

Same pattern already handles workspace-level `skills:` today; extend
to job-level.

#### D.3 Job-removal cascade (v5: new)

When an entire job block disappears from `workspace.yml`:

```
declared_jobs  = Object.keys(workspace.jobs ?? {})
db_jobs        = listJobNamesForWorkspace(workspaceId)  // distinct job_name values
orphaned_jobs  = db_jobs − declared_jobs

for each orphaned_job:
  deleteAllJobAssignments(workspaceId, orphaned_job)  // prune
```

Runs in the same reconcile transaction as D.2. Keeps the DB clean;
no accretive clutter.

**Warning path:** log each cascade deletion at `info` level — the
user should see "pruned 3 job-level skill assignments for removed job
'nightly-v1'" in logs to confirm the cascade happened, not silent
data loss.

#### D.4 Runtime backstop warning

On the first `resolveVisibleSkills({jobName: X})` call that returns
zero job-level rows for a workspace whose YAML clearly declares some
for `X`, log a warning once. Belt-and-braces for YAML-DB drift.

### Phase E — UI

#### E.0 Stand up `/platform/:ws/jobs/:jobName` route

Verified during v4 review: list page exists, detail page doesn't.
Basic skeleton (header, breadcrumb, tab nav) is ~1 h.

#### E.1 Job detail page — Skills section

Three sections:

- **Workspace-inherited** (grayed, read-only): lists every skill from
  `resolveVisibleSkills(workspaceId)` — what the job gets from the
  workspace layer. Clicking routes to the workspace skills page.
- **Job-specific** (editable): current `listAssignmentsForJob` result.
  Add/Remove mutations hit the extended scoping route.
- **Always available** (grayed, read-only): `@friday/*` bypass set.
  Hardcoded list today; closes the "why does this skill show up?"
  debugging gap.

**Dual-assignment warn**: if the user adds a job-specific assignment
for a skill that's already workspace-level, show a non-blocking warn
("already visible to all jobs"). DB accepts it; UI flags redundancy.

#### E.2 Workspace Skills page — per-job breakdown

Add a "Job-scoped" section grouped by `job_name`, listing which
skills are private to which jobs. Read-only; writes happen on the
job detail page.

### Phase F — Testing

#### F.1 Drift invariant — gating, not optional (v5: promoted)

**F.1 is written first.** PR #1 (schema stubs) includes the test
skeleton; it passes trivially because no job layer exists yet. PR #2
(job-level lands) requires F.1 green before merge. Any future PR that
touches the resolver, the tool, or the call-site threading must keep
F.1 green.

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

**Fixtures:** inline in the test file. 3-5 skills covering
(unassigned-global / workspace-level / job-a-only / job-b-only /
`@friday/*`) exercise every branch.

#### F.2 Unit / integration

- Adapter tests for `assignToJob` / `unassignFromJob` /
  `listAssignmentsForJob` / `listJobNamesForWorkspace` /
  `deleteAllJobAssignments`.
- `resolveVisibleSkills(ws, { jobName })` per-branch unions.
- **Migration test**: populate a v-legacy DB (two-col PK, no job_name),
  run `addJobNameColumn`, assert schema + rows preserved + NULL
  backfill.
- **Cascade test**: workspace.yml removes a job; reconcile runs; DB
  rows for that job gone.
- FSM integration: run a job with job-level skills; assert LLM sees
  them; assert another job doesn't.

#### F.3 QA plan entry

Extend `docs/testing/2026-04-20-skills-ui-qa-plan.v2.md`:
- **§3 smoke tests**: W-J-01 add skill to job; W-J-02 skill appears
  in job context; W-J-03 peer job doesn't see it; W-J-04 workspace
  chat doesn't see job-private skills.
- **§4 chain 4.13**: assign skill to job-A → run job-A → verify
  visible → run job-B → verify not visible → run workspace chat →
  verify not visible.

## API surface

### Scoping route — body extension (v5: atomic flip, no transition)

**Before:**
```
POST /api/skills/scoping/:skillId/assignments
body: { workspaceIds: string[] }
```

**After (ships atomically with the UI/CLI clients):**
```
POST /api/skills/scoping/:skillId/assignments
body: { assignments: { workspaceId: string; jobName?: string }[] }
```

Behavior:
- `jobName` absent → `assignSkill(skillId, workspaceId)` — workspace-level row.
- `jobName` present → `assignToJob(skillId, workspaceId, jobName)` — job-level row.
- Response shape unchanged (`{ assigned, failed }` with partial-success semantics).

No dual-shape support, no deprecation header. All in-repo clients
(playground UI, atlas-cli) update in the same PR. External callers
would break — verify none exist before merge (grep
`scoping/.*/assignments` across the monorepo, no external consumers
expected).

Delete stays path-based:
```
DELETE /api/skills/scoping/:skillId/assignments/:workspaceId
DELETE /api/skills/scoping/:skillId/assignments/:workspaceId/:jobName   # NEW
```

## Phases / rollout

| # | Scope | Estimate | Risk |
| --- | --- | --- | --- |
| A.1 | Migration (rebuild pattern + new SCHEMA) | 1.5 h | Med — migration code is subtle |
| A.2 | Config schema (`jobs.*.skills` + `@experimental` note) | 45 min | Low |
| A.3 | `AgentSessionDataSchema` gains `jobName` | 15 min | Low |
| B | Adapter CRUD (assign/unassign/list + cascade helpers) | 1.5 h | Low |
| C.1 | `resolveVisibleSkills({jobName})` | 30 min | Low |
| C.2 | `createLoadSkillTool({jobName})` — retire `jobFilter` | 1 h | Med |
| C.3 | Two call sites thread `jobName` | 45 min | Low |
| C.4 | FSM engine reads `this._definition.id` | 10 min | Very low |
| C.5 | workspace-runtime injects `jobName` into sessionData | 20 min | Low |
| D.1 | Parse-time validation warnings | 45 min | Low |
| D.2 | Declarative reconcile for `jobs.*.skills` | 1.5 h | Med — transaction correctness |
| D.3 | Job-removal cascade | 45 min | Low |
| D.4 | Runtime backstop warning | 15 min | Low |
| E.0 | Stand up `/platform/:ws/jobs/:jobName` route | 1 h | Low |
| E.1 | Job detail page — Skills section (3 groups + warn) | 3 h | Med |
| E.2 | Workspace skills page — per-job breakdown | 1.5 h | Low |
| F.1 | Drift invariant (TDD scaffold first, gate after) | 1.5 h | Low |
| F.2 | Adapter + migration + cascade + integration tests | 1.5 h | Low |
| F.3 | QA chain + smoke tests | 45 min | Low |

**Total:** ~16 h (up ~1.5 h from v4 for A.1 migration rigor + D.3
cascade + F.1 gating formalization).

**Ship order (4 PRs):**

1. **PR #1 — Schema stubs** (A.1 + A.2 + A.3 + F.1 skeleton). Pure
   additive. F.1 passes trivially because no consumer reads the new
   fields yet. Safe to ship; no behavior change.

2. **PR #2 — Job-level lands** (B + C + F.1 green + F.2 unit). This
   is where behavior changes. F.1 required green before merge. If
   F.1 fails, the PR is not mergeable.

3. **PR #3 — YAML + scoping API** (D.1 + D.2 + D.3 + D.4 + scoping
   route body flip + client updates). Users can now drive the flow
   from CLI / YAML.

4. **PR #4 — UI** (E.0 + E.1 + E.2 + F.3).

## Semantics clarifications (same as v3/v4)

1. Workspace layer is the outer VISIBILITY set for workspace-wide
   surfaces (chat, conversation). No `jobName` ⇒ workspace + global.
2. Job layer is additive for THAT JOB only.
3. A skill can be assigned at both levels — both rows exist, dedup at
   read.
4. Step-level filter (`action.skills`) is a no-op in v5.
5. Catalog presence required for assignment.

## Field-shape note (unchanged)

`workspace.yml` uses two shapes for `skills:`:
- Workspace level: objects `[{name: "@foo/bar"}, {inline: true, …}]`
- Job level: bare strings `["@foo/bar"]`

Intentional; job level is pure assignment, no inline defs. Unifying
would break `workspace.yml` back-compat.

## Deferred follow-ups

- **Step-level filter** — schema kept, runtime ignored. Re-enable as
  a power-user escape hatch.
- **`@friday/*` opt-out per job** — for sandboxed jobs. Not v5.
- **"Skill not in scope" debug event** — emit when `load_skill(X)` is
  rejected; surface in playground inspector. Distinct feature.
- **Agent-level skills** — `agents: { foo: { skills: […] } }`. Same
  additive model applies. Not v5.
- **Version pinning at assignment level** — orthogonal.

## Open questions

1. **`@db/sqlite` NULL-in-PK behavior** — standard SQL says NULL is
   distinct; needs a sanity test at A.1 implementation time. Falls
   back to `COALESCE(job_name, '')` generated column if the binding
   equates NULLs.
2. **Reconcile interaction with simultaneous API writes** — if a UI
   mutation (via scoping API) lands at the same moment as a YAML
   save, both reconcile. UI writes should probably acquire the same
   SQLite transaction the YAML reconcile holds. Needs audit at D.2
   implementation time.
3. **What about jobs not in workspace.yml at all?** E.g., an
   ad-hoc runtime-dispatched job that's not declared. Today
   `this._definition.id` will resolve to something, but there's no
   YAML to validate against. v5 assumes: no YAML declaration ⇒ no
   job-level assignments possible ⇒ resolver returns
   workspace-level only. Matches today's behavior; explicit in plan.
