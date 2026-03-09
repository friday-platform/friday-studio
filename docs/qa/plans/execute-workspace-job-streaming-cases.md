# QA Plan: Stream Workspace Signals via HTTP+SSE

**Context**: PR #1505 — replaces conversation agent's workspace execution with
real-time SSE streaming, deletes deprecated `DaemonCapabilityRegistry`, unifies
signal execution paths
**Branch**: feat/execute-workspace-job-streaming
**Date**: 2026-03-06

## Prerequisites

- Daemon running on `:8080` (`deno task atlas daemon start --detached`)
- Web client running on `:1420` (`cd apps/web-client && npm run dev`)
- A workspace with at least one configured signal — create via
  `deno task atlas prompt "create a workspace called qa-streaming-test with a
  simple echo job that returns 'hello from streaming'"` and note the workspace
  ID + signal ID

## Cases

### 1. SSE streaming happy path (curl)

**Trigger**: `curl` the signal endpoint with SSE accept header:
```bash
curl -N -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"payload":{}}' \
  http://localhost:8080/api/workspaces/<workspaceId>/signals/<signalId>
```
**Expect**: Response streams SSE events line by line:
- One or more `data: {"type":"<fsm-event>", ...}` lines (FSM progress events)
- A `data: {"type":"job-complete","data":{"success":true,"sessionId":"...","status":"completed"}}` line
- A final `data: [DONE]` line
- Connection closes after `[DONE]`
**If broken**: Check daemon logs `deno task atlas logs --since 30s`. Look at
`apps/atlasd/routes/workspaces/index.ts:807-868` (SSE middleware) and
`triggerWorkspaceSignal` in `apps/atlasd/src/atlas-daemon.ts:1127`.

### 2. JSON mode still works (curl)

**Trigger**: `curl` the same endpoint WITHOUT the SSE accept header:
```bash
curl -H "Content-Type: application/json" \
  -d '{"payload":{}}' \
  http://localhost:8080/api/workspaces/<workspaceId>/signals/<signalId>
```
**Expect**: Returns a JSON response (not a stream) with
`{"sessionId":"...","status":"completed"}`. No SSE framing.
**If broken**: The SSE middleware at `index.ts:807` should fall through to the
JSON handler at `index.ts:870`. Check the `Accept` header check logic.

### 3. Pre-stream error: nonexistent workspace (curl)

**Trigger**: `curl` with SSE header but a fake workspace ID:
```bash
curl -N -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"payload":{}}' \
  http://localhost:8080/api/workspaces/nonexistent-ws-id/signals/some-signal
```
**Expect**: HTTP 404 JSON error response (NOT an SSE stream). Pre-stream errors
should return normal HTTP responses before opening the stream.
**If broken**: Check if `triggerWorkspaceSignal` throws before the stream opens
vs. after. Look at error handling in the `.catch()` at `index.ts:843-857`.

### 4. Nonexistent signal on valid workspace (curl)

**Trigger**: `curl` with SSE header, valid workspace but fake signal ID:
```bash
curl -N -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"payload":{}}' \
  http://localhost:8080/api/workspaces/<workspaceId>/signals/fake-signal
```
**Expect**: SSE stream opens, receives a `job-error` event with error details,
then `[DONE]`, then closes. OR a pre-stream JSON error. Either is acceptable —
document which behavior occurs.
**If broken**: Check `triggerWorkspaceSignal` error path and whether the error
happens before or after stream creation.

### 5. Conversation agent triggers streaming signal (CLI)

**Trigger**: Send a prompt that references the test workspace:
```bash
deno task atlas prompt "trigger the qa-streaming-test workspace"
```
**Expect**: The response shows real-time progress (e.g., "Running space
qa-streaming-test") and completes with a summary of the workspace execution
result. The job should run to completion.
**If broken**: Check `streaming-signal-trigger.ts` — the tool must resolve the
workspace, call the SSE endpoint, parse events, and forward progress. Also check
the conversation agent prompt routing rules in `prompt.txt:191-202`.

### 6. Streaming progress visible in web UI (browser)

**Trigger**: Open `http://localhost:1420/chat`, send a message referencing the
test workspace (e.g., "run the qa-streaming-test workspace").
**Expect**: While the workspace job runs, the chat UI shows real-time progress
updates (rendered as `data-tool-progress` chunks — typically a "Running space X"
indicator). After completion, the full result appears in the conversation.
**If broken**: Check that `writer.write()` calls in
`streaming-signal-trigger.ts:141-144` and `:219` produce valid
`AtlasUIMessageChunk` objects. Inspect browser console for errors.

### 7. Workspace-chat job execution (browser)

**Trigger**: Navigate to the test workspace's chat page at
`http://localhost:1420/spaces/<spaceId>/chat`, send a message that triggers the
echo job (e.g., "run the echo job").
**Expect**: The workspace-chat agent invokes the job through the signal endpoint
(JSON mode, not SSE). The response includes the job result.
**If broken**: Check `packages/system/agents/workspace-chat/tools/job-tools.ts`
— it should call `/signals/:signalId` (not the deleted `/jobs/:jobName/execute`).
Check daemon logs for the request.

### 8. Session detail streaming (browser)

**Trigger**: After triggering a workspace signal (case 5 or 6), navigate to the
session detail page. Find the session ID from the chat response or from
`deno task atlas session list`, then visit
`http://localhost:1420/sessions/<sessionId>`.
**Expect**: The session detail page renders correctly. If the session was active
when navigated to, SSE events should stream in. If completed, the full session
state should display. No console errors.
**If broken**: The refactored `session-event-stream.ts` uses the shared
`parseSSEStream` from `@atlas/utils`. Check browser console for JSON parse
errors or schema validation failures.

### 9. Dead code removal verification

**Trigger**: Run these greps from the repo root:
```bash
grep -r "DaemonCapabilityRegistry" --include="*.ts" --include="*.js" .
grep -r "executeJobDirectly" --include="*.ts" --include="*.js" .
grep -r "daemon-capabilities" --include="*.ts" --include="*.js" .
```
**Expect**: Zero hits outside of `docs/reviews/`, git history, and test mocks.
No runtime code should reference any of these.
**If broken**: If references remain, trace the dependency chain — they indicate
incomplete cleanup that will cause compile or runtime errors.

### 10. sanitizeToolCallInputs TDD verification

**Trigger**: Spawn a sub-agent with the `tdd` skill. The agent should:
1. Read `packages/system/agents/conversation/message-windowing.ts` (the fix)
2. Read `packages/system/agents/conversation/message-windowing.test.ts` (existing tests)
3. Temporarily revert `sanitizeToolCallInputs` to a no-op (red phase) — verify
   tests fail
4. Restore the fix (green phase) — verify tests pass
5. Confirm the regression test reproduces the exact production failure: a
   `tool-call` part with `input: undefined` gets patched to `input: {}`
**Expect**: Red phase fails, green phase passes. The fix is correctly guarded.
**If broken**: If red phase passes (tests don't fail), the test doesn't actually
exercise the fix. Strengthen the assertions.

### 11. Client disconnect resilience

**Trigger**: Start an SSE stream and abort mid-flight:
```bash
# Start stream, kill after 2 seconds
timeout 2 curl -N -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"payload":{}}' \
  http://localhost:8080/api/workspaces/<workspaceId>/signals/<signalId>
```
Then immediately check daemon logs:
```bash
deno task atlas logs --since 10s --level error,warn
```
**Expect**: No unhandled promise rejections or error-level log entries. The
per-chunk callback wraps `enqueue` in try/catch, and a `.finally()` block
ensures `controller.close()` is always called. Debug-level "Client disconnected"
log is expected and fine.
**If broken**: Check the `.finally()` block at the end of the promise chain in
the SSE middleware. If removed, client disconnect after job completion would
leave the stream controller dangling.

### 12. Stale test mock detection

**Trigger**: Read `packages/system/agents/workspace-chat/tools/job-tools.test.ts`
and compare mock setup to actual implementation in `job-tools.ts`.
```bash
grep -n "jobs.*execute\|signals.*post" \
  packages/system/agents/workspace-chat/tools/job-tools.test.ts \
  packages/system/agents/workspace-chat/tools/job-tools.ts
```
**Expect**: The test mocks should mock the same endpoint as the implementation
calls. Implementation calls `/signals/:signalId`, so mocks should match.
Mock data should use `status: "completed"` (matching the fixed JSON endpoint).
**If broken**: If mocks reference the old `/jobs/:jobName/execute` endpoint or
use stale status values like `"processing"`, they provide false confidence.

## Smoke Candidates

- **Case 1** (SSE streaming happy path) — fundamental protocol test, durable,
  fast to run, catches regressions in SSE middleware or signal processing
- **Case 2** (JSON mode still works) — guards against SSE middleware breaking
  the existing JSON path
- **Case 5** (conversation agent triggers signal) — E2E through the primary
  user-facing flow, catches tool wiring issues
- **Case 9** (dead code removal) — grep-based, instant, prevents zombie code
  from creeping back
