# Meeting Backlog — 2026-04-17

**Source:** Team call (LCF + Ken + Eric, evening of 2026-04-17)
**Status:** Extracted from transcript. Items already shipped on `declaw`
are omitted. Complements `docs/plans/2026-04-17-remaining-chat-and-fast-work.md`
(which covers 3.1 / 3.2 / 4.3 / 4.5 — not duplicated here).

**Successor doc:** `docs/plans/2026-04-21-launch-readiness.md` captures
the 2026-04-21 strategic reset (keep core closed, open-source the
standard distribution; the three bodies of work required for launch).
B.1, B.6, C.1 from this backlog are load-bearing for that plan.

Priority tags: **P0** blocker, **P1** near-term, **P2** follow-up.

**Progress legend** (last synced 2026-04-21 against `declaw` tip
`080f25c6f0`): ✅ done · ◐ partial · ☐ not started. Status lines per
item name the commits or branches that moved the needle.

---

## A. Chat Architecture (biggest open design question)

### A.1 ☐ Combined communicator stream in workspace chat (P1)
**Status:** not started. No unified fan-in surface on `declaw` yet.
Personal workspace chat should be the **single admin DM** for the user,
fed by every communicator (Slack, Discord, email, Telegram, WhatsApp, API).
Inbound fans in; outbound does *not* fan out. Per-communicator replies
stay on their channel; FAST Studio sees the unified work stream.

**Why:** Mirrors how users actually text humans — one thread per peer,
linear, no cross-communicator thread sprawl. Removes the "which chat do I
reply in" friction for users and keeps FAST as a single pipe.

**Model captured in the call:**
- Workspace chat = DM (linear, no threads).
- One DM per "peer" — a communicator at most, not per-thread-within-it.
- No "new chat" button for communicator traffic; it's implicit.

### A.2 ☐ Scoped sub-chats in workspaces (bucketlist use case) (P1)
**Status:** not started.
Separate from A.1: allow creating a **sub-chat** on a workspace that's
configured for a specific caller. This is the bucketlist / multi-tenant
API case — a chat wrapper that restricts which tools/jobs are available,
verifies JWT/header shape, and gets a tenant key.

**Shape of the API design to figure out:**
- A "chat manager" on the workspace: singleton vs. multi-chat config.
- Per-sub-chat tool allowlist, job allowlist, incoming-signal shape.
- Tenant key → webhook signature + data access restrictions
  (see Manu's Snowflake view as the reference integration).
- Storage scaling story: SQLite + markdown today → offer "infinite
  chats" as a paid tier later.

### A.3 ◐ "Running in background" acknowledgement in personal chat (P0)
When the chat kicks off a long tool call or dispatch, there's currently
**no visual acknowledgement**. Users don't know whether anything is
happening. Needs a persistent "Friday is working on X" indicator
distinct from the in-message tool cards — something that sticks around
even if the response is delayed.

**Status:** partial. `18297d39b0` / `080f25c6f0` added a "Thinking…"
placeholder assistant bubble that covers the pre-first-token window
and hides the moment real content (text or tool-call cards) arrives.
The stronger ask — a persistent "working on X" indicator that survives
long async dispatch after tool cards finish — isn't built yet.

### A.4 ✅ Debug/inspector panel for active context (P1)
A tab on the chat that shows, in real time: **active skills, active
tools, active workspace, what's in scope**. Useful while we iterate; can
graduate to a dev-mode-only toggle later.

**Status:** shipped. `c9b0292aa8` landed the Context tab on the
chat-inspector (active agent, model, skills, session loads); follow-up
polish in the chat-inspector component since.

---

## B. Workspace Model & UX

### B.1 ☐ Move `.atlas/` from `$HOME` to CWD (P0)
Today everything lives in `~/.atlas/`, so only one Friday can run on a
machine at a time. Move to a project-level `.atlas/` directory (like
`.git/` or `.claude/`). Multiple Fridays in different CWDs = separate
state. Global config layer can come later; don't block on it.

**Bonus:** bundling / export (B.6) becomes straightforward once state is
CWD-scoped.

**Status:** not started. `packages/utils/src/paths.ts:getAtlasHome()`
still defaults to `~/.atlas`. This is the outstanding P0 blocker.

### B.2 ✅ Workspace-level `.env` (P1)
Currently `.env` is only honored at the root. Add workspace-level
`.env` so each workspace can carry its own credentials without polluting
the global namespace.

**Status:** shipped. `packages/workspace/src/manager.ts` loads per-
workspace `.env` (falling back to the root) during workspace
registration; UI shows whether the file exists.

### B.3 ◐ Hide Personal workspace's run list / job pages (P1)
Personal workspace shows runs from the workspace chat itself, plus the
Jobs page renders "No job configured" when empty. Neither is useful in
Personal — it's an admin chat, not a job runner.
- Jobs tab: hide or render a meaningful empty state.
- Runs tab: hide handle-chat sessions (partially done already via
  `fb0e698fc2`; verify Personal is fully scrubbed).

**Status:** partial. `HIDDEN_JOBS = new Set(["handle-chat"])` filter
lives in `/platform/:ws/+page.svelte` and `/platform/:ws/sessions/
+page.svelte`, so handle-chat sessions no longer clutter the Runs
widgets. The Jobs-tab polish on Personal (hide entirely vs. meaningful
empty state) isn't done yet.

### B.4 ✅ Workspace creation from the chat (P1)
"Create a workspace called X" should work from the Personal chat. Empty
workspace with just a name, then the user layers config.

**Status:** shipped. `99f9892b27` added a `<workspace_management>`
section to the workspace-chat system prompt that instructs Friday to
`load_skill @friday/workspace-api` and call `POST /api/workspaces/create`
via `run_code` (e.g. `deno eval 'fetch(...)'`). No new tool — the
pre-existing `workspace-api` skill covers it. QA'd end-to-end in Chrome.
Full planner wiring (C.1) stays open as a follow-up for richer
"create a workspace for X" prompts.

### B.5 ✅ Finish admin-mode gating (`ATLAS_EXPOSE_KERNEL`) (P1)
The env var exists but the system / kernel workspace still leaks into
the playground under the default (non-admin) mode. Audit:
- Sidebar workspace list filter.
- Memory page workspace list (`thick_endive` / `fizzy_waffle` still
  visible during the call).
- Direct-URL routes to those workspaces (403 or silent-redirect).

**Status:** shipped. `exposeKernel` flag threaded through
`apps/atlasd/src/atlas-daemon.ts` → factory context → workspaces index
route and `routes/memory/index.ts`. Chat SDK instance also honours it.
Kernel stays hidden in the default mode; direct URLs filtered at the
API boundary.

### B.6 ✅ Bundle / export feature — Michal (P1)
Ship two export scopes:
1. **Per-workspace** — single archive with workspace.yml + skills +
   agents + memory snapshot.
2. **Whole-Friday** — the full distribution a user can hand to someone
   else: workspaces, skills, agents, env template (no secrets).

**Status:** shipped. Merged via PR #2899 (`ba6dca122e`, content-addressed
packaging) + PR #2974 (`9c993762f5`, follow-up). `@atlas/bundle` package
(`bundle.ts`, `bundle-all.ts`, `global-skills.ts`, `hasher.ts`,
`lockfile.ts`) and daemon routes — `GET /:workspaceId/bundle`,
`GET /bundle-all`, `POST /import-bundle` — are live on `declaw`. Lays
the groundwork for B.7.

### B.7 ☐ Workspace / skill registry ("community spaces") (P2)
**Status:** not started. Gated on B.6 landing first.
A tab for browsing and pulling down workspaces and skills from a
registry (GitHub to start). Paid workspaces attach a license/payment
gate; free ones are just `git clone` + import.
- Skills auto-discovery: when a skill is requested but missing,
  suggest the registry match.
- Workspace install: `friday install <name>` → adds to workspace list.

---

## C. Workspace Creation Quality (extends 3.1)

### C.1 ☐ Wire `workspace-planner` system agent into chat (P0)
It exists (`packages/system/agents/workspace-planner/`) and produces a
validated Blueprint JSON that the compiler deterministically expands
into a working workspace. Today the conversation agent cannot invoke it
— system agents aren't exposed as tools in the workspace chat. Wire
this tool in so the chat can fall through to it for "create a workspace
for X" prompts.

**Performance gap:** the planner is slower than Ken's manual skill.
Target: planner at or under the skill's wall-clock.

**Status:** not started. Agent exists (`packages/system/agents/
workspace-planner/`) but `workspace-chat` doesn't import or expose it
as a tool. Remains a P0 blocker for B.4.

### C.2 ☐ Full-config skill (extends 3.1) (P1)
**Status:** not started on `declaw`.
Reference in 3.1 should include: `packages/config/` schema, full
`workspace.yml` example, Friday CLI reference, Friday REST API. Single
skill with sub-references rather than three separate skills — easier to
keep in sync.

---

## D. Skills: Scoping

### D.1 ✅ Per-workspace and per-job skill scoping (P1)
Skills today are global. Two levels of scoping needed:
- **Workspace level** (minimum): attach a skill to a workspace.
- **Job level** (ideal): attach a skill to a specific job step.

Plays into C.1 so that workspace-creator only loads config-authoring
skills; the chat doesn't see them in other contexts.

**Status:** shipped. Full v9 plan landed via four PRs on `declaw`:
`b939a44436` (schema + migration + query audit), `fba4c9464c`
(resolver + adapter CRUD + drift-invariant tests), `12663e2018`
(scoping API body flip + declarative-skill warnings), `61b7e3f89a`
(UI). Subsequent polish commits added the two-section Job Skills
redesign, install-from-skills.sh on the job page, pinned/inherited
breakdown on the jobs list, and detach-uninstalls-orphaned-skills.
Design doc: `docs/plans/2026-04-20-job-scoped-skills.v9.md`.

---

## E. Memory

### E.1 ☐ Background memory-commit step during chat (P1)
**Status:** not started. `memory_save` tool exists but no heartbeat /
end-of-turn hook yet.
Add a step in `handle-chat` that, on a heartbeat (end of turn?),
evaluates "is there anything worth committing to memory here" and
silently calls `memory_save`. Short prompt, cheap model (classifier
archetype from `friday.yml`).

### E.2 ☐ Short-term memory windowing (P2)
**Status:** not started.
Load only the last N days of short-term memory into context. Today it's
the full file; long-running users will OOM the context window.

### E.3 ☐ Long-term memory pruning / RAG (P2, follow-up to E.1)
**Status:** not started. Gated on E.1.
Once background commits (E.1) are writing regularly, long-term memory
grows fast. Two tracks:
- Free tier: flat-file search, user prunes manually or accepts
  degradation.
- Paid tier: embed + RAG-search memory at load time.

### E.4 ☐ Session-history digest job (P2)
**Status:** not started.
A scheduled job on the system workspace that reads finished sessions,
distills long-term memory commits + improvement suggestions, and
surfaces them in the improvements inbox. Closes the loop between chat
transcripts and the existing autopilot flow.

---

## F. Agent Infrastructure

### F.1 ☐ Structured config on agents — Eric's proposal (P2)
**Status:** not started.
Today `structuredInput` / `structuredOutput` exist; add `structuredConfig`
(Zod schema). Registry lists the config schema; UI renders a form; the
agent reads typed config at invocation time. Use cases: model selection,
retry counts, provider switching (EXA vs. Parallel in the web agent),
any tinkerer knob.

### F.2 ☐ Cloud Code / Py agent per-step router (P2, extends 4.3)
**Status:** not started.
Within a single agent run, step 1 uses Opus (planning), steps 2–N use
Sonnet (execution). The router is a mapping from step-kind → archetype,
sourced from `friday.yml` via the newly-landed `PlatformModels`.

---

## G. Communicators

### G.1 ☐ Discord adapter (P1)
Telegram and WhatsApp landed (`349a9f382d`). Discord is next — same
adapter pattern, Sarah can own.

**Status:** not started. Only placeholder at
`docs/integrations/discord/README.md`; no adapter code.

### G.2 ◐ Communicators UI — Sarah (P1)
No UI for communicator config today, only env vars. Needs:
- List of configured communicators per workspace.
- Add/remove/edit via form (webhook URL, bot token, signature secret).
- Connection status indicator (green = receiving, red = last failure).

**Status:** partial. Backend client/routes refactored onto a typed
`link-client` (`ff0db451e1`, `faa9626eb2`), Telegram/WhatsApp managed-
bot flows live, disconnect handlers unified (`8f6e0db7b8`). The per-
workspace UI form (list + add/edit + status dot) isn't built on
`declaw` yet.

---

## H. Visual Polish — David

### H.1 ✅ Job Inspector — fix empty state + scroll (P1)
Screenshot-verifiable bugs captured during the call:
- Workspace with no jobs renders "No jobs configured" with no useful
  affordance — should link to "Create a job" or just hide the card.
- Multi-workspace view clips off the top (can't scroll to first
  workspace header).

**Status:** shipped. `7fd7e34e35` rewrote the hero-dag layout
(`display: grid; align-content: start`) so the picker scrolls from row
1 properly, and made empty workspaces render as dashed cards with an
italic "No jobs configured — add one" link to `/platform/:ws/jobs`.

### H.2 ☐ Marketing site (P1)
**Status:** not tracked on `declaw`; lives outside this monorepo scope.
Fresh landing / product pages aligned with the FAST pitch. Visual
polish on existing screens — no UX changes without explicit ask.

### H.3 ◐ Specific UI asks as they come up (P2)
Channel for David: ship him specific, framed problems ("this screen
is cluttered, the data model is X, design a denser view") rather than
"design the workspace page". Avoids scope drift.

**Status:** active. Recent David-authored work merged: design system
tokens + `IconLarge` set + sidebar refresh (PR #2972, merged as
`218477a27d`); settings primary/fallback model chain (`8f5f321268`,
`4629efd3f7`, `4273b209ae`, `4fdec9e36f`, `bf0d228601`). Ongoing
ad-hoc: settings light-mode token fix (`32e928bdb0`), chat thinking
indicator (`080f25c6f0`), inspector scroll/empty-state (`7fd7e34e35`),
jobs-list skills breakdown (`84ab940441`).

---

## I. Suggested Order

**Tomorrow (all-hands pickup):**
1. B.1 `.atlas/` → CWD (unlocks B.6)
2. A.3 background-running indicator
3. C.1 wire `workspace-planner` into chat
4. H.1 Job Inspector (David)
5. G.1 Discord + G.2 communicators UI (Sarah)
6. B.6 export/bundle (Michal)

**After that:**
- A.1 combined communicator stream
- A.2 scoped sub-chats (bucketlist)
- D.1 skill scoping
- E.1 background memory commits

**Schedule when someone has headspace:**
- F.1 structured config
- F.2 per-step router
- B.7 registry
- E.2–E.4 memory follow-ups

### Sync as of 2026-04-21 (second pass, evening)

Two items moved since the morning sync:
- **B.4** shipped via `99f9892b27` (prompt-only; reuses the existing
  `@friday/workspace-api` skill + daemon HTTP API instead of a new tool).
- **B.6** merged to `declaw` via PR #2899 + PR #2974.

**Done:** A.4, B.2, B.4, B.5, B.6, D.1, H.1 (7).
**Partial:** A.3, B.3, G.2, H.3 (4).
**Not started:** A.1, A.2, B.1, B.7, C.1, C.2, E.1, E.2, E.3, E.4,
F.1, F.2, G.1, H.2 (14 — B.1 and C.1 are the outstanding P0s).

**Revised picks for the next pickup:**
1. **B.1** `.atlas/` → CWD (still the P0 blocker; nothing moved).
2. **C.1** wire `workspace-planner` into chat (P0; richer than the
   B.4 prompt path — needed for "create a workspace for X" where
   the planner should blueprint jobs/signals, not just stub a
   blank one).
3. **A.3** upgrade the thinking bubble to a persistent "working on
   X" badge that survives long async dispatch after tool cards
   finish.
4. **G.1** Discord adapter — ready for Sarah.
5. **B.7** workspace/skill registry — B.6 is now unblocked.

---

## J. Open Questions Captured

- **A.2:** Does a sub-chat inherit the parent workspace's tool list and
  narrow down, or start empty and whitelist up? Inheritance is faster
  to ship but leakier to reason about.
- **B.1:** How do we migrate existing users' `~/.atlas/`? Copy on first
  launch, prompt, or silent?
- **E.1:** Does the memory-commit step run inline (blocks turn end) or
  fire-and-forget? Inline = deterministic; fire-and-forget = faster
  user-visible completion.
- **F.1:** Does structured config live per-agent-instance (workspace
  overrides) or per-agent-definition (global)? Probably both, but
  spec the merge rule before building.
