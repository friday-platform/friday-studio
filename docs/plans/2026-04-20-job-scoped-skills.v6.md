<!-- v6 - 2026-04-20 - Generated via /improving-plans from docs/plans/2026-04-20-job-scoped-skills.v5.md -->

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

## v5 → v6 changes (correctness pass)

v5's Phase D.2 claimed "workspace.yml is the source of truth for
assignments today; extend to job-level." **This is factually wrong.**
Today there is no auto-reconcile hook: `skill_assignments` rows come
exclusively from explicit API calls (install, fork, scoping). The
top-level `skills:` field in `workspace.yml` is read at runtime only
by code agents with `useWorkspaceSkills: true`
(`runtime.ts:1713`) — it doesn't populate the DB.

v6 drops the fiction:

- **Drop Phase D.2 (declarative reconcile)** and **Phase D.3 (job-
  removal cascade)**. They don't exist for workspace-level either;
  adding them for job-level would be a new architecture, not an
  extension.
- **Scoping API is the source of truth**, as it already is for
  workspace-level assignments. UI (playground) and CLI (atlas-cli)
  both drive through it.
- **`jobs.*.skills:` in `workspace.yml` is declarative-export only.**
  Users who hand-edit YAML and expect it to auto-apply will see
  a new warning (Phase D.2 in v6 — the renamed runtime backstop) but
  nothing else happens. Plan explicitly punts auto-sync to a
  follow-up.
- **Three deferred concerns acknowledged explicitly** — the
  `useWorkspaceSkills` path, blueprint-backed workspaces, and
  two-way YAML↔DB sync. Each has a named follow-up with a one-line
  scope.

Estimate drops from ~16 h → ~13 h.

## Current state (verified)

- **`skill_assignments` table** (`packages/skills/src/local-adapter.ts:37`).
  Composite PK `(skill_id, workspace_id)`. Rows populated **only** by:
  - `POST /api/skills/install` (auto-assigns to caller's workspaceId)
  - `POST /api/skills/fork` (auto-assigns the fork target)
  - `POST /api/skills/scoping/:skillId/assignments` (UI + CLI path)
- **`resolveVisibleSkills(workspaceId, storage)`** reads the DB:
  `global_unassigned ∪ workspace_assigned(workspace_id)`. Five callers
  consume it to build `<available_skills>`.
- **`createLoadSkillTool({ workspaceId })`** — defense-in-depth check
  against the same DB. `jobFilter` option exists as dead code.
- **`workspace.yml`'s `skills:` field** is read directly by
  `runtime.ts:1713` only when a code agent opts in via
  `agent-source.metadata.useWorkspaceSkills`. Does NOT write to the DB.
  The DB and this YAML field are independent stores today.

## Semantics (unchanged)

| Layer | Meaning | Where |
| --- | --- | --- |
| Global (unassigned) | Zero `skill_assignments` rows → visible everywhere | Catalog `publish()` — no assignment |
| Workspace-level | `skill_assignments` row with `job_name IS NULL` | Scoping API (UI + CLI) |
| Job-level | `skill_assignments` row with `job_name = 'X'` | Scoping API (UI + CLI, `jobName` param) |

Rules:

1. **Union, never narrow** — job layer adds to workspace + global.
2. **Per-job isolation** — job Y can't see job X's private skills.
3. **`@friday/*` always-visible bypass** stays unchanged.
4. **Workspace-wide surfaces** (chat, conversation) see workspace +
   global only (no `jobName`).
5. **Assignment requires a catalog skill** — the ref must resolve.

## Design

### Phase A — Schema

#### A.1 Data model + migration

SQLite can't ALTER a PK in place. Follow `dropLegacyAssignmentColumn`'s
table-rebuild pattern.

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
CREATE INDEX IF NOT EXISTS idx_skill_assignments_workspace_job
  ON skill_assignments (workspace_id, job_name);
```

```ts
// Migration for existing installs — idempotent.
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
      SELECT skill_id, workspace_id, NULL, created_at FROM skill_assignments;
    DROP TABLE skill_assignments;
    ALTER TABLE skill_assignments_new RENAME TO skill_assignments;
    CREATE INDEX IF NOT EXISTS idx_skill_assignments_workspace_job
      ON skill_assignments (workspace_id, job_name);
    COMMIT;
  `);
}
```

**Open Q (carried):** verify `@db/sqlite` treats NULL as distinct in
the PK via a sanity test. Fall back to `COALESCE(job_name, '')` if
not.

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

The `describe()` blurb is load-bearing — it tells anyone who writes
this field that hand-editing YAML isn't enough. Surfaced in
`atlas workspace validate` output too (Phase D.2).

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
  // existing, unchanged — target job_name IS NULL:
  assignSkill(skillId, workspaceId): Promise<Result<void,string>>;
  unassignSkill(skillId, workspaceId): Promise<Result<void,string>>;

  // NEW — job layer:
  assignToJob(skillId, workspaceId, jobName): Promise<Result<void,string>>;
  unassignFromJob(skillId, workspaceId, jobName): Promise<Result<void,string>>;
  listAssignmentsForJob(workspaceId, jobName): Promise<Result<SkillSummary[],string>>;
}
```

No cascade helpers in v6 — the YAML reconcile path is gone, so
there's no automatic orphan-pruning. Admins who want to clean up can
call `unassignFromJob` explicitly.

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
  storage.listAssigned(workspaceId),                       // job_name IS NULL
  opts?.jobName
    ? storage.listAssignmentsForJob(workspaceId, opts.jobName)
    : Promise.resolve({ ok: true, data: [] } as const),
]);
// dedupe union by skillId
```

#### C.2 `createLoadSkillTool` switches to `jobName`

Drop `jobFilter`; add `jobName?: string`. Defense-in-depth check
inside calls `resolveVisibleSkills(workspaceId, storage, { jobName })`.

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

`executeAgent` (`workspace/src/runtime.ts:1451`) already has
`job.name` in scope. Inject into sessionData when constructing the
agent runner call. A.3 makes it typed; C.5 populates.

### Phase D — Validation only (v6 simplified)

#### D.1 Parse-time warning for unresolved refs

When parsing `workspace.yml`, walk `jobs.*.skills[*]` entries. If a
ref doesn't resolve to a catalog skill, emit a warning:
```
jobs.nightly-report.skills[0] = "@foo/bar" — no such skill in the catalog.
This field is declarative only; no assignment will be created.
```

Plus, whenever the field is populated but has zero corresponding
`skill_assignments` rows, emit:
```
jobs.nightly-report.skills lists 2 skills but 0 matching assignments
exist in the DB. Use the Job Skills UI or `atlas workspace apply` to
sync.
```

Both warnings fire at YAML parse time and again (once) when a job
first runs without matching assignments.

#### D.2 Scoping API atomic body flip

**Before:**
```
POST /api/skills/scoping/:skillId/assignments
body: { workspaceIds: string[] }
```

**After:**
```
POST /api/skills/scoping/:skillId/assignments
body: { assignments: { workspaceId: string; jobName?: string }[] }
```

Entries without `jobName` → workspace-level. Entries with `jobName` →
job-level. In-repo clients (playground + CLI) update in the same PR.
Delete endpoint adds optional trailing segment:
`.../assignments/:workspaceId/:jobName`.

No transition window — see `v4 → v5 changes`.

### Phase E — UI

#### E.0 Stand up `/platform/:ws/jobs/:jobName` route

Only the list page exists today. Skeleton (header, breadcrumb, tab
nav): ~1 h.

#### E.1 Job detail page — Skills section

Three groups:
- **Workspace-inherited** (grayed, read-only): `resolveVisibleSkills(workspaceId)` result
- **Job-specific** (editable): `listAssignmentsForJob(workspaceId, jobName)` — Add/Remove via scoping API
- **Always available** (grayed, read-only): `@friday/*` bypass set. Hardcoded enumeration.

Dual-assignment warning: if a user adds a job-specific assignment
for a skill already at workspace level, show a non-blocking warn
("already visible to all jobs").

#### E.2 Workspace Skills page — per-job breakdown

New "Job-scoped" section grouped by `job_name`. Read-only; writes go
through E.1.

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

Fixtures inline. Skeleton lands in PR #1, live in PR #2, gate for any
future change.

#### F.2 Unit / integration / migration

- Adapter tests: `assignToJob` / `unassignFromJob` / `listAssignmentsForJob`.
- `resolveVisibleSkills(ws, { jobName })` branch coverage.
- **Migration test:** legacy-schema DB + run `addJobNameColumn` +
  assert schema + rows preserved + NULL backfill.
- FSM integration: two jobs with different job-level assignments;
  assert each sees only its own.

#### F.3 QA plan entry

Extend `docs/testing/2026-04-20-skills-ui-qa-plan.v2.md`:
- **§3 smoke**: W-J-01 add skill to job; W-J-02 skill appears in job
  context; W-J-03 peer job doesn't see it; W-J-04 workspace chat
  doesn't see job-private skills.
- **§4 chain 4.13**: assign via UI → run job-A → see it → run job-B
  → don't see it → run workspace chat → don't see it.

## Phases / rollout

| # | Scope | Estimate | Risk |
| --- | --- | --- | --- |
| A.1 | Migration (rebuild pattern + new SCHEMA) | 1.5 h | Med — migration subtle |
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
| F.2 | Adapter + migration + integration tests | 1 h | Low |
| F.3 | QA chain + smoke tests | 45 min | Low |

**Total:** ~13 h (down from v5's 16 h — dropped 2 phases, ~3 h).

**Ship order (4 PRs):**

1. **PR #1 — Schema stubs** (A.1 + A.2 + A.3 + F.1 skeleton). Pure
   additive, migration runs dark.
2. **PR #2 — Job-level lands** (B + C + F.1 live + F.2). Behavior
   change. F.1 green required before merge.
3. **PR #3 — API + validation** (D.1 + D.2). Scoping route flips
   atomically.
4. **PR #4 — UI** (E.0 + E.1 + E.2 + F.3).

PR #2 and #3 can run in parallel; their changes touch disjoint
code paths after PR #1 lands.

## Semantics clarifications (unchanged)

1. Workspace layer = outer VISIBILITY for workspace-wide surfaces.
2. Job layer = additive FOR THAT JOB ONLY.
3. A skill can be assigned at both levels — both rows exist.
4. Step-level (`action.skills`) is a no-op in v6.
5. Catalog presence required for assignment.

## Field-shape note (unchanged)

`workspace.yml` uses objects for workspace-level `skills:` and bare
strings for job-level `jobs.*.skills:`. Asymmetric but intentional;
job level is pure ref list, no inline defs.

## Acknowledged non-goals (v6 is explicit)

These are **deliberately not solved in v6**. Each has a named
follow-up and a one-line scope. Users who expect any of these behaviors
will be surprised unless the docs land first.

### NG-1: `useWorkspaceSkills` code-agent path sees only workspace-level

`runtime.ts:1713` reads `config.workspace.skills` directly for code
agents opting into `useWorkspaceSkills: true`. Those agents bypass
the DB and the `resolveVisibleSkills` path. Job-level skills will
NOT be visible to them in v6.

- **Why punt**: extending that path requires either (a) making it
  read the DB (same model as FSM agents, but changes a runtime
  contract) or (b) reading both YAML and DB and merging (ugly,
  synchronization bug surface).
- **Follow-up task**: document in `useWorkspaceSkills` agent metadata
  that the flag only loads workspace-level skills, not job-level.

### NG-2: Blueprint-backed workspaces have a different save path

`apps/atlasd/routes/workspaces/config.ts:400-451` shows dual-path
config save: blueprint-backed workspaces recompile from a blueprint,
and direct `workspace.yml` mutation is blocked there. v6's Phase D
touches neither path — the scoping API writes to `skill_assignments`,
independent of the YAML / blueprint pipeline.

- **Why punt**: YAML is declarative-only in v6, so the blueprint
  path's "direct YAML changes get overwritten" behavior doesn't
  break anything — the DB assignments survive recompile.
- **Follow-up task**: if we ever implement Phase D.3 / D.4 (YAML →
  DB reconcile), we'd need to integrate with the blueprint recompile
  to avoid re-overwriting reconciled rows.

### NG-3: Two-way sync `workspace.yml` ↔ `skill_assignments`

v5 attempted declarative YAML semantics; v6 drops that fiction. Users
who hand-edit YAML currently get parse-time warnings (Phase D.1)
but no automatic sync. An `atlas workspace apply` command (or
similar) would close the gap.

- **Why punt**: either direction is a sizeable piece of work.
  DB→YAML (auto-emit) requires YAML formatting preservation,
  comment handling, PR/merge safety. YAML→DB (auto-import) requires
  the reconcile + cascade + transaction logic that v5 inflated the
  plan with.
- **Follow-up task**: spec an `atlas workspace apply --skills`
  command that reads `workspace.yml` and issues scoping API calls
  to make the DB match. Opt-in; users who want YAML-as-source-of-truth
  can run it; others use the UI.

## Deferred follow-ups (unchanged)

- Step-level filter reactivation
- `@friday/*` opt-out per job
- "Skill not in scope" debug event
- Agent-level skills (`agents: { foo: { skills } }`)
- Version pinning on assignments

## Open questions

1. **`@db/sqlite` NULL-in-PK behavior** — sanity test at A.1
   implementation.
2. **Simultaneous scoping API writes** — if two UI clicks (or a
   CLI + UI race) assign the same skill to the same job in parallel,
   both hit `assignToJob`. The PK rejects the duplicate; scoping
   route's partial-success path handles it. Verify test case.
3. **Ad-hoc runtime-dispatched jobs not in YAML** — resolver returns
   workspace-level only (no matching `job_name` rows). Matches
   today's behavior; test in F.2.
