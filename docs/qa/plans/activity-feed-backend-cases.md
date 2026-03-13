# QA Plan: Activity Feed Backend (TEM-3779)

**Context**: Track session completions and resource modifications as activity items
**Branch**: `david/tem-3779-track-new-activity-sessions-etc-when-users-come-back-into`
**Date**: 2026-03-12

## Prerequisites

- Daemon running: `deno task atlas daemon start --detached`
- At least one workspace configured with an agent
- User authenticated (daemon has a valid user session)

## Scope

Activity tracking only applies to **FSM-based workspace sessions** (i.e.,
workspaces with configured agents). The `atlas-conversation` workspace uses
non-FSM jobs (`handle-conversation`) and intentionally does **not** generate
activity items — it's a direct chat interface, not an autonomous agent session.

## How to Verify Activity Was Created

Since this is a backend feature, all verification is done via the daemon API:

```bash
# List all activity items
curl -s http://localhost:8080/api/activity | jq

# List only session activities
curl -s "http://localhost:8080/api/activity?type=session" | jq

# List only resource activities
curl -s "http://localhost:8080/api/activity?type=resource" | jq

# Filter by workspace
curl -s "http://localhost:8080/api/activity?workspaceId=<WORKSPACE_ID>" | jq

# Check unread count
curl -s http://localhost:8080/api/activity/unread-count | jq

# You can also inspect the SQLite database directly
sqlite3 ~/.atlas/activity.db "SELECT * FROM activities ORDER BY created_at DESC LIMIT 10;"
sqlite3 ~/.atlas/activity.db "SELECT * FROM activity_read_status;"
```

## Cases

### 1. Session completion creates activity

**Trigger**: Send a prompt to a workspace that will complete successfully:
```bash
deno task atlas prompt --workspace <WORKSPACE_ID> "what time is it?"
```
Wait for the session to complete.

**Expect**:
- `GET /api/activity` returns an activity with `type: "session"`, `source: "agent"`
- Activity has a non-empty `title` (AI-generated summary of the session)
- `workspace_id` matches the workspace used
- `reference_id` is the session ID
- `job_id` is populated
- `user_id` is null (agent-initiated)
- Unread count at `/api/activity/unread-count` increments by 1

**If broken**:
- Check daemon logs: `deno task atlas daemon logs`
- Look at `packages/workspace/src/runtime.ts` around `teardownSession()` (lines 906-935)
- Verify ActivityStorageAdapter is wired: `apps/atlasd/src/atlas-daemon.ts` line 564

### 2. Session failure creates activity

**Trigger**: Send a prompt that will cause a session to fail (e.g., reference a non-existent tool or trigger an error):
```bash
deno task atlas prompt --workspace <WORKSPACE_ID> "use the nonexistent_tool_xyz tool"
```
Wait for the session to fail/complete.

**Expect**:
- Activity created with `type: "session"`, `source: "agent"`
- Title reflects the failure (should mention error or failure)
- Activity appears in the list alongside successful session activities

**If broken**:
- Check if `teardownSession()` is called on failure path
- Check `packages/activity/src/title-generator.ts` handles error messages

### 3. Resource auto-publish creates activity

**Trigger**: Send a prompt to a workspace that will cause the agent to create or modify a resource (e.g., a document, note, or file):
```bash
deno task atlas prompt --workspace <WORKSPACE_ID> "create a document about project planning best practices"
```
Wait for session to complete (resources are auto-published at session teardown).

**Expect**:
- Activity created with `type: "resource"`, `source: "agent"`
- Title references the resource name/type
- `reference_id` is the resource ID
- `workspace_id` matches
- If the session also completed, there should be TWO activities: one session + one resource

**If broken**:
- Check `packages/resources/src/publish-hook.ts` (`publishDirtyDrafts`)
- Verify the agent actually created a resource: `curl -s http://localhost:8080/api/workspaces/<WORKSPACE_ID>/resources | jq`
- Check daemon logs for publish hook errors

### 4. Multiple resources create multiple activity items

**Trigger**: Send a prompt that causes the agent to create/modify multiple resources in one session:
```bash
deno task atlas prompt --workspace <WORKSPACE_ID> "create three separate documents: one about cats, one about dogs, one about birds"
```

**Expect**:
- One `session` activity + multiple `resource` activities (one per published resource)
- Each resource activity has a distinct `reference_id` and title
- All share the same `workspace_id` and `job_id`

**If broken**:
- Check if `publishDirtyDrafts` iterates over all dirty resources
- Check `packages/resources/src/publish-hook.ts` for loop logic

### 5. Activity list filtering works

**Trigger**: After running cases 1-4, test the filter parameters:
```bash
# Filter by type
curl -s "http://localhost:8080/api/activity?type=session" | jq '.activities | length'
curl -s "http://localhost:8080/api/activity?type=resource" | jq '.activities | length'

# Filter by workspace
curl -s "http://localhost:8080/api/activity?workspaceId=<WORKSPACE_ID>" | jq '.activities | length'

# Pagination
curl -s "http://localhost:8080/api/activity?limit=2" | jq '.activities | length'
curl -s "http://localhost:8080/api/activity?limit=2&offset=2" | jq '.activities | length'

# Date filtering (use ISO-8601 timestamps)
curl -s "http://localhost:8080/api/activity?after=2026-03-12T00:00:00Z" | jq '.activities | length'
```

**Expect**:
- Type filter returns only matching type
- Workspace filter returns only activities for that workspace
- Limit/offset pagination returns correct subsets
- Date filters correctly bound results

**If broken**:
- Check `packages/activity/src/local-adapter.ts` list query construction
- Check `packages/activity/src/schemas.ts` for `ActivityListFilterSchema`

### 6. Unread count and mark-as-read flow

**Trigger**: After generating activities from previous cases:
```bash
# 1. Check unread count
curl -s http://localhost:8080/api/activity/unread-count | jq

# 2. Get activity IDs
ACTIVITY_IDS=$(curl -s http://localhost:8080/api/activity | jq -r '.activities[:2] | .[].id')

# 3. Mark specific activities as viewed
curl -s -X POST http://localhost:8080/api/activity/mark \
  -H "Content-Type: application/json" \
  -d "{\"activityIds\": [\"$(echo $ACTIVITY_IDS | head -1)\"], \"status\": \"viewed\"}" | jq

# 4. Check unread count decreased
curl -s http://localhost:8080/api/activity/unread-count | jq

# 5. Mark all before a timestamp as viewed
curl -s -X POST http://localhost:8080/api/activity/mark \
  -H "Content-Type: application/json" \
  -d "{\"before\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"status\": \"viewed\"}" | jq

# 6. Confirm unread count is 0
curl -s http://localhost:8080/api/activity/unread-count | jq
```

**Expect**:
- Initial unread count matches number of agent-created activities
- After marking by IDs: unread count decreases by number marked
- After mark-all-before: unread count drops to 0
- List endpoint shows `read_status: "viewed"` on marked items, `read_status: null` on unread

**If broken**:
- Check `packages/activity/src/local-adapter.ts` for `updateReadStatus` and `markViewedBefore`
- Inspect DB: `sqlite3 ~/.atlas/activity.db "SELECT * FROM activity_read_status;"`

### 7. Dismiss status works

**Trigger**:
```bash
# Get an activity ID
ACTIVITY_ID=$(curl -s http://localhost:8080/api/activity | jq -r '.activities[0].id')

# Mark as dismissed
curl -s -X POST http://localhost:8080/api/activity/mark \
  -H "Content-Type: application/json" \
  -d "{\"activityIds\": [\"$ACTIVITY_ID\"], \"status\": \"dismissed\"}" | jq

# Verify
curl -s http://localhost:8080/api/activity | jq ".activities[] | select(.id == \"$ACTIVITY_ID\")"
```

**Expect**:
- Activity's `read_status` is `"dismissed"`
- Dismissed activities still appear in the list (they're not filtered out)
- Dismissed activities do NOT count toward unread count

**If broken**:
- Check `ReadStatusValueSchema` accepts "dismissed"
- Check unread count query excludes dismissed

### 8. User-initiated resource activity is auto-viewed

**Trigger**: Upload or create a resource directly through the API (not via an agent session):
```bash
# Check what resource endpoints accept user-created resources
# Then create/upload a resource and check activity
curl -s http://localhost:8080/api/activity?type=resource | jq '.activities[0]'
```

**Expect**:
- If a user-initiated resource action creates an activity, it should have `source: "user"` and `read_status: "viewed"` (auto-marked)
- It should NOT increment the unread count

**If broken**:
- Check `packages/activity/src/local-adapter.ts` create method — user activities should auto-insert read_status
- Check `packages/resources/src/publish-hook.ts` for user source detection

## Smoke Candidates

- Case 1 (session completion creates activity) — core happy path, stable trigger
- Case 3 (resource auto-publish creates activity) — validates the publish hook integration
- Case 6 (unread count + mark-as-read) — validates the read status lifecycle
