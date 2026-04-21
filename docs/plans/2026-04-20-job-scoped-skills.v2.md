<!-- v2 - 2026-04-20 - Generated via /improving-plans from docs/plans/2026-04-20-job-scoped-skills.md -->

# Job-scoped skills

**Status:** draft · **Owner:** TBD · **Date:** 2026-04-20
**Depends on:** skills subsystem landed on `declaw` (41 commits ending `e2714783fe`).

## Goal

Let a user restrict which skills are loadable by an individual **job**
(and, inside FSM-based jobs, by an individual **step**). Today all jobs
in a workspace see every workspace-assigned skill; there's no way to
say "this nightly-report job should only use `@anthropics-skills/pdf`
and `@tempest/report-format`, not the other 12 skills on the workspace."

**v2 changes (review pass):** split Phase B into LLM-action vs
agent-action wirings (different runtime paths); expanded Phase C into
an explicit 5-caller audit table; swapped "add `jobFilter` to
`resolveVisibleSkills`" for a single-responsibility `filterVisibleSkills`
helper at the call sites; added Phase F.1 drift-invariant test;
promoted empty-filter prompt UX to an Open Question.

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

### Phase B — Engine wiring (split)

Two runtime paths, independently wired. Both must land together so
the same `skills: […]` field in YAML behaves consistently whether the
job is FSM-based or agent-based.

#### B.1 — LLM actions (FSM path)

**File: `packages/fsm-engine/fsm-engine.ts:1192`**

Replace:
```ts
const { tool: loadSkill, cleanup } = createLoadSkillTool({ workspaceId });
```

With:
```ts
// Resolution: action.skills (step) overrides job.skills, then falls
// through to undefined (inherit workspace visibility).
const jobFilter = action.skills ?? jobSpec?.skills;
const { tool: loadSkill, cleanup } = createLoadSkillTool({
  workspaceId,
  jobFilter,
});
```

`action.skills` is already in scope at line 1192 because `action` is the
`LLMActionSchema` instance being executed. **`jobSpec` is not** —
FSM context (`sig._context`) doesn't today include the job spec. Two
options:

- **Thread `jobSpec` into `FSMContext`.** `WorkspaceRuntime.runFSMJob`
  already has the spec; it builds the context and passes to fsm-engine.
  Add `jobSpec?: JobSpecification` to the context type.
- **Skip job-level for FSM path in v1.** Only step-level (action.skills)
  works for FSM jobs. Agent jobs get job-level only. Simpler, punts the
  combined case.

**Decision: thread the spec.** Mixing step + job semantics in one
runtime is cleaner than branching on job type. ~30 min of threading.

Cost: ~2h total (2-line change + spec threading + one new test).
Risk: medium — missing the combined case would silently disable
job-level filters for FSM jobs.

#### B.2 — Agent actions

Agent actions go through `packages/core/src/agent-context/index.ts:172`,
NOT `fsm-engine.ts`. The tool there is built off `sessionData`, which
doesn't today carry the FSM action's per-step fields.

**Files touched:**
- `packages/workspace/src/runtime.ts` — when dispatching an agent
  action, pass the action's `skills` down into the agent runner's
  session data (new field `sessionData.jobFilter?: string[]`).
- `packages/core/src/agent-context/index.ts:172` — read
  `sessionData.jobFilter`, pass as `createLoadSkillTool({ workspaceId,
  jobFilter })`.

Cost: ~2h. Risk: higher than B.1 because the threading crosses three
packages.

### Phase C — `<available_skills>` prompt path

The LLM sees an `<available_skills>` list in its prompt. It must
match exactly what `load_skill` will accept — otherwise the agent
sees ghosts or has its matches silently blocked.

**Approach:** don't add a `jobFilter` parameter to
`resolveVisibleSkills` (would explode across 5 callers with different
job-context shapes). Instead, add one pure helper and apply it at each
call site:

**New helper: `packages/skills/src/resolve.ts`**
```ts
export function filterVisibleSkills(
  skills: SkillSummary[],
  jobFilter: readonly string[] | null | undefined,
): SkillSummary[] {
  if (!jobFilter) return skills; // null / undefined → no filter
  const set = new Set(jobFilter);
  return skills.filter((s) => {
    const ref = `@${s.namespace}/${s.name}`;
    // Same bypass policy as createLoadSkillTool — @friday/* always visible.
    return ref.startsWith("@friday/") || set.has(ref);
  });
}
```

**Call-site audit — each must apply the filter:**

| # | File:line                                                                        | How it gets the filter today                               |
| - | -------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1 | `packages/core/src/agent-context/index.ts:106,178`                               | `sessionData.jobFilter` (B.2 threads it in)                |
| 2 | `packages/system/agents/workspace-chat/compose-context.ts:41`                    | no current job context — confirm if this path sees one     |
| 3 | `packages/system/agents/workspace-chat/workspace-chat.agent.ts:510`              | `sessionData.jobFilter`                                    |
| 4 | `packages/system/agents/conversation/conversation.agent.ts:727`                  | no current job context — global conversation, probably N/A |
| 5 | `packages/fsm-engine/fsm-engine.ts:1171`                                         | `action.skills ?? jobSpec?.skills` (B.1 provides this)     |

Each site applies `filterVisibleSkills(resolveVisibleSkills(...), jobFilter)`
before passing to `formatAvailableSkills`. Call-site #2 and #4 may
turn out to need no filter (workspace-chat compose-context runs outside
a job; conversation is user-scoped, not job-scoped) — verify during
implementation and document.

Cost: ~4h (1 helper + 5 call-site changes + per-site tests).
Risk: **high** — one missed site and the LLM sees a list that doesn't
match what the tool allows. The Phase F.1 invariant test exists to
guard this.

### Phase D — Parse-time validation

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

#### F.1 — Drift invariant (new)

**What it catches:** any future call site that builds
`<available_skills>` but forgets to apply the filter, or vice versa.

**Test (one, deterministic):**
```ts
// packages/skills/src/filter-visible.test.ts
test.each([
  { filter: null, expect: "all visible" },
  { filter: [], expect: "@friday/* only" },
  { filter: ["@tempest/foo"], expect: "tempest/foo + @friday/*" },
])("prompt ⊆ tool allows: $expect", async ({ filter }) => {
  const skills = makeFixtureSkills();                     // mixed namespaces
  const shown = filterVisibleSkills(skills, filter);
  const { tool } = createLoadSkillTool({ workspaceId: "w", jobFilter: filter });
  for (const s of shown) {
    const ref = `@${s.namespace}/${s.name}`;
    const res = await tool.execute({ name: ref, reason: "probe" });
    expect(res).not.toHaveProperty("error"); // every shown skill must be loadable
  }
  // and the reverse: anything not in `shown` that's in the full list must be rejected
  const hidden = skills.filter((s) => !shown.includes(s));
  for (const s of hidden) {
    const ref = `@${s.namespace}/${s.name}`;
    if (ref.startsWith("@friday/")) continue; // allowlisted by design
    const res = await tool.execute({ name: ref, reason: "probe" });
    expect(res).toHaveProperty("error");
  }
});
```

This test stays useful forever: every time someone touches the filter
path, they can't accidentally desync the two sides.

#### F.2 — Unit / integration (original Phase F)

- `createLoadSkillTool` with a `jobFilter` — already has tests.
- `filterVisibleSkills` with empty / null / populated filter — new.
- Parse: workspace.yml with `jobs.*.skills` + invalid ref — new.
- Integration: run a job with narrow filter; assert LLM received an
  `<available_skills>` list matching the filter; assert `load_skill`
  refuses skills outside it.

#### F.3 — QA plan entry

Extend `docs/testing/2026-04-20-skills-ui-qa-plan.v2.md`:
- §3 "Job skills picker" surface (UI smoke).
- §4 new chain 4.13 — assign skill to job → run job → verify only
  that skill is usable.

## Phases / rollout

| #   | Scope                                                        | Estimate | Risk   | Notes                                                |
| --- | ------------------------------------------------------------ | -------- | ------ | ---------------------------------------------------- |
| A   | Schema (`jobs.*.skills` + tighten `action.skills` type)      | 1 h      | Low    | Additive, optional field                             |
| B.1 | LLM-action wiring (fsm-engine, thread jobSpec into context)  | 2 h      | Med    | 2-line change + spec threading                       |
| B.2 | Agent-action wiring (agent-context + workspace-runtime)      | 2 h      | Med-hi | Cross-package threading                              |
| C   | `filterVisibleSkills` helper + 5 call-site audit             | 4 h      | **Hi** | Must stay in sync with B                             |
| D   | Parse-time validation + warning for unassigned refs          | 1 h      | Low    |                                                      |
| E1  | UI: job-detail skills picker                                 | 3 h      | Med    | Reuse tier-badge + autocomplete                      |
| E2  | UI: FSM step skills picker                                   | 3 h      | Med    | Low-usage; defer                                     |
| F.1 | Drift invariant test                                         | 1 h      | Low    | Permanent guardrail                                  |
| F.2 | Unit + integration tests                                     | 1 h      | Low    |                                                      |
| F.3 | QA-plan entry (chain 4.13)                                   | 30 min   | Low    |                                                      |

**Ship order:** A → B.1+B.2+C (one PR — these are a coherent unit;
shipping any subset breaks the prompt↔tool invariant) → D → F.1 → F.2
→ F.3 → E1 → E2.

**Total v1 scope (everything except E2):** ~15 h. Feasible as a
single day-and-a-half push.

## Open questions

1. **Does `workspace-runtime` call `createLoadSkillTool` for
   agent-based jobs, or is it only fsm-engine?** Audit confirmed
   agent-based jobs route through
   `packages/core/src/agent-context/index.ts`, which already calls the
   tool at line 172. Phase B.2 threads the filter there. ✅

2. **Existing compiled workspaces in `docs/COMPREHENSIVE_FRIDAY_EXAMPLE.yml`
   don't set `jobs.*.skills`.** That's fine (optional), but worth
   documenting the new field in that example so it's discoverable.

3. **Does `resolveVisibleSkills` leak into the agent runtime?** Yes —
   5 call sites enumerated in Phase C. v2's plan applies
   `filterVisibleSkills` at each.

4. **UI host route for #E1.** `/platform/:ws/jobs/:job` may or may not
   exist as a detail page. If not, there's a prerequisite task:
   surface job details somewhere first. **Action: verify before
   starting Phase E1.**

5. **What about agent-level skills?** A workspace agent
   (`agents: { foo: … }`) isn't the same as a job — it's an agent
   definition. Should agents also gain a `skills` whitelist? Probably
   yes (same model), but out of scope for this plan; file as a
   follow-up.

6. **Empty-filter prompt UX.** When `jobFilter: []`, the LLM gets an
   `<available_skills>` block containing only `@friday/*` entries.
   Today that's silent — the model may infer "no skills needed."
   Should we inject a `<!-- filtered: no workspace skills for this
   step -->` marker? Or is the empty-looking block enough signal
   given the model already sees the filtered tool description? Punt
   to implementation: try without the marker first, add if evals show
   drift.

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
