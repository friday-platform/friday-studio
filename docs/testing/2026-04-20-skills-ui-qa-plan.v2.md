<!-- v2 - 2026-04-20 - Generated via /improving-plans from docs/testing/2026-04-20-skills-ui-qa-plan.md -->

# Skills UI — Holistic QA Plan

**Last updated:** 2026-04-20
**Surfaces covered:** `/skills`, `/skills/:ns/:name`, `/skills/:ns/:name/:path`, `/platform/:workspaceId/skills`
**Out of scope:** skill execution inside a running workspace (covered by workspace/runtime QA)

## 0. Why this plan exists

The skills subsystem shipped across ~30 commits with many surfaces touching
the same data. Recent rounds of manual QA caught real bugs that broke user
flows silently (500s, missing refetches, swapped state, wrong namespaces,
tier badges that all looked the same). This plan codifies every single
action we expose, every reasonable chain, and every regression we've
already paid for — so the next round of QA is thorough instead of
hopeful.

**v2 changes (2026-04-20 review pass):**
- §2 prerequisites upgraded with a **DB snapshot/restore** step so chains
  are idempotent between runs (you can re-run chain 4.1 twice and get the
  same result both times).
- §4 chains now point at **executable bash scripts** under `qa/skills/`
  that drive agent-browser + assert — prose stays as the contract, scripts
  are the runner. No Playwright; same tooling we already use.
- §4 gains a new chain for the **`@friday/*` fork-before-edit** flow that
  v1 missed entirely.
- §3 covers the new routes/flows surfaced during review: `POST /fork`,
  `POST /` (empty create), `DELETE /:ns/:name/:version` (per-version
  delete).
- §8 (open gaps) turns into an actionable next-pass list with file paths
  + concrete acceptance criteria for local fixtures and
  concurrent-session tests.

**Runtime:** every test runs through Chrome via `agent-browser` against a
live daemon + playground. The daemon must have `ATLAS_ALLOW_REMOTE_SKILLS`
unset or `true`. Never curl alone — curl-only QA is how the `shouldAssign`
bug shipped (curl returned 500, nobody saw it until a user clicked
Import).

## 1. Invariants (true for every test)

These must hold after every action. Failing any of these is a regression.

1. **Console stays clean** — no `[error]` or `[warning]` entries in the
   DevTools console. Exceptions only for noise from unrelated tabs
   (1password, WebMCP, Snap-ins). Helper:
   ```bash
   qa_console_clean() {
     local errs
     errs=$(agent-browser --session-name atlas-qa console \
       | grep -E '^\[(error|warning)\]' \
       | grep -vE '1password|WebMCP|HMR|Snap-ins|sourcemap')
     [ -z "$errs" ] || { echo "FAIL: console errors:" ; echo "$errs" ; return 1 ; }
   }
   ```
2. **Mutations refetch automatically** — after any publish/install/update/
   delete/autofix/restore, the detail page's version badge, markdown
   preview, lint panel, and history dropdown update without a manual
   reload.
3. **Toasts fire on both success and failure** — every mutation path
   produces either a success toast or an error toast. Silent failure is
   a bug.
4. **Navigation doesn't leak state** — navigating away from a skill
   closes any open dialog (compare, delete, upload) and clears any
   skill-scoped state.
5. **URL-driven state is authoritative** — `?edit` toggles the editor,
   `#anchor` scrolls to a heading, `/:path` targets a file. Refreshing
   the page should land on the same visual state.
6. **Dialogs are readable** — every dialog must show at least 720px of
   content width on a 1728 viewport, never default-squeezed to 288px.

## 2. Prerequisites and setup

Before running any scenario:

```bash
# Daemon up?
curl -s http://localhost:8080/health -o /dev/null -w "%{http_code}\n"
# → 200

# Playground up?
curl -s http://localhost:5200 -o /dev/null -w "%{http_code}\n"
# → 200

# Chrome driven by agent-browser (keep session name fixed)
agent-browser --session-name atlas-qa tab list
```

**Viewport:** always test at 1728 × 945 (the standard dev viewport). Also
spot-check dialogs at 1024 × 768 to catch fixed-px overflows.

### 2.1 Test-skill pool (canonical list — do not substitute)

| Source (skills.sh)                            | Tier      | Has archive | Notes                      |
| --------------------------------------------- | --------- | ----------- | -------------------------- |
| `anthropics/skills/pdf`                       | official  | yes         | 79k installs, clean lint   |
| `anthropics/skills/mcp-builder`               | official  | yes         | Many refs, TOC warnings    |
| `anthropics/skills/frontend-design`           | official  | yes         | 318k installs              |
| `anthropics/skills/skill-creator`             | official  | yes         | Self-referential           |
| `ljagiello/ctf-skills/ctf-reverse`            | community | yes         | 18 refs, depth warnings    |
| `openai/skills/pdf`                           | official  | yes         | Tests tier sort            |
| `anthropics/skills/nonexistent-zzzz`          | n/a       | n/a         | Must 404                   |

**Local skills (bundled):**
- `@friday/authoring-skills` — system skill, edit requires fork
- `@friday/workspace-api` — system skill, has `skill.ts` for code render
- `@tempest/qa-lint-test` — ad-hoc sandbox, safe to mutate freely

### 2.2 DB snapshot + restore — required

Chains mutate `~/.atlas/skills.db` (install / delete / edit / fork all
write rows). Without snapshotting, chain 4.1 on a fresh DB installs v1
but on a dirty DB 409s — the chain "passes" differently run-to-run.
Every chain script must snapshot on entry and restore on exit:

```bash
# qa/skills/qa-lib.sh — shared helpers
SKILLS_DB=~/.atlas/skills.db
SNAPSHOT=/tmp/skills.db.snapshot

qa_snapshot() {
  cp "$SKILLS_DB" "$SNAPSHOT"
  echo "[snap] $(sqlite3 "$SKILLS_DB" 'SELECT COUNT(*) FROM skills') skill rows saved"
}

qa_restore() {
  # Daemon holds a read-write handle; it must drop it before we clobber
  # the file. Simplest: stop daemon, restore, restart. ~6s round trip.
  deno task atlas daemon stop --force >/dev/null 2>&1 || true
  cp "$SNAPSHOT" "$SKILLS_DB"
  deno task atlas daemon start --detached >/dev/null 2>&1
  sleep 8
  echo "[restore] DB restored"
}

# Auto-restore on exit (success or failure)
trap qa_restore EXIT
qa_snapshot
```

Restore costs ~8s per chain; parallelism is not worth it for a QA run
you do a few times a week. If you need faster iteration during
authoring, use a per-session `.atlas-qa/` data dir and skip the daemon
restart.

## 3. Smoke tests — one action per test

Run these as a pre-flight before the chains. A broken smoke test
invalidates every downstream chain that exercises the same surface.

### 3.1 `/skills` (global catalog)

| ID  | Action                                   | Expected                                                       |
| --- | ---------------------------------------- | -------------------------------------------------------------- |
| S1  | Load page                                | Sidebar tree loads, namespaces collapsed except active         |
| S2  | Expand namespace                         | Carets rotate, skills list                                     |
| S3  | Click skill name                         | Route → `/skills/:ns/:name`, detail panel loads                |
| S4  | Click `+` button                         | Dialog opens at ≥720px width, Upload tab selected              |
| S5  | Dialog → Import tab                      | Search input appears, Install button disabled                  |
| S6  | Dialog → ESC                             | Dialog closes                                                  |
| S7  | Empty state `/skills` (no skill picked)  | Tabs render, Upload default                                    |
| S8  | Skill row shows `skills.sh` badge        | Only for remotely-installed skills (frontmatter.source)        |

### 3.2 Skill detail — `/skills/:ns/:name`

| ID  | Action                             | Expected                                                           |
| --- | ---------------------------------- | ------------------------------------------------------------------ |
| D1  | Load detail                        | `v<N>` badge, markdown body, page actions bar                      |
| D2  | Click `vN` badge tooltip           | Shows "Published v2 · N total"                                     |
| D3  | Click History (multi-version only) | Dropdown lists all versions with timestamps; current is disabled   |
| D4  | Click an older version             | Compare dialog opens, diff renders (green/red rows, line numbers)  |
| D5  | Compare dialog → ESC               | Dialog closes, state resets                                        |
| D6  | Compare dialog → Close button      | Dialog closes                                                      |
| D7  | Compare dialog → Restore           | Toast "Version restored", new version appears, dialog closes       |
| D8  | Click "from skills.sh" link        | Opens `https://skills.sh/<owner>/<repo>/<slug>` in new tab         |
| D9  | Click Check for updates            | Toast "Up to date" or "Update available"                           |
| D10 | Click Update (when available)      | Toast "Skill updated", version bumps                               |
| D11 | Click `N issues`                   | Lint panel opens, each row shows severity · rule · message         |
| D12 | Click Fix on fixable rule          | Toast "Lint fix applied", version bumps, panel re-evaluates        |
| D13 | Click Edit                         | Route `?edit`, CodeMirror editor replaces preview                  |
| D14 | Edit body + Save                   | Toast, exits edit mode, new version in history                     |
| D15 | Edit body + Cancel                 | Confirm dialog if dirty; otherwise just exits                      |
| D16 | ⋯ menu → Disable                   | Status badge appears, toggles label                                |
| D17 | ⋯ menu → Replace                   | Upload dialog opens with same ns/name                              |
| D18 | ⋯ menu → Remove                    | Block if in use; else confirm dialog → deletes, routes to `/skills`|
| D19 | Click SKILL.md in sidebar          | Route `/skills/:ns/:name` (detail view)                            |
| D20 | Click a reference file             | Route `/skills/:ns/:name/<path>`                                   |
| D21 | Per-version delete                 | `DELETE /:ns/:name/:version` removes only that row; history gap OK |
| D22 | Try Edit on `@friday/*`            | 403 on save OR UI should redirect to fork flow (see chain 4.11)    |

### 3.3 Skill file — `/skills/:ns/:name/:path`

| ID  | Action                              | Expected                                              |
| --- | ----------------------------------- | ----------------------------------------------------- |
| F1  | Load `.md` file                     | Markdown prose rendered with headings (IDs on h2+)    |
| F2  | Load `.ts` file                     | Syntax-highlighted code, purple keywords, green strings|
| F3  | Load `.py` / `.sh` / `.yaml` / `.json` | Syntax-highlighted per language                    |
| F4  | Load unknown extension              | Plain `<pre>` rendering, still readable               |
| F5  | URL with `#heading-slug`            | Scrolls to heading on load                            |
| F6  | Click TOC link inside markdown      | Scrolls to heading, does not open new tab             |
| F7  | Edit → save                         | Same skill detail publish flow; archive updates       |
| F8  | Edit → navigate away with dirty     | beforeUnload confirm prompt                           |

### 3.4 Workspace skills — `/platform/:workspaceId/skills`

| ID  | Action                             | Expected                                                  |
| --- | ---------------------------------- | --------------------------------------------------------- |
| W1  | Load page                          | Three sections: Assigned / Global / Available             |
| W2  | Type in search input               | Autocomplete suggestions appear (debounced 200ms)         |
| W3  | Suggestion shows tier              | OFFICIAL green, COMMUNITY blue — visually distinct        |
| W4  | Click suggestion                   | Input fills, suggestions close                            |
| W5  | Click Install                      | Toast "Skill installed" or error; auto-assigned to WS     |
| W6  | Attach from "Available" section    | Skill moves to Assigned; toast                            |
| W7  | Detach from Assigned               | Skill moves to Available; toast                           |
| W8  | Global skill shown with no detach  | Read-only — global skills auto-visible                    |

## 4. Action chains — executable end-to-end scenarios

Each chain has a shell script under `qa/skills/chain-<id>.sh`. The prose
here is the contract; the script is the runner. Scripts share
`qa-lib.sh` which provides:

```bash
# qa/skills/qa-lib.sh — excerpt
install_skill() { curl -sf -X POST ".../api/skills/install" -d "{\"source\":\"$1\"}" ; }
expect_version() { local got=$(curl -sf ".../@$ns/$name" | jq -r .skill.version); [ "$got" = "$1" ] || fail "expected v$1 got v$got"; }
assert_toast() { local text=$(agent-browser --session-name atlas-qa eval 'document.querySelector("[data-portal] .toast")?.innerText'); [[ "$text" == *"$1"* ]] || fail "toast '$text' missing '$1'"; }
nav_to_skill() { agent-browser --session-name atlas-qa open "http://localhost:5200/skills/$1/$2" ; agent-browser --session-name atlas-qa wait --load networkidle ; }
```

Script template:

```bash
#!/usr/bin/env bash
# qa/skills/chain-<id>.sh
set -euo pipefail
source "$(dirname "$0")/qa-lib.sh"
trap qa_restore EXIT
qa_snapshot

# ... chain steps ...

echo "PASS"
```

Every step must satisfy §1 invariants. After each interactive click,
call `qa_console_clean` at least once per chain.

### 4.1 Fresh install → browse → delete → re-install → 409

**Why:** reproduces the "why is re-install at v3?!" bug.
**Script:** `qa/skills/chain-4.1.sh`

1. Snapshot DB.
2. `/skills` → `+` → Import tab → type `anthropics/skills/skill-creator`.
3. Click Install → assert toast "Skill imported", routed to detail.
4. `expect_version 1`.
5. ⋯ → Remove → confirm. Assert routed back to `/skills`, skill gone.
6. `+` → Import → same source → Install.
7. `expect_version 1` (fresh install, not v2 via silent bump).
8. Second `+` → Import → same source again.
9. Assert error toast contains `already installed` and matches status 409
   in the fetch panel.
10. Restore DB (via `trap`).

### 4.2 Install → edit → version history → compare → restore

**Why:** full local-edit lifecycle.
**Script:** `qa/skills/chain-4.2.sh`

1. Install `anthropics/skills/pdf`. `expect_version 1`.
2. Click Edit → modify instructions → Save.
3. `expect_version 2` without reload. Assert badge shows "v2".
4. Open History dropdown → assert both v1 + v2 shown.
5. Click v1 → compare dialog opens, diff renders.
6. Assert at least one `.row-add` and one `.row-del`.
7. Click Restore → toast "Version restored".
8. `expect_version 3` (append-only).
9. Open compare v2 vs v3 → assert v3 matches v1's original content.

### 4.3 Install → lint → autofix (deterministic) → refresh

**Why:** local-string rule path.
**Script:** `qa/skills/chain-4.3.sh`

1. Install any skill. Inject a `path-style` warning by PUT'ing a
   reference file containing `foo\bar\baz.md` outside a fence.
2. `/skills/:ns/:name` → N issues → expand panel.
3. Locate the row with `rule="path-style"`.
4. Click Fix → assert toast "fixed via deterministic".
5. `expect_version` bumped.
6. Panel re-evaluates and `path-style` gone.

### 4.4 Install → lint → autofix (LLM) → verify conformance

**Why:** LLM rule path + authoring-skills context.
**Script:** `qa/skills/chain-4.4.sh`

1. Install a skill with `description-person` warning (ctf-reverse works).
2. N issues → Fix on `description-person`.
3. Wait up to 20s for LLM round trip.
4. Toast "fixed via llm".
5. Assert new description reads in third person (regex: no `\bI\b` or
   `\byou\b`).
6. Panel re-evaluates: `description-person` gone.
7. Assert history is append-only (old description retrievable via
   `/versions/<v-1>`).

### 4.5 Install → check-for-updates → no change

**Why:** upstream-idempotent path.
**Script:** `qa/skills/chain-4.5.sh`

1. Install `anthropics/skills/pdf`.
2. Click Check for updates → assert toast "Up to date".
3. `expect_version 1` unchanged.

### 4.6 Install → stale-hash → pull update → bump

**Why:** upstream-changed path. Hard to trigger against real skills.sh
without access to an updated archive, so we force it by corrupting the
stored `source-hash`.
**Script:** `qa/skills/chain-4.6.sh`

1. Install `anthropics/skills/pdf`.
2. Stop daemon, `UPDATE skills SET frontmatter=json_set(frontmatter,'$.\"source-hash\"','stale') WHERE …`.
3. Restart daemon.
4. Click Check for updates → toast "Update available".
5. Click Update → toast "Skill updated", `expect_version 2`.
6. Lint panel refreshes.

### 4.7 Workspace-scoped install

**Script:** `qa/skills/chain-4.7.sh`

1. `/platform/user/skills` → type `anthropics/skills/pdf`.
2. Install → toast with "assigned to this workspace".
3. Assert skill in Assigned section.
4. Navigate to `/skills/anthropics-skills/pdf` — catalog sees it too.
5. Detach → assert it moves to Available.

### 4.8 Compare dialog → navigate → no leak

**Why:** reproduces the "dialog opens on every skill click" bug.
**Script:** `qa/skills/chain-4.8.sh`

1. Open a skill with history.
2. Open compare dialog on v1.
3. Click a different skill in the sidebar.
4. Assert dialog closed (`document.querySelector(".body")` → null).
5. Click History on new skill → dropdown present, no stale state.
6. Open compare on new skill's v1 → diff renders against its own data.

### 4.9 Import conflict toast

**Script:** `qa/skills/chain-4.9.sh`

1. Install `anthropics/skills/mcp-builder`.
2. `+` → Import → same source again.
3. Assert toast "Import failed · already installed (v1)".

### 4.10 Markdown anchor + code render

**Script:** `qa/skills/chain-4.10.sh`

1. Install a skill with a reference file that links to `#some-heading`.
2. Open the reference file.
3. Click a TOC link → assert `.preview-content` scrollTop > 0 and
   target heading is in viewport.
4. Navigate to a `.ts` file → assert `.code-preview span[style]` count > 0
   (syntax-highlighted).
5. Reload with `#heading` → assert scroll lands.

### 4.11 `@friday/*` fork-before-edit

**Why:** v1 of the plan only tested the 403 wall. The happy path — fork
into your namespace and edit the fork — was silently missing.
**Script:** `qa/skills/chain-4.11.sh`

1. `/skills/friday/authoring-skills`.
2. Click Edit. Make a change. Save.
3. Expected flow today: **403 Forbidden** (bundled skill is locked).
   - Note: the UI currently doesn't offer a fork button. Either the
     save handler needs a 403-recovery that offers to fork, or the
     detail page needs a "Fork to edit" button. **This chain codifies
     the current behavior (403) but v2 of the UI should convert it to
     the fork flow.** Tracked as a follow-up.
4. Via API: `POST /api/skills/fork` with `{sourceNamespace:"friday",
   sourceName:"authoring-skills", targetNamespace:"tempest"}`.
5. Assert fork lands at `@tempest/authoring-skills` v1, archive
   preserved.
6. Navigate to the fork, Edit, Save → new version under `@tempest/*`.
7. Original `@friday/authoring-skills` untouched.

### 4.12 Concurrent-tab write race (known hazard)

**Why:** two tabs open on the same skill, both edit, both save. What
happens? `SkillStorage.publish` reads `MAX(version)` at call time so
the later save wins the higher version number, but both writes succeed
with no conflict signal to the user.
**Script:** `qa/skills/chain-4.12.sh`

1. Install `@tempest/qa-lint-test`.
2. Open two agent-browser tabs on the same skill.
3. Tab A: Edit, change to `AAA`.
4. Tab B: Edit (without refresh), change to `BBB`.
5. Tab A: Save → v2, content `AAA`.
6. Tab B: Save → v3, content `BBB`.
7. Assert: history shows v1 → v2(AAA) → v3(BBB); no data loss, but tab
   B's view of "current" was stale.
8. **This is documented behavior, not a test that fails.** If we ever
   add optimistic-concurrency (version token in publish payload), the
   chain gets an extra assertion.

## 5. Error paths & known regressions

Each of these has bitten us; re-running them every QA round is mandatory.
Row order is chronological — newest at the bottom.

| ID    | Regression                                           | Reproduction                                     | Expected                       |
| ----- | ---------------------------------------------------- | ------------------------------------------------ | ------------------------------ |
| R-01  | Install 500 from `shouldAssign is not defined`       | POST /install any valid source                   | 201 (never 500)                |
| R-02  | Install silent version bump                          | Install same source twice                        | 409 conflict toast             |
| R-03  | Route 400 on `@anthropics-skills`                    | GET `/api/skills/@anthropics-skills/mcp-builder` | 200 (segment-match, no substr) |
| R-04  | Compare dialog stays open after ESC                  | Open → ESC → History → same version              | Dialog re-opens                |
| R-05  | Compare dialog leaks to next skill                   | Open dialog → click another skill in sidebar     | Dialog closed on navigate      |
| R-06  | Autofix didn't refetch detail                        | Fix a rule → check badge                         | Version + panel update instant |
| R-07  | Lint errors blocked install                          | Install `ljagiello/ctf-skills/ctf-reverse`       | 201 (lint warnings ≠ block)    |
| R-08  | Toast duplicate-module drop                          | Install anything via `+` dialog                  | Toast fires (not silent)       |
| R-09  | Dialog too narrow                                    | Open `+` dialog                                  | ≥720px on 1728 vp              |
| R-10  | Tiers indistinguishable                              | Search → inspect badges                          | OFFICIAL green, COMMUNITY blue |
| R-11  | Skill.ts rendered as garbled markdown                | Open `/skills/friday/workspace-api/skill.ts`     | Syntax-highlighted code        |
| R-12  | Anchor links not scrolling                           | Open `/skills/.../*.md#some-heading`             | Scrolls to heading             |
| R-13  | "from skills.sh" not a link                          | Open detail of remote skill                      | Anchor with target=_blank      |
| R-14  | Missing Import tab                                   | Open `+` on `/skills`                            | Two tabs visible               |
| R-15  | Reserved-word false reject                           | Install source with "anthropic" in owner         | Installs (namespace allowed)   |

Each regression has an entry in `qa/skills/regressions/R-NN.sh` that
reproduces it in ≤30s. The shell script MUST be runnable standalone
(no GUI required for the `curl`-only R-NNs; those that require the UI
drive agent-browser).

## 6. Data coverage matrix

Scenarios should span these inputs to catch branch-specific bugs:

### Skill types
- Text-only skill (no archive) — just SKILL.md
- Skill with single reference — one .md file
- Skill with nested refs — triggers `reference-depth` warning
- Skill with large refs — triggers `reference-toc` warning
- Skill with SKILL.md + scripts — `.py`/`.sh` in archive
- Forked skill (parent `@friday/*` → fork `@tempest/*`)

### Lint rule coverage (at least one test per fixable rule)
- `path-style` (deterministic)
- `description-length` (deterministic)
- `description-person` (LLM)
- `description-trigger` (LLM)
- `description-missing` (LLM)
- `first-person` (LLM, body)
- `time-sensitive` (LLM, body)

### Lint rules that must surface but can't autofix
- `reference-toc`
- `reference-depth`
- `body-lines` / `body-tokens`
- `name-pattern`, `name-reserved` (both block publish, not install)

### Namespaces
- `@friday/*` — bundled; mutate via fork only (chain 4.11)
- `@anthropics-skills/*` — installed remote; full CRUD
- `@tempest/*` — ad-hoc local; full CRUD
- `@remote/*` — legacy default namespace from early installs (still
  valid, kept for back-compat)

## 7. Executing this plan

```
qa/skills/
├── qa-lib.sh                  # shared helpers (snapshot/restore, assertions)
├── chain-4.1.sh ... 4.12.sh   # end-to-end flows
├── regressions/
│   ├── R-01.sh ... R-15.sh    # each minimal repro
│   └── run-all.sh             # runs every regression
└── run-all.sh                 # runs smoke + chains + regressions, prints summary
```

Recommended cadence:
- **Before each release:** `qa/skills/run-all.sh` (≈12 min end-to-end
  with agent-browser automation; DB restore dominates latency).
- **Before each skills-subsystem commit:**
  `qa/skills/regressions/run-all.sh` (≈2 min, curl-only subset) plus
  any §4 chain touching the code area.
- **On bug reports:** add a new `regressions/R-NN.sh` *before* you fix
  the bug, assert it fails today, then fix and re-run until it passes.
  That guarantees the regression test actually tests the fix.

Capture results in `docs/testing/runs/<YYYY-MM-DD>-skills-qa.md`. For
each failure, include: chain id, step number, expected, actual, console
dump, screenshot. Clean-console check is non-negotiable — it's saved us
three times already.

## 8. Open gaps (known holes in coverage)

Items below have **owners, target paths, and acceptance criteria** so
they can be picked up without a second brainstorm.

### 8.1 Replace live skills.sh dependency with local fixtures
- **Why:** plan depends on skills.sh being up + install counts stable.
- **Target:** check 3 tarballs into `packages/skills/test/fixtures/skills-sh/`:
  - `tiny-clean.tar.gz` — SKILL.md only, zero lint findings
  - `with-refs-clean.tar.gz` — 2 reference files, all under 100 lines
  - `with-refs-dirty.tar.gz` — 2 reference files, one triggers
    `description-person` + `path-style` so chains 4.3/4.4 are offline
- **Wire:** `SKILLS_SH_BASE_URL` env var on the daemon → `SkillsShClient`
  reads it; point at `file://` in test runs.
- **Acceptance:** `qa/skills/run-all.sh` passes with
  `SKILLS_SH_BASE_URL=file://…` and `curl skills.sh` returning 503.

### 8.2 Formal E2E runner
- **Why:** `qa/skills/*.sh` is a foothold; not a long-term framework.
- **Candidate:** Playwright. Already listed as a dev dep somewhere in
  node_modules via transitive knip plugins, not installed directly.
  Budget: 2 days to port chains 4.1–4.11.
- **Acceptance:** chains green in CI; same assertions as bash scripts;
  screenshots on failure.

### 8.3 Concurrent-session race hardening
- **Status:** chain 4.12 documents current behavior (last-write-wins
  with silent version skip).
- **Fix direction (out of scope for QA plan):** add an
  `If-Match: <version>` header on publish; daemon returns 412 if the
  client's base version isn't latest.
- **Acceptance:** chain 4.12 gets an assertion that the second save
  returns 412 + the user sees a "Someone else edited this" toast.

### 8.4 No soft-delete
- `deleteSkill` drops every version including history. If a user
  "deletes" and wants undo, they have to re-install from source.
- **Fix direction:** add `deleted_at` column; `list` filters on null.
  409 on install reads through soft-deleted rows and offers restore.
- **Chain to add when implemented:** `chain-4.13.sh` — delete → list
  → undo → content restored.

### 8.5 Workspace skill assignments across refresh
- Not explicitly covered by chains 4.1–4.12. Add when we touch that
  path again; likely `chain-4.14.sh`:
  1. Assign skill to workspace A.
  2. Refresh `/platform/A/skills` → present.
  3. Open in new tab → same result.
  4. Detach from tab 1 → tab 2 sees `Available` on next view.

### 8.6 Route coverage audit
The following daemon routes exist but aren't directly exercised by a
smoke test. Add when touching:
- `POST /api/skills/` (empty-skill create from UI — no current UI
  flow exposes this; useful for scripting)
- `POST /api/skills/:namespace/:name` (JSON publish — covered
  indirectly via Save, but no direct smoke case)
- `GET /api/skills/:skillId` (by-id; agent runtime uses this, not UI)
