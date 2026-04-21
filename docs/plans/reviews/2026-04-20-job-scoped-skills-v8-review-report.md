# Job-scoped skills — v8 Review Report

**Reviewed:** 2026-04-20
**Input:** `docs/plans/2026-04-20-job-scoped-skills.v8.md`
**Output:** `docs/plans/2026-04-20-job-scoped-skills.v9.md`
**Prior reviews:** v1–v7 review reports.

## TL;DR

v8 fixed the tool's defense-in-depth but missed that `SkillStorageAdapter`
has two implementations. `CortexSkillAdapter` doesn't get the three new
methods → compile error the moment the implementer runs `deno task
typecheck`. v9 adds three fail-or-empty stubs to cortex-adapter (~15 min)
and a new NG-4 documenting the SQLite-only limitation.

Single finding. Clears a slightly weaker version of the "name a
failing test" bar — "name a compile error that fails before tests
run."

## Context Gathered

- Read `packages/skills/src/cortex-adapter.ts:44-406`. `CortexSkillAdapter`
  implements `SkillStorageAdapter` and today stubs assignment methods
  with `fail()` / `success([])`. Cortex is a valid backend (loaded at
  `storage.ts:57-58` when `cortexUrl` env var is set), not dead code.
- Verified no current reference to `assignToJob` / `unassignFromJob`
  / `listAssignmentsForJob` in either adapter. v8's Phase B adds them
  to the interface without specifying implementations for both.
- Confirmed interface conformance is TypeScript-checked: `implements
  SkillStorageAdapter` at line 44 means all interface members must be
  present.

## Ideas Proposed (1)

### 1. Cortex adapter interface gap

Adding three methods to `SkillStorageAdapter` (Phase B in v8) without
mirroring stubs on `CortexSkillAdapter` produces a compile error.
Implementer hits it at `deno task typecheck`. v9 adds a named Phase
B.1 with three-line stubs (pattern: `Promise.resolve(fail(...))` for
writes, `success([])` for reads) and NG-4 to explain that job-level
scoping is SQLite-only — Cortex backend users get workspace-level-only
visibility.

### Rejected / Not Adopted

None. Confined the pass to one concrete finding; avoided gold-plating.

## What v8 Missed That v9 Doesn't

v8 thoroughly covered the single-adapter path but didn't look at
`packages/skills/src/storage.ts` where the adapter is chosen at
runtime based on config. A quick grep for `CortexSkillAdapter` would
have surfaced it; my v8 review didn't do that grep.

Lesson: when the plan adds to an interface, grep for `implements
<Interface>` to find every class that conforms. In this codebase
there are only two; in a larger codebase there could be more.

## Caveats & Tradeoffs

- **Cortex backend users can't use job-level scoping.** If an
  operator switches to Cortex expecting job-level scoping to work,
  assignment UI mutations return 500 (from `fail()`). v9 documents
  this as NG-4 but doesn't surface a UX warning. For v9 scope,
  Cortex deployments are rare enough that a runtime log is
  sufficient; if that changes, UI could detect via a feature-flag
  endpoint.
- **NG-4 freezes Cortex parity as a follow-up.** If someone lands
  workspace-level assignments on Cortex in the future, they'd want
  job-level at the same time. The plan explicitly punts both
  together, so no half-complete Cortex surface.

## Unresolved Questions (carried forward)

1. **~~`@db/sqlite` NULL-in-PK~~** resolved.
2. **Simultaneous scoping API writes** — F.2.
3. **Ad-hoc runtime-dispatched jobs not in YAML** — F.2.

None new in v9.

## Overlap with Prior Reviews

- v1-v5 ideas absorbed through v6.
- v6 idea: `listAssigned` / `unassignSkill` / `listAssignments` /
  `assignSkill` / migration SELECT — integrated in v7.
- v7 idea: unified defense-in-depth — integrated in v8.
- v8 idea (this pass): cortex adapter stubs — integrated in v9.

## Process Reflection

Each review has turned up exactly one class of issue:

- v1 (pre-pivot): missed call sites (5 not 3)
- v2: field-shape, debug UX, inline fixtures, runtime backstop, layering clarity
- v3: AgentSessionData gap, fsm-engine simplification, scoping API shape
- v4: UI dual-assign, @friday implicit
- v5: migration rebuild, declarative YAML, cascade, F.1 gate, atomic API
- v6: factual error about YAML reconcile (pivot to scoping-API-as-source)
- v7: co-located SQL query bugs (listAssigned leak, unassignSkill nuke, etc.)
- v8: tool defense-in-depth drift
- v9: cortex adapter interface mismatch

Pattern: each pass finds what the previous pass's lens didn't look at.
"Review is done" means "I looked at every lens I know to look at."
Nine passes in, the next untested lens would be something like "are
there runtime-data migrations downstream of this schema change?" or
"does a live workspace's session state need clearing?" — both legit
lenses worth a pass if requested.

**Recommendation for v10 decision**: before invoking /improving-plans
again, ask yourself which new lens you'd want reviewed. If the
answer is "I don't know, just make it better" → stop and ship. If
the answer is a specific concern → great, that's the next pass.

v9 is implementable. Next step is execution.
