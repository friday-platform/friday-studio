<!-- v4 - 2026-04-20 - Generated via /improving-plans from docs/plans/2026-04-20-job-scoped-skills.v3.md -->

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

## v3 → v4 changes

Three code-contact fixes caught in review:

- **A.3 (new):** `AgentSessionDataSchema` needs a `jobName` field. v3
  assumed it already existed as "sessionData.jobName"; it doesn't.
- **C.4 simplified:** FSM engine already has the job identifier as
  `this._definition.id` (used at 6+ sites for event emission). No
  need to thread `jobName` through `SignalWithContext._context`.
  Drops a schema change.
- **Open Q3 resolved:** scoping API extends body
  (`{ assignments: [{workspaceId, jobName?}] }`) rather than adding a
  new path. One endpoint, richer body.

Also two UI implementation notes added to Phase E.1 (dual-assignment
rendering + implicit `@friday/*` section).

## Current state (unchanged from v3)

Three disjointed pieces today, reused as-is:

1. **`skill_assignments` table** (`packages/skills/src/local-adapter.ts:37`).
   Composite PK `(skill_id, workspace_id)`.

2. **`resolveVisibleSkills(workspaceId, storage)`** returns
   `global_unassigned ∪ workspace_assigned`.

3. **`createLoadSkillTool({ workspaceId })`**
   ([`load-skill-tool.ts:76`]) — rejects catalog skills that aren't in
   the resolved-visible set. `jobFilter` option exists in the file but
   no caller uses it; v4 retires the concept (subsumed by the new
   `jobName` arg on the resolver).

## Semantics (unchanged from v3)

| Layer | Meaning | Where |
| --- | --- | --- |
| Global (unassigned) | Zero `skill_assignments` rows → visible everywhere | Catalog `publish()` — no assignment |
| Workspace-level | `skill_assignments` row with `job_name IS NULL` | `workspace.yml` top-level `skills:` + Workspace Skills UI |
| Job-level | `skill_assignments` row with `job_name = 'X'` | `workspace.yml` `jobs.X.skills:` + Job Skills UI |

Rules:

1. **Union, never narrow.** Job layer adds, doesn't filter.
2. **Per-job isolation.** Job Y cannot see skills assigned with
   `job_name = 'X'`.
3. **`@friday/*` stays always-visible.** Bypass in
   `load-skill-tool.ts` unchanged.
4. **Workspace-wide surfaces** (chat, conversation) call
   `resolveVisibleSkills(workspaceId)` (no jobName) — sees workspace +
   global only. Never a peer job's private skills.
5. **Validation.** `jobs.*.skills[k]` must resolve to an existing
   catalog skill. Does NOT need to be already-assigned — that's the
   point; a job assignment can introduce a skill no other workspace
   actor has.

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

Migration: existing rows all get `job_name IS NULL` → workspace-level,
no behavior change. Backward compat for readers that don't care.

**Why `job_name` in the PK:** a skill can be assigned to (a) the
workspace level AND (b) one or more specific jobs in that workspace,
without collision. Each combination is its own row.

#### A.2 `jobs.*.skills` config schema

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

**File: `packages/fsm-engine/schema.ts`** — `LLMActionSchema.skills`
and `AgentActionSchema.skills` stay in the schema as
`@experimental`. Runtime ignores them in v4. Saves a schema-breaking
change to existing (dead) configs. Reconsider in a follow-up.

#### A.3 `AgentSessionData` gets `jobName`

**File: `packages/agent-sdk/src/types.ts` — `AgentSessionDataSchema`**
```ts
export const AgentSessionDataSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string().optional(),
  userId: z.string().optional(),
  streamId: z.string().optional(),
  jobName: z.string().optional(),       // NEW — present when run inside a job
  datetime: …,
  memoryContextKey: z.string().optional(),
  foregroundWorkspaceIds: z.array(z.string()).optional(),
});
```

Needed by Phase C.3 (agent-context path). Trivial addition; no
consumer today so adding it doesn't break anything.

### Phase B — Assignment CRUD

**File: `packages/skills/src/local-adapter.ts`**

```ts
interface SkillStorageAdapter {
  // existing …
  assignSkill(skillId, workspaceId): Promise<Result<void,string>>;         // job_name IS NULL
  unassignSkill(skillId, workspaceId): Promise<Result<void,string>>;

  // NEW — job layer
  assignToJob(skillId, workspaceId, jobName): Promise<Result<void,string>>;
  unassignFromJob(skillId, workspaceId, jobName): Promise<Result<void,string>>;
  listAssignmentsForJob(workspaceId, jobName): Promise<Result<SkillSummary[],string>>;
}
```

Implementation is near-copy of the existing `assignSkill` /
`unassignSkill` with `job_name` in the WHERE. Keep old methods —
they already target `job_name IS NULL`.

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
  storage.listAssigned(workspaceId),                         // job_name IS NULL rows
  opts?.jobName
    ? storage.listAssignmentsForJob(workspaceId, opts.jobName)
    : Promise.resolve({ ok: true, data: [] } as const),
]);
// union with dedupe by skillId (existing logic)
```

Backward compat: calls without `opts` get today's set.

#### C.2 `createLoadSkillTool` switches to `jobName`

**File: `packages/skills/src/load-skill-tool.ts`**

Replace `jobFilter` with `jobName`:
```ts
interface CreateLoadSkillToolOptions {
  hardcodedSkills?: readonly HardcodedSkill[];
  workspaceId?: string;
  jobName?: string;   // NEW; replaces jobFilter
}
```

The internal defense-in-depth check calls
`resolveVisibleSkills(workspaceId, storage, { jobName })` to compute
the allowed set. Subsumes both "listed in description" and "allowed by
filter" into one code path.

#### C.3 Call-site audit — two live, three N/A

| # | File:line | `jobName` source |
| --- | --- | --- |
| 1 | `packages/core/src/agent-context/index.ts:106,178` | `sessionData.jobName` (A.3 adds this) |
| 2 | `workspace-chat/compose-context.ts:41` | N/A — workspace chat isn't a job |
| 3 | `workspace-chat/workspace-chat.agent.ts:510` | N/A — ditto |
| 4 | `conversation.agent.ts:727` | N/A — user-scoped, not job-scoped |
| 5 | `packages/fsm-engine/fsm-engine.ts:1171` | **`this._definition.id`** (already in scope — see C.4) |

Only two sites need threading (#1 via sessionData, #5 via the FSM
engine's own field).

#### C.4 FSM engine — use `this._definition.id` directly

**v3 proposed** threading `jobName` through `SignalWithContext._context.jobName`.
**v4 drops that** — the FSM engine already has the job identifier as
`this._definition.id`, used at six sites for event emission
(fsm-engine.ts:760, 908, 1037, 1678, 1698, 1762). At line 1171:

```ts
const jobName = this._definition.id;
const skills: SkillSummary[] = workspaceId
  ? await resolveVisibleSkills(workspaceId, SkillStorage, { jobName })
  : [];
// …
const { tool: loadSkill, cleanup } = createLoadSkillTool({
  workspaceId,
  jobName,
});
```

No new field on `SignalWithContext._context`; no threading; one line
reads the engine's own instance state. Cleaner than v3.

#### C.5 Workspace runtime threads `jobName` into sessionData

**File: `packages/workspace/src/runtime.ts` — `executeAgent`
(line 1451)** already has `job.name` in scope (seen at line 1464 where
it's passed to a logger). When the agent runs (orchestrator call at
1609 or the buildAgentPrompt above), `sessionData` is constructed
somewhere upstream; find that and inject `jobName: job.name`. The
field lands in `AgentSessionData` via A.3.

Two places to check:
- orchestrator call (builds session data for agent runner)
- `buildAgentPrompt` → `createAgentContext` which reads
  `sessionData.jobName` (C.3 wires the consume side).

Threading cost: ~20 min once A.3 + C.3 land.

### Phase D — `workspace.yml` reconciliation

When YAML contains:
```yaml
skills:
  - name: "@foo/bar"             # workspace-level

jobs:
  nightly-report:
    skills:
      - "@anthropics-skills/pdf" # job-level
      - "@tempest/report-format"
```

On save, reconcile both layers:
- `skill_assignments(skill_id, workspace_id, NULL)` rows match
  top-level `skills:`
- `skill_assignments(skill_id, workspace_id, 'nightly-report')` rows
  match `jobs.nightly-report.skills`

**Validation:**
- `SkillRefSchema` on each entry.
- Unresolved ref → parse-time **warning** (not error).
- **Runtime backstop**: if `resolveVisibleSkills({ jobName: 'X' })`
  returns zero job-level rows for a workspace whose YAML clearly
  declares some, log a warning once at first use. Catches config
  drift between YAML and DB.

**Transaction safety:** removing workspace-level + adding job-level
for the same skill simultaneously must run inside one SQLite
transaction so the skill is never briefly invisible to a running job.

### Phase E — UI

#### E.1 Job detail page — Skills section

**Prerequisite:** `/platform/:ws/jobs/:jobName` route doesn't exist
today (only `/platform/:ws/jobs` list page). Stand it up first (~1 h).

**Components:**
- **Workspace-inherited section** (grayed, read-only): lists every
  skill from `resolveVisibleSkills(workspaceId)` — what the job sees
  because of workspace-level assignments. Clicking routes to the
  workspace skills page to edit.
- **Job-specific section** (editable): current
  `listAssignmentsForJob(workspaceId, jobName)` result. Add/Remove
  mutations hit the extended scoping route (see below).
- **Always-available section** (grayed, read-only): lists the
  `@friday/*` bypass set. Short but present — closes a real "why does
  this skill show up here?" debugging gap. Source: hard-coded list
  since the bypass is `ref.startsWith("@friday/")` today; flex later
  if we add more always-visible namespaces.
- **Dual-assignment warn**: if the user adds a job-specific assignment
  for a skill already workspace-level, surface a non-blocking warn
  ("This skill is already visible to all jobs. Are you sure you want a
  job-specific assignment too?"). Allow it — the DB accepts
  `(skill, ws, NULL) + (skill, ws, 'job-a')` both — but flag as
  redundant.

#### E.2 Workspace Skills page — per-job breakdown

Existing `/platform/:ws/skills` page gains a "Job-scoped" section
grouped by `job_name`, listing which skills are private to which
jobs. Read-only; writes happen on the job detail page.

### Phase F — Testing

#### F.1 Drift invariant — prompt ≡ tool (additive version)

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

**Fixtures:** inline in the test file. 3-5 skills across
(unassigned-global / workspace-level / job-a-only / job-b-only /
`@friday/*`) exercise every branch. No new fixture directory.

#### F.2 Unit / integration

- `assignToJob` / `unassignFromJob` / `listAssignmentsForJob` adapter
  tests — null vs non-null `job_name` paths.
- `resolveVisibleSkills(ws, { jobName })` — per-branch unions.
- FSM integration: run a job with job-level skills; assert LLM sees
  them; assert another job without those skills doesn't.

#### F.3 QA plan entry

Extend `docs/testing/2026-04-20-skills-ui-qa-plan.v2.md`:
- **§3 new smoke tests**: W-J-01 add skill to job; W-J-02 skill
  appears in job context; W-J-03 peer job doesn't see it;
  W-J-04 workspace chat doesn't see job-private skills.
- **§4 chain 4.13**: assign skill to job-A only → run job-A → verify
  `<available_skills>` lists it → run job-B → verify it's not listed
  → run workspace chat → verify it's not listed.

## API surface

### Scoping route — extend body, don't add endpoint

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

Behavior:
- Entries without `jobName` hit `assignSkill(skillId, workspaceId)` —
  workspace-level row.
- Entries with `jobName` hit `assignToJob(skillId, workspaceId,
  jobName)` — job-level row.
- Response shape unchanged (`{ assigned, failed }` with the same
  partial-success semantics).

Migration: backend supports both body shapes for a release (detect
`workspaceIds` vs `assignments`). Playground + CLI clients move to
the new shape. After a release without breakage, drop
`workspaceIds`.

Delete stays path-based:
```
DELETE /api/skills/scoping/:skillId/assignments/:workspaceId
DELETE /api/skills/scoping/:skillId/assignments/:workspaceId/:jobName   # NEW
```

Path length is fine at three params; cleaner than a querystring
alternative.

## Phases / rollout

| # | Scope | Estimate | Risk |
| --- | --- | --- | --- |
| A.1 | DB migration (job_name column + index) | 45 min | Low |
| A.2 | Config schema (`jobs.*.skills` + step-skill `@experimental`) | 45 min | Low |
| A.3 | `AgentSessionDataSchema` gains `jobName` | 15 min | Low |
| B | Adapter CRUD (`assignToJob` etc.) | 1 h | Low |
| C.1 | `resolveVisibleSkills({jobName})` | 30 min | Low |
| C.2 | `createLoadSkillTool({jobName})` — retire `jobFilter` | 1 h | Med |
| C.3 | Two call sites thread `jobName` | 45 min | Low |
| C.4 | FSM engine reads `this._definition.id` (no threading) | 10 min | Very low |
| C.5 | workspace-runtime injects `jobName` into sessionData | 20 min | Low |
| D.1 | Parse-time validation warnings | 45 min | Low |
| D.2 | Reconcile hook (job-level rows on YAML save) | 1 h | Med |
| D.3 | Scoping API extended body + transition support | 45 min | Low |
| E.0 | Stand up `/platform/:ws/jobs/:jobName` route | 1 h | Low |
| E.1 | Job detail page — skills picker (3 sections + warn) | 3 h | Med |
| E.2 | Workspace skills page — job-scoped section | 1.5 h | Low |
| F.1 | Drift invariant test | 1 h | Low |
| F.2 | Adapter + integration tests | 1 h | Low |
| F.3 | QA chain + smoke tests | 45 min | Low |

**Total:** ~14.5 h (up from v3's 13.5 h because A.3 + E.0 landed, C.4
shrank).

**Ship order:** A (1+2+3) → B → C (1+2+3+4+5) → D (1+2+3) → F.1 →
F.2 → F.3 → E.0 → E.1 → E.2.

A, B, C should land in one PR — schema + resolver + tool + call-site
threading are a coherent unit; shipping any subset breaks the
prompt↔tool invariant. F.1 in the same PR locks it.

## Semantics clarifications (unchanged from v3)

1. **Workspace layer is the outer VISIBILITY set for workspace-wide
   surfaces** (chat, conversation). No `jobName` ⇒ workspace + global
   only.
2. **Job layer is additive for THAT JOB only**. Not narrowing, not
   visible to peers, not visible to workspace chat.
3. **A skill can be assigned at both levels** — both rows exist;
   `resolveVisibleSkills` dedupes by skillId.
4. **Step-level filter (`action.skills`) is a no-op.** Schema kept,
   runtime ignores, marked `@experimental`.
5. **Catalog presence required.** Assignment rows FK to catalog
   skills.

## Field-shape note

`workspace.yml` uses two shapes for `skills:`:
- **Workspace level** (`SkillEntrySchema`): objects —
  `[{name: "@foo/bar"}, {inline: true, …}]`.
- **Job level** (new, v4): bare strings — `["@foo/bar"]`.

Asymmetric but intentional: job level is pure assignment, no inline
defs. Unifying would break workspace.yml. Documented, not changed.

## Deferred follow-ups

- **Step-level filter** — schema kept, runtime ignored. Re-enable as
  a power-user escape hatch once the additive model proves out.
- **`@friday/*` opt-out per job** — for sandboxed / minimal-blast-
  radius jobs. Not v4.
- **Debug UX: "skill not in scope" event** — surface a data event in
  the playground inspector when `load_skill(X)` is rejected. Distinct
  feature.
- **Agent-level skills** — `agents: { foo: { skills: […] } }`. Same
  model would work. Not v4.
- **Version pinning at assignment level** — assignment row carries a
  `pinned_version`. Orthogonal.

## Open questions (tracking)

1. **~~Job-detail route exists?~~** Answered during review: no. Phase
   E.0 stands one up (~1 h, now counted in estimate).
2. **`@db/sqlite` NULL-in-PK behavior** — standard SQL says NULL is
   distinct. Needs a sanity test at implementation time; if it's
   treated as equal, switch to `(skill_id, workspace_id, COALESCE(job_name, ''))`.
3. **~~Scoping-route API shape?~~** Answered: extend body, don't add
   path.
4. **Reconcile-on-save transaction boundary** — covered in Phase D;
   one SQLite transaction.
5. **Observability when a filter blocks a load** — out of scope in v4
   (there's no filter); tracked as a deferred follow-up instead.
