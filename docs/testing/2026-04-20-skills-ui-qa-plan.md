# Skills UI — Holistic QA Plan

**Last updated:** 2026-04-20
**Surfaces covered:** `/skills`, `/skills/:ns/:name`, `/skills/:ns/:name/:path`, `/platform/:workspaceId/skills`
**Out of scope:** skill execution inside a running workspace (covered by workspace/runtime QA)

## 0. Why this plan exists

The skills subsystem shipped across ~25 commits with many surfaces touching
the same data. Recent rounds of manual QA caught real bugs that broke user
flows silently (500s, missing refetches, swapped state, wrong namespaces,
tier badges that all looked the same). This plan codifies every single
action we expose, every reasonable chain, and every regression we've
already paid for — so the next round of QA is thorough instead of
hopeful.

**Runtime:** every test runs through Chrome via `agent-browser` against a
live daemon + playground. The daemon must have `ATLAS_ALLOW_REMOTE_SKILLS`
unset or `true`. Never curl alone — curl-only QA is how the shouldAssign
bug shipped.

## 1. Invariants (true for every test)

These must hold after every action. Failing any of these is a regression.

1. **Console stays clean** — no `[error]` or `[warning]` entries in the
   DevTools console. Exceptions only for noise from unrelated tabs
   (1password, WebMCP, Snap-ins). Grep filter:
   ```bash
   agent-browser --session-name atlas-qa console | \
     grep -E '^\[(error|warning)\]' | \
     grep -vE '1password|WebMCP|HMR|Snap-ins|sourcemap'
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

**Test skill pool** (pick from these so cases are reproducible):

| Source (skills.sh)                            | Tier      | Has archive | Notes                      |
| --------------------------------------------- | --------- | ----------- | -------------------------- |
| `anthropics/skills/pdf`                       | official  | yes         | 79k installs, clean lint   |
| `anthropics/skills/mcp-builder`               | official  | yes         | Many refs, TOC warnings    |
| `anthropics/skills/frontend-design`           | official  | yes         | 318k installs              |
| `anthropics/skills/skill-creator`             | official  | yes         | Self-referential           |
| `ljagiello/ctf-skills/ctf-reverse`            | community | yes         | 18 refs, depth warnings    |
| `openai/skills/pdf`                           | official  | yes         | Tests tier sort            |
| `anthropics/skills/nonexistent`               | n/a       | n/a         | Must 404                   |

**Local skill pool:**
- `@friday/authoring-skills` — bundled, not deletable
- `@friday/workspace-api` — bundled, has `skill.ts` for code render
- `@tempest/qa-lint-test` — sandbox skill, safe to mutate

## 3. Smoke tests — one action per test

### 3.1 `/skills` (global catalog)

| # | Action                                   | Expected                                                       |
| -- | ---------------------------------------- | -------------------------------------------------------------- |
| S1 | Load page                                | Sidebar tree loads, namespaces collapsed except active         |
| S2 | Expand namespace                         | Carets rotate, skills list                                     |
| S3 | Click skill name                         | Route → `/skills/:ns/:name`, detail panel loads                |
| S4 | Click `+` button                         | Dialog opens at ≥720px width, Upload tab selected              |
| S5 | Dialog → Import tab                      | Search input appears, Install button disabled                  |
| S6 | Dialog → ESC                             | Dialog closes                                                  |
| S7 | Empty state `/skills` (no skill picked)  | Tabs render, Upload default                                    |
| S8 | Skill row shows `skills.sh` badge        | Only for remotely-installed skills (frontmatter.source)        |

### 3.2 Skill detail — `/skills/:ns/:name`

| # | Action                             | Expected                                                           |
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

### 3.3 Skill file — `/skills/:ns/:name/:path`

| # | Action                              | Expected                                              |
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

| # | Action                             | Expected                                                  |
| --- | ---------------------------------- | --------------------------------------------------------- |
| W1  | Load page                          | Three sections: Assigned / Global / Available             |
| W2  | Type in search input               | Autocomplete suggestions appear (debounced 200ms)         |
| W3  | Suggestion shows tier              | OFFICIAL green, COMMUNITY blue — visually distinct        |
| W4  | Click suggestion                   | Input fills, suggestions close                            |
| W5  | Click Install                      | Toast "Skill installed" or error; auto-assigned to WS     |
| W6  | Attach from "Available" section    | Skill moves to Assigned; toast                            |
| W7  | Detach from Assigned               | Skill moves to Available; toast                           |
| W8  | Global skill shown with no detach  | Read-only — global skills auto-visible                    |

## 4. Action chains — multi-step scenarios

Each chain must complete end-to-end without a manual reload, and every
step must satisfy §1 invariants. These are the flows users actually do.

### 4.1 Fresh install → browse → delete → re-install

**Why:** reproduces the "why is re-install at v3?!" bug.

1. `/skills` → `+` → Import tab → type `anthropics/skills/skill-creator`
2. Install → success toast, routed to `/skills/anthropics-skills/skill-creator`
3. Version badge shows **v1**
4. ⋯ → Remove → confirm
5. Routed back to `/skills`, skill gone from sidebar
6. `+` → Import → same source → Install
7. **Expected:** fresh v1 (not v2). If the skill already exists under the
   same `(namespace, name)` from another path, a **409 toast** must
   explain the conflict and point at "Check for updates".

### 4.2 Install → edit → version history → compare → restore

**Why:** full local-edit lifecycle.

1. Install `anthropics/skills/pdf` (new skill)
2. Detail page → Edit → change instructions → Save
3. Version badge flips v1 → v2 without reload
4. History dropdown shows both versions
5. Click v1 → compare dialog opens, diff shows added lines in green
6. Click Restore v1 → toast "Version restored"
7. Badge reads v3 (snapshot of v1 appended — append-only history)
8. Diff against v2 shows the new v3 matches v1's content

### 4.3 Install → lint → autofix (deterministic) → refresh check

**Why:** local-string rule path.

1. Find / craft a skill with `path-style` warning (backslash in prose)
2. Detail page → `N issues` → expand panel
3. Click Fix on `path-style` row → toast "fixed via deterministic"
4. Version badge bumps
5. Panel re-evaluates: that finding is gone

### 4.4 Install → lint → autofix (LLM) → verify conformance

**Why:** LLM rule path + authoring-skills context.

1. Install a community skill with `description-person` warning
2. Detail page → N issues → Fix on `description-person`
3. Wait ≤15s → toast "fixed via llm"
4. New description reads in third person
5. Panel re-evaluates: `description-person` gone
6. Fetch `/api/skills/@ns/name/versions` — history is append-only

### 4.5 Install → check-for-updates → no change

**Why:** upstream-idempotent path.

1. Install `anthropics/skills/pdf`
2. Click Check for updates → toast "Up to date"
3. No version bump

### 4.6 Install → check-for-updates → pull update

**Why:** upstream-changed path (hard to trigger without hacking
source-hash; acceptable to test by manually mutating the stored
`source-hash` via sqlite3, or by using a skill whose source-hash we
intentionally zero out).

1. Install, then `UPDATE skills SET frontmatter=json_set(frontmatter, '$."source-hash"', 'stale') WHERE skill_id=?`
2. Click Check for updates → toast "Update available"
3. Click Update → toast "Skill updated", version bumps
4. Lint panel refreshes

### 4.7 Workspace-scoped install

1. `/platform/user/skills` → type `anthropics/skills/pdf`
2. Install → toast with "assigned to this workspace"
3. Skill appears in Assigned section
4. Navigate to `/skills/anthropics-skills/pdf` — catalog sees it too

### 4.8 Skill navigation while compare dialog is open

**Why:** reproduces the "dialog opens on every skill click" bug.

1. Open a skill with history
2. Open compare dialog on v1
3. Click a different skill in the sidebar
4. **Expected:** dialog closes on navigate; new skill detail loads clean
5. Click History on new skill → dropdown doesn't contain stale state

### 4.9 Re-import guard with conflicts

1. Import `anthropics/skills/mcp-builder`
2. From `/skills` `+` → Import → same source again
3. **Expected:** toast "Import failed · Skill @…/… is already installed (vN). Use 'Check for updates' …"

### 4.10 Markdown anchor + code render

1. Install a skill with a reference file that links to `#some-heading`
2. Open the reference file
3. Click a TOC link → scrolls to heading (does NOT open new tab)
4. Navigate to a `.ts` file → syntax-highlighted
5. Reload with `#heading` suffix → scroll lands correctly

## 5. Error paths & known regressions

Each of these has bitten us; re-running them every QA round is mandatory.

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

## 6. Data coverage matrix

Scenarios should span these inputs to catch branch-specific bugs:

### Skill types
- Text-only skill (no archive) — just SKILL.md
- Skill with single reference — one .md file
- Skill with nested refs — triggers `reference-depth` warning
- Skill with large refs — triggers `reference-toc` warning
- Skill with SKILL.md + scripts — `.py`/`.sh` in archive

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
- `@friday/*` — bundled, must 403 on user-driven delete/mutate
- `@anthropics-skills/*` — installed remote, must allow mutation
- `@tempest/*` — ad-hoc local, full CRUD

## 7. Executing this plan

Recommended cadence:
- **Before each release:** full run of §3 + §4 + §5 (≈45 min with
  agent-browser automation)
- **Before each skills-subsystem commit:** §5 regression list + any
  §4 chain touching the code area
- **On bug reports:** add a new R-NN entry to §5 with the repro; never
  fix a bug without pinning it down here

Capture results in `docs/testing/runs/<date>-skills-qa.md` with
screenshots for any failures. Clean-console check is non-negotiable —
it's saved us three times already.

## 8. Open gaps (known holes in coverage)

1. **No automated E2E runner** — today this is all manual through
   agent-browser. A vitest-browser or Playwright harness would let us
   run the whole plan as CI. Not blocking, but flagged.
2. **No fixture library** — the "test skill pool" depends on live
   skills.sh availability. A tarball set checked into
   `packages/skills/test/fixtures/` would make the plan air-gapped.
3. **No soft-delete** — `deleteSkill` drops every version including
   history. If we ever add undelete, §4.1 needs an updated step.
4. **Workspace skill assignments across refresh** — not explicitly
   covered by any chain. Add when we touch that path again.
