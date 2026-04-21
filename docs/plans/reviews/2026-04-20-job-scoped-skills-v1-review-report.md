# Job-scoped skills — v1 Review Report

**Reviewed:** 2026-04-20
**Input:** `docs/plans/2026-04-20-job-scoped-skills.md`
**Output:** `docs/plans/2026-04-20-job-scoped-skills.v2.md`
**Prior reviews:** none (v1 was the first pass)

## Context Gathered

- Verified that the three disjoint pieces v1 identified are indeed
  disjoint: `createLoadSkillTool(jobFilter)` accepts the param,
  `LLMActionSchema`/`AgentActionSchema` have `skills` fields, but
  `fsm-engine.ts:1192` only passes `workspaceId`. Task #37 "Phase 7:
  Job-level scoping in fsm-engine" is marked completed but landed only
  the schema half.
- Enumerated callers of `resolveVisibleSkills` + `formatAvailableSkills`:
  five sites across four packages (`@atlas/core`, `@atlas/skills`,
  `@atlas/fsm-engine`, system agents). v1 mentioned three; the missing
  two are `workspace-chat/compose-context.ts:41` and the shared
  `core/agent-context/index.ts:106,178`.
- Read the v4 ancestor plan
  (`docs/plans/2026-04-20-skills-scoping-and-inspector.v4.md`) — Phase 7
  section lays out semantics that match v1's proposal. The semantics in
  v1 are correct; the gap was only in the implementation-path audit.
- Confirmed `workspace/src/runtime.ts` does **not** call
  `createLoadSkillTool`. Agent-based jobs run through
  `packages/core/src/agent-context/index.ts:172`, which reads from
  `sessionData`.
- Verified `WorkspaceAgentConfigSchema` has no `skills` field — agent-
  level scoping is a separate concern (noted in v1 open Q5, unchanged
  in v2).

## Ideas Proposed (5)

All proposed as net-new; none retread v1.

### Accepted (integrated into v2)

**1. Call-site audit undercounts.** v1 named three; ripgrep finds five.
v2's Phase C now has a 5-row `<file:line>` audit table + a per-site
note on how each site can obtain the job filter (B.1 provides it for
fsm-engine; B.2 threads through `sessionData.jobFilter` for agent paths;
two sites — workspace-chat compose-context and conversation agent —
may not need a filter at all, to be confirmed at implementation time).
Estimate bumped from 2h → 4h.

**2. `filterVisibleSkills` pure helper vs parameter-explosion on
`resolveVisibleSkills`.** v1 proposed adding a `jobFilter` param to the
resolver. v2 adds a separate pure `filterVisibleSkills(skills,
jobFilter)` helper instead. Keeps the resolver a leaf; isolates filter
logic to one place; easier to unit-test. Also matches the shape of the
existing `createLoadSkillTool` filter — both read from the same helper
shape so there's one definition of "what @friday/* means" and one
definition of "what empty array means."

**3. Drift invariant test (new Phase F.1).** The scariest failure mode
is `<available_skills>` ⇄ `createLoadSkillTool` desync: the model sees
skill X that the tool rejects, or vice versa. v2 adds F.1 as a
permanent property test that runs fixture filters through both sides
and asserts they agree. Catches any future caller that adds a new path
and forgets one side.

**5. Split Phase B into LLM-action vs agent-action wirings.** v1
treated them as parallel; they aren't. LLM actions have `action` in
scope at fsm-engine:1192 (easy). Agent actions flow through
`packages/core/src/agent-context/index.ts:172` with only `sessionData` —
FSM action fields aren't propagated. v2 splits B into B.1 (fsm-engine,
easy) and B.2 (agent-context via workspace-runtime, harder,
cross-package). Both must land in the same PR because they share the
same YAML field.

### Deferred to Open Question (not a doc change)

**4. Empty-filter prompt UX signal.** When `jobFilter: []`, the model
sees an empty `<available_skills>` block. v1 didn't mention this;
possibility of the model inferring "no skills needed." v2 adds this as
Open Q6 with a "try without; evals will tell us" stance — a code change
today would be prompt-engineering on a hunch. Flagged so we remember
to watch eval output after the feature ships.

### Rejected

None of the 5 ideas was fully rejected. #4 was demoted to an open
question rather than being baked in.

## Other v1→v2 Adjustments

- **Ship order tightened.** v1 said "A → B → C → …". v2 groups B.1 +
  B.2 + C into a single PR because shipping any subset breaks the
  `<available_skills>` ⇄ tool invariant. Phase F.1 immediately after
  that PR gives a permanent drift guard.
- **Total estimate.** v1 didn't sum; v2 totals ~15h for everything
  except E2.
- **Q1 in Open Questions moved to ✅** — agent-based jobs do route
  through `core/agent-context`. Confirmed during review.

## Caveats & Tradeoffs

- **`filterVisibleSkills` is a thin wrapper, but the wrapper matters.**
  Each call site that needs to filter is ~3 lines of boilerplate with
  the helper, vs 1 line of hidden behavior if we'd added the param to
  `resolveVisibleSkills`. The explicitness is worth the line count —
  each site has different logic for *how to obtain* the filter, so
  surfacing the call makes the threading auditable.

- **Phase B+C coupling risk.** The plan calls this out multiple times
  but doesn't build a hard gate. If someone ships B without C (or part
  of C), the LLM sees skills it can't load. The F.1 invariant test
  catches it in CI, not at review time — so a B-without-F.1 PR is
  risky. Open question whether F.1 should be written **first** (TDD
  style) so B's merge requires it to stay green.

- **`workspace-chat/compose-context.ts:41` and `conversation.agent.ts:727`
  may not need filtering.** Plan flags these as "confirm at
  implementation." Fine, but adds uncertainty to the estimate. Worth a
  10-min prebuild audit: trace who calls these and whether they're
  ever in a job-scoped context.

## Unresolved Questions

1. **Should we write F.1 before B, as a TDD gate?** v2 puts F.1 after
   the B+C PR. Rearguing: writing F.1 first would let us assert the
   invariant fails today (it does — tool rejects refs the prompt shows)
   and use that failure to drive B+C. But F.1 depends on
   `filterVisibleSkills` existing, which is part of C. Circular.
   Compromise: write F.1's skeleton with a `.skip` in the same PR as
   Phase A, flip it to live in the B+C PR.

2. **Does `conversation.agent.ts` ever run in a job context?** The
   conversation agent is user-scoped (the chat model), not job-scoped.
   Pretty sure the answer is "no filter needed" but this should be
   confirmed before Phase C starts — saves one call-site change.

3. **What about `@friday/workspace-api`?** If a job filters to
   `["@tempest/foo"]`, `@friday/workspace-api` is still visible
   (always-available bypass). But if the intent is "this job should
   only see @tempest/foo," that includes blocking workspace-api.
   Today's semantics don't support that, and adding it would be a
   breaking change to the `@friday/*` bypass. Document but don't
   change.

4. **`jobSpec` threading cost is estimated at 30 min.** That could be
   wrong — depends on how many places the FSM context is constructed.
   If the threading turns out to cross more than one function boundary,
   Phase B.1 could double in cost.

## Overlap with Prior Reviews

None — this is v1 of this plan. The v4 ancestor at
`docs/plans/2026-04-20-skills-scoping-and-inspector.v4.md` covered the
same territory in broader scope but already shipped (with gaps — this
plan exists to close them).
