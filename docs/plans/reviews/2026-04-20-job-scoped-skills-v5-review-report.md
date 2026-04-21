# Job-scoped skills — v5 Review Report

**Reviewed:** 2026-04-20
**Input:** `docs/plans/2026-04-20-job-scoped-skills.v5.md`
**Output:** `docs/plans/2026-04-20-job-scoped-skills.v6.md`
**Prior reviews:**
- `reviews/2026-04-20-job-scoped-skills-v1-review-report.md`
- `reviews/2026-04-20-job-scoped-skills-v2-review-report.md`
- `reviews/2026-04-20-job-scoped-skills-v3-review-report.md`
- `reviews/2026-04-20-job-scoped-skills-v4-review-report.md`

## TL;DR

v4 review said "further reviews should focus on implementation-time
questions, not plan-space." That advice was wrong. Re-reading the
codebase during this pass turned up a factual error in v5's Phase
D.2: the claim that "workspace.yml is the source of truth today;
extend to job-level" is not true. There is no auto-reconcile hook.

v6 drops the fiction, simplifies to scoping-API-as-source-of-truth
(matching today's architecture), and names three deferred concerns
that v5 silently papered over. Estimate drops from ~16 h → ~13 h.

## Context Gathered

**Critical finding:** no auto-reconcile from `workspace.yml`
`skills:` to `skill_assignments` today.

- `apps/atlasd/routes/workspaces/config.ts` has the config save path:
  blueprint-backed workspaces recompile; non-blueprint mutate YAML
  directly. Neither path writes to `skill_assignments`.
- `packages/skills/src/storage.ts` and `local-adapter.ts` show
  assignments come exclusively from explicit API calls:
  `POST /install` (auto-assigns caller's workspace), `POST /fork`
  (assigns to fork target), `POST /scoping/.../assignments` (UI + CLI
  path). No listener on YAML changes.
- `packages/workspace/src/runtime.ts:1713` reads
  `this.config.workspace.skills` directly — the single path where
  the YAML field is consulted at runtime, only for code agents with
  `useWorkspaceSkills: true`. That path bypasses the DB entirely.

So v5's plan to "extend the existing reconcile path" for job-level
skills was extending a path that doesn't exist. The implementer
would have spent a day building what v5 called extension before
realizing it was new construction.

## Ideas Proposed (5)

### 1. D.2's "existing reconcile" claim is wrong (CRITICAL)

Not a design question — a factual error. v6 fixes the plan's current-
state description: `skill_assignments` is populated **only** by
explicit API calls. The YAML `skills:` field is read-only at runtime
and bypasses the DB.

### 2. `useWorkspaceSkills` path bypasses the DB

`runtime.ts:1713` reads `this.config.workspace.skills` directly.
Code agents with `useWorkspaceSkills: true` would not see any
job-level assignments. v5 ignores this path; v6 names it as NG-1
(acknowledged non-goal with a one-line follow-up scope).

### 3. Blueprint-backed workspaces have a second config-save path

`config.ts:400-451` shows dual-path save. v5's Phase D wasn't
blueprint-aware; v6 doesn't touch YAML writes at all, so the
blueprint path is not affected. Named as NG-2.

### 4. Decide scoping-API ↔ YAML relationship

v5 implicitly treated them as synced. Two options: (a) scoping API
also writes YAML; (b) YAML is declarative-only, UI/CLI drive via
scoping API. v6 picks (b) — cleaner, matches today's architecture,
and avoids opening a YAML-formatting-preservation can of worms.
Named as NG-3 with a proposed follow-up (`atlas workspace apply
--skills`).

### 5. Drop Phase D.2/D.3 entirely

Once the fiction is dropped, the YAML-reconcile phase evaporates.
No reconcile = no cascade. Plan shrinks by ~3 h. v6 keeps only the
trivial bits from the original Phase D:

- Parse-time validation warnings (unresolved refs) — valuable
  regardless.
- Runtime first-run warning when YAML declares job skills but the
  DB has none — tells the user their hand-edit was a no-op.
- Scoping API body flip (was already independent of D.2/D.3; moves
  to Phase D.2 in v6).

### Rejected / Not Adopted

None. All five findings integrated.

## Other v5 → v6 Adjustments

- **Estimate drops** ~16 h → ~13 h. Two phases deleted (D.2
  reconcile, D.3 cascade), Phase B cascade helpers removed
  (~0.5 h).
- **Acknowledged non-goals section is new** — NG-1 (`useWorkspaceSkills`
  path), NG-2 (blueprint recompile), NG-3 (two-way sync). Each with
  a named follow-up and the one-line "why punt" rationale. The
  plan now says what it *doesn't* do as clearly as what it does.
- **`jobs.*.skills` field description updated** to spell out
  "declarative only; not auto-applied." Signals to future authors
  that hand-editing YAML won't propagate.
- **No B-phase cascade helpers** — `listJobNamesForWorkspace` and
  `deleteAllJobAssignments` were added for v5's Phase D.3 cascade.
  Without cascade, they're unnecessary. Drop from Phase B.

## Caveats & Tradeoffs

- **Some users will hand-edit YAML.** v6's D.1 fires a warning when
  that happens without matching DB rows. Some users will miss the
  warning or ignore it. Cost: a config-looks-valid-but-doesn't-work
  failure mode. Mitigation: the warning text explicitly names the UI
  and CLI paths.
- **NG-1 (`useWorkspaceSkills` path) is a real limitation.** Code
  agents that opt into workspace skills won't see job-level ones.
  That's a behavior gap that matters for users who write code agents
  expecting full parity. v6 names it explicitly rather than hiding.
  The follow-up scope is small (~1-2 h) if prioritized.
- **NG-3 (two-way sync) kicked to a future `atlas workspace apply`
  command.** For users who live in YAML (CI-driven workspaces,
  infra-as-code), that command is necessary. Not v6, but not
  forgotten.
- **v5's cascade helpers may still be useful** for NG-3 when it
  lands. They're not in v6's Phase B but worth remembering.

## Unresolved Questions (carried forward)

1. **`@db/sqlite` NULL-in-PK behavior** — standard SQL says NULL is
   distinct; verify at A.1 implementation.
2. **Simultaneous scoping API writes** — race handled by PK conflict;
   partial-success route path already deals with it. Verify in F.2.
3. **Ad-hoc runtime-dispatched jobs not in YAML** — resolver returns
   workspace-level only. Matches today's behavior.

## Overlap with Prior Reviews

- **v1 ideas** — filter model obsolete after v3 pivot.
- **v2 ideas** — absorbed or documented.
- **v3 ideas** — integrated in v4.
- **v4 ideas** — integrated in v5.
- **v5 ideas** (this pass) — five findings, all integrated or
  acknowledged.

## Process note (self-correction)

My v4 review report said: "if v6 is requested, my recommendation is
to time-box it and resist the urge to gold-plate." That advice was
premature confidence in v5's completeness. The v5 pass fixed
mechanical issues (migration pattern, gating F.1) but didn't
re-verify the architectural assumption that "workspace.yml is source
of truth today." v6's review caught that because it specifically
looked for the reconcile hook and found it didn't exist.

Lesson for future plan reviews: treat claims of "extend the existing
pattern" as load-bearing and verify the pattern exists. "Further
review is gold-plating" is a reasonable default but not when a
plan contains an unverified claim about current state.

## Implementation Note for v6

Ship order same as v5:
1. PR #1 — Schema stubs (A.1 + A.2 + A.3 + F.1 skeleton)
2. PR #2 — Job-level lands (B + C + F.1 live + F.2)
3. PR #3 — Validation + scoping API (D.1 + D.2)
4. PR #4 — UI (E.0 + E.1 + E.2 + F.3)

PR #2 and #3 can run in parallel after PR #1.

v6 is the first version I'd describe as both correct and
implementable without further plan-space iteration. If v7 is
requested, the bar for a new idea should be something the
implementer would concretely fail without — same bar v5's review
should have applied but didn't.
