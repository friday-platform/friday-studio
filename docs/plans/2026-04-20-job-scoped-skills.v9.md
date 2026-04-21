<!-- v9 - 2026-04-20 - Generated via /improving-plans from docs/plans/2026-04-20-job-scoped-skills.v8.md -->

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

## v8 → v9 changes (adapter-interface completeness)

v8 fixed the security check but missed that `SkillStorageAdapter` has
**two implementations**, not one: `LocalSkillAdapter` (SQLite, the
one the plan has been designing against) and `CortexSkillAdapter`
(HTTP to the Cortex service, loaded when `cortexUrl` is set at
`packages/skills/src/storage.ts:57`).

Adding three new methods to the interface (Phase B) breaks
`CortexSkillAdapter`'s `implements SkillStorageAdapter` declaration
— TypeScript compile error before any test runs.

v9 adds:
- **Phase B.1 (new):** stub the three new methods on `CortexSkillAdapter`
  with the same fail-or-empty pattern the existing assignment methods
  use (Cortex backend doesn't host assignments).
- **Non-goal NG-4 (new):** document that job-level scoping is
  SQLite-only. Under Cortex, `resolveVisibleSkills` returns the job
  layer as empty, equivalent to workspace-level-only visibility.

No other changes. Phase estimates unchanged. Ship order unchanged.

## Current state (verified for v9)

- Two adapter implementations share `SkillStorageAdapter`:
  - `LocalSkillAdapter` (`packages/skills/src/local-adapter.ts`)
  - `CortexSkillAdapter` (`packages/skills/src/cortex-adapter.ts`)
- `CortexSkillAdapter` today returns `fail("CortexSkillAdapter does
  not support assignSkill")` for assignment writes and `success([])`
  for assignment reads. Cortex doesn't host the assignment surface
  — the local SQLite adapter does.
- Switching between adapters happens at `storage.ts:52-62` based on
  env config.

## Semantics (unchanged)

Unchanged from v3 onward.

## Design

### Phase A — Schema

Unchanged from v8. A.1 migration + partial unique index, A.1.5 query
audit, A.2 config schema, A.3 AgentSessionData jobName.

### Phase B — Assignment CRUD

#### B.0 `LocalSkillAdapter` gains the new methods

**File: `packages/skills/src/local-adapter.ts`**

Same as v7/v8:
```ts
assignToJob(skillId, workspaceId, jobName): Promise<Result<void,string>>
unassignFromJob(skillId, workspaceId, jobName): Promise<Result<void,string>>
listAssignmentsForJob(workspaceId, jobName): Promise<Result<SkillSummary[],string>>
```

#### B.1 `CortexSkillAdapter` stubs the new methods (v9: new)

**File: `packages/skills/src/cortex-adapter.ts`**

Mirror the existing unsupported-assignment pattern:
```ts
assignToJob(): Promise<Result<void, string>> {
  return Promise.resolve(fail("CortexSkillAdapter does not support assignToJob"));
}
unassignFromJob(): Promise<Result<void, string>> {
  return Promise.resolve(fail("CortexSkillAdapter does not support unassignFromJob"));
}
listAssignmentsForJob(): Promise<Result<SkillSummary[], string>> {
  return Promise.resolve(success([]));
}
```

Without these stubs, Phase B.0 is a compile error the moment
`deno task typecheck` runs. Easy to miss because the plan focuses
on SQLite.

### Phase C — Runtime resolution

Unchanged from v8 (includes the unified defense-in-depth fix).

### Phase D — Validation only

Unchanged from v8. D.1 parse-time warnings, D.2 atomic scoping API
body flip.

### Phase E — UI

Unchanged from v8.

### Phase F — Testing

Unchanged from v8.

## Phases / rollout

| # | Scope | Estimate | Risk |
| --- | --- | --- | --- |
| A.1 | Migration (rebuild + partial unique index) | 1.5 h | Med |
| A.1.5 | Query audit (AND job_name IS NULL + DISTINCT fixes) | 30 min | Low |
| A.2 | Config schema | 45 min | Low |
| A.3 | AgentSessionData gets jobName | 15 min | Low |
| B.0 | LocalSkillAdapter new methods | 1 h | Low |
| B.1 | CortexSkillAdapter stub methods (v9: new) | 15 min | Very low |
| C.1 | resolveVisibleSkills({jobName}) | 30 min | Low |
| C.2 | createLoadSkillTool({jobName}) + unified defense-in-depth | 1 h | Med |
| C.3 | Two call sites thread jobName | 45 min | Low |
| C.4 | FSM engine uses this._definition.id | 10 min | Very low |
| C.5 | workspace-runtime injects jobName | 20 min | Low |
| D.1 | Parse-time + first-run warnings | 45 min | Low |
| D.2 | Scoping API atomic body flip | 45 min | Low |
| E.0 | Job detail route skeleton | 1 h | Low |
| E.1 | Job detail Skills section | 3 h | Med |
| E.2 | Workspace skills per-job breakdown | 1.5 h | Low |
| F.1 | Drift invariant (gating) | 1.5 h | Low |
| F.2 | Adapter + regression + migration tests | 1.5 h | Low |
| F.3 | QA chain + smoke tests | 45 min | Low |

**Total:** ~13.25 h (v8's 13 h + 15 min for B.1 cortex stubs).

**Ship order:** unchanged from v7/v8.

## Acknowledged non-goals

### NG-1: `useWorkspaceSkills` code-agent path sees only workspace-level
Unchanged.

### NG-2: Blueprint-backed workspaces have a different save path
Unchanged.

### NG-3: Two-way sync `workspace.yml` ↔ `skill_assignments`
Unchanged.

### NG-4: Job-level scoping is SQLite-only (v9: new)

When the daemon is configured with `cortexUrl` (switching to
`CortexSkillAdapter`), Phase B.1's stubs return `fail()` for
assignment writes and `success([])` for job-level reads.
`resolveVisibleSkills({ jobName })` returns `[]` for the job layer
— the job becomes equivalent to workspace-level-only visibility.

This matches Cortex's current behavior: it doesn't host workspace-
level assignments either. v9 doesn't extend Cortex to host either
layer; the plan punts entirely on the Cortex path. If Cortex ever
needs to host skill assignments, both the workspace-level and
job-level surfaces would land in the same follow-up.

The UI's scoping-API mutations would return 500 (from `fail()`)
under Cortex deployments. v9 non-goal; UI doesn't need to
pre-detect.

## Semantics clarifications (unchanged)

1. Workspace layer = outer VISIBILITY for workspace-wide surfaces.
2. Job layer = additive FOR THAT JOB ONLY.
3. A skill can be assigned at both levels — both rows exist.
4. Step-level (action.skills) is a no-op.
5. Catalog presence required for assignment.

## Field-shape note (unchanged)

Workspace level `skills:` uses objects; job level `jobs.*.skills:`
uses bare strings. Intentional asymmetry.

## Deferred follow-ups (unchanged)

Step-level filter reactivation, `@friday/*` opt-out per job,
skill-not-in-scope debug event, agent-level skills, version
pinning.

## Open questions

1. **~~`@db/sqlite` NULL-in-PK behavior~~** (resolved by partial
   unique index in v7)
2. **Simultaneous scoping API writes** — verify in F.2.
3. **Ad-hoc runtime-dispatched jobs not in YAML** — verify in F.2.

## Process note

v9 exists because v8 missed the Cortex interface parity. Same bar as
every prior review: if v10 is requested, name a failing test or
compile error — otherwise it's gold-plating.

v9 is now the first version that **typechecks** after a mechanical
implementation pass. Earlier versions would have produced a compile
error at Phase B the moment cortex-adapter was loaded.

Eight passes in, time to stop reviewing and start shipping.
