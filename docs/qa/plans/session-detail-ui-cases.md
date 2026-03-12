# QA Plan: Session Detail UI Redesign

**Context**: docs/plans/2026-03-09-session-detail-ui-design.md
**Branch**: david/tem-3799-updated-session-ui
**Date**: 2026-03-10

## Prerequisites

- Daemon running on localhost:8080
- Web client running on localhost:1420
- Access to sessions in different states (completed, failed, in-progress)

## Cases

### 1. Completed session — all agent rows open by default

**Trigger**: Navigate to a completed session.
**Expect**: Every agent block is expanded (open) by default. User can collapse individual blocks by clicking, but initial state is all open.
**If broken**: Check `defaultOpen` prop passed to `AgentBlockCard` — for finished sessions, all blocks should get `defaultOpen={true}`. Check `isLive` and `block.status` logic.

### 2. Failed session — all agent rows open by default

**Trigger**: Navigate to a failed session.
**Expect**: All agent blocks are expanded by default, same as completed. The failed block shows error details. The session footer shows "Failed" with red icon and error output.
**If broken**: Check `isFinished` derived (should be true for both `completed` and `failed`), `defaultOpen` logic.

### 3. In-progress session — running block open, past closed, future pending

**Trigger**: Navigate to an actively running session (or trigger one).
**Expect**:
  - Past (completed/failed) agent blocks are collapsed
  - The currently running agent block is open with a spinning progress icon and ephemeral status
  - Future (pending) agent blocks show as pending with an open dot icon and "Not started" subtitle
**If broken**: Check `defaultOpen={!isLive || block.status === "running"}` — when `isLive` is true, only running blocks should be open. Check `isPending` status rendering.

### 4. Title always shows

**Trigger**: Load sessions in each state (completed, failed, in-progress).
**Expect**: The `<h1>` always displays a title — either the job display name or the session ID as fallback. Never blank or missing.
**If broken**: Check `displayTitle` derived: `jobDisplayName || data.sessionId`. If `jobQuery` hasn't loaded yet, the session ID should still show.

### 5. Description always shows

**Trigger**: Load sessions in each state.
**Expect**: Below the title, a description paragraph is always present:
  - In-progress: "This session is actively running"
  - Completed/failed with AI summary: the summary text
  - If no AI summary yet: verify something still renders (not blank space)
**If broken**: Check the `description` snippet — `isLive && !isFinished` vs `session?.aiSummary` branches.

### 6. Sidebar — empty sections don't render titles

**Trigger**: Load a session that has no key details in its AI summary.
**Expect**: The "Summary" section heading does not appear at all — no orphaned `<h3>` with empty content below it. The sidebar skips straight from Job to Accounts (or whatever section has data).
**If broken**: Check `{#if session.aiSummary?.keyDetails && session.aiSummary.keyDetails.length > 0}` guard.

### 7. Sidebar — Accounts section with connected account

**Trigger**: Load a session whose job has integrations with connected credentials.
**Expect**: An "Accounts" heading appears, followed by a list. Each connected account shows: provider logo icon, provider name, and the account label (e.g. "david@tempest.team") in muted text below.
**If broken**: Check `jobIntegrations` derived, the credential resolution chain (job providers → config credentials → Link labels).

### 8. Sidebar — Accounts section with disconnected account

**Trigger**: Load a session whose job has an integration without a connected credential.
**Expect**: The disconnected account shows: provider logo icon, provider name, and "Disconnected" in red text below the name.
**If broken**: Check `connected` boolean in `jobIntegrations`, the `.disconnected` CSS class on `.account-label`.

### 9. Sidebar — Accounts section hidden when no integrations

**Trigger**: Load a session whose job has no integrations.
**Expect**: The "Accounts" heading and section don't appear at all. No empty list or orphaned heading.
**If broken**: Check `{#if jobIntegrations.length > 0}` guard.

### 10. Sidebar — Job section hidden gracefully when workspace unavailable

**Trigger**: Load a session where the workspace query fails or hasn't loaded yet.
**Expect**: The Job section either shows "Space unavailable" with the raw job name (no link), or shows nothing while loading. No crash, no blank section with just a heading.
**If broken**: Check `workspaceQuery.isError` branch, the `.error` class on `.job-details`.

### 11. In-progress session — status badge shows "Running"

**Trigger**: Navigate to an actively running session.
**Expect**: A yellow status badge appears above the title with a spinning progress icon and "Running" text.
**If broken**: Check `isLive` derived, the `.active` CSS class, spin animation.

### 12. Failed session — status badge shows "Failed"

**Trigger**: Navigate to a failed session.
**Expect**: A red status badge appears above the title with a close icon and "Failed" text.
**If broken**: Check `session.status === "failed"`, the `.failed` CSS class.

### 13. Completed session — no status badge

**Trigger**: Navigate to a completed session.
**Expect**: No status badge appears — the title renders directly without a badge above it. Status badges only show for non-completed states.
**If broken**: Check `{#if session.status !== "completed"}` guard.

### 14. Agent block icons from integration mapping

**Trigger**: Expand agent blocks on a session with integrations.
**Expect**: Agent-type blocks show the integration logo (Slack, Google Sheets, etc.) in the timeline icon position. LLM-type blocks show a tool-derived icon or default dot. Icons are correctly sized and aligned with the timeline.
**If broken**: Check `agentIconMap`, `stateId` matching, `getServiceIcon`.

### 15. Tool call Request/Response tabs

**Trigger**: Expand an agent block with tool calls.
**Expect**: Each non-complete tool call shows tabbed "Request"/"Response" buttons. Request tab is active by default showing args JSON. Clicking Response shows result JSON. If no result exists, the Response tab is hidden.
**If broken**: Check `tool-call-data.svelte`, `createTabs`, `hasResult` conditional.

### 16. Session completed footer

**Trigger**: Scroll to the bottom of a completed or failed session.
**Expect**: A final step block appears after all agent blocks:
  - Completed: green checkmark, "Complete", "Succeeded in {duration}"
  - Failed: red X, "Failed", "After {duration}", plus error details
**If broken**: Check `isFinished`, the `StepBlock` rendering at the end of `.steps`.

## Smoke Candidates

- Case 1 (completed — open by default; foundational interaction)
- Case 3 (in-progress — open/closed/pending states; most complex logic)
- Case 6 (empty sidebar sections hidden; prevents UI clutter regressions)
- Case 7+8 (accounts connected/disconnected; exercises full credential chain)
