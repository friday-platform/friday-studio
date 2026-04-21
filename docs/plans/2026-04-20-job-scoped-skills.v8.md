<!-- v8 - 2026-04-20 - Generated via /improving-plans from docs/plans/2026-04-20-job-scoped-skills.v7.md -->

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

## v7 → v8 changes (single correctness fix)

v7 was called mechanically implementable. One bug survived the v7
audit: the tool's defense-in-depth check (`load-skill-tool.ts:207`)
is too permissive for the additive model.

- **The bug**: the check uses `listAssignments(skillId)` — "does the
  caller's workspace appear in *any* assignment row for this skill?"
  Pre-additive, only workspace-level rows existed so that was
  sufficient. Post-migration, a skill assigned only to `job-a` has a
  row `(X, ws, 'job-a')`. `listAssignments(X)` (DISTINCT fix from
  v7) returns `['ws']`. Any caller in `ws` — workspace chat,
  conversation agent, or peer job `job-b` — passes the check and
  can load X despite X being scoped to `job-a` only.

- **Why F.1 doesn't catch it**: F.1 tests
  `resolveVisibleSkills(context) ≡ resolveVisibleSkills(context)`
  indirectly through `createLoadSkillTool` — but the legacy
  defense-in-depth is a *second* independent gate that goes around
  the resolver. F.1 passes while the bug exists.

- **The fix**: replace the legacy check with a call to
  `resolveVisibleSkills(workspaceId, { jobName })` and assert the
  requested ref is in the result. Single source of truth. F.1 now
  covers the complete tool-accept logic.

- **Regression test**: F.2 gains one entry — "skill assigned only
  to job-a is rejected by load_skill when called from workspace
  chat and from job-b."

No other changes v7 → v8. Phase estimates and ship order unchanged.

## Current state (unchanged from v7)

- `skill_assignments` table with two-column PK today;
  three-column + partial unique index after migration.
- Rows populated by scoping API, install, fork.
- `workspace.yml`'s `skills:` field read directly by
  `runtime.ts:1713` for `useWorkspaceSkills` code agents.
- `load-skill-tool.ts` has TWO visibility checks:
  - the new v7 `resolveVisibleSkills(workspaceId, {jobName})` path
    (drives `<available_skills>` and gates via the tool's internal
    check)
  - the legacy `listAssignments`-based defense-in-depth at line 207
    (**v8 replaces this**)

## Semantics (unchanged)

Unchanged from v7.

## Design

### Phase A — Schema

Unchanged from v7. A.1 migration + partial unique index, A.1.5
query audit, A.2 config schema, A.3 AgentSessionData jobName.

### Phase B — Assignment CRUD

Unchanged from v7.

### Phase C — Runtime resolution

#### C.1 `resolveVisibleSkills` gets `jobName`

Unchanged from v7.

#### C.2 `createLoadSkillTool` — jobName + unified defense-in-depth (v8)

**File: `packages/skills/src/load-skill-tool.ts`**

Drop `jobFilter`; add `jobName?: string`.

**v8: replace the legacy listAssignments defense-in-depth.**

Before (today):
```ts
if (workspaceId) {
  const assignments = await SkillStorage.listAssignments(result.data.skillId);
  if (assignments.ok && assignments.data.length > 0
      && !assignments.data.includes(workspaceId)) {
    return { error: `Skill "${ref}" is not available in this workspace` };
  }
}
```

After (v8):
```ts
if (workspaceId) {
  // Defense in depth: enforce the same visibility the <available_skills>
  // prompt block shows. One source of truth for "is this skill
  // loadable in this context" — prevents the legacy listAssignments
  // presence-check from leaking job-scoped skills to peer jobs or
  // workspace-wide callers.
  const visible = await resolveVisibleSkills(workspaceId, SkillStorage, { jobName });
  const hit = visible.some((s) => `@${s.namespace}/${s.name}` === ref);
  if (!hit) {
    // @friday/* always allowed (bypass), mirrors the prompt filter.
    if (!ref.startsWith("@friday/")) {
      logger.warn("skill_not_visible", { skill: ref, workspaceId, jobName });
      return { error: `Skill "${ref}" is not available in this context` };
    }
  }
}
```

Benefits:
- One definition of visibility shared by prompt and tool.
- F.1 drift invariant now covers the full tool-accept path.
- Error message reflects scope ("context" not just "workspace")
  since job-level can reject a skill that's technically "in this
  workspace."

#### C.3 Call-site audit

Unchanged from v7.

#### C.4 FSM engine reads `this._definition.id` directly

Unchanged from v7.

#### C.5 workspace-runtime injects `jobName` into sessionData

Unchanged from v7.

### Phase D — Validation only

Unchanged from v7. D.1 parse-time warnings, D.2 atomic scoping API
body flip.

### Phase E — UI

Unchanged from v7.

### Phase F — Testing

#### F.1 Drift invariant — gating test (v8: now fully covers the tool)

```ts
test.each([
  { jobName: undefined, expect: "workspace + global" },
  { jobName: "job-a",   expect: "workspace + global + job-a layer" },
  { jobName: "job-b",   expect: "workspace + global + job-b layer" },
])("prompt ⊆ tool allows: $expect", async ({ jobName }) => {
  const shown = await resolveVisibleSkills("ws-1", storage, { jobName });
  const { tool } = createLoadSkillTool({ workspaceId: "ws-1", jobName });
  // every shown skill must load; anything not shown (except @friday/*)
  // must be rejected. v8: the tool's entire accept path goes through
  // resolveVisibleSkills, so this invariant now includes the
  // defense-in-depth check.
});
```

No wording change to the test itself — the semantic coverage
improved because C.2's refactor unified the two accept-paths.

#### F.2 Unit / integration / migration (v8: one new regression test)

All v7 tests plus:

- **v8: defense-in-depth with additive model**. Set up a skill
  assigned only to `(X, 'ws-1', 'job-a')`. Assert:
  - `load_skill("@ns/X")` called from workspace chat (no jobName) → error
  - `load_skill("@ns/X")` called from `job-b` context → error
  - `load_skill("@ns/X")` called from `job-a` context → success

This test would fail under v7's design (the legacy check passes)
and pass under v8's.

#### F.3 QA plan entry

Unchanged from v7. v8 adds W-J-07 to §3:
- W-J-07: skill assigned only to job-a is NOT loadable from job-b
  via any hallucinated ref.

## Phases / rollout

Unchanged from v7; same estimate ~13 h. C.2's refactor is inside
the existing C.2 estimate (1 h) — no budget change. F.2 gains one
test case (minutes).

**Ship order (4 PRs):** same as v7.

## Acknowledged non-goals (v6+v7, unchanged)

- NG-1: `useWorkspaceSkills` code-agent path sees only workspace-level
- NG-2: Blueprint-backed workspaces have a different save path
- NG-3: Two-way sync `workspace.yml` ↔ `skill_assignments`

## Semantics clarifications (unchanged)

1. Workspace layer = outer VISIBILITY for workspace-wide surfaces.
2. Job layer = additive FOR THAT JOB ONLY.
3. A skill can be assigned at both levels — both rows exist.
4. Step-level (`action.skills`) is a no-op.
5. Catalog presence required for assignment.

## Deferred follow-ups (unchanged)

Step-level filter reactivation, `@friday/*` opt-out per job,
skill-not-in-scope debug event, agent-level skills, version pinning.

## Open questions

1. **~~`@db/sqlite` NULL-in-PK behavior~~** (resolved by partial
   unique index in v7)
2. **Simultaneous scoping API writes** — verified in F.2.
3. **Ad-hoc runtime-dispatched jobs not in YAML** — verified in F.2.

## Process note

v8 exists because my v6 review said "if v7 is requested, the bar
rises to 'what failing test would name it?'" — and v8 had exactly
one test to point at. One fix. If v9 is requested, same bar: name a
failing test or it's gold-plating.

Seven review passes in, the remaining path is execution. v8 is the
plan an implementer can run mechanically.
