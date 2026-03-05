# QA Plan: Workspace Direct Chat

**Context**: `docs/plans/2026-03-04-workspace-direct-chat.md`
**Branch**: `feat/workspace-chat`
**Date**: 2026-03-04

## Prerequisites

- Daemon running (`deno task atlas daemon start --detached`)
- Web client running (`cd apps/web-client && npm run dev`)
- **Create test workspace A** with a custom job (with `inputs` schema) and a
  custom agent:
  ```bash
  deno task atlas prompt "Create a workspace called 'qa-grocery' with:
  - A job called 'add-item' that adds items to a grocery list, with inputs schema: item (string, required), quantity (number, default 1)
  - A job called 'list-items' that lists all grocery items
  - A custom agent for managing the grocery list"
  ```
- **Create test workspace B** (minimal, for isolation testing):
  ```bash
  deno task atlas prompt "Create a minimal workspace called 'qa-notes' with a single job called 'save-note' that saves a note"
  ```
- Note workspace IDs for both (check `deno task atlas workspace list`)

## Cases

### 1. ChatProvider endpoint routing (verify fix)

**Trigger**: Open browser devtools Network tab. Navigate to workspace A's chat
page (`/spaces/{spaceIdA}/chat`). Send a message. Inspect the POST request URL.

**Expect**: POST hits `/api/workspaces/{workspaceId}/chat`, NOT `/api/chat`.
Stream resumption (GET) and stop (DELETE) also use the workspace-scoped
endpoint.

**If broken**: Check `ChatProvider` at
`apps/web-client/src/lib/modules/conversation/chat-provider.svelte` — the
`apiEndpoint` prop should flow into `DefaultChatTransport` and the stop handler.

---

### 2. API: Create workspace chat via POST

**Trigger**: `curl -X POST http://localhost:8080/api/workspaces/{workspaceIdA}/chat -H 'Content-Type: application/json' -d '{"chatId":"test-chat-1","messages":[{"role":"user","content":"What can you do?"}]}'`

**Expect**: SSE stream response (`text/event-stream`). Events include
`data: {...}` chunks with assistant response. Response ends with
`data: [DONE]`. The assistant should mention workspace capabilities (jobs,
agents).

**If broken**: Check `apps/atlasd/routes/workspaces/chat.ts`. Verify route is
mounted in `apps/atlasd/routes/workspaces/index.ts`. Check daemon logs:
`deno task atlas logs --since 60s --level error,warn`

---

### 3. API: List workspace chats

**Trigger**: After creating a chat in case 2, call
`curl http://localhost:8080/api/workspaces/{workspaceIdA}/chat`

**Expect**: JSON response with `{ chats: [...], nextCursor, hasMore }`. Array
contains the chat created in case 2 with `id`, `title`, `workspaceId` fields.
`workspaceId` matches workspace A.

**If broken**: Check `packages/core/src/chat/storage.ts` —
`listChatsByWorkspace()` reads from `{ATLAS_HOME}/chats/{workspaceId}/`
subdirectory. Verify files exist:
`ls ~/.atlas/chats/{workspaceIdA}/`

---

### 4. API: Get specific workspace chat

**Trigger**: `curl http://localhost:8080/api/workspaces/{workspaceIdA}/chat/test-chat-1`

**Expect**: JSON with `id`, `title`, `workspaceId`, and `messages` array. Should
contain both the user message and assistant response from case 2. Messages
capped at last 100.

**If broken**: Check `ChatStorage.getChat()` path resolution — workspace chats
at `{ATLAS_HOME}/chats/{workspaceId}/{chatId}.json`.

---

### 5. Chat isolation: workspace A vs workspace B

**Trigger**:
1. Create a chat in workspace B: `curl -X POST http://localhost:8080/api/workspaces/{workspaceIdB}/chat -H 'Content-Type: application/json' -d '{"chatId":"test-chat-b","messages":[{"role":"user","content":"Hello"}]}'`
2. List workspace A chats: `curl http://localhost:8080/api/workspaces/{workspaceIdA}/chat`
3. List workspace B chats: `curl http://localhost:8080/api/workspaces/{workspaceIdB}/chat`
4. Try to access workspace B's chat via workspace A's endpoint: `curl http://localhost:8080/api/workspaces/{workspaceIdA}/chat/test-chat-b`

**Expect**:
- Workspace A list contains only workspace A chats
- Workspace B list contains only workspace B chats
- Cross-workspace chat access returns 404

**If broken**: Check `ChatStorage` — `getChat` uses
`{workspaceId}/{chatId}.json` path. If it falls back to bare `{chatId}.json`,
isolation is broken. Check `packages/core/src/chat/storage.ts`.

---

### 6. Chat isolation: workspace vs global

**Trigger**:
1. List global chats: `curl http://localhost:8080/api/chat`
2. List workspace A chats: `curl http://localhost:8080/api/workspaces/{workspaceIdA}/chat`

**Expect**: Global chat list does NOT contain workspace A chats. Workspace A
list does NOT contain global chats. The two lists are fully disjoint.

**If broken**: `listChats()` reads from `{ATLAS_HOME}/chats/` root (files only,
not subdirectories). `listChatsByWorkspace()` reads from
`{ATLAS_HOME}/chats/{workspaceId}/`. If `listChats` recurses into
subdirectories, isolation breaks.

---

### 7. Reserved "chat" signal name

**Trigger**: Create a `workspace.yml` that defines its own `chat` signal:
```yaml
workspace:
  name: "signal-conflict-test"
signals:
  chat:
    provider: http
    config:
      path: /webhook
jobs:
  handle-webhook:
    triggers:
      - signal: chat
    execution:
      strategy: sequential
      agents:
        - id: conversation
```
Load or create this workspace.

**Expect**: Daemon emits a clear error at workspace load time:
`Workspace "..." defines a "chat" signal, but "chat" is reserved for workspace direct chat. Rename your signal.`
The workspace should fail to initialize, not silently override the system chat
signal.

**If broken**: Check `packages/workspace/src/runtime.ts` lines 318-324 for the
reserved name check. If the check is missing or after injection, the user's
signal could overwrite the system one.

---

### 8. Agent: Job-as-tool invocation (structured probe)

**Trigger**: Send a workspace chat message designed to trigger the `add-item`
job: `curl -X POST http://localhost:8080/api/workspaces/{workspaceIdA}/chat -H 'Content-Type: application/json' -d '{"chatId":"test-job-invoke","messages":[{"role":"user","content":"Add milk to the grocery list, quantity 2"}]}'`

**Expect**: The agent invokes the `add-item` tool with
`{ item: "milk", quantity: 2 }`. The SSE stream includes a tool call for
`add_item` (or the job's tool name). The response confirms the item was added.

**If broken**: Check `packages/system/agents/workspace-chat/tools/job-tools.ts`.
Verify the job tool was registered — look for
`"Registered job tool"` in daemon logs. If the tool doesn't appear, check that
the workspace config has `inputs` schema and the job has a trigger signal.

---

### 9. Agent: do_task with workspace agent preference

**Trigger**: Send a workspace chat message that requires a task the workspace
agent can handle:
`"Use do_task to check what agents are available for this workspace"`

**Expect**: The agent uses `do_task`. In the planning output, workspace agents
should appear with a preference annotation (tier 1) above bundled system agents.
The agent should mention workspace-specific agents by name.

**If broken**: Check
`packages/system/agents/workspace-chat/tools/do-task.ts` — verify
`workspaceContext` is passed to `createDoTaskTool`. Check
`packages/system/agents/conversation/tools/do-task/index.ts` for the
`workspaceContext` parameter handling.

---

### 10. Agent: Empty workspace chat

**Trigger**: Create a bare workspace with no custom jobs, agents, or MCP
servers. Send a chat message: `"What can you help me with?"`

**Expect**: The agent responds sensibly — acknowledges it doesn't have
specialized tools but can still help with general tasks via `do_task`. No
errors, no empty tool list crash.

**If broken**: Check `createJobTools` with empty jobs object. Check system
prompt assembly when workspace has no agents/jobs.

---

### 11. UI: First-time experience (empty workspace chat)

**Trigger**: Navigate to `/spaces/{spaceIdA}/chat` in the browser (no prior
workspace chats).

**Expect**:
- Page shows centered "Chat with {workspace.name}" heading
- Input form is visible and focused
- No sidebar (no prior conversations)
- Breadcrumbs show workspace name with color dot

**If broken**: Check `+page.svelte` — `data.isNew` should be `true` when no
`chatId` in URL. The sidebar renders only if
`!data.isNew || workspaceChatsQuery.data?.chats?.length`.

---

### 12. UI: Send message and navigate

**Trigger**: On the empty workspace chat page, type a message and send it.

**Expect**:
- URL updates to `/spaces/{spaceId}/chat/{chatId}` (replaceState, no back
  button entry)
- Streaming response appears in real-time
- After response completes, the message history shows both user and assistant
  messages
- Input form moves to footer position

**If broken**: Check `onPostSuccess` callback in `+page.svelte` line 39. Check
`ChatProvider` — the `onPostSuccess` fires after POST succeeds.

---

### 13. UI: Chat sidebar with conversation history

**Trigger**: After creating 2-3 chats in workspace A, navigate to
`/spaces/{spaceIdA}/chat` (new chat view).

**Expect**:
- Sidebar shows "Conversations" heading
- Previous chats listed with titles (not "Untitled")
- Clicking a chat navigates to `/spaces/{spaceIdA}/chat/{chatId}`
- Active chat has reduced opacity styling

**If broken**: Check `workspaceChatsQuery` — uses `listWorkspaceChats` which
hits `GET /api/workspaces/{spaceId}/chat`. If the query returns empty despite
existing chats, check the API endpoint and storage scoping.

---

### 14. UI: Auto-generated chat title

**Trigger**: Start a new workspace chat. Send a first message. Wait for
response. Check the sidebar or chat list.

**Expect**: Chat title is auto-generated (something descriptive, not "Untitled"
or "Saved Chat"). Title appears in the sidebar conversation list and in the API
response for the chat.

**If broken**: Title generation fires on turn 2 (after first exchange) in
`workspace-chat.agent.ts`. Check `generateChatTitle` function — uses
`smallLLM()` with 50 token limit. Failure falls back to "Saved Chat". Check
`PATCH /api/workspaces/{workspaceId}/chat/{chatId}/title` endpoint.

---

### 15. Stream: Resume after page refresh

**Trigger**: Start a workspace chat with a prompt that takes time (e.g., "Write
a detailed analysis of..."). While the response is still streaming, refresh the
page (Cmd+R).

**Expect**:
- Page reloads and shows the partial response
- Stream resumes from where it left off (no duplicate content)
- Response continues to completion
- OR: if stream finished during reload, full response is shown from storage

**If broken**: Stream resumption depends on `GET /api/workspaces/{workspaceId}/chat/{chatId}/stream`
and `StreamRegistry` buffer. If `ChatProvider` is hitting `/api/chat/{chatId}/stream`
(the global endpoint), resumption breaks. Also check: `StreamRegistry` is
in-memory — if daemon restarted, buffer is gone and 204 is returned.

---

### 16. Stream: Daemon restart recovery

**Trigger**:
1. Start a workspace chat, send a long-running prompt
2. Kill the daemon: `deno task atlas daemon stop`
3. Restart: `deno task atlas daemon start --detached`
4. Reload the workspace chat page

**Expect**: The page loads with whatever messages were persisted before the
crash. The partial/incomplete assistant response may be missing (acceptable for
MVP). No error crash, no infinite loading spinner. User can send a new message
to continue.

**If broken**: Chat data is on disk (safe), but in-flight assistant message may
be lost. Check `ChatStorage.appendMessage` — writes happen during stream, so
partial writes are possible. The UI should handle a chat with only a user
message gracefully.

---

### 17. API: Missing workspace returns 404

**Trigger**: `curl -X POST http://localhost:8080/api/workspaces/nonexistent-workspace-id/chat -H 'Content-Type: application/json' -d '{"chatId":"test","messages":[{"role":"user","content":"hi"}]}'`

**Expect**: HTTP 404 response (not 500, not a hang).

**If broken**: Check route handler — should validate workspace exists before
signal dispatch. Check `ctx.getOrCreateWorkspaceRuntime(workspaceId)` error
path.

---

### 18. API: Abort mid-stream

**Trigger**: Start a workspace chat via curl, then immediately Ctrl+C to
disconnect the client.

**Expect**: The daemon handles the disconnect gracefully — logs it as debug
level, no error spam, no zombie processes. Subsequent requests to the same
workspace work normally.

**If broken**: Check abort signal propagation in
`apps/atlasd/routes/workspaces/chat.ts`. The `AbortSignal` from the HTTP
request should propagate through the signal pipeline to the agent's
`streamText` call.

### 19. Agent: Resource awareness in workspace chat

**Trigger**: Create (or use) a workspace that has at least one resource (e.g., a
document or dataset). Send a workspace chat message:
`"What resources are available in this workspace?"`

**Expect**: The agent's response mentions the resource(s) by name/type. The
system prompt should include a `<resources>` section listing workspace resources.

**If broken**: Check
`packages/system/agents/workspace-chat/workspace-chat.agent.ts` — the prompt
assembly fetches `details.resources` from the workspace details endpoint. If the
resources list is empty, check the workspace details API
(`/api/workspaces/{id}/details`) returns resources.

---

### 20. Runtime: Resource guidance in job agent prompts

**Trigger**: Using a workspace with resources AND a custom job, trigger the job
directly via signal (not through workspace chat):
`curl -X POST http://localhost:8080/api/workspaces/{workspaceId}/signals/add-item -H 'Content-Type: application/json' -d '{"item":"milk"}'`

Check daemon logs for the agent prompt.

**Expect**: The agent prompt includes a resource guidance section (e.g.,
"## Workspace Resources" with categorized resource listings — Documents,
Datasets, Files). This comes from `buildAgentPrompt` → `buildResourceGuidance`.

**If broken**: Check `apps/atlasd/src/agent-helpers.ts` — `buildAgentPrompt`
should receive `resourceAdapter`, `workspaceId`, `artifactStorage` from
`packages/workspace/src/runtime.ts`. If params are missing, resource block is
skipped. Also check that `LEDGER_URL` is set so `createLedgerClient()` succeeds
in the daemon.

---

### 21. API: Job execute blocks until completion

**Trigger**: Send a workspace chat message that invokes a job (e.g., "Add milk to
the list"). Observe the SSE stream response.

**Expect**: The agent's tool call uses `POST /api/workspaces/{id}/jobs/{jobName}/execute`
(not the signal trigger endpoint). The response includes actual job results, not
just "Signal accepted for processing". The agent relays meaningful output from the
job execution.

**If broken**: Check `packages/system/agents/workspace-chat/tools/job-tools.ts` —
`execute` should call `client.workspace[":workspaceId"].jobs[":jobName"].execute.$post`.
Check `apps/atlasd/routes/workspaces/index.ts` for the execute endpoint mounting.

---

### 22. API: Job execute returns structured results

**Trigger**: `curl -X POST http://localhost:8080/api/workspaces/{workspaceIdA}/jobs/add-item/execute -H 'Content-Type: application/json' -d '{"item":"eggs","quantity":3}'`

**Expect**: HTTP 200 with JSON containing session results (not just `{ sessionId }`).
Response should indicate the job ran to completion.

**If broken**: Check route handler at `apps/atlasd/routes/workspaces/index.ts` —
should call `runtime.executeJobDirectly()` which blocks until completion.

---

### 23. API: Job execute with invalid inputs returns 400

**Trigger**: `curl -X POST http://localhost:8080/api/workspaces/{workspaceIdA}/jobs/add-item/execute -H 'Content-Type: application/json' -d '{"invalid_field":"bad"}'`

**Expect**: HTTP 400 with validation error describing the schema mismatch.

**If broken**: Check input validation in the execute endpoint — should validate
against the job's input schema before dispatching.

---

## Smoke Candidates

- **Case 2** (API: Create workspace chat) — core happy path, exercises full
  signal pipeline
- **Case 5** (Chat isolation: cross-workspace) — isolation regression would be
  embarrassing
- **Case 8** (Job-as-tool invocation) — validates the key differentiator from
  global chat
- **Case 11** (UI: First-time experience) — first impression, easy to break
  with layout changes

