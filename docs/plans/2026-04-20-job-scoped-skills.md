# Job-scoped skills

**Status:** draft · **Owner:** TBD · **Date:** 2026-04-20
**Depends on:** skills subsystem landed on `declaw` (41 commits ending `e2714783fe`).

## Goal

Let a user restrict which skills are loadable by an individual **job**
(and, inside FSM-based jobs, by an individual **step**). Today all jobs
in a workspace see every workspace-assigned skill; there's no way to
say "this nightly-report job should only use `@anthropics-skills/pdf`
and `@tempest/report-format`, not the other 12 skills on the workspace."

## What's actually in the codebase today

Scouting this before planning — three disjointed pieces, none wired to
each other:

1. **`createLoadSkillTool()` accepts a `jobFilter`**
   (`packages/skills/src/load-skill-tool.ts:56`). Empty array blocks all
   catalog skills for the step; `undefined` inherits workspace
   visibility; `@friday/*` always bypasses the filter because those are
   system utilities. **No caller ever passes it.**

2. **FSM step schema has a `skills` field** on both `LLMActionSchema`
   and `AgentActionSchema` (`packages/fsm-engine/schema.ts:30,53`).
   **The engine never reads it** — `fsm-engine.ts:1192` calls
   `createLoadSkillTool({ workspaceId })` only. This is what task #37
   ("Phase 7: D.1.b Job-level scoping in fsm-engine") landed, but it
   stopped at schema + dead runtime plumbing.

3. **`JobSpecificationSchema` has no `skills` field**
   (`packages/config/src/jobs.ts:117`). Agent-based jobs (the common
   case — `execution: { … }` not `fsm: { … }`) have nowhere in YAML to
   express a skill filter.

Net result: the user's observation is correct — **no way to assign a
skill to a job today.**

## Semantics (decide upfront)

These questions have to be nailed down before schema lands; otherwise
the feature ships with ambiguous behavior.

1. **Replace or add?** Job filter is a **whitelist that replaces** the
   workspace list, not additive. `skills: []` explicitly means "no
   catalog skills, only `@friday/*` built-ins." This matches the
   existing `jobFilter` semantics in `load-skill-tool.ts` and is the
   only safe default for security — additive filters can't shrink the
   visible set. **Decision: whitelist.**

2. **`@friday/*` bypass stays.** Already in the runtime; the plan
   doesn't touch it. These are cross-cutting utilities (authoring,
   workspace-api) and always visible regardless of filter.

3. **Unassigned-global skills?** `load-skill-tool.ts` currently
   allows catalog skills that are unassigned-globally, even under a
   `jobFilter`. **Decision: no — once `jobFilter` is set, it's a
   strict whitelist.** If the user wants globals in a job, they list
   them. Open q: does this break existing flows that rely on globals
   leaking through? Needs a quick audit.

4. **Job-level vs step-level.** Both needed. FSM jobs want step-level
   (authorization can change between states). Agent-based jobs only
   have one prompt so per-job is fine. **Decision: add job-level as
   the default; step-level overrides job-level when set.**

5. **Validation.** Should a job be allowed to list skills that aren't
   assigned to the workspace? **Decision: yes, but warn at parse
   time.** A job ref to `@foo/bar` when the workspace doesn't have it
   assigned means the skill is unreachable — surface as a lint
   warning, not a hard error, so config can ship decoupled from
   assignment state.

## Design

### Phase A — Schema

Add `skills?: SkillRef[]` to two places:

**`packages/config/src/jobs.ts` — `JobSpecificationSchema`**:
```ts
skills: z
  .array(SkillRefSchema)
  .optional()
  .describe(
    "Whitelist of skills this job can load. Empty array ⇒ no catalog " +
    "skills; undefined ⇒ inherit workspace visibility. `@friday/*` is " +
    "always available regardless of this list.",
  ),
```

**`packages/fsm-engine/schema.ts`** — schema already has it; keep as-is
but tighten the type from `z.array(z.string())` to the shared
`SkillRefSchema`:
```ts
skills: z.array(SkillRefSchema).optional(),
```

`SkillRefSchema` lives in `packages/config/src/skills.ts`. This is the
one validated `@namespace/name` schema already used by
`WorkspaceSkillsSchema`.

### Phase B — Engine wiring

**File: `packages/fsm-engine/fsm-engine.ts:1192`**

Replace:
```ts
const { tool: loadSkill, cleanup } = createLoadSkillTool({ workspaceId });
```

With:
```ts
const { tool: loadSkill, cleanup } = createLoadSkillTool({
  workspaceId,
  // Resolution: action.skills (step) overrides job.skills, then falls
  // through to undefined (inherit workspace visibility).
  jobFilter: action.skills ?? jobSpec?.skills,
});
```

`jobSpec` has to be threaded in from the workspace runtime. Current
call site only has `action` and `context`. Needs:

1. `WorkspaceRuntime` passes the job spec into FSM engine execution
   context (probably on the `context.meta.jobSpec` path — audit
   needed).
2. `fsm-engine.ts` pulls `jobSpec.skills` out of the context when
   building each action.

**File: `packages/workspace/src/runtime.ts` — agent-based jobs**

Agent execution goes through a different path (not fsm-engine). Audit
where `createLoadSkillTool` is called for agent-based jobs — if
anywhere. Some agent runs go through `packages/core/src/agent-context`
which calls the tool at line 172. That caller already has access to
the job spec. Same fix pattern: read `jobSpec.skills`.

### Phase C — Resolved-skills visibility

The LLM sees an `<available_skills>` list in its prompt. Today it
shows all workspace-visible skills. After this lands, the list should
reflect the effective filter (`job.skills ∩ workspace.skills`,
plus `@friday/*`).

File: `packages/skills/src/resolve.ts` (the `resolveVisibleSkills`
helper). Add an optional `jobFilter: string[] | null` parameter; when
set, shrink the returned list to the filter.

Every caller that builds a prompt (conversation agent, workspace
agent, fsm-engine) needs to thread the filter through. This is the
riskiest piece — miss a caller and the LLM sees skills it can't
actually load.

### Phase D — Validation (parse-time)

**File: `packages/config/src/workspace.ts`** — `WorkspaceConfigSchema`'s
`refine()` block.

For each `jobs[j].skills[k]`, check the ref appears in
`workspace.skills[*]` (either as `{name: ref}` or matches a
`@global/` visibility rule). If not, emit a parse-time **warning**
(not an error) of the shape:
```
jobs.nightly-report.skills[0] references @foo/bar which isn't assigned
to the workspace. The job will not be able to load it.
```

Parse-time warnings already have a plumbing path — reuse it. Hard
error if the ref doesn't match `SkillRefSchema`.

### Phase E — UI

Two surfaces:

1. **Job detail page** (`/platform/:ws/jobs/:job` or wherever the job
   detail lives — verify the route). Add a **Skills** section:
   - Dropdown of all workspace-visible skills (assigned + global + the
     current job's existing skill list).
   - "No filter (inherit workspace)" default state.
   - Picker: multi-select with tier badges (green/blue), same
     component used in the workspace skills page.
   - Edits write to `workspace.yml` via the existing config mutation
     path.

2. **FSM step inspector** (`/platform/:ws/fsm` or wherever FSM state
   detail is shown). Same picker, but scoped to the action inside a
   state definition. Lower priority — most users author FSM in YAML.

Ship #1 first. #2 can be a follow-up.

### Phase F — Testing

- **Unit**: `createLoadSkillTool` with a `jobFilter` — already has tests.
- **Unit**: `resolveVisibleSkills` with `jobFilter` — new.
- **Parse**: workspace.yml with `jobs.*.skills` — new schema tests.
- **Integration**: run a job with a narrow filter; assert the LLM
  received an `<available_skills>` list matching the filter; assert
  `load_skill` refuses skills outside it.
- **QA plan entry**: extend `docs/testing/2026-04-20-skills-ui-qa-plan.v2.md`
  §3 with a "job skills picker" surface and §4 with a new chain 4.13
  (assign skill to job → run job → verify only that skill is usable).

## Phases / rollout

| # | Scope                                       | Estimate | Risk                                   |
| --- | ------------------------------------------- | -------- | -------------------------------------- |
| A | Schema fields (`jobs.*.skills` +            | 1 hr     | Low — additive, optional               |
|   | `action.skills` type upgrade)               |          |                                        |
| B | Engine wiring (pass `jobFilter` through)    | 2 hr     | **High** — easy to miss callers        |
| C | Resolved-skills prompt path (shrink         | 2 hr     | **High** — must stay consistent with B |
|   | `<available_skills>` under filter)          |          |                                        |
| D | Parse-time validation + warnings            | 1 hr     | Low                                    |
| E1| UI: job-detail skills picker                | 3 hr     | Med — new form component + mutation    |
| E2| UI: FSM step skills picker                  | 3 hr     | Med — low-usage path, defer            |
| F | Tests + QA chain 4.13                       | 1 hr     | Low                                    |

**Ship order:** A → B → C → D → F → E1 → E2. B and C must ship in the
same PR so the prompt stays consistent with the runtime filter.

## Open questions

1. **Does `workspace-runtime` call `createLoadSkillTool` for
   agent-based jobs, or is it only fsm-engine?** Need to audit. If
   agent-based jobs never hit that path, agent-based per-job scoping
   is a no-op until that runtime grows the call.
2. **Existing compiled workspaces in `docs/COMPREHENSIVE_FRIDAY_EXAMPLE.yml`
   don't set `jobs.*.skills`.** That's fine (optional), but worth
   documenting the new field in that example so it's discoverable.
3. **Does `resolveVisibleSkills` leak into the agent runtime?** If so,
   Phase C needs more surface area than expected.
4. **UI host route for #1.** `/platform/:ws/jobs/:job` may or may not
   exist as a detail page. If not, there's a prerequisite task:
   surface job details somewhere first.
5. **What about agent-level skills?** A workspace agent
   (`agents: { foo: … }`) isn't the same as a job — it's an agent
   definition. Should agents also gain a `skills` whitelist? Probably
   yes (same model), but out of scope for this plan; file as a
   follow-up.

## Out of scope

- Agent-level `skills` whitelist (see Q5).
- Per-skill *version pinning* at the job level (job says "only
  `@foo/bar@3`"). Today all loads hit latest version; versioning on
  assignment would cross cut this plan and the assignment schema.
- Workspace-level deny-list (opposite polarity — "everyone except these
  skills"). Users can express the equivalent via an explicit whitelist
  so it's not needed today.
- Runtime UI showing "this job would see these N skills" as a
  preview. Useful but not required for v1.
