# Skills UI QA Plan — v1 Review Report

**Reviewed:** 2026-04-20
**Input:** `docs/testing/2026-04-20-skills-ui-qa-plan.md`
**Output:** `docs/testing/2026-04-20-skills-ui-qa-plan.v2.md`

## Context Gathered

- Enumerated all skill routes in `apps/atlasd/routes/skills.ts` (22 routes
  total) to verify plan coverage. Identified three under-covered paths:
  `POST /fork`, `POST /`, `DELETE /:ns/:name/:version`.
- Checked for existing browser-test infra (playwright, vitest-browser,
  puppeteer) — none wired up; agent-browser is the only automation.
- Verified existing unit test coverage in `packages/skills/tests/` is
  fine-grained (parser, archive, adapter, audit, skills-sh-client) but
  exercises nothing across the HTTP boundary.
- Cross-checked `SkillStorage.publish` to confirm the "silent version
  bump" root cause was indeed `SELECT skill_id FROM skills WHERE ns AND
  name` returning an existing row after a partial delete.
- Reviewed melt-ui `Dialog.Root` / `Content` contracts to confirm
  `size="auto"` is the canonical override (used in both the compare
  dialog and Add Skill dialog).

## Ideas Proposed

5 new ideas, 0 retreads from prior reviews (this was the first pass, so
no prior reviews to deduplicate against).

### Accepted (integrated into v2)

**1. Convert chains to executable bash scripts** — v1 was prose. v2
keeps prose as the contract + points each chain at a shell script under
`qa/skills/chain-<id>.sh`. Scripts share `qa-lib.sh` with `install_skill`,
`expect_version`, `assert_toast`, `nav_to_skill`. Runnable as
`qa/skills/run-all.sh` in ≈12 min end-to-end. No Playwright yet — kept
tooling identical to what we already use for manual QA.

**2. DB snapshot/restore hooks in §2.2** — v1 implicitly assumed a clean
DB. v2 mandates `qa_snapshot` on entry + `qa_restore` on `trap EXIT`.
Restore stops the daemon, copies `~/.atlas/skills.db`, restarts — ~8s per
chain but makes runs idempotent. First-run vs second-run consistency is
the critical property here; previously chain 4.1 would pass on clean DB
and 409 on dirty DB, producing different "passes".

**3. `@friday/*` fork-before-edit chain (4.11)** — v1 only tested the 403
wall. v2 adds the fork happy path: try Edit on bundled skill → 403 →
invoke `POST /fork` → edit the fork. Also explicitly flags that the UI
today has no "Fork to edit" button, so the chain captures the current
behavior and the §8.6 follow-up implements the missing button.

### Partially accepted (promoted to §8 gaps with concrete next-pass detail)

**4. Local test fixtures instead of live skills.sh** — v1 listed this in
§8 as a known gap with no path forward. v2 promotes to §8.1 with target
paths (`packages/skills/test/fixtures/skills-sh/{tiny-clean,with-refs-clean,with-refs-dirty}.tar.gz`),
a `SKILLS_SH_BASE_URL` env var plumbed through `SkillsShClient`, and a
concrete acceptance criterion (run with skills.sh returning 503). Didn't
promote to v2 plan body because fixture creation is its own 1-day task
and shouldn't block the plan shipping.

**5. Concurrent-tab / multi-session race test** — v1 didn't cover this.
v2 adds chain 4.12 that documents the current behavior (last-write-wins,
no user warning, no data loss but stale view) and §8.3 as a follow-up
for the If-Match + 412 fix. Caveat: chain 4.12 doesn't assert failure —
it asserts documented behavior. If we ever tighten concurrency, the
chain gets a new assertion.

### Rejected

- **Performance time budgets per action.** Proposed but rejected —
  wrong surface. APM/telemetry is the right place; QA plan shouldn't
  own "how slow is too slow" thresholds because they'll rot. Tracked as
  discussion only, no doc change.

- **Restructure R-01..R-15 as pytest-parametrize style.** Rejected as
  orthogonal — only useful after idea #1 lands, and the bash scripts
  under `qa/skills/regressions/R-NN.sh` already capture each as a
  standalone ≤30s repro. Moving to pytest adds a dependency without
  gain.

## Caveats & Tradeoffs

- **Bash as the test harness** is a pragmatic choice, not an ideal one.
  assertions are string-matching, not structural. When a chain breaks
  the failure message is only as good as the assertion. Acceptable
  tradeoff for now because we already drive agent-browser from bash in
  ad-hoc QA.

- **DB restore costs ~8s** because we stop+restart the daemon to drop
  the sqlite handle. If chains run sequentially (which they do), that's
  ~1.5 min across all 12 chains. Tolerable. If we parallelize (we don't
  today), we'd need per-chain isolated data dirs.

- **Chain 4.6 (pull update) requires a stale-hash forcing step** that
  corrupts the DB mid-chain. Ugly but honest — there's no ergonomic way
  to simulate "upstream changed" against live skills.sh. §8.1 local
  fixtures would fix this cleanly: put two fixtures for the same source
  and swap them between steps.

- **Chain 4.11 documents a known UX gap** (no Fork button in UI). The
  chain uses the API to get to the happy path. A reader might think
  "test passes ⇒ feature works." It doesn't — only the API works.
  Flagged explicitly in the chain prose.

## Unresolved Questions

1. **Should `@friday/*` edits silently offer Fork in the UI?** Today
   Save returns 403. The natural flow is: click Edit → warning banner
   "this is a system skill; Fork to edit" → one-click fork into your
   default namespace. Not decided; chain 4.11 documents today's
   behavior.

2. **Should chain 4.12 (concurrent tabs) assert today's behavior or
   desired behavior?** v2 asserts today's (no warning, version skip).
   If we want TDD-style, it should assert desired (412 on stale write)
   and fail until we implement. Going with today's behavior so the
   chain is stable; acceptance criterion in §8.3 pinpoints the
   switchover.

3. **Should the snapshot snapshot everything or just the skills table?**
   Today it's full DB copy. Just `skills` + `skill_assignments` would
   be faster but harder to write safely (schema evolution, foreign
   keys). Going with full file copy; revisit if chain runtime becomes
   a problem.

4. **Does §2.1's test-skill pool need pinned versions?** Install counts
   change; `anthropics/skills/pdf` at "79k installs" will drift. The
   pool itself is stable (slug exists) but install-count assertions in
   any future chain would need fixtures. §8.1 covers this.

## Overlap with Prior Reviews

None — v1 review pass.
