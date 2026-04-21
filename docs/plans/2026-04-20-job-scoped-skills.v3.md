<!-- v3 - 2026-04-20 - Generated via /improving-plans from docs/plans/2026-04-20-job-scoped-skills.v2.md -->

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
Additive. Never narrows. No whitelist; no intersection.

## v2 → v3 pivot

v2 modeled job-level as a **whitelist that narrows** the workspace set
(intersection semantics). The user's intent is the opposite: the job
list is **extra assignments unique to that job** (additive semantics).

Consequence: the v2 `jobFilter` concept — where a job's `skills: […]`
field was a filter on a larger visible set — doesn't exist in v3.
Instead `skill_assignments` gains a nullable `job_name` column, and
`resolveVisibleSkills(workspaceId, jobName?)` unions in the job layer.

## Current state (unchanged from v2)

Three disjointed pieces today, reused as-is:

1. **`skill_assignments` table** (`packages/skills/src/local-adapter.ts:37`).
   Composite PK `(skill_id, workspace_id)`. Assignment is the only
   mechanism for workspace visibility today.

2. **`resolveVisibleSkills(workspaceId, storage)`** returns
   `global_unassigned ∪ workspace_assigned`. Five callers build
   `<available_skills>` XML from it — see Phase C.

3. **`createLoadSkillTool({ workspaceId })`** ([`load-skill-tool.ts:76`])
   is the `load_skill` MCP tool. Defense-in-depth already rejects
   catalog skills that `resolveVisibleSkills` would exclude. Today's
   `jobFilter` plumbing inside this file goes away in v3 (no longer
   needed — same result comes from adding `jobName` to the resolver).

## Semantics (additive model)

| Layer | Meaning | Where |
| --- | --- | --- |
| Global (unassigned) | Zero `skill_assignments` rows → visible everywhere | Catalog `publish()` — no assignment |
| Workspace-level | `skill_assignments` row with `job_name IS NULL` | `workspace.yml` top-level `skills:` + Workspace Skills UI |
| Job-level | `skill_assignments` row with `job_name = 'X'` | `workspace.yml` `jobs.X.skills:` + Job Skills UI |

Rules:

1. **Union, never narrow.** Job layer is added, not filtered. A job
   never has fewer skills than the workspace.
2. **Per-job isolation.** Job Y cannot see skills assigned with
   `job_name = 'X'`. That's the whole point of the level.
3. **`@friday/*` stays always-visible.** Bypass in
   `load-skill-tool.ts` unchanged.
4. **Chat / conversation / workspace-level surfaces** call
   `resolveVisibleSkills(workspaceId)` (no jobName) — sees
   `global ∪ workspace-level` only. They never see a job's private
   skills. This matches today's behavior.
5. **Validation of `jobs.*.skills[k]`**: the ref must resolve to a
   skill that exists in the catalog. It does **not** need to be
   workspace-assigned — that's the point; the job list can introduce
   skills the rest of the workspace doesn't have.

## Design

### Phase A — Schema

#### A.1 Data model

**File: `packages/skills/src/local-adapter.ts`**

Add a nullable `job_name` column to `skill_assignments`:

```sql
CREATE TABLE IF NOT EXISTS skill_assignments (
  skill_id    TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  job_name    TEXT,           -- NEW: NULL = workspace-level, non-null = job-scoped
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (skill_id, workspace_id, job_name)
);
CREATE INDEX IF NOT EXISTS idx_skill_assignments_workspace_job
  ON skill_assignments (workspace_id, job_name);
```

Migration: existing rows all get `job_name IS NULL`. The change is
backward-compat for readers that don't care about `job_name`.

**`job_name` in the PK** means a skill can be assigned to (a) the
workspace AND (b) one or more specific jobs in that workspace, without
collision. Each combination is its own row. Duplicate `(skill, ws,
NULL)` is an error (as today); duplicate `(skill, ws, 'X')` is an
error.

#### A.2 Config schema

**File: `packages/config/src/jobs.ts` — `JobSpecificationSchema`**
```ts
skills: z
  .array(SkillRefSchema)
  .optional()
  .describe(
    "Skills assigned to this job. Adds to the workspace-level skills " +
    "— every job sees workspace skills; this list is additional and " +
    "private to this job (not visible to other jobs in the same " +
    "workspace). `@friday/*` is always available.",
  ),
```

**File: `packages/fsm-engine/schema.ts`** — `LLMActionSchema.skills` and
`AgentActionSchema.skills`:

The existing step-level `skills` field is **deferred, not removed**.
Runtime ignores it in v3. Schema stays so existing configs still
parse. Added comment:

```ts
/**
 * @experimental — step-level skill narrowing. Not enforced in v3.
 * Job-level + workspace-level cover 95% of use cases; this field
 * is preserved for a later power-user escape hatch but today the
 * engine ignores it.
 */
skills: z.array(z.string()).optional(),
```

No removal = no breaking change. Reconsider in a follow-up once the
additive model has landed and users request finer granularity.

### Phase B — Assignment CRUD

**File: `packages/skills/src/local-adapter.ts`**

New methods on `SkillStorageAdapter`:

```ts
interface SkillStorageAdapter {
  // existing …
  assignSkill(skillId: string, workspaceId: string): Promise<Result<void, string>>;
  unassignSkill(skillId: string, workspaceId: string): Promise<Result<void, string>>;

  // NEW — job layer
  assignToJob(skillId: string, workspaceId: string, jobName: string): Promise<Result<void, string>>;
  unassignFromJob(skillId: string, workspaceId: string, jobName: string): Promise<Result<void, string>>;
  listAssignmentsForJob(workspaceId: string, jobName: string): Promise<Result<SkillSummary[], string>>;
}
```

Implementation is a near-copy of the existing `assignSkill` /
`unassignSkill` with `job_name` in the WHERE clauses. Keep the old
methods unchanged — they target the `job_name IS NULL` row.

Backend impact: ~30 min of adapter code + tests.

### Phase C — Runtime resolution

#### C.1 `resolveVisibleSkills` gets `jobName`

**File: `packages/skills/src/resolve.ts`**

Signature:
```ts
export async function resolveVisibleSkills(
  workspaceId: string,
  storage: SkillStorageAdapter,
  opts?: { jobName?: string | undefined },
): Promise<SkillSummary[]>;
```

Logic:
```ts
const [unassigned, workspaceLevel, jobLevel] = await Promise.all([
  storage.listUnassigned(),
  storage.listAssigned(workspaceId),  // existing — returns job_name IS NULL rows
  opts?.jobName
    ? storage.listAssignmentsForJob(workspaceId, opts.jobName)
    : Promise.resolve({ ok: true, data: [] } as const),
]);
// union with dedupe by skillId (existing logic)
```

Backward compat: callers that don't pass `opts` get the same set as
today. New callers pass `{ jobName }` to get the union.

#### C.2 `createLoadSkillTool` switches to `jobName`

**File: `packages/skills/src/load-skill-tool.ts`**

Replace:
```ts
interface CreateLoadSkillToolOptions {
  hardcodedSkills?: readonly HardcodedSkill[];
  workspaceId?: string;
  jobFilter?: readonly string[] | null;  // DROP
}
```

With:
```ts
interface CreateLoadSkillToolOptions {
  hardcodedSkills?: readonly HardcodedSkill[];
  workspaceId?: string;
  jobName?: string;  // NEW
}
```

Downstream of this change:
- The tool description filter-suffix (`"filtered for this step: …"`)
  goes away — there's no step-level filter in v3.
- The defense-in-depth check inside `execute()` calls
  `resolveVisibleSkills(workspaceId, storage, { jobName })` to compute
  the allowed set. Already a conceptually clean consolidation of
  today's split between "listed in description" and "allowed by
  filter".

#### C.3 Call-site audit — five sites, explicit threading

Each site that builds `<available_skills>` needs to pass `jobName` to
`resolveVisibleSkills`. Audit (same five sites v2 identified):

| # | File:line | Source of `jobName` |
| --- | --- | --- |
| 1 | `packages/core/src/agent-context/index.ts:106,178` | `sessionData.jobName` (new — threaded through workspace-runtime) |
| 2 | `packages/system/agents/workspace-chat/compose-context.ts:41` | N/A — workspace chat is not a job. No `jobName`. |
| 3 | `packages/system/agents/workspace-chat/workspace-chat.agent.ts:510` | N/A — ditto. No `jobName`. |
| 4 | `packages/system/agents/conversation/conversation.agent.ts:727` | N/A — user-scoped, not job-scoped. No `jobName`. |
| 5 | `packages/fsm-engine/fsm-engine.ts:1171` | `sig._context?.jobName` (new — threaded from workspace-runtime when job starts) |

Two paths need new threading (#1, #5). Three paths are unchanged
because they never run under a job (workspace chat is an ongoing
conversation, not a job execution; conversation agent is user-scoped).
This is a simpler call-site picture than v2 because there's no
"filter" to fold in — just a new optional arg.

#### C.4 Context threading

- **`sessionData.jobName`**: set by `workspace-runtime` when
  dispatching an agent action inside a job. Plumbed through
  `packages/core/src/agent-context/index.ts:172`.
- **`SignalWithContext._context.jobName`**: set by `workspace-runtime`
  when launching an FSM job (see `packages/fsm-engine/types.ts:234`).
  `fsm-engine.ts:1171` reads it.

Adding one field to each is ~20 lines total. Low risk.

### Phase D — `workspace.yml` reconciliation

When a `workspace.yml` contains:
```yaml
skills:                                    # workspace-level assignments
  - name: "@foo/bar"

jobs:
  nightly-report:
    skills:                                # job-level assignments
      - "@anthropics-skills/pdf"
      - "@tempest/report-format"
```

On save, the daemon reconciles **both layers**:
- `skill_assignments(skill_id, workspace_id, NULL)` rows match top-level `skills:`
- `skill_assignments(skill_id, workspace_id, 'nightly-report')` rows match `jobs.nightly-report.skills`

The existing reconcile path in `apps/atlasd/routes/workspaces/…`
handles workspace-level today. Extend to walk each job and reconcile
the job-level rows.

**Validation:**
- `SkillRefSchema` on each entry (already).
- If a ref doesn't resolve to a catalog skill, emit a parse-time
  **warning** (not error — keep configs portable).
- **Runtime backstop**: if `resolveVisibleSkills` returns zero job-level
  rows for a workspace whose YAML clearly declares some, log a warning
  once at first use. Belt-and-braces against drift between YAML and
  DB.

### Phase E — UI

#### E.1 Job detail page — Skills section

Target: wherever the job detail page lives under `/platform/:ws/…`.
**Prerequisite**: verify a job-detail route exists; if not, surface
one first.

Components:
- List of current job-level assignments (uses the same tier-badge row
  component from the workspace skills page).
- Picker: multi-select over the full catalog. Same autocomplete as
  `SkillsShImport`. Writes hit `POST /api/skills/scoping/:skillId/assignments`
  with `{ workspaceId, jobName }` (extend body to accept jobName).
- Inherited-from-workspace section: shows workspace-level skills in a
  grayed "inherited" style with no controls, so the user understands
  the job sees them too.

#### E.2 Workspace Skills page — per-job breakdown

The existing `/platform/:ws/skills` page should gain a "Job-scoped"
section listing job-level assignments grouped by `job_name`, so the
user can see at a glance which skills are scoped to which jobs
without clicking into each job.

Read-only in this view; writes happen on the job detail page.

### Phase F — Testing

#### F.1 Drift invariant — prompt ≡ tool (additive version)

Same property test as v2's F.1, retargeted:

```ts
test.each([
  { jobName: undefined, expect: "workspace + global" },
  { jobName: "job-a",   expect: "workspace + global + job-a layer" },
  { jobName: "job-b",   expect: "workspace + global + job-b layer" },
])("prompt ⊆ tool allows: $expect", async ({ jobName }) => {
  const shown = await resolveVisibleSkills("ws-1", storage, { jobName });
  const { tool } = createLoadSkillTool({ workspaceId: "ws-1", jobName });
  // every shown skill must load; anything not shown (except @friday/*) must be rejected
  // … (as v2's F.1)
});
```

**Fixtures:** inline in the test file. 3-5 skills across
(unassigned-global / workspace-level / job-a-only / job-b-only /
@friday/*) exercise every branch. No new fixture directory.

#### F.2 Unit / integration

- `assignToJob` / `unassignFromJob` / `listAssignmentsForJob` adapter
  tests — cover null vs non-null `job_name` paths.
- `resolveVisibleSkills(ws, { jobName })` — covers each union branch
  separately.
- FSM integration: run a job with job-level skills; assert LLM sees
  them; assert another job without those skills doesn't.

#### F.3 QA plan entry

Extend `docs/testing/2026-04-20-skills-ui-qa-plan.v2.md`:
- **§3 new smoke tests**: W-J-01 add skill to job; W-J-02 skill
  appears in job context; W-J-03 peer job doesn't see it.
- **§4 chain 4.13**: assign skill to job-A only → run job-A → verify
  `<available_skills>` lists it → run job-B → verify it's not listed
  → run workspace chat → verify it's not listed.

## Phases / rollout

| # | Scope | Estimate | Risk |
| --- | --- | --- | --- |
| A.1 | DB migration (job_name column + index) | 45 min | Low — nullable, backward compat |
| A.2 | Config schema (`jobs.*.skills` + deprecate step-skills) | 45 min | Low |
| B | Adapter CRUD (`assignToJob` etc.) | 1 h | Low |
| C.1 | `resolveVisibleSkills({jobName})` | 30 min | Low |
| C.2 | `createLoadSkillTool({jobName})` | 1 h | Med — retire `jobFilter` concept, move check |
| C.3 | Call-site audit (2 live + 3 N/A) | 1 h | Low — the audit already narrowed scope |
| C.4 | Context threading (sessionData + FSMContext) | 30 min | Low |
| D.1 | Parse-time validation warnings | 45 min | Low |
| D.2 | Reconcile hook (job-level rows on YAML save) | 1 h | Med |
| E.1 | Job detail page — skills picker | 3 h | Med — new route if none exists |
| E.2 | Workspace skills page — job-scoped section | 1.5 h | Low |
| F.1 | Drift invariant test | 1 h | Low — permanent guardrail |
| F.2 | Adapter + integration tests | 1 h | Low |
| F.3 | QA chain + smoke tests | 45 min | Low |

**Total:** ~13.5 h — slightly less than v2's 15 h because the call-site
audit simplified and the step-level filter went away.

**Ship order:** A → B → C → D → F.1 → F.2 → F.3 → E1 → E2. A/B/C
should land in one PR; E after, since it depends on stable APIs.

## Semantics clarifications

These come up repeatedly; nail them down once here.

1. **Workspace layer is outer set in terms of VISIBILITY for
   workspace-wide surfaces** (chat, conversation). Those paths don't
   pass `jobName` and see only workspace + global.

2. **Job layer is additive for THAT JOB only**. Not narrowing. Not
   visible to peer jobs. Not visible to workspace chat.

3. **A skill can be assigned at both levels in the same workspace.**
   `(skill, ws, NULL)` AND `(skill, ws, 'job-a')` — both rows exist.
   `resolveVisibleSkills(ws, { jobName: 'job-a' })` dedupes by skillId
   (existing logic).

4. **Step-level filter (`action.skills`) is a no-op in v3.** Schema
   kept, runtime ignores, comment says `@experimental`. Saves a
   breaking change to existing (dead) configs.

5. **Catalog presence still required.** Job-level assignment rows
   reference a real catalog skill (same FK as workspace-level). You
   can't `jobs.x.skills: ["@whatever/ghost"]` and have it materialize.

## Field-shape note (from review idea A)

`workspace.yml` uses two shapes for `skills:` now:
- **Workspace level** (`SkillEntrySchema`): objects — `[{name: "@foo/bar"}, {inline: true, …}]`
- **Job level** (new, v3): bare strings — `["@foo/bar"]`

Asymmetric, but intentional: job-level is a pure assignment list, no
inline definitions needed (a skill can't be defined only inside a
job; it must come from the catalog). Unifying would break
`workspace.yml` back-compat. Accepted as-is; documented in the
example YAML comments.

## Deferred follow-ups

- **Step-level filter** (kept in schema; runtime ignored). Re-enable
  as a power-user escape hatch once v3 is in use and someone asks.
- **`@friday/*` opt-out per job.** Today every job sees `@friday/*`
  unconditionally. If someone wants a minimal-blast-radius job
  (e.g. a sandbox for an untrusted prompt), they'd need a way to
  drop system utilities too. Not v3.
- **Debug UX: "skill not in scope" event**. When `load_skill(X)` is
  rejected because X isn't in the job's resolved set, the LLM retries
  silently. Emit an `AtlasDataEvent` so the playground inspector can
  surface it. Valuable for debugging but a distinct feature.
- **Agent-level skills** (`agents: { foo: { skills: […] } }`).
  Workspace agents aren't jobs but could benefit from the same
  model. Not v3.
- **Version pinning at assignment level.** Today all loads hit latest.
  Pinning would require a `pinned_version` column on assignments;
  orthogonal to this plan.

## Open questions

1. **Does the `/platform/:ws/jobs/:jobName` route exist today?**
   Phase E.1 assumes yes; verify. If not, E.1 grows by ~1 h to
   stand up a basic job detail page.

2. **Unique index reconsideration.** `(skill_id, workspace_id, NULL)`
   and `(skill_id, workspace_id, 'job-a')` must both be allowed. SQLite
   treats NULL as distinct in PRIMARY KEY / UNIQUE constraints, so the
   PK above works — but double-check behavior on mixed-null inserts
   with the specific `@db/sqlite` binding before committing.

3. **Does the existing scoping route accept `jobName` in the body?**
   `POST /api/skills/scoping/:skillId/assignments` — need to extend or
   introduce `POST /api/skills/scoping/:skillId/assignments/:jobName`.
   Decide at Phase B review.

4. **Reconciliation order at save.** If a `workspace.yml` save
   simultaneously removes a skill from workspace-level and adds it to
   job-level, the intermediate state must not drop it visible-to-the-job
   for a brief moment (a running job could load-skill during the
   window). Run the reconcile as one SQLite transaction.
