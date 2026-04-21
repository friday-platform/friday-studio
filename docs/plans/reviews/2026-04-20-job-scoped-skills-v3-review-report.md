# Job-scoped skills — v3 Review Report

**Reviewed:** 2026-04-20
**Input:** `docs/plans/2026-04-20-job-scoped-skills.v3.md`
**Output:** `docs/plans/2026-04-20-job-scoped-skills.v4.md`
**Prior reviews:**
- `reviews/2026-04-20-job-scoped-skills-v1-review-report.md`
- `reviews/2026-04-20-job-scoped-skills-v2-review-report.md`

## TL;DR

v4 is a refinement of v3. The additive semantic model is settled and
unchanged. v4 fixes three code-contact gaps the v3 plan missed or
over-engineered, resolves two of v3's four open questions, and adds
two UI polish notes to Phase E.1.

## Context Gathered

- Read `packages/agent-sdk/src/types.ts:260` — `AgentSessionDataSchema`
  has `sessionId`, `workspaceId`, `workspaceName`, `userId`,
  `streamId`, `datetime`, `memoryContextKey`,
  `foregroundWorkspaceIds`. **No `jobName` field.** v3's plan assumed
  this existed ("sessionData.jobName"). Task #30 (MessageMetadata
  extensions) added `jobName` to message metadata — a different
  surface.
- Confirmed `packages/fsm-engine/fsm-engine.ts` references
  `this._definition.id` at 6 sites (lines 760, 908, 1037, 1678, 1698,
  1762) labeled `jobName` in the emitted events. The FSM engine
  already has the identifier as instance state — no need to thread
  through `SignalWithContext._context`.
- Read `apps/atlasd/routes/skills.ts:442-489` — existing scoping
  routes:
  - `GET /scoping/:skillId/assignments` → `{ workspaceIds }`
  - `POST /scoping/:skillId/assignments` body: `{ workspaceIds: string[] }`
  - `DELETE /scoping/:skillId/assignments/:workspaceId`
  Extending POST body with `{ assignments: [...] }` is cleaner than
  adding a new path.
- Checked `tools/agent-playground/src/routes/platform/[workspaceId]/jobs/`
  — only a `+page.svelte` (list page). **No `[jobName]` subdirectory.**
  v3 Open Q1 confirmed: detail route has to be stood up (Phase E.0 in
  v4, +1 h).
- Checked `packages/workspace/src/runtime.ts:1451` — `executeAgent`
  has `job.name` already in scope; needs to inject into sessionData
  upstream of orchestrator call. Confirms Phase C.5.

## Ideas Proposed (5)

### Accepted into v4

**1. `AgentSessionData` schema gap — new Phase A.3.**
v3's plan repeatedly referenced `sessionData.jobName` but the schema
doesn't have it. v4 adds Phase A.3: `jobName: z.string().optional()`
on `AgentSessionDataSchema`. Without this, the implementation would
hit a type error on first compile. 15-minute fix; would cost an hour
of confusion if missed.

**2. FSM engine uses `this._definition.id` directly — drop `_context`
threading.**
v3 proposed a new `SignalWithContext._context.jobName` field to pass
the job name into fsm-engine.ts:1171. Unnecessary: the engine already
has the identifier as `this._definition.id` (6 existing references).
v4 Phase C.4 shrinks to "one line reads the engine's own instance
state." Saves the threading + `_context` type change. Concretely
simpler, same functional result.

**3. Scoping-API body extension — resolves Open Q3.**
v3 listed the API shape as an open question. v4 answers: extend body
to `{ assignments: [{workspaceId, jobName?}] }`. Backend supports both
shapes during a transition window (detect `workspaceIds` vs
`assignments`). Delete endpoint adds an optional path segment:
`/:workspaceId/:jobName`. Clean, symmetric, avoids a second endpoint.

### Integrated as Phase E.1 implementation notes

**4. UI semantics for dual-assigned skills** (workspace + job level
rows both exist for the same skill). v4 Phase E.1 now specifies: show
a non-blocking warn ("This skill is already visible to all jobs. Are
you sure…?") when the user adds a job-specific assignment for a
skill that's already at workspace level. Allow it (DB accepts) but
flag as redundant.

**5. `@friday/*` implicit "always available" section in Job Skills
UI.** v4 Phase E.1 adds a "Always available" gray section listing the
bypass set (`@friday/authoring-skills`, `@friday/workspace-api`,
etc.). Closes a real "why does this skill show up?" debugging gap.
Read-only; hard-coded to `ref.startsWith("@friday/")` today.

### Rejected

None — all five ideas landed. 1-3 as structural, 4-5 as UI
implementation notes rather than their own phases (kept the phase
count sane).

## Other v3→v4 Adjustments

- **Added Phase E.0** to stand up the `/platform/:ws/jobs/:jobName`
  route (open Q1 resolved: doesn't exist today, ~1 h).
- **Shipped order tightened**: C.4 moves to 10 min (was 30 min in v3),
  C.5 is now a named phase (was implicit in v3's "context threading"),
  D.3 is new (the API body migration).
- **Total estimate up ~1 h** (14.5 vs 13.5) — E.0 adds 1 h, A.3 adds
  15 min, C.4 saves 20 min, D.3 adds 45 min. Net +1 h.
- **Open Q1 and Q3 closed**; Q2 (`@db/sqlite` NULL-in-PK) and Q4
  (transaction boundary) still open.

## Caveats & Tradeoffs

- **Scoping API body migration has a transition risk.** During the
  window when the backend accepts both `{ workspaceIds }` and
  `{ assignments }`, a client that sends both will surprise someone.
  Keep the detection strict: reject requests that set both fields.

- **Phase E.0 prerequisite** — the job-detail route is a separate
  feature, not really part of "job-scoped skills." Bundling them is
  pragmatic (one PR fits) but surfaces a dependency that didn't exist
  before. If the route is controversial, Phase E can ship as a CLI /
  YAML-only feature until UI lands.

- **`this._definition.id` assumption** — this is how the FSM engine
  emits events today. If FSM definitions ever have an id that
  doesn't match their job name in `workspace.yml` (unlikely but not
  structurally guaranteed), Phase C.4 would silently resolve the
  wrong layer. Worth a quick invariant check during implementation:
  where does `_definition.id` come from when built from `jobs.*.fsm`?

- **`@friday/*` hard-coded in Phase E.1** — the UI enumerates the
  bypass set. If the runtime bypass ever generalizes (e.g., multiple
  "always-visible" namespaces, or user-controlled), the UI logic has
  to grow with it. Low probability but flag it.

## Unresolved Questions (carried forward from v3)

2. **`@db/sqlite` NULL-in-PK behavior** — standard SQL distinct,
   specific binding unverified. Sanity test at A.1 implementation
   time; fall back to `COALESCE(job_name, '')` if the binding equates
   NULLs.
4. **Reconcile-on-save transaction boundary** — covered in Phase
   D.2 as "one SQLite transaction," but the reconcile path today
   might not already use transactions. Audit before implementation.

## Overlap with Prior Reviews

### v1 ideas (filter-model era)
- v1-1 (call-site audit 3→5): absorbed; v4 shows 2 live + 3 N/A
- v1-2 (`filterVisibleSkills` helper): obsolete after v3 pivot
- v1-3 (F.1 drift invariant): kept, adapted
- v1-4 (empty-filter UX marker): obsolete after v3 pivot
- v1-5 (split Phase B into LLM / agent): baked into v3/v4's phase layout

### v2 ideas
- v2-A (field-shape mismatch): documented in v3/v4
- v2-B (debug UX for blocked loads): deferred; not applicable in
  additive model without an equivalent "not in scope" event
- v2-C (F.1 inline fixtures): adopted
- v2-D (runtime backstop warning): adopted as Phase D.1's warning
- v2-E (workspace/job outer/inner framing): superseded by v3 pivot

### v3 ideas (this pass)
All five landed (three structural, two UI notes).

## Implementation Note for v4

Revised natural ordering with new phases:

1. **PR #1 — "Schema stubs"**: A.1 + A.2 + A.3. Landing these alone
   changes nothing at runtime (no caller reads the new fields/rows).
   Pure additive; safe to ship.
2. **PR #2 — "Job-level lands"**: B + C.1 through C.5 + F.1 + F.2.
   This is where behavior actually changes. F.1 in the same PR locks
   the prompt-vs-tool invariant.
3. **PR #3 — "YAML reconcile + scoping API"**: D.1 + D.2 + D.3.
   Agents can now drive the workflow from CLI / YAML.
4. **PR #4 — "UI"**: E.0 + E.1 + E.2 + F.3. Last because UI
   consumes the now-stable API.

Writing F.1 first as a TDD scaffold (passes trivially before C.1
lands, fails as soon as job-level rows exist but C.1 isn't wired)
would help catch a regression in PR #2's bounds.
