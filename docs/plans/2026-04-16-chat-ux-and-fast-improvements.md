# Chat UX & FAST Improvements — Execution Plan

**Date:** 2026-04-16
**Source:** Meeting transcript (LCF + team)
**Status:** Planning — individual items to be broken into tickets and scheduled

## Context

Post-demo feedback session covering: per-workspace chat UX, chat history model,
thinking/streaming UX bugs, workspace creation optimization, and FAST platform
gaps (settings, cancellation, model routing). Also: first external communicator
(Telegram) integration underway as parallel track.

Items below are grouped by theme, with rough priority tags:
- **P0** — Must-fix bugs / blockers
- **P1** — Quality of life, near-term
- **P2** — New features, post-fixes

---

## 1. Chat: Per-Workspace, Always-On

### 1.1 Per-workspace chat always visible (P1)
Chat is always available in each workspace — not a "click to start a chat"
flow. Opening a workspace shows chat as a persistent surface, no affordance
needed to "begin".

**Clarification captured:** Not a "+" / "new chat" gating step. Always there.

### 1.2 Chat history / conversation list (P1)
Currently "new chat" clears the view and silently creates a fresh chat under
the hood. Old chats are unreachable from the UI. Keep the clearing behavior
(users want to switch tasks cleanly), but add a way back.

**Two acceptable UI patterns (pick one or both):**
- Conversation list rendered on the right side of the main content area
  (only if >1 historical conversation)
- A "history" button next to "new chat" that opens a sidebar with the full
  list; user selects which one to load

Either or both. Conversation list on right-hand side + history button is fine.

---

## 2. Chat: Streaming / Thinking UX Bugs

### 2.1 Leaving chat during thinking loses state (P0)
**Repro:** Start a long-running generation → navigate away → come back. Chat
shows nothing. May also block new chats from being started.

**Investigation:** Not just visual — may be a real blocker. Probably a subscriber
/ event replay issue (see existing SSE reconnection notes in memory). Confirm
whether the web adapter's replay path handles the navigate-away case.

### 2.2 Chat input grays out while LLM is responding (P0)
Currently the input is disabled during LLM response. Should be possible to keep
typing and queue additional context while the model is still generating. LLM
figures out how to incorporate late-arriving input.

**Good news:** The web adapter is ours (custom), not Vercel's — this is
fully in our control. No upstream dependency.

### 2.3 Thinking blocks — compress to one-line toggle (P1)
Keep expanded-thinking display (loved). But verbose tool-call chatter (e.g.
workspace creation's 18 trial-and-error calls) clutters the conversation.

**Pattern to mirror:** HelloFriday.ai collapses a thinking/tool block to a
single-line summary that expands on click. Not about hiding — about density.

---

## 3. Workspace Creation: Optimize Tool Calls

### 3.1 Skill-based workspace creation (not a new agent) (P1)
Root cause of verbose chat: workspace creation LLM is trial-and-error because
the current skill is rudimentary and doesn't ship the full config type
definitions.

**Approach:** Upgrade the existing workspace-creation skill to cover every
supported config shape. Resist building a custom agent — agents become stale
as new config cases emerge; a single comprehensive skill is easier to keep
current. First try is "literally just build a skill that covers every possible
case and optimize that."

### 3.2 Meta-skill: when to build what (P2, depends on 3.1)
Downstream of 3.1, once we're using it: a skill/guidance for *when* to build
an agent vs. build a skill vs. use a skill vs. configure an LLM agent.
This emerges from usage feedback — do not front-load before we have data.

---

## 4. FAST Platform Gaps

### 4.1 Task cancellation (P0) — [STATUS: done, MVP]
FAST needs a way to cancel a running task. Currently no escape hatch.

**Shipped (2026-04-17, lcf):**
- `WorkspaceRuntime` tracks an `AbortController` per in-flight session in
  `activeAbortControllers` (keyed by sessionId). Composed with any upstream
  AbortSignal so client disconnects also cancel.
- `cancelSession()` aborts the controller with an AbortError-named Error; the
  signal threads into `engine.signal({..., abortSignal})` and from there into
  `AgentOrchestrator.executeAgent({..., abortSignal})`, which already sends
  `notifications/cancelled` to the MCP agents server.
- `SessionStatusSchema` extended with `"cancelled"` so the terminal event
  carries the right status through to the session view and history adapter
  (previously the runtime translated "cancelled" → "failed" on emit).
- Runtime catch block and success path both check
  `effectiveAbortSignal.aborted` and force `WorkspaceSessionStatus.CANCELLED`
  when set — the orchestrator currently maps MCP "cancelled" → "completed",
  so we need this server-side check to avoid false success.
- HTTP: `DELETE /api/sessions/:id` now routes via `runtime.hasActiveSession(id)`
  against the in-flight map (the old path searched `getSessions()` which only
  holds finalized sessions, making the endpoint effectively dead).
- Playground chat: "Stop response" button appears while streaming; clicking it
  calls `chat.stop()` (client-side SSE abort) + DELETE against the
  `data-session-start` sessionId.

**QA:** Chrome playground, fresh chat, long 3000-word prompt, Stop clicked
after 4s → session persists with `status: "cancelled"` and duration 3.5s.

**Known gaps (acceptable for MVP):**
- Worker layer (`worker-executor.ts`) still uses timeout-based termination;
  abort doesn't interrupt mid-worker code actions.
- Stale tool-card "running…" remains in the UI for the last in-flight tool at
  abort time. Re-opens after reload with the final cancelled state.

### 4.2 Settings page (P1) — [STATUS: done, MVP]
Models are already chosen and wired up; the settings UI just isn't exposed.
**Approach:** Ship a simple settings page that surfaces whatever is already
configurable. Don't over-design upfront — iterate based on what feels missing
once people use it. Admin settings layer on later.

Check: https://github.com/tempestteam/atlas/pull/2894

**Shipped (2026-04-17, lcf):**
- New route `tools/agent-playground/src/routes/settings/+page.svelte` — table
  of every key/value pair from `~/.atlas/.env`, with add / remove / save.
  Keys containing `KEY`, `TOKEN`, `SECRET`, or `PASSWORD` render as password
  inputs so screenshots don't leak secrets.
- Wires to the pre-existing `GET/PUT /api/config/env` endpoints in
  `apps/atlasd/routes/config.ts` (no new daemon routes needed).
- Sidebar entry added in
  `tools/agent-playground/src/lib/components/shared/sidebar.svelte:30`.
- `SessionStatusSchema` and `StatusBadge` both extended with `"cancelled"` as
  a side effect of 4.1; picks up a greyed-out pill on the sessions page
  automatically.

**QA:** Chrome playground → `/settings` loads all 17 `.env` keys, edits round-
trip through `PUT /api/config/env`, daemon sees the update on next
`GET /api/config/env`. Daemon restart still needed for values to take effect
in-process (that's a surfacing limitation, not a settings-page one).

**Not shipped (out of scope for MVP):**
- Model routing picker (per-role defaults live in `friday.yml` / env, not in
  `.env`) — wait for 4.3.
- Admin vs. user setting split.
- Validation of keys against known set; today any key is accepted.

### 4.3 Per-step model routing (P2) — [STATUS: blocked on 4.2]
Claude Code agent currently uses Opus for everything. Want a router so some
steps use cheaper/faster models when Opus isn't needed. Blocked on 4.2
(settings) landing first so there's a place to configure it.

### 4.4 Workspace signals firing multiple jobs (P0) — [STATUS: cannot reproduce, parked]
Observed during demo: firing a signal from the workspace kicks off multiple
jobs instead of one. Root cause unknown. Needs investigation — possibly a
subscriber duplication or an idempotency gap in the signal dispatch path.

**Investigation notes (2026-04-17, lcf):**
- QA via curl on live daemon: `POST /api/workspaces/user/signals/chat` → exactly
  1 session per fire (both JSON and SSE variants). No duplicate dispatch.
- QA via Chrome on playground chat: sending one chat message → exactly 1
  `handle-chat` session. Historical pattern of 3–4 consecutive sessions in
  a 7-second window traced to the reviewer's own rapid-fire QA, not a bug.
- Traced dispatch path: HTTP → `triggerWorkspaceSignal` → runtime.processSignal
  (`packages/workspace/src/runtime.ts:769-820`) → `matchingJobs[0]` only runs
  the first matching job even if duplicates are registered.
- Suspicious-but-not-a-bug-today:
  - `runtime.ts:534` — standalone `*.fsm.yaml` files get auto-assigned *all*
    workspace signals as triggers. Fragile; guarded by matchingJobs[0].
  - Two `.post()` handlers on `/:workspaceId/signals/:signalId`
    (`routes/workspaces/index.ts:1611` SSE + `:1728` JSON). Tested: only the
    matching one fires per request.
- **To resume:** need a concrete repro. Specifically: which workspace, which
  signal/chat action, and how many sessions appear in `/api/sessions` after a
  single trigger. Consider adding instrumentation (log every `processSignal`
  call with signal id + caller stack) so the next occurrence is easier to
  trace.

### 4.5 Tool selection: us vs OpenColors vs Hermes (P2)
Evaluate moving tool selection off Vercel default. Motivation is
**transparency** — we want to log tool selection decisions, which is hard to
do inside the current stack. Decision item, not a commitment yet.

---

## 5. External Communicators (Parallel Track)

### 5.1 Telegram integration (in progress — LCF)
Connect one external communicator end-to-end to validate the pattern, then
iterate and add more (WhatsApp already has notes in memory; others TBD).

---

## Execution Order (Suggested)

**Sprint 1 — Unblock chat UX (P0 bugs first):**
1. 2.1 — Navigate-away loses state / blocks new chats (investigation + fix)
2. 2.2 — Allow typing while LLM is responding
3. 4.1 — Task cancellation
4. 4.4 — Multiple signal firings investigation

**Sprint 2 — Quality of life:**
5. 1.1 — Per-workspace always-on chat
6. 1.2 — Conversation list / history button
7. 2.3 — Collapsed thinking blocks
8. 4.2 — Settings page (expose existing config)

**Sprint 3 — Optimization & longer-term:**
9. 3.1 — Workspace creation skill upgrade
10. 4.3 — Per-step model routing (after 4.2)
11. 4.5 — Tool selection approach evaluation
12. 3.2 — Meta-skill for "when to build what" (after 3.1 usage data)

**Parallel track:**
- 5.1 — Telegram integration (LCF, independent)

---

## Open Questions

- 2.1: Is this the same root cause as the documented SSE reconnection bug
  (`apps/atlasd/routes/chat.ts` + `stream-registry.ts`), or a separate issue
  specific to the web adapter's subscriber lifecycle?
- 4.4: Does "multiple jobs" mean duplicate executions of the same run, or
  multiple distinct runs queued? Need a clean repro before fixing.
- 1.2: Conversation list on right-hand panel AND history button, or just one?
  Leaning toward both, but pick one first and iterate.
