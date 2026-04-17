# Meeting Backlog — 2026-04-17

**Source:** Team call (LCF + Ken + Eric, evening of 2026-04-17)
**Status:** Extracted from transcript. Items already shipped on `declaw`
are omitted. Complements `docs/plans/2026-04-17-remaining-chat-and-fast-work.md`
(which covers 3.1 / 3.2 / 4.3 / 4.5 — not duplicated here).

Priority tags: **P0** blocker, **P1** near-term, **P2** follow-up.

---

## A. Chat Architecture (biggest open design question)

### A.1 Combined communicator stream in workspace chat (P1)
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

### A.2 Scoped sub-chats in workspaces (bucketlist use case) (P1)
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

### A.3 "Running in background" acknowledgement in personal chat (P0)
When the chat kicks off a long tool call or dispatch, there's currently
**no visual acknowledgement**. Users don't know whether anything is
happening. Needs a persistent "Friday is working on X" indicator
distinct from the in-message tool cards — something that sticks around
even if the response is delayed.

### A.4 Debug/inspector panel for active context (P1)
A tab on the chat that shows, in real time: **active skills, active
tools, active workspace, what's in scope**. Useful while we iterate; can
graduate to a dev-mode-only toggle later.

---

## B. Workspace Model & UX

### B.1 Move `.atlas/` from `$HOME` to CWD (P0)
Today everything lives in `~/.atlas/`, so only one Friday can run on a
machine at a time. Move to a project-level `.atlas/` directory (like
`.git/` or `.claude/`). Multiple Fridays in different CWDs = separate
state. Global config layer can come later; don't block on it.

**Bonus:** bundling / export (B.6) becomes straightforward once state is
CWD-scoped.

### B.2 Workspace-level `.env` (P1)
Currently `.env` is only honored at the root. Add workspace-level
`.env` so each workspace can carry its own credentials without polluting
the global namespace.

### B.3 Hide Personal workspace's run list / job pages (P1)
Personal workspace shows runs from the workspace chat itself, plus the
Jobs page renders "No job configured" when empty. Neither is useful in
Personal — it's an admin chat, not a job runner.
- Jobs tab: hide or render a meaningful empty state.
- Runs tab: hide handle-chat sessions (partially done already via
  `fb0e698fc2`; verify Personal is fully scrubbed).

### B.4 Workspace creation from the chat (P1)
"Create a workspace called X" should work from the Personal chat. Empty
workspace with just a name, then the user layers config. Related to
3.1 in the other plan (better creation skill), but the entry path
through chat is the user-visible affordance.

### B.5 Finish admin-mode gating (`ATLAS_EXPOSE_KERNEL`) (P1)
The env var exists but the system / kernel workspace still leaks into
the playground under the default (non-admin) mode. Audit:
- Sidebar workspace list filter.
- Memory page workspace list (`thick_endive` / `fizzy_waffle` still
  visible during the call).
- Direct-URL routes to those workspaces (403 or silent-redirect).

### B.6 Bundle / export feature — Michal (P1)
Ship two export scopes:
1. **Per-workspace** — single archive with workspace.yml + skills +
   agents + memory snapshot.
2. **Whole-Friday** — the full distribution a user can hand to someone
   else: workspaces, skills, agents, env template (no secrets).

**Distribution end-goal:** upload an archive, everything from LCF's box
reproduces on mine. Lays the foundation for B.7.

### B.7 Workspace / skill registry ("community spaces") (P2)
A tab for browsing and pulling down workspaces and skills from a
registry (GitHub to start). Paid workspaces attach a license/payment
gate; free ones are just `git clone` + import.
- Skills auto-discovery: when a skill is requested but missing,
  suggest the registry match.
- Workspace install: `friday install <name>` → adds to workspace list.

---

## C. Workspace Creation Quality (extends 3.1)

### C.1 Wire `workspace-planner` system agent into chat (P0)
It exists (`packages/system/agents/workspace-planner/`) and produces a
validated Blueprint JSON that the compiler deterministically expands
into a working workspace. Today the conversation agent cannot invoke it
— system agents aren't exposed as tools in the workspace chat. Wire
this tool in so the chat can fall through to it for "create a workspace
for X" prompts.

**Performance gap:** the planner is slower than Ken's manual skill.
Target: planner at or under the skill's wall-clock.

### C.2 Full-config skill (extends 3.1) (P1)
Reference in 3.1 should include: `packages/config/` schema, full
`workspace.yml` example, Friday CLI reference, Friday REST API. Single
skill with sub-references rather than three separate skills — easier to
keep in sync.

---

## D. Skills: Scoping

### D.1 Per-workspace and per-job skill scoping (P1)
Skills today are global. Two levels of scoping needed:
- **Workspace level** (minimum): attach a skill to a workspace.
- **Job level** (ideal): attach a skill to a specific job step.

Plays into C.1 so that workspace-creator only loads config-authoring
skills; the chat doesn't see them in other contexts.

---

## E. Memory

### E.1 Background memory-commit step during chat (P1)
Add a step in `handle-chat` that, on a heartbeat (end of turn?),
evaluates "is there anything worth committing to memory here" and
silently calls `memory_save`. Short prompt, cheap model (classifier
archetype from `friday.yml`).

### E.2 Short-term memory windowing (P2)
Load only the last N days of short-term memory into context. Today it's
the full file; long-running users will OOM the context window.

### E.3 Long-term memory pruning / RAG (P2, follow-up to E.1)
Once background commits (E.1) are writing regularly, long-term memory
grows fast. Two tracks:
- Free tier: flat-file search, user prunes manually or accepts
  degradation.
- Paid tier: embed + RAG-search memory at load time.

### E.4 Session-history digest job (P2)
A scheduled job on the system workspace that reads finished sessions,
distills long-term memory commits + improvement suggestions, and
surfaces them in the improvements inbox. Closes the loop between chat
transcripts and the existing autopilot flow.

---

## F. Agent Infrastructure

### F.1 Structured config on agents — Eric's proposal (P2)
Today `structuredInput` / `structuredOutput` exist; add `structuredConfig`
(Zod schema). Registry lists the config schema; UI renders a form; the
agent reads typed config at invocation time. Use cases: model selection,
retry counts, provider switching (EXA vs. Parallel in the web agent),
any tinkerer knob.

### F.2 Cloud Code / Py agent per-step router (P2, extends 4.3)
Within a single agent run, step 1 uses Opus (planning), steps 2–N use
Sonnet (execution). The router is a mapping from step-kind → archetype,
sourced from `friday.yml` via the newly-landed `PlatformModels`.

---

## G. Communicators

### G.1 Discord adapter (P1)
Telegram and WhatsApp landed (`349a9f382d`). Discord is next — same
adapter pattern, Sarah can own.

### G.2 Communicators UI — Sarah (P1)
No UI for communicator config today, only env vars. Needs:
- List of configured communicators per workspace.
- Add/remove/edit via form (webhook URL, bot token, signature secret).
- Connection status indicator (green = receiving, red = last failure).

---

## H. Visual Polish — David

### H.1 Job Inspector — fix empty state + scroll (P1)
Screenshot-verifiable bugs captured during the call:
- Workspace with no jobs renders "No jobs configured" with no useful
  affordance — should link to "Create a job" or just hide the card.
- Multi-workspace view clips off the top (can't scroll to first
  workspace header).

### H.2 Marketing site (P1)
Fresh landing / product pages aligned with the FAST pitch. Visual
polish on existing screens — no UX changes without explicit ask.

### H.3 Specific UI asks as they come up (P2)
Channel for David: ship him specific, framed problems ("this screen
is cluttered, the data model is X, design a denser view") rather than
"design the workspace page". Avoids scope drift.

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
