# `decompose-plan` — Kernel Job Design

**Date:** 2026-04-15
**Status:** Draft (design for review)
**Branch:** `declaw`
**Companion to:** `2026-04-13-openclaw-parity-plan.md`, `2026-04-13-friday-dev-walkthrough.md`, `2026-04-13-personal-assistant-walkthrough.md`
**Skill reference:** `.claude/skills/creating-tasks/SKILL.md`, `.claude/skills/implementing-tasks/SKILL.md`, `.claude/skills/fast-self-modification/SKILL.md`

---

## Problem Statement

Friday engineers write detailed plans in `docs/plans/` — design docs, phase breakdowns, walkthroughs. To turn any one of those plans into kernel-executed work, an engineer currently has to:

1. Hand-author every task in the shape the `autopilot-backlog` expects (`task_id`, `priority`, `blocked_by`, `target_workspace_id`, `target_signal_id`, `payload`).
2. Manually identify the tracer bullet, wire the dependency graph, and verify each task is bite-sized enough to fit one `fast-improvements-source` session.
3. POST each task individually to the kernel's backlog corpus.

This is tedious, error-prone, and doesn't compose with the autopilot loop that now runs every two minutes. A 20-task phase breakdown can take 45+ minutes to transcribe by hand, during which the operator is blocked and the autopilot is idle.

## Solution

A new HTTP signal `decompose-plan` on the `fast-loop` kernel workspace that:

1. Accepts a pointer to a plan document, a scope slice, a default target (workspace + signal), and an optional `dry_run` flag.
2. Runs a small FSM that reads the plan, calls a claude-code agent to produce a structured task batch, verifies structural integrity, and appends each task directly to `autopilot-backlog`.
3. Returns silently on success. Surfaces a diagnostic task via the existing discovery-task flow on genuine failure (two retries exhausted).

From the operator's perspective: write a plan, fire one signal, autopilot drains the batch over minutes-to-hours. No approval gate. No staging. The self-reinforcement ladder (`reflect-on-last-run`, `cross-session-reflect`) already running on the kernel observes decomposition outcomes and proposes decomposer prompt updates over time.

## User Stories

1. As a Friday engineer, I want to turn a design doc into a backlog of bite-sized tasks with one signal, so that the autopilot loop can execute the plan while I work on something else.
2. As a Friday engineer, I want each decomposed task to fit one `fast-improvements-source` session, so that the coder doesn't run out of context mid-implementation.
3. As a Friday engineer, I want the decomposer to identify a tracer bullet and order the batch by dependencies, so that the tracer runs first and proves the approach before the rest dispatch.
4. As a Friday engineer, I want structural integrity checks on the proposed batch before it lands in the backlog, so that cyclic dependencies and missing starting points don't poison the task queue.
5. As a Friday engineer, I want decomposition failures surfaced as discovery tasks in Studio inbox, so that I know when a plan genuinely doesn't decompose well without having to poll for status.
6. As a Friday engineer, I want each task to reference its plan section, so that a downstream coder or reviewer can read the source plan directly for context.
7. As a Friday engineer, I want `dry_run` mode, so that CI or a chat agent can preview a decomposition's output without committing state to the backlog.
8. As a Friday engineer, I want the decomposer to route tasks to different kernel signals when appropriate (`author-agent` for new agents, `extend-workspace` for new signals, `run-task` on `fast-improvements-source` for source mods), so that one plan can span the kernel's full action surface.
9. As the cross-session-reflector, I want decomposition batches to be observable as a cohort via `batch_id`, so that I can detect patterns across applied batches and propose decomposer prompt updates.
10. As the autopilot-planner, I want decomposed tasks to carry valid `blocked_by` lists that already work with my existing dependency filter, so that no planner changes are required.
11. As a Friday engineer, I want integrity-rule violations to trigger a single automatic retry with findings as feedback, so that minor decomposer mistakes self-correct without operator intervention.
12. As a Friday engineer building this feature, I want to bootstrap the first task set via the existing `creating-tasks` skill in chat and dispatch those tasks through `fast-improvements-source`, so that the build process validates the pipeline the feature will later populate.

## Implementation Decisions

### Modules built or modified

- **`workspaces/fast-loop/workspace.yml`** — add the `decompose-plan` HTTP signal, a `decompose-plan` job with its FSM, and a new agent definition `plan-decomposer` (type: `atlas`, agent: `claude-code`, workDir pointing at the atlas repo root so the decomposer can read plans and grep the codebase to verify starting points).
- **`workspaces/fast-loop/jobs/decompose-plan/job.ts`** (new) — exports the FSM code actions: `prepare_decompose`, `retry_decompose`, `apply_to_backlog`, `emit_diagnostic_task`, plus the guards `guard_integrity_clean`, `guard_retry_allowed`.
- **`workspaces/fast-loop/jobs/decompose-plan/integrity.ts`** (new) — pure function `checkIntegrity(batch: DecomposerResult): IntegrityFinding[]`. No LLM, no I/O beyond filesystem `existsSync` for target-file resolution. Unit-testable in isolation.
- **`packages/memory/src/discovery-to-task.ts`** (extend) — reuse the existing `appendDiscoveryAsTask` helper for the diagnostic failure case. No new helper needed; `apply_to_backlog` can POST directly to the backlog corpus endpoint in a loop.

### FSM shape

```
decompose-plan-pipeline
  idle
    entry: cleanup
    on: decompose-plan → prepare
  prepare
    entry: prepare_decompose (code)
    on: ADVANCE → decompose
  decompose
    entry: plan-decomposer agent (claude-code)
    outputTo: decomposer-output
    outputType: decomposer-result
    on: ADVANCE → integrity
  integrity
    entry: integrity_check (code)
    on:
      ADVANCE (guard_integrity_clean) → apply
      RETRY    (guard_retry_allowed)  → retry_prepare
      FAIL                             → diagnostic
  retry_prepare
    entry: retry_decompose (code, bumps counter, serializes findings into context)
    on: ADVANCE → decompose
  apply
    entry: apply_to_backlog (code)
    type: final
  diagnostic
    entry: emit_diagnostic_task (code)
    type: final
```

Retry cap: 1 (so at most 2 decompose attempts total). Guards enforce it via `context.results['retry-counter']`.

### Data contracts

**Signal payload (Zod):**

```ts
const DecomposePlanSignalSchema = z.object({
  plan_path: z.string(),
  scope: z.string().optional(),
  default_target: z.object({
    workspace_id: z.string(),
    signal_id: z.string(),
  }),
  dry_run: z.boolean().optional(),
});
```

**Decomposer output (`decomposer-result` document type):**

```ts
const ProposedTaskSchema = z.object({
  task_id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  subject: z.string().min(1),
  task_brief: z.string().min(1),         // full markdown per SKILL.md template
  target_files: z.array(z.string()),
  blocked_by: z.array(z.string()),
  priority: z.number().int(),
  is_tracer: z.boolean(),
  target_workspace_id: z.string().optional(),
  target_signal_id: z.string().optional(),
  plan_section: z.string().optional(),   // e.g. "Phase 2 § Scaffolding"
});

const DecomposerResultSchema = z.object({
  batch_id: z.string(),                  // dp-<plan-basename>-<timestamp>-<short-sha>
  plan_ref: z.object({
    path: z.string(),
    scope: z.string().optional(),
    sha: z.string(),                     // git SHA of plan file, or content sha256 if uncommitted
  }),
  default_target: z.object({
    workspace_id: z.string(),
    signal_id: z.string(),
  }),
  tasks: z.array(ProposedTaskSchema).min(1),
});
```

**Integrity findings:**

```ts
type IntegrityFinding = {
  rule: "no_cycles"
      | "blocked_by_resolves"
      | "non_empty_content"
      | "tracer_discipline"
      | "target_files_resolve";
  severity: "BLOCK";                     // all integrity failures block
  task_id?: string;
  detail: string;
};
```

All integrity failures are `BLOCK` in MVP — the retry loop tries once, then diagnoses out if still failing.

### Integrity rules (5)

1. **`no_cycles`** — topological sort on `blocked_by` must succeed.
2. **`blocked_by_resolves`** — every `blocked_by` entry matches a `task_id` in the batch.
3. **`non_empty_content`** — each task's `subject` and `task_brief` are non-empty, and `task_brief` contains the markdown headers `## Acceptance Criteria` and `## Starting Points` with non-empty content beneath each.
4. **`tracer_discipline`** — for multi-task batches, exactly one task has `is_tracer: true`, its `subject` starts with `Tracer Bullet:`, and its `blocked_by` is empty. For single-task batches, no tracer is required.
5. **`target_files_resolve`** — each `target_files` path either resolves on disk (relative to the atlas repo root) or appears in another task's `target_files` with a `(to-create)` marker in that task's `task_brief`.

### Autopilot-backlog entry shape (per task)

The `apply_to_backlog` step POSTs one entry per proposed task:

```ts
{
  id: task.task_id,
  text: task.subject,
  metadata: {
    status: "pending",
    priority: task.priority,
    kind: task.is_tracer ? "tracer-bullet" : "decomposed-task",
    blocked_by: task.blocked_by,
    match_job_name: "execute-task",       // fast-improvements-source default
    auto_apply: true,
    discovered_by: "decompose-plan",
    discovered_session: sessionId,
    batch_id: batch.batch_id,              // NEW field for reflector grouping
    plan_ref: {                            // NEW field
      path: batch.plan_ref.path,
      section: task.plan_section,
      sha: batch.plan_ref.sha,
    },
    payload: {
      workspace_id: task.target_workspace_id ?? batch.default_target.workspace_id,
      signal_id:    task.target_signal_id    ?? batch.default_target.signal_id,
      task_id: task.task_id,
      task_brief: task.task_brief,
      target_files: task.target_files,
    }
  }
}
```

`batch_id` and `plan_ref` are new fields in the task metadata — additive, so existing consumers (planner, status-watcher, post-session-validator) ignore them cleanly.

### `dry_run` semantics

When `dry_run: true`:
- FSM runs through `prepare` → `decompose` → `integrity` as normal.
- `apply` step records the batch to a `dry-run-decompositions` narrative corpus on `thick_endive` instead of POSTing to `autopilot-backlog`.
- Operator can inspect the staged batch via the Studio memory viewer.
- `dry-run-decompositions` entries auto-expire (TTL-tagged) after 24 hours — they're previews, not long-term state.

### Decomposer prompt (sketch)

The `plan-decomposer` agent prompt includes:
- Workflow: read the plan at `plan_ref.path`, slice to `scope` if provided, identify abstractions/files mentioned, propose a tracer bullet, decompose the rest into dependent tasks.
- Reference to `.claude/skills/creating-tasks/SKILL.md` for task shape and cross-task integrity discipline.
- Reference to `.claude/skills/implementing-tasks/SKILL.md` for the single-teammate-per-task sizing discipline.
- Routing guidance: use `default_target` unless the task content clearly belongs elsewhere (e.g. "add a new Python WASM agent" → `author-agent`; "add a cron signal" → `extend-workspace`). When overriding, include a brief rationale in the task_brief's `## Routing Rationale` section.
- Hard rule: respond with a single JSON object matching `DecomposerResultSchema`. No prose.

The prompt defers to skills rather than duplicating their content, so improvements to `creating-tasks` propagate without a workspace.yml change.

### Module Boundaries

**`plan-decomposer` agent (claude-code).**
- Interface: Zod-typed JSON output matching `DecomposerResultSchema`.
- Hides: plan parsing, codebase exploration, tracer identification, markdown `task_brief` authoring, routing judgment per task.
- Trust contract: the consumer can rely on schema validity (the FSM enforces it); content validity (the actual correctness of the decomposition) is the next module's job.

**`integrity_check` module.**
- Interface: `checkIntegrity(batch: DecomposerResult): IntegrityFinding[]`.
- Hides: graph traversal for cycles, `blocked_by` resolution, markdown section presence via regex, filesystem path verification.
- Trust contract: empty findings array means safe to apply to backlog. Non-empty means the FSM must either retry or diagnose out.

**`apply_to_backlog` step.**
- Interface: `applyBatch(batch: DecomposerResult): Promise<{ applied_task_ids: string[] }>`.
- Hides: conversion from `DecomposerResult` to autopilot-backlog POST payloads, injection of `batch_id` and `plan_ref` metadata, per-task POST sequencing.
- Trust contract: every task in the batch becomes exactly one entry in `autopilot-backlog` with consistent metadata. Partial-apply failures propagate as FSM errors (not caught mid-loop).

### Data Isolation

No user-scoped database tables touched. `autopilot-backlog` and `dry-run-decompositions` are workspace-scoped narrative corpora on `thick_endive`. No RLS implications.

## Testing Decisions

A good test for this feature verifies **external behavior**: given a plan file + signal payload, does the expected batch land in autopilot-backlog (or the dry-run corpus) with correct metadata and structural integrity?

Tests that verify LLM output quality are out of scope — the decomposer is a claude-code agent whose behavior is shaped by skills and the reinforcement loop, not by unit tests.

**Modules tested:**

- **`integrity.ts`** — unit tests with fixture batches covering each rule: valid batch, cyclic `blocked_by`, dangling `blocked_by` reference, empty AC section in `task_brief`, no tracer in multi-task batch, multiple tracers, `target_files` path that doesn't exist. Follow the style of `packages/memory/src/discovery-to-task.test.ts` — pure function, fixture-in-fixture-out.
- **`job.ts` code actions** — unit tests for `prepare_decompose` (hashing, scope extraction), `retry_decompose` (counter increment, findings serialization), `apply_to_backlog` (POST payload shape). Mock the HTTP client; verify the payloads constructed. Prior art: `workspaces/fast-loop/jobs/post-session-validator/job.test.ts`.
- **FSM integration** — use the `@atlas/fsm-engine` test harness with a mocked `plan-decomposer` agent (returns a pre-canned valid batch, then a pre-canned invalid batch on the retry path) to verify state transitions and guards fire correctly. Prior art: `packages/fsm-engine/src/engine.test.ts`.
- **E2E** — one smoke test that dispatches `decompose-plan` against a fixture plan file (`test/fixtures/trivial-plan.md`), stubs the claude-code agent with a deterministic mock, asserts the tasks land in an in-memory backlog double with correct metadata.

**Not tested:**

- The claude-code decomposer's actual LLM behavior — testing it means burning tokens for flaky assertions or mocking to the point of uselessness. The data contract + integrity checker is the guardrail; quality improves via the reflector loop observing real batches over time.
- Integration with real `autopilot-backlog` HTTP — covered by existing memory adapter tests.

## Out of Scope

- **Approval / staging flow.** Considered (batch-as-unit with `apply-decomposition` / `reject-decomposition` signals), rejected in favor of the simpler autonomous design. Can be revisited if the reflector surfaces patterns the integrity checker can't catch.
- **Per-task approval within a batch.** The `blocked_by` graph surgery is a tarpit; if partial approval is ever needed, re-decompose with a narrower scope.
- **Size-budget enforcement** (file count, AC count, weight bands). Considered and rejected as over-engineered predictive-engineering. The reflector catches oversized tasks via downstream coder/reviewer failure and proposes decomposer prompt updates.
- **Iterative "reject batch, retry with feedback" loop** beyond the 1-retry in-FSM. If data shows genuinely hard plans need multi-round iteration, revisit as a follow-up.
- **Plan-embedded routing markers** (YAML frontmatter or inline HTML comments in plan files). Architecturally clean but requires changing authoring conventions across every existing plan. Deferred.
- **Chat-tool wrapper.** The signal is the primary surface. A chat tool that fires the signal can be added later as a thin wrapper without affecting this design.
- **CLI wrapper** (`atlas decompose-plan docs/plans/foo.md --default-target=...`). Same as above — thin wrapper over the HTTP signal, can land later.
- **Studio UI** for viewing applied batches. Uses the existing `autopilot-backlog` viewer; `batch_id` surfacing in the UI is a separate Studio-track task.
- **Cross-batch semantic de-duplication.** If two plans decompose to overlapping tasks (same `target_files`, similar briefs), they both land. The planner's existing per-`task_id` cooldown handles accidental same-id duplication; broader semantic overlap is out of scope.

## Further Notes

### Bootstrapping (dogfood via Tier 6)

The feature doesn't exist yet, so the first task batch to build it must be produced another way. The build sequence:

1. **Write this design doc** (you're reading it).
2. **Use `creating-tasks` in chat** against this doc to generate the initial task batch. Each task goes through the existing SKILL.md template; the chat session IS the "first decomposer."
3. **Dispatch each task via `fast-improvements-source/run-task`** one at a time, monitoring via the Studio Job Inspector and `autopilot-backlog` viewer. Architect → coder → reviewer runs per task. The existing Tier 6 pipeline IS the build mechanism.
4. **Once the feature ships**, validate it by firing `decompose-plan` against a phase of the parity plan that hasn't been implemented yet (e.g. Phase 2 scaffolding) with `dry_run: true` first, then a real run. Watch the autopilot drain the batch.

This closes the self-reinforcement loop: Tier 6 (fast-improvements-source) builds the feature that produces Tier 6 workloads autonomously. The first plan decomposed after shipping is the parity plan itself — the plan the pipeline exists to execute.

### `batch_id` format

`dp-<plan-basename>-<YYYYMMDD-HHMM>-<short-sha>`

Example: `dp-openclaw-parity-plan-20260415-1430-a3f2c9`

- `plan-basename`: slugified plan filename without `.md`
- `YYYYMMDD-HHMM`: decomposition timestamp (UTC)
- `short-sha`: first 6 chars of plan file SHA (git if committed, sha256 of content if not)

Readable, sortable, collision-resistant for the observable regime.

### Plan SHA resolution

`prepare_decompose` resolves the plan SHA via:

1. Shell out `git rev-parse HEAD:<plan_path>` relative to atlas repo root. If it succeeds, use that.
2. Fallback: read file contents, compute sha256, use the first 6 hex chars.

Either satisfies `batch_id` uniqueness and `plan_ref.sha` traceability.

### Routing rationale discipline

When the decomposer routes a task to a non-default target, the `task_brief` markdown includes a `## Routing Rationale` section explaining why (e.g. "This task adds a new cron signal to the target workspace, which requires the `extend-workspace` kernel pipeline rather than the source-mod `run-task` pipeline.") No integrity rule enforces this — it's a prompt-level convention. If the reflector later observes operator confusion from missing rationales, we add a rule.

### Reflector-driven improvement path

Every applied batch carries `batch_id` on every task, and every downstream dispatch records its session outcome via the existing `status-watcher` → `reflect-on-last-run` chain. This means:

- A batch whose tasks consistently hit reviewer `BLOCK` verdicts produces a visible pattern the `cross-session-reflect` job can detect.
- The reflector's proposals can target the decomposer's prompt, the integrity rules, or the skill content under `.claude/skills/creating-tasks/`.
- High-confidence (≥0.9) proposals auto-apply per the existing `apply-approved-reflection` mechanism. Lower-confidence surface for review.

No new reflector work. The decomposer is just another source of dispatched sessions, and the reflector already watches every dispatched session.

### Interaction with existing autopilot-planner

The `autopilot-planner` (v1.6.0, at `agents/autopilot-planner/agent.py`) already filters by `blocked_by` (see agent.py line 206: `all(dep in completed_ids for dep in t.get("blocked_by", []))`). No planner changes are required. The decomposer produces `blocked_by` lists that the planner respects for free.

The planner's per-task 30-min cooldown also applies — if a decomposed task fails and re-surfaces via discovery, it won't re-fire within 30 minutes of its last dispatch, giving the operator time to investigate without the planner thrashing.

### Deferred decisions (for future iteration)

- **Routing deviation threshold.** The prompt encourages decomposer to stay ≥80% on `default_target`, but integrity doesn't enforce it. If deviation-heavy batches become common and noisy, add it as a WARN-severity rule later.
- **`max_tasks` cap.** Signal has no explicit cap. If batches of 100+ tasks happen and cause operational issues, add a cap in the signal schema (default 50, operator-overridable).
- **Multi-scope decompositions.** If an operator wants to decompose multiple sections of one plan into one batch, they can fire `decompose-plan` per scope. If that's painful, consider accepting `scope: string[]`.

---

## References

- Parity plan — `docs/plans/2026-04-13-openclaw-parity-plan.md`
- Dev walkthrough — `docs/plans/2026-04-13-friday-dev-walkthrough.md`
- Personal assistant walkthrough — `docs/plans/2026-04-13-personal-assistant-walkthrough.md`
- Creating tasks skill — `.claude/skills/creating-tasks/SKILL.md`
- Implementing tasks skill — `.claude/skills/implementing-tasks/SKILL.md`
- Fast self-modification skill — `.claude/skills/fast-self-modification/SKILL.md`
- Autopilot planner agent — `agents/autopilot-planner/agent.py`
- Post-session validator job — `workspaces/fast-loop/jobs/post-session-validator/job.ts`
- Discovery-to-task helper — `packages/memory/src/discovery-to-task.ts`
- Fast-improvements-source workspace — `workspaces/fast-improvements-source/workspace.yml`
- Fast-loop workspace — `workspaces/fast-loop/workspace.yml`
