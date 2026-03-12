# QA Plan: Workspace Chat Resource Access

**Context**: docs/plans/2026-03-06-workspace-chat-resource-access.v6.md
**Branch**: workspace-chat-resource-access
**Date**: 2026-03-09

## Prerequisites

- Daemon running: `deno task atlas daemon start --detached`
- Web client running: `cd apps/web-client && npm run dev` (for browser cases)
- No external credentials required for core cases (Notion/Google Sheets cases are skip-if-unavailable)

## Setup: Create Test Workspace

Before running cases, create a fresh workspace with document resources and no
external services. This exercises the planner CRUD-job suppression simultaneously.

```bash
deno task atlas prompt "I want to track my daily food intake — just store everything in Friday, no external services"
```

Follow the conversation agent's questions:
- Storage: use Friday's built-in tables (not Notion/Google Sheets)
- No scheduled triggers, no external integrations
- Approve the generated plan when presented

Capture the **workspace ID** and **chat ID** from the output for subsequent cases.

```bash
# Get workspace ID
deno task atlas workspace list --json
```

---

## Section 1: Planner Output — CRUD Job Suppression

### 1.1 Resource-only workspace generates zero CRUD jobs

**Trigger**: After workspace creation completes, inspect the workspace config.

```bash
curl -s http://localhost:8080/api/workspaces/<WORKSPACE_ID> | jq '.jobs'
```

**Expect**: The only job present is `handle-chat` (auto-injected). No jobs like
`add_food`, `remove_food`, `update_food`, `read_food_log`, or similar
single-resource CRUD operations. Resources section should declare at least one
`type: document` resource with a schema.

**If broken**: Check planner prompt changes in
`packages/workspace-builder/planner/plan.ts` — look for the "Jobs and resource
operations" guidance section. Run `deno task atlas logs --level warn,error` for
planner errors.

---

## Section 2: Resource Tool Happy Path (curl)

### 2.1 Read from a document resource — discover schema

**Trigger**: Start a workspace chat and ask the agent to show what's in the
resource.

```bash
curl -N -X POST http://localhost:8080/api/workspaces/<WORKSPACE_ID>/chat \
  -H 'Content-Type: application/json' \
  -d '{"id":"qa-read-1","message":{"role":"user","parts":[{"type":"text","text":"What food have I logged so far?"}]}}'
```

**Expect**: The agent uses `resource_read` to query the document resource. Since
the resource is empty, the response should indicate no entries/empty log — NOT
"I don't have a query/search tool" or "I can't access your data." The agent
should demonstrate awareness of the resource and its schema.

**If broken**: Check that resource tools are registered in
`workspace-chat.agent.ts`. Verify resource entries are fetched at startup — check
`deno task atlas logs --chat <chatId>` for resource loading errors. Look for
`resource_read` tool call in the chat transcript:
`deno task atlas chat <chatId> --human` (use conversation chatId from setup, not
workspace chatId — workspace chat transcripts may need the API).

### 2.2 Write to a document resource — add an entry

**Trigger**: Continue the workspace chat and add a food item.

```bash
curl -N -X POST http://localhost:8080/api/workspaces/<WORKSPACE_ID>/chat/<CHAT_ID>/message \
  -H 'Content-Type: application/json' \
  -d '{"message":{"role":"user","parts":[{"type":"text","text":"Add 2 eggs for breakfast today"}]}}'
```

**Expect**: The agent uses `resource_write` to insert the entry. Response
confirms the addition with the details (eggs, quantity 2, breakfast, today's
date). No errors, no "I can't modify" responses.

**If broken**: Check `resource_write` tool definition in `resource-tools.ts`.
Verify the Ledger `mutate()` call succeeds — `deno task atlas logs --level error`.
Check the Ledger service is reachable.

### 2.3 Read after write — verify persistence within conversation

**Trigger**: Ask the agent what's logged again, in the same conversation.

```bash
curl -N -X POST http://localhost:8080/api/workspaces/<WORKSPACE_ID>/chat/<CHAT_ID>/message \
  -H 'Content-Type: application/json' \
  -d '{"message":{"role":"user","parts":[{"type":"text","text":"Show me everything in my food log"}]}}'
```

**Expect**: The agent uses `resource_read` and returns the eggs entry added in
2.2. Data persists within the conversation via the dirty draft.

**If broken**: The draft CTE should contain the uncommitted write. Check if
`resource_read` is querying the correct draft. Look at Ledger query logs.

### 2.4 Write then read in single turn — multi-step operation

**Trigger**: Ask the agent to add something AND show the full log in one message.

```bash
curl -N -X POST http://localhost:8080/api/workspaces/<WORKSPACE_ID>/chat/<CHAT_ID>/message \
  -H 'Content-Type: application/json' \
  -d '{"message":{"role":"user","parts":[{"type":"text","text":"Add a banana for snack, then show me the full food log"}]}}'
```

**Expect**: The agent calls `resource_write` (banana), then `resource_read`. The
read result includes both eggs (from 2.2) and the banana. Two tool calls in one
turn.

**If broken**: Check that the agent is allowed multiple tool calls per turn.
Verify the dirty draft reflects the write before the subsequent read.

### 2.5 Read persists across conversations

**Trigger**: Start a NEW workspace chat and query the resource.

```bash
curl -N -X POST http://localhost:8080/api/workspaces/<WORKSPACE_ID>/chat \
  -H 'Content-Type: application/json' \
  -d '{"id":"qa-read-new","message":{"role":"user","parts":[{"type":"text","text":"What food have I logged?"}]}}'
```

**Expect**: Returns the eggs and banana from the previous conversation. Data
survives across chat sessions via auto-publish at session teardown.

**If broken**: Auto-publish may not have fired. Check
`runtime.ts` publish hooks. Look for `publishDirtyDrafts` in logs. Verify the
Ledger has a published version:
`curl -s http://localhost:8080/api/workspaces/<WORKSPACE_ID>/resources`.

---

## Section 3: Resource Type Guards (curl)

### Setup: Create Workspace with Notion Resource

Create a second workspace that includes a Notion integration alongside a document
resource. This exercises the mixed-resource scenario.

```bash
deno task atlas prompt "I want to track meals and sync my meal plans to Notion"
```

Follow the conversation agent's questions:
- Storage for meal log: use Friday's built-in tables
- Meal plan sync: connect to Notion (complete OAuth when prompted)
- Approve the generated plan

Capture the **workspace ID** for cases 3.1 and 3.1b.

### 3.1 External resource returns guidance error via type guard

**Trigger**: Chat with the Notion workspace and explicitly ask to read the Notion
resource by its slug name.

```bash
curl -N -X POST http://localhost:8080/api/workspaces/<NOTION_WORKSPACE_ID>/chat \
  -H 'Content-Type: application/json' \
  -d '{"id":"qa-ext-1","message":{"role":"user","parts":[{"type":"text","text":"Use resource_read to query the Notion meals resource"}]}}'
```

**Expect**: The type guard catches the `external_ref` resource and returns a
structured guidance error:
```json
{
  "error": "\"<slug>\" is an external resource (Notion). Use do_task to interact with it.",
  "hint": "Example: do_task({ intent: 'read the latest entries from the Notion meals database' })"
}
```
The agent relays this to the user — mentions `do_task` as the correct path.

**If broken**: Check type guard logic in `resource-tools.ts` for the
`external_ref` case. Verify the resource metadata map is populated correctly at
startup — `deno task atlas logs --chat <chatId>` for resource loading. Check
that `buildResourceGuidance()` categorizes Notion under "External Resources."

### 3.1b Agent routes to do_task naturally for external resources

**Trigger**: In the same workspace, ask a natural question about the Notion data
without forcing a specific tool.

```bash
curl -N -X POST http://localhost:8080/api/workspaces/<NOTION_WORKSPACE_ID>/chat/<CHAT_ID>/message \
  -H 'Content-Type: application/json' \
  -d '{"message":{"role":"user","parts":[{"type":"text","text":"What meal plans do I have in Notion?"}]}}'
```

**Expect**: The agent routes to `do_task` proactively (guided by the system
prompt's resource routing rules), NOT `resource_read`. The agent should recognize
from the resource guidance that this is an external resource and use the correct
tool without hitting the type guard at all.

**If broken**: Check the `<resources>` section in `prompt.txt` — routing rules
should steer external resources to `do_task`. Check `buildResourceGuidance()`
output includes "External Resources" with Notion listed. If the agent uses
`resource_read` first and gets redirected, that's acceptable but suboptimal —
the system prompt should prevent it.

### 3.2 Unknown slug forwards to Ledger (not hard error)

**Trigger**: Ask the agent to query a resource that doesn't exist.

```bash
curl -N -X POST http://localhost:8080/api/workspaces/<WORKSPACE_ID>/chat/<CHAT_ID>/message \
  -H 'Content-Type: application/json' \
  -d '{"message":{"role":"user","parts":[{"type":"text","text":"Query the workout_log resource"}]}}'
```

**Expect**: The agent may attempt `resource_read` with slug `workout_log`. The
type guard forwards to Ledger (unknown slug isn't blocked). Ledger returns a 404.
The agent reports that the resource doesn't exist — no crash, no unhandled error.

**If broken**: Check the unknown-slug branch in `resource-tools.ts`. Verify
Ledger 404 is caught and surfaced as `{ error: "..." }` to the agent.

---

## Section 4: System Prompt Assembly

### 4.1 Resource guidance present in system prompt

**Trigger**: Start a workspace chat, then inspect the chat transcript for the
system prompt content.

```bash
curl -s http://localhost:8080/api/workspaces/<WORKSPACE_ID>/chat/<CHAT_ID> | jq '.messages[0]'
```

**Expect**: The system message contains:
- `buildResourceGuidance()` output with "Documents" category listing the food
  resource with `resource_read`/`resource_write` instructions
- SQL skill text (JSONB query patterns, draft CTE)
- `<resources>` routing section from prompt.txt
- NO old XML `<resource>` blocks from the previous format

**If broken**: Check `workspace-chat.agent.ts` `getSystemPrompt()` method.
Verify `buildResourceGuidance()` is called with
`availableTools: ["resource_read", "resource_write"]`. Check that
`formatWorkspaceSection()` no longer emits `<resources>` XML.

### 4.2 No resource guidance when workspace has no resources

**Trigger**: Create a minimal workspace with no resources (e.g., "create a
workspace that just responds to chat, no data storage needed"). Chat with it and
inspect the system prompt.

**Expect**: No `buildResourceGuidance()` output, no SQL skill text, no resource
tool registrations. The agent should have `do_task` and job tools but NOT
`resource_read`/`resource_write`.

**If broken**: Check the conditional logic in `workspace-chat.agent.ts` that
gates resource tool registration on `hasDocumentResources`.

---

## Section 5: Browser End-to-End

### 5.1 Workspace chat via web UI — full conversation flow

**Trigger**: Open the web client at `http://localhost:1420`. Navigate to the test
workspace's chat page (`/spaces/<WORKSPACE_ID>/chat`). Send the message:
"What's in my food log?"

**Expect**: The chat UI renders the agent's response. The agent queries the
resource and shows the food entries (eggs, banana from earlier curl tests). The
response streams in via SSE. No errors in the UI, no spinning indefinitely.

**If broken**: Check browser console for SSE errors. Verify the workspace chat
API endpoint returns proper SSE format. Check
`apps/atlasd/routes/workspaces/chat.ts`.

### 5.2 Add entry via web UI and verify

**Trigger**: In the same web chat, send: "Add a chicken salad for lunch"

**Expect**: Agent confirms the addition. Send a follow-up "Show my full log" and
verify it includes eggs, banana, and chicken salad. The UI handles multi-turn
correctly.

**If broken**: Same debugging path as 5.1. Additionally check that
`POST /workspaces/:id/chat/:chatId/message` endpoint works for follow-ups.

---

## Section 6: do_task Resource Access

### 6.1 Sub-task via do_task can access workspace resources

**Trigger**: In a workspace chat, ask for something that requires `do_task` to
exercise the ephemeral executor path with resource access.

```bash
curl -N -X POST http://localhost:8080/api/workspaces/<WORKSPACE_ID>/chat/<CHAT_ID>/message \
  -H 'Content-Type: application/json' \
  -d '{"message":{"role":"user","parts":[{"type":"text","text":"Analyze my food log and write a brief nutritional summary — use a task for the analysis"}]}}'
```

**Expect**: The agent spawns a `do_task` sub-task. The sub-task's FSM engine has
`resourceAdapter` wired and can read the workspace's food resource. The analysis
completes and returns a summary. The key signal is that the sub-task doesn't fail
with "no resource tools available."

**If broken**: Check `ephemeral-executor.ts` — verify `resourceAdapter` and
`artifactStorage` are passed to `createEngine()`. Check
`do-task/index.ts` — verify context includes `resourceAdapter`. Look at session
logs for the sub-task: `deno task atlas logs --level error`.

---

## Section 7: Orphaned Artifacts Fallback

### Setup: Create an Orphaned Artifact

Upload a file directly to the artifacts endpoint (bypassing the resource upload
flow). This creates an artifact associated with the workspace but with no
`artifact_ref` resource entry in the Ledger — exactly what older workspaces have.

Use the food-tracker workspace from Section 2 setup.

```bash
# Create a small test file
echo "date,meal,calories\n2026-03-01,breakfast,450\n2026-03-02,lunch,600" > /tmp/orphan-test.csv

# Upload directly to artifacts endpoint (NOT /resources/upload)
curl -X POST http://localhost:8080/api/artifacts/upload \
  -F "file=@/tmp/orphan-test.csv" \
  -F "workspaceId=<WORKSPACE_ID>"
```

Capture the artifact ID from the response.

Verify the orphan exists:
```bash
# Artifact exists
curl -s http://localhost:8080/api/artifacts/<ARTIFACT_ID> | jq '.title'

# No artifact_ref resource entry for it
curl -s http://localhost:8080/api/workspaces/<WORKSPACE_ID>/resources | \
  jq '.resources[] | select(.type == "artifact_ref")'
```

### 7.1 Orphaned artifact appears in chat guidance

**Trigger**: Start a NEW workspace chat (fresh system prompt assembly) and ask
what data is available.

```bash
curl -N -X POST http://localhost:8080/api/workspaces/<WORKSPACE_ID>/chat \
  -H 'Content-Type: application/json' \
  -d '{"id":"qa-orphan-1","message":{"role":"user","parts":[{"type":"text","text":"What files or data do you have access to?"}]}}'
```

**Expect**: The agent mentions both:
1. The document resource (food_log) — accessible via `resource_read`/`resource_write`
2. The orphaned CSV file — listed under "Files" with `artifacts_get` routing

The orphaned artifact isn't lost. The agent knows it exists and tells the user
how to access it.

**If broken**: Check `fetchWorkspaceDetails()` in `workspace-chat.agent.ts` —
verify orphaned artifact computation at lines 173-179. The logic filters
artifacts whose IDs don't appear in any `artifact_ref` resource entry's
`artifactId`. Check that the orphaned artifacts are appended to the system
prompt after `buildResourceGuidance()` output. Inspect the system message:
```bash
curl -s http://localhost:8080/api/workspaces/<WORKSPACE_ID>/chat/qa-orphan-1 | jq '.messages[0]'
```

### 7.2 Agent can retrieve orphaned artifact content

**Trigger**: In the same chat, ask the agent to show the CSV contents.

```bash
curl -N -X POST http://localhost:8080/api/workspaces/<WORKSPACE_ID>/chat/qa-orphan-1/message \
  -H 'Content-Type: application/json' \
  -d '{"message":{"role":"user","parts":[{"type":"text","text":"Show me the contents of that CSV file"}]}}'
```

**Expect**: The agent uses `artifacts_get` (not `resource_read`) to retrieve the
file and displays the CSV data (dates, meals, calories). The routing from the
guidance text works end-to-end.

**If broken**: Check that `artifacts_get` tool is registered in
workspace-chat. Verify the artifact ID in the guidance text matches the uploaded
artifact. Check `artifact-tools.ts` for the tool implementation.

---

## Section 8: Skill Text Filtering

### 8.1 Filtered skill text omits unavailable tools

**Trigger**: Hit the Ledger skill endpoint directly with the workspace-chat tool
surface.

```bash
curl -s http://localhost:8080/api/ledger/v1/skill?tools=resource_read,resource_write
```

(Adjust URL based on how the Ledger is exposed — may need to check the daemon's
proxy routes.)

**Expect**: The returned skill text mentions `resource_read` and `resource_write`
but does NOT mention `resource_save` or `resource_link_ref`. No lifecycle
instructions for save, no link_ref examples.

**If broken**: Check `sqlite-skill.ts` (or `postgres-skill.ts`) — verify the
conditional sections based on `availableTools`. Check `apps/ledger/src/index.ts`
for the `tools` query parameter parsing.

### 8.2 Full skill text when no filter

**Trigger**: Hit the same endpoint without the tools parameter.

```bash
curl -s http://localhost:8080/api/ledger/v1/skill
```

**Expect**: Full skill text including all 4 tools: `resource_read`,
`resource_write`, `resource_save`, `resource_link_ref`.

**If broken**: Same files as 8.1. Verify backwards compatibility — omitting
`availableTools` should return unfiltered output.

---

## Smoke Candidates

- **Case 2.1** (read from document resource) — core happy path, durable
- **Case 2.2** (write to document resource) — core mutation path, durable
- **Case 2.5** (read persists across conversations) — auto-publish validation, catches regressions in lifecycle hooks
- **Case 3.1** (external resource type guard) — safety net for non-document resources, catches type guard regressions
- **Case 3.2** (unknown slug forwards gracefully) — error handling boundary, catches type guard regressions
