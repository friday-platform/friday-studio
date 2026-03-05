# QA Plan: Workspace Resources — Comprehensive

**Branch**: `workspace-storage`
**Date**: 2026-02-28
**Adapter**: SQLite only (Postgres cases deferred — Section 21)
**Supersedes**: `resource-storage-redesign-cases.md`,
`workspace-resources-e2e-gaps.md`

## Prerequisites

- `deno task dev:full` running (daemon `:8080` + web client `:1420`)
- Ledger service running (daemon auto-starts it, or `deno task start` in
  `apps/ledger`)
- Browser connected via claude-in-chrome — required for Sections 12-18
- Notion OAuth credential configured (Settings page) — required for Sections 6,
  16
- No existing workspace named "grocery" or "meeting-notes" (clean slate for
  Sections 5-8)

## API Path Reference

**Ledger proxy** (raw Ledger access):

```
POST   /api/ledger/resources/:workspaceId/provision
GET    /api/ledger/resources/:workspaceId
GET    /api/ledger/resources/:workspaceId/:slug[?published=true]
POST   /api/ledger/resources/:workspaceId/:slug/query
POST   /api/ledger/resources/:workspaceId/:slug/mutate
POST   /api/ledger/resources/:workspaceId/:slug/publish
PUT    /api/ledger/resources/:workspaceId/:slug/version
DELETE /api/ledger/resources/:workspaceId/:slug
POST   /api/ledger/resources/:workspaceId/:slug/link-ref
POST   /api/ledger/resources/:workspaceId/:slug/reset-draft
GET    /api/ledger/v1/skill
GET    /api/ledger/health
```

**Workspace routes** (enriched, UI-facing, upload/export):

```
GET    /api/workspaces/:workspaceId/resources
GET    /api/workspaces/:workspaceId/resources/:slug
GET    /api/workspaces/:workspaceId/resources/:slug/export
POST   /api/workspaces/:workspaceId/resources/upload
PUT    /api/workspaces/:workspaceId/resources/:slug
DELETE /api/workspaces/:workspaceId/resources/:slug
```

---

## Section 1: Ledger API — Provision & Draft/Publish Cycle

_Direct API verification of the core storage model. Fast, no LLM round-trips._

### 1.1 Provision a tabular document resource

**Trigger**:

```bash
curl -X POST http://localhost:8080/api/ledger/resources/test-ws/provision \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": "default-user",
    "slug": "grocery-list",
    "name": "Grocery List",
    "description": "Weekly grocery items",
    "type": "document",
    "schema": {
      "type": "object",
      "properties": {
        "item": {"type": "string"},
        "quantity": {"type": "integer"},
        "purchased": {"type": "boolean"}
      }
    },
    "initialData": []
  }'
```

**Expect**: 201 response with `ResourceMetadata`. `currentVersion: 1`
(auto-published on provision). Draft row exists with `data: []`,
`dirty: false`.
**If broken**: Check `apps/ledger/src/sqlite-adapter.ts` provision +
auto-publish logic, `apps/ledger/src/routes.ts` POST handler.

### 1.2 Provision is idempotent

**Trigger**: Re-run the same provision call from 1.1 but change the description
to `"Updated weekly grocery items"`.

**Expect**: 201 response (upsert). Metadata updated (new description), draft
schema updated. Existing data and version history preserved — still
`currentVersion: 1`, no duplicate version rows. No error or conflict.
**If broken**: Check `INSERT ... ON CONFLICT` upsert logic in provision.

### 1.3 Provision a prose document resource

**Trigger**:

```bash
curl -X POST http://localhost:8080/api/ledger/resources/test-ws/provision \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": "default-user",
    "slug": "meeting-notes",
    "name": "Meeting Notes",
    "description": "Sprint planning notes",
    "type": "document",
    "schema": {"type": "string", "format": "markdown"},
    "initialData": ""
  }'
```

**Expect**: 201. Draft data is empty string `""`. Version 1 published. Schema is
`{"type": "string", "format": "markdown"}`.
**If broken**: Check prose type handling in provision.

### 1.4 List resources for workspace

**Trigger**: `curl http://localhost:8080/api/ledger/resources/test-ws`

**Expect**: JSON array with two entries: `grocery-list` (type `document`) and
`meeting-notes` (type `document`). Both show `currentVersion: 1`. No deleted
resources included. Each entry has `id`, `userId`, `workspaceId`, `slug`,
`name`, `description`, `type`, `currentVersion`, `createdAt`, `updatedAt`,
`deletedAt: null`.
**If broken**: Check `listResources()` adapter method, route handler.

### 1.5 Get resource — draft vs published

**Trigger**:

```bash
# Draft view (agent reads — default)
curl http://localhost:8080/api/ledger/resources/test-ws/grocery-list

# Published view (UI reads)
curl http://localhost:8080/api/ledger/resources/test-ws/grocery-list?published=true
```

**Expect**: Both return `{ metadata: {...}, version: {...} }`. No mutations yet,
so data is identical. Draft view returns the draft row (`version: null`).
Published view returns the latest versioned row (`version: 1`). Both include
`schema` and `data` on the `version` object.
**If broken**: Check `getResource()` and `?published` query param coercion.

### 1.6 Mutate draft — tabular append

**Trigger**:

```bash
curl -X POST http://localhost:8080/api/ledger/resources/test-ws/grocery-list/mutate \
  -H 'Content-Type: application/json' \
  -d '{
    "sql": "SELECT json_insert(draft.data, '\''$[#]'\'', json_object('\''item'\'', '\''eggs'\'', '\''quantity'\'', 12, '\''purchased'\'', 0)) FROM draft"
  }'
```

**Expect**: 200 response with `{ applied: true }`. Verify draft via GET — now
contains `[{"item": "eggs", "quantity": 12, "purchased": 0}]`. Draft row shows
`dirty: true`.
**If broken**: Check `mutate()` — CTE injection, SELECT → UPDATE pipeline,
dirty flag setting.

### 1.7 Draft isolation — published unchanged after mutate

**Trigger**: Fetch published view after 1.6.

```bash
curl http://localhost:8080/api/ledger/resources/test-ws/grocery-list?published=true
```

**Expect**: Published data is still `[]` (empty). The mutation only affected the
draft. `version.version` is still `1`.
**If broken**: Check that mutate targets only the draft row
(`version IS NULL`).

### 1.8 Publish draft

**Trigger**:

```bash
curl -X POST http://localhost:8080/api/ledger/resources/test-ws/grocery-list/publish
```

**Expect**: 200 response with `{ version: 2 }`. Published view now shows the
eggs data. Draft `dirty: false`. Metadata `currentVersion: 2`.
**If broken**: Check `publish()` — version row insertion, trigger for version
number assignment, dirty flag clear.

### 1.9 Publish is no-op when not dirty

**Trigger**: Call publish again immediately after 1.8.

**Expect**: 200 response with `{ version: null }` (no-op — draft clean). No new
version created. `currentVersion` still 2.
**If broken**: Check dirty flag check in `publish()`.

### 1.10 Mutate draft — prose replace

**Trigger**:

```bash
curl -X POST http://localhost:8080/api/ledger/resources/test-ws/meeting-notes/mutate \
  -H 'Content-Type: application/json' \
  -d '{
    "sql": "SELECT $1 FROM draft",
    "params": ["# Sprint Planning\n\nDiscussed roadmap priorities.\n\n## Action Items\n- Ship resource redesign"]
  }'
```

**Expect**: 200 with `{ applied: true }`. Draft data is the full markdown
string. Dirty flag set to `true`.
**If broken**: Check parameterized query handling in mutate.

### 1.11 Reset draft to latest published version

**Trigger**: Mutate the grocery list draft (add another item), then reset
without publishing.

```bash
# Add bread
curl -X POST http://localhost:8080/api/ledger/resources/test-ws/grocery-list/mutate \
  -H 'Content-Type: application/json' \
  -d '{"sql": "SELECT json_insert(draft.data, '\''$[#]'\'', json_object('\''item'\'', '\''bread'\'', '\''quantity'\'', 1, '\''purchased'\'', 0)) FROM draft"}'

# Reset
curl -X POST http://localhost:8080/api/ledger/resources/test-ws/grocery-list/reset-draft
```

**Expect**: 200 with `{ reset: true }`. Draft reverts to published state (eggs
only, no bread). Dirty flag cleared.
**If broken**: Check `resetDraft()` — copies data from latest version row back
to draft.

### 1.12 Replace version — direct version insert

**Trigger**:

```bash
curl -X PUT http://localhost:8080/api/ledger/resources/test-ws/grocery-list/version \
  -H 'Content-Type: application/json' \
  -d '{
    "data": [
      {"item": "milk", "quantity": 2, "purchased": 0},
      {"item": "butter", "quantity": 1, "purchased": 0}
    ]
  }'
```

**Expect**: 201 with `ResourceVersion` (version 3). Draft reset to match the
replacement data. Dirty flag cleared. Old versions (1, 2) preserved in history.
**If broken**: Check `replaceVersion()` — direct version insert, draft reset,
trigger.

### 1.13 Soft delete

**Trigger**:

```bash
curl -X DELETE http://localhost:8080/api/ledger/resources/test-ws/meeting-notes
```

**Expect**: 200 with `{ deleted: true }`. List endpoint no longer includes
`meeting-notes`. Direct GET still returns it (with `deletedAt` set). Version
history and draft preserved.
**If broken**: Check `deleteResource()` — soft delete, list exclusion filter.

---

## Section 2: Ledger API — Security & Constraints

_Verify the safety boundaries that protect data integrity._

### 2.1 Read-only enforcement on query

**Trigger**:

```bash
curl -X POST http://localhost:8080/api/ledger/resources/test-ws/grocery-list/query \
  -H 'Content-Type: application/json' \
  -d '{"sql": "DELETE FROM resource_versions; SELECT 1 FROM draft"}'
```

**Expect**: Error response — rejected by the read-only database connection (not
string parsing). Error message should be agent-friendly with schema context.
**If broken**: Check read-only connection setup (`?mode=ro` in SQLite).

### 2.2 Read-only enforcement on mutate SELECT phase

**Trigger**:

```bash
curl -X POST http://localhost:8080/api/ledger/resources/test-ws/grocery-list/mutate \
  -H 'Content-Type: application/json' \
  -d '{"sql": "WITH x AS (DELETE FROM resource_versions RETURNING *) SELECT json_array() FROM draft"}'
```

**Expect**: Error — writable CTE rejected by read-only connection during the
SELECT phase. Draft unchanged.
**If broken**: Check that mutate's SELECT phase runs on the read-only
connection.

### 2.3 Immutability — version rows reject UPDATE

**Trigger**: Covered by adapter unit tests
(`apps/ledger/src/sqlite-adapter.test.ts`). Verify test exists and passes.

**Expect**: BEFORE UPDATE trigger rejects UPDATE on rows where
`version IS NOT NULL`.
**If broken**: Check immutability trigger in `init()` schema setup.

### 2.4 Immutability — version rows reject DELETE

**Trigger**: Covered by adapter unit tests. Verify test exists and passes.

**Expect**: BEFORE DELETE trigger rejects DELETE on versioned rows.
**If broken**: Check immutability trigger.

### 2.5 Draft uniqueness — partial index prevents duplicates

**Trigger**: Covered by adapter unit tests. Verify test exists and passes.

**Expect**: Unique constraint violation from the partial index
`idx_one_draft_per_resource`.
**If broken**: Check partial index creation in `init()`.

### 2.6 Mutate rejected on artifact_ref

**Trigger**: Provision an artifact_ref resource, then attempt mutate.

```bash
curl -X POST http://localhost:8080/api/ledger/resources/test-ws/provision \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": "default-user",
    "slug": "big-report",
    "name": "Q4 Report",
    "description": "Quarterly report PDF",
    "type": "artifact_ref",
    "schema": {"type": "object", "properties": {"artifact_id": {"type": "string"}, "artifact_type": {"type": "string"}}},
    "initialData": {"artifact_id": "abc-123", "artifact_type": "pdf"}
  }'

curl -X POST http://localhost:8080/api/ledger/resources/test-ws/big-report/mutate \
  -H 'Content-Type: application/json' \
  -d '{"sql": "SELECT json_set(draft.data, '\''$.artifact_id'\'', '\''hacked'\'') FROM draft"}'
```

**Expect**: Error — mutate rejects `artifact_ref` and `external_ref` types.
Message: `Query is only supported on document resources,
got type="artifact_ref"`.
**If broken**: Check type guard in `mutate()`.

### 2.7 Mutate rejected on external_ref

**Trigger**: Provision an external_ref, then attempt mutate.

**Expect**: Same rejection as 2.6.
**If broken**: Check type guard in `mutate()`.

### 2.8 Workspace isolation — cross-workspace query

**Trigger**: Provision a resource in `ws-a`, then attempt to query it via
`ws-b`.

```bash
curl -X POST http://localhost:8080/api/ledger/resources/ws-a/provision \
  -H 'Content-Type: application/json' \
  -d '{"userId": "default-user", "slug": "secret", "name": "Secret", "description": "Private data", "type": "document", "schema": {"type": "object", "properties": {"value": {"type": "string"}}}, "initialData": [{"value": "confidential"}]}'

curl -X POST http://localhost:8080/api/ledger/resources/ws-b/secret/query \
  -H 'Content-Type: application/json' \
  -d '{"sql": "SELECT * FROM draft"}'
```

**Expect**: 404 or error — the CTE scope includes `workspace_id` so the slug
doesn't resolve in a different workspace.
**If broken**: Check CTE scope injection includes
`rm.workspace_id = :workspaceId`.

### 2.9 SQL injection via params

**Trigger**:

```bash
curl -X POST http://localhost:8080/api/ledger/resources/test-ws/grocery-list/mutate \
  -H 'Content-Type: application/json' \
  -d '{"sql": "SELECT $1 FROM draft", "params": ["test'\'')); DROP TABLE resource_versions; --"]}'
```

**Expect**: Parameter is treated as a literal string value, not SQL. No table
dropped. Draft data becomes the injection string verbatim.
**If broken**: Check parameter binding in query/mutate execution.

---

## Section 3: Ledger API — Ref Resources & Skill Endpoint

### 3.1 Provision external_ref resource

**Trigger**:

```bash
curl -X POST http://localhost:8080/api/ledger/resources/test-ws/provision \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": "default-user",
    "slug": "notion-notes",
    "name": "Reading Notes",
    "description": "Notion database for reading notes",
    "type": "external_ref",
    "schema": {"type": "object", "properties": {"provider": {"type": "string"}, "ref": {"type": "string"}, "metadata": {"type": "object"}}},
    "initialData": {"provider": "notion", "ref": null, "metadata": {}}
  }'
```

**Expect**: 201 with ResourceMetadata. Resource created with `ref: null`
(unlinked). Version 1 published. `currentVersion: 1`.
**If broken**: Check external_ref provision path.

### 3.2 Link ref on external_ref resource

**Trigger**:

```bash
curl -X POST http://localhost:8080/api/ledger/resources/test-ws/notion-notes/link-ref \
  -H 'Content-Type: application/json' \
  -d '{"ref": "https://www.notion.so/my-database-abc123"}'
```

**Expect**: 201 with ResourceVersion. New version created with updated
`data.ref`. Draft updated to match. `currentVersion` incremented.
**If broken**: Check `linkRef()` — new version insert, draft reset.

### 3.3 Link ref rejected on non-ref types

**Trigger**: Call link-ref endpoint on the `grocery-list` document resource.

```bash
curl -X POST http://localhost:8080/api/ledger/resources/test-ws/grocery-list/link-ref \
  -H 'Content-Type: application/json' \
  -d '{"ref": "https://example.com"}'
```

**Expect**: Error — link only works on `external_ref` type.
**If broken**: Check type guard in `linkRef()`.

### 3.4 Agent skill endpoint

**Trigger**: `curl http://localhost:8080/api/ledger/v1/skill`

**Expect**: Returns SQLite-specific JSONB skill document as plain text. Content
includes: `draft` CTE reference, `json_extract()` / `json_set()` patterns,
`json_each()` for array expansion, mutate pattern (SELECT returns new data
value), parameter binding syntax.
**If broken**: Check `apps/ledger/src/skill.ts`, route at `GET /v1/skill`.

### 3.5 Health endpoint

**Trigger**: `curl http://localhost:8080/api/ledger/health`

**Expect**: 200 with `{ status: "ok", service: "ledger" }`.
**If broken**: Check health route in `apps/ledger/src/index.ts`.

---

## Section 4: Draft Recovery

_resetDraft restores the draft to the latest published version. Safety net for
crash recovery._

### 4.1 resetDraft API restores published state

**Trigger**: Mutate a resource draft (add data), do NOT publish. Then call
resetDraft:

```bash
# Mutate (dirties draft)
curl -X POST http://localhost:8080/api/ledger/resources/{workspaceId}/{slug}/mutate \
  -H 'Content-Type: application/json' \
  -d '{"sql": "SELECT json_insert(draft.data, '\''$[#]'\'', json_object('\''item'\'', '\''test'\'', '\''qty'\'', 1)) FROM draft"}'

# Verify draft is dirty
curl http://localhost:8080/api/ledger/resources/{workspaceId}/{slug} | jq '.version.dirty'

# Reset
curl -X POST http://localhost:8080/api/ledger/resources/{workspaceId}/{slug}/reset-draft

# Verify draft restored
curl http://localhost:8080/api/ledger/resources/{workspaceId}/{slug} | jq '.version'
```

**Expect**: After reset, draft data matches the latest published version. Dirty
flag cleared. The test item added during mutation is gone.
**If broken**: Check `resetDraft()` in `apps/ledger/src/sqlite-adapter.ts`.

### 4.2 Agent session starts with clean draft

**Trigger**: Manually dirty a draft via API (mutate without publish). Then
trigger a new agent session in that workspace.

```bash
# Dirty the draft
curl -X POST http://localhost:8080/api/ledger/resources/{workspaceId}/{slug}/mutate \
  -H 'Content-Type: application/json' \
  -d '{"sql": "SELECT json_insert(draft.data, '\''$[#]'\'', json_object('\''item'\'', '\''orphan'\'', '\''qty'\'', 999)) FROM draft"}'

# Trigger new session
deno task atlas prompt "What items are in my list?"
```

**Expect**: Agent reads the published data, not the dirty draft. The "orphan"
item does NOT appear. Confirms resetDraft fires at session start.
**If broken**: Check session startup flow in
`packages/workspace/src/runtime.ts`.

### 4.3 resetDraft is safe when draft matches published

**Trigger**: Call resetDraft on a resource with a clean draft (dirty = false).

```bash
curl -X POST http://localhost:8080/api/ledger/resources/{workspaceId}/{slug}/reset-draft
```

**Expect**: No error. Draft unchanged. Idempotent operation.
**If broken**: Check resetDraft handles clean draft gracefully.

---

## Section 5: Upload Pipeline

_File uploads routed by type and size. Upload endpoints are on the daemon, not
Ledger._

### 5.1 Small CSV → document resource

**Trigger**:

```bash
echo 'name,price,in_stock
Apples,2.99,true
Bananas,1.49,true
Cherries,4.99,false' > /tmp/test-products.csv

curl -X POST http://localhost:8080/api/workspaces/{workspaceId}/resources/upload \
  -F "file=@/tmp/test-products.csv"
```

**Expect**: 200 response. Resource created as `type: "document"`. Data is JSONB
array with string values:
`[{"name": "Apples", "price": "2.99", "in_stock": "true"}, ...]`. Schema
derived from CSV headers. Mutable via agent tools.
**If broken**: Check upload route, CSV → JSONB parsing via PapaParse,
`classifyUpload()` in `upload-strategy.ts`.

### 5.2 Large CSV (>5MB) → artifact_ref resource

**Trigger**: Generate a large CSV and upload.

```bash
python3 -c "
import csv, sys
w = csv.writer(sys.stdout)
w.writerow(['id','value','category'])
for i in range(200000):
    w.writerow([i, f'item_{i}', f'cat_{i%10}'])
" > /tmp/large-data.csv

curl -X POST http://localhost:8080/api/workspaces/{workspaceId}/resources/upload \
  -F "file=@/tmp/large-data.csv"
```

**Expect**: Resource created as `type: "artifact_ref"`. Data stored as artifact
(not JSONB). Read-only. `data.artifact_id` points to the artifact. Threshold is
exactly 5 * 1024 * 1024 bytes.
**If broken**: Check `UPLOAD_SIZE_THRESHOLD` in `upload-strategy.ts`.

### 5.3 Markdown file (.md) → prose document resource

**Trigger**:

```bash
echo '# Project README

This is a test document.

## Features
- Feature one
- Feature two' > /tmp/test-readme.md

curl -X POST http://localhost:8080/api/workspaces/{workspaceId}/resources/upload \
  -F "file=@/tmp/test-readme.md"
```

**Expect**: Resource created as `type: "document"` with prose schema
(`{"type": "string", "format": "markdown"}`). Data is the raw markdown string.
Mutable.
**If broken**: Check `.md` / `.markdown` extension detection in
`classifyUpload()`.

### 5.4 TXT file → prose document

**Trigger**:

```bash
echo 'Just some plain text content' > /tmp/notes.txt

curl -X POST http://localhost:8080/api/workspaces/{workspaceId}/resources/upload \
  -F "file=@/tmp/notes.txt"
```

**Expect**: Resource created as `type: "document"` with prose schema
(`{"type": "string", "format": "markdown"}`). Implementation classifies `.txt`,
`.md`, and `.markdown` as prose (matches v6 design).
**If broken**: Check `classifyUpload()` in `upload-strategy.ts`.

### 5.5 DOCX file → artifact_ref (no conversion)

**Trigger**:

```bash
curl -X POST http://localhost:8080/api/workspaces/{workspaceId}/resources/upload \
  -F "file=@/tmp/test-doc.docx"
```

**Expect**: Resource created as `type: "artifact_ref"`. No markdown conversion.

**NOTE**: v6 user story 5 specifies DOCX → prose. Not implemented — see Known
Gaps (20.3).
**If broken**: Check default case in `classifyUpload()`.

### 5.6 Binary/other file → artifact_ref resource

**Trigger**:

```bash
curl -X POST http://localhost:8080/api/workspaces/{workspaceId}/resources/upload \
  -F "file=@/tmp/some-image.png"
```

**Expect**: Resource created as `type: "artifact_ref"` regardless of size.
**If broken**: Check default case in `classifyUpload()`.

### 5.7 Replace document with new CSV

**Trigger**: Replace the resource from 5.1.

```bash
echo 'name,price,in_stock
Figs,6.99,true
Grapes,3.49,true' > /tmp/updated-products.csv

curl -X PUT http://localhost:8080/api/workspaces/{workspaceId}/resources/test_products \
  -F "file=@/tmp/updated-products.csv"
```

**Expect**: New version created via `replaceVersion()`. Draft reset to match.
Old data preserved in version history. Current data shows 2 rows, not 3+2.
**If broken**: Check replace route, `replaceVersion()` call.

### 5.8 Replace document with non-CSV → 422

**Trigger**:

```bash
echo '{"data": "nope"}' > /tmp/bad-replace.json

curl -X PUT http://localhost:8080/api/workspaces/{workspaceId}/resources/test_products \
  -F "file=@/tmp/bad-replace.json"
```

**Expect**: 422 Unprocessable Entity with error "Table resources require a CSV
file". Document data unchanged.

**NOTE**: This type check also affects prose documents — see Known Gaps (20.4).
**If broken**: Check MIME type guard in replace route.

### 5.9 Duplicate slug on upload → 409

**Trigger**: Upload another file named `test-products.csv` (same slug as 5.1).

**Expect**: 409 Conflict with error message mentioning slug collision.
**If broken**: Check pre-flight slug uniqueness check in upload route.

### 5.10 Slug derivation from edge-case names

**Trigger**: Upload files with unusual names:

- `123-data.csv` (leading digit → prefixed with `d`)
- `café-menu.csv` (unicode → underscores)
- `...dots.csv` (special chars → underscores, trimmed)
- `a.csv` (very short → `a`)

**Expect**: All produce valid slugs. Leading digit prefixed with `d`. Special
chars become `_`. Consecutive underscores collapsed. Leading/trailing underscores
trimmed. Max 64 chars. Empty result falls back to `"data"`.
**If broken**: Check slug derivation in upload route.

### 5.11 CSV export for tabular document

**Trigger**:

```bash
curl http://localhost:8080/api/workspaces/{workspaceId}/resources/test_products/export
```

**Expect**: Response with `Content-Type: text/csv` and
`Content-Disposition: attachment; filename="test_products.csv"`. Contains all
rows with proper CSV escaping.
**If broken**: Check export route.

### 5.12 CSV export for non-document type → 404

**Trigger**:

```bash
curl http://localhost:8080/api/workspaces/{workspaceId}/resources/{artifactRefSlug}/export
```

**Expect**: 404 — export only works on document resources.
**If broken**: Check type guard in export route.

---

## Section 6: CLI E2E — Tabular Document

_Full stack: conversation agent → planner → provision → agent tools._

### 6.1 Conversation agent asks about storage

**Trigger**:

```bash
deno task atlas prompt "Set up a workspace that tracks my grocery list. I want to store items with their name, quantity, category, and whether I've purchased them."
```

**Expect**: Agent asks a clarifying question about storage — specifically whether
to store in Friday or an external service. Should suggest Friday first.
**If broken**: Check conversation agent skill at
`packages/system/agents/conversation/skills/workspace-creation/skill.ts`.

### 6.2 Planner produces document resource in plan card

**Trigger**: Answer clarifying questions affirmatively until a workspace plan
card appears in chat.

**Expect**: Plan card shows a resource section with a document resource. Schema
shows properties: name (string), quantity (integer), category (string),
purchased (boolean). Type labeled as `document`.
**If broken**: Check planner guidance, plan card transform in
`workspace-plan-resources.svelte.ts`.

### 6.3 Workspace provisioning calls Ledger

**Trigger**: Approve the workspace plan card.

**Expect**: Workspace appears in sidebar. Verify via Ledger API:
`curl http://localhost:8080/api/ledger/resources/{workspaceId}` — shows the
grocery list resource, `type: "document"`, `currentVersion: 1`.
**If broken**: Check `provision-resources.ts`, `createLedgerClient()`.

### 6.4 Agent reads from document resource

**Trigger**:

```bash
deno task atlas prompt --chat <chatId> "What's on my grocery list?"
```

**Expect**: Agent uses `resource_read` tool with JSONB query against `draft`
CTE. Response mentions the list is empty. Agent's SQL uses `json_each()` /
`json_extract()` patterns from the SQLite skill.
**If broken**: Check resource_read tool → Ledger query endpoint.

### 6.5 Agent writes to document resource

**Trigger**:

```bash
deno task atlas prompt --chat <chatId> "Add these items to my grocery list: milk (2, dairy), eggs (12, dairy), bread (1, bakery)"
```

**Expect**: Agent uses `resource_write` with JSONB append SQL. Verify via Ledger
API draft GET — now has 3 items. Dirty flag is `true`.
**If broken**: Check resource_write tool → Ledger mutate endpoint.

### 6.6 Agent updates existing items

**Trigger**:

```bash
deno task atlas prompt --chat <chatId> "Mark milk as purchased"
```

**Expect**: Agent uses `resource_write` with `json_set` or `json_group_array`
to update the purchased field. Verify — milk row shows `purchased: true/1`.
**If broken**: Check mutate SQL patterns.

### 6.7 Agent saves resource explicitly

**Trigger**:

```bash
deno task atlas prompt --chat <chatId> "Save my grocery list"
```

**Expect**: Agent uses `resource_save` tool. `currentVersion` incremented. Dirty
flag cleared.
**If broken**: Check resource_save tool → Ledger publish endpoint.

### 6.8 Prompt injection includes resource guidance

**Trigger**: Inspect agent context via logs.

```bash
deno task atlas logs --chat <chatId> | grep -i "resource"
```

**Expect**: Agent's system prompt includes resource guidance section listing the
grocery-list resource. Guidance built by `buildResourceGuidance()`.

**Known limitation**: Skill content from `GET /v1/skill` may not be injected
— see Known Gaps (20.1).
**If broken**: Check `buildResourceGuidance()`, enrichment in
`packages/fsm-engine/fsm-engine.ts`.

---

## Section 7: CLI E2E — External Ref

### 7.1 Conversation agent acknowledges existing Notion doc

**Trigger**:

```bash
deno task atlas prompt "Set up a workspace for my reading list. Track books and ratings in Friday, and sync my reading notes to a Notion doc I already have: https://www.notion.so/Eric-s-Resource-Tester-3101d8723ea38004989ccffa52d55c45"
```

**Expect**: Agent acknowledges the Notion doc as the destination (not trying to
replace with Friday). Should suggest Friday for the book/rating data
(dual-intent). The specific URL should be captured.
**If broken**: Check workspace-creation skill.

### 7.2 Planner produces document + linked external ref

**Trigger**: Answer clarifying questions until plan card appears.

**Expect**: Plan card shows two resources: (1) document for books/ratings, (2)
external_ref for Notion with the URL. Provider icon visible.
**If broken**: Check planner pipeline, plan card transform.

### 7.3 Provisioned external ref has pre-populated ref

**Trigger**: Approve the plan. Verify via API.

```bash
curl http://localhost:8080/api/ledger/resources/{workspaceId}
```

**Expect**: External ref resource has `data.ref` set to the Notion URL (not
null). Document resource provisioned with empty data (`[]`).
**If broken**: Check provision pipeline passes ref URL through to Ledger.

### 7.4 Conversation agent captures Notion creation intent

**Trigger**:

```bash
deno task atlas prompt "Set up a workspace for project tracking. Track tasks in Friday. Store project docs in Notion — create a new database for them."
```

**Expect**: Agent understands the user wants a NEW Notion database. Should NOT
ask for a Notion URL.
**If broken**: Check workspace-creation skill.

### 7.5 Planner produces document + unlinked external ref

**Trigger**: Answer clarifying questions until plan card appears.

**Expect**: Plan card shows: (1) document for tasks, (2) external_ref for
Notion with NO ref URL.
**If broken**: Check planner — `provider` set, `ref` absent.

### 7.6 Provisioned unlinked external ref has null ref

**Trigger**: Approve the plan. Verify via API.

**Expect**: External ref entry has `type: "external_ref"`,
`data.provider: "notion"`, `data.ref: null`.
**If broken**: Check provision pipeline.

### 7.7 Notion OAuth credential available

**Trigger**: Check Settings page or
`curl http://localhost:8080/api/link/v1/credentials` for Notion credential.

**Expect**: Notion credential present with valid status. If expired, reconfigure
via Settings before proceeding.
**If broken**: Check OAuth config.

### 7.8 Agent creates Notion resource and links it

**Trigger**: Send a prompt directly to the workspace (not via `do_task` — the
workspace agent needs the FSM engine's resource tools). Use the workspace's chat:

```bash
deno task atlas prompt --workspace <workspaceId> "Create the Notion database for the unlinked external ref and register it"
```

Agent should see the unlinked external ref with the workflow instruction:
`→ Create this resource using notion MCP tools, then call resource_link_ref`

**Expect**: Agent uses Notion MCP tools to create a new database, then calls
`resource_link_ref`. Verify via API — external ref now has non-null `ref`.
**If broken**: Check `resource_link_ref` tool wiring in `fsm-engine.ts`
(requires `resourceAdapter`), Notion MCP tools, agent prompt guidance. If the
agent went through `do_task` instead, the ephemeral executor does not wire
resource tools — that's the wrong execution path for this test.

---

## Section 8: CLI E2E — Prose Document

### 8.1 Planner produces prose resource

**Trigger**:

```bash
deno task atlas prompt "Set up a workspace that maintains a weekly status report. The report should be a markdown document that gets updated each week."
```

**Expect**: Plan card shows a document resource with prose schema
(`{"type": "string", "format": "markdown"}`).
**If broken**: Check planner guidance for prose type.

### 8.2 Agent writes prose content

**Trigger**: After provisioning, prompt the agent.

```bash
deno task atlas prompt --chat <chatId> "Write this week's status report: shipped resource redesign, fixed 3 bugs, started Postgres adapter work"
```

**Expect**: Agent uses `resource_write` with `SELECT $1 FROM draft` and the
full markdown string as a bound parameter.
**If broken**: Check prose write path.

### 8.3 Agent reads prose content

**Trigger**:

```bash
deno task atlas prompt --chat <chatId> "What does my status report say?"
```

**Expect**: Agent uses `resource_read` to fetch the markdown string. Responds
with content from 8.2.
**If broken**: Check prose read path.

---

## Section 9: Multi-Session Resource Persistence

_The core value proposition — data survives across agent sessions._

### 9.1 Data persists across independent agent sessions

**Trigger**: Using a workspace with a document resource:

```bash
# Session 1: add data
deno task atlas prompt "Add 3 wines to my collection: 2019 Barolo from Piedmont rated 92, 2020 Sancerre from Loire rated 88, 2018 Rioja from Spain rated 90"

# Wait for session to complete

# Session 2: new chat, same workspace trigger
deno task atlas prompt "What wines do I have in my collection?"
```

**Expect**: Session 2 agent reads the data written by Session 1. All 3 wines
returned. Auto-publish at Session 1 end → Session 2 reads published state.
**If broken**: Check auto-publish hook at session teardown
(`packages/workspace/src/runtime.ts`). Check resetDraft on session start.

### 9.2 Data survives daemon restart

**Trigger**:

```bash
deno task atlas prompt --chat <chatId> "Add a 2017 Burgundy rated 95"
# Wait for completion
deno task atlas daemon stop
deno task atlas daemon start --detached
deno task atlas prompt "What wines do I have?"
```

**Expect**: All wines present after restart. SQLite database persists on disk.
**If broken**: Check `LEDGER_SQLITE_PATH` — ensure not in-memory.

### 9.3 Version history accumulates across sessions

**Trigger**: After multiple sessions with mutations:

```bash
curl http://localhost:8080/api/ledger/resources/{workspaceId}/{slug}?published=true
```

**Expect**: `currentVersion` reflects all published snapshots. Published data
matches latest state. Older versions preserved.
**If broken**: Check `publish()` version numbering, auto-publish hooks.

### 9.4 Browser reflects agent-written data

**Trigger**: After agent writes data via CLI (9.1), navigate to the workspace
in the browser and click "View" on the resource.

**Expect**: Detail page shows the data written by the agent — correct columns,
rows, current values. No stale cache.
**If broken**: Check detail page data fetch.

---

## Section 10: Auto-Publish Lifecycle

### 10.1 Auto-publish after agent turn

**Trigger**: Prompt the agent to add items without asking it to save.

```bash
deno task atlas prompt --chat <chatId> "Add yogurt and granola to my grocery list"
```

**Expect**: After agent finishes, dirty drafts auto-published. `currentVersion`
incremented, dirty flag cleared.
**If broken**: Check auto-publish hook in
`packages/workspace/src/runtime.ts`.

### 10.2 Auto-publish skips clean drafts

**Trigger**: After 10.1, trigger a read-only agent turn.

```bash
deno task atlas prompt --chat <chatId> "What's on my grocery list?"
```

**Expect**: No new version created. `currentVersion` unchanged.
**If broken**: Check `publish()` returns `{ version: null }` for clean drafts.

### 10.3 Auto-publish after FSM step completion

**Trigger**: Trigger a workspace with an FSM-driven agent that modifies a
resource during a step.

**Expect**: After each FSM step, dirty drafts published before state transition.
**If broken**: Check auto-publish hook in
`packages/fsm-engine/fsm-engine.ts`.

### 10.4 Auto-publish at session teardown (defensive)

**Trigger**: Trigger a workspace agent run that modifies a resource. Check
version history after session completes.

**Expect**: Teardown hook fires safely (no-op for clean drafts). Failures logged
as warnings, not thrown.
**If broken**: Check finally block in
`packages/workspace/src/runtime.ts`.

---

## Section 11: Resource Guidance Quality

_Verify the agent's system prompt contains correct, type-appropriate resource
instructions._

### 11.1 Document resource guidance includes read/write tools

**Trigger**: Trigger an agent turn in a workspace with only document resources.

```bash
deno task atlas logs --chat <chatId> --level debug | grep -A 30 "Workspace Resources"
```

**Expect**: Guidance lists each document resource by slug. Mentions
`resource_read` for queries and `resource_write` for mutations. Does NOT mention
`artifacts_get` or DuckDB.
**If broken**: Check `buildResourceGuidance()` in
`packages/resources/src/guidance.ts`.

### 11.2 Artifact-ref guidance says use DuckDB/artifacts_get

**Trigger**: Workspace with an artifact-ref resource. Trigger agent.

**Expect**: Guidance lists artifact-ref under "Datasets" (database type with row
count) or "Files" (other types). Mentions read-only access. Does NOT mention
`resource_read`/`resource_write`.
**If broken**: Check `buildResourceGuidance()` artifact_ref routing.

### 11.3 Unlinked external-ref guidance includes creation workflow

**Trigger**: Workspace with unlinked external ref. Trigger agent.

**Expect**: Guidance shows `(unregistered)` marker and workflow instruction:
`→ Create this resource using [provider] MCP tools, then call resource_link_ref
with the URL/ID to register it.`
**If broken**: Check `buildResourceGuidance()` unlinked external_ref handling.

### 11.4 Linked external-ref guidance shows ref URL

**Trigger**: Workspace with linked external ref. Trigger agent.

**Expect**: Guidance shows provider name and ref URL. No "unregistered" marker.
No "create" instruction.
**If broken**: Check `buildResourceGuidance()` linked external_ref handling.

### 11.5 Mixed workspace guidance categorizes correctly

**Trigger**: Workspace with all three resource types. Trigger agent.

**Expect**: Guidance has sections: "Documents" (read/write tools), "Datasets" or
"Files" (artifact access), "External Resources" (provider info). Each resource
in correct category. No duplicates.
**If broken**: Check `buildResourceGuidance()` categorization.

### 11.6 Unavailable artifact-ref omitted from guidance

**Trigger**: Workspace with artifact-ref whose backing artifact was deleted.
Trigger agent.

**Expect**: Unavailable artifact-ref does NOT appear in guidance. Other resources
still appear.
**If broken**: Check filter in `buildResourceGuidance()`.

### 11.7 Skill text appended when document resources exist

**Trigger**: Workspace with document resource. Inspect logs for skill content.

```bash
deno task atlas logs --chat <chatId> --level debug | grep -i "skill\|json_extract\|json_each"
```

**Expect**: Agent context includes SQLite JSONB skill text with `json_extract`,
`json_each`, `json_set` patterns.

**NOTE**: Per Known Gap 20.1, skill injection may not be wired. If absent, this
confirms the gap — not a new failure.
**If broken**: Check FSM engine skill injection at
`packages/fsm-engine/fsm-engine.ts`.

---

## Section 12: Browser — Workspace Creation

_Full user journey from chat through resource-backed workspace in the browser._

### 12.1 Create workspace with tabular document via chat UI

**Trigger**: Navigate to `http://localhost:1420/chat`. Type:
> "Create a workspace that tracks my wine collection. Store wine name, vintage
> year, region, rating, and tasting notes for each bottle."

Answer clarifying questions affirmatively (store in Friday).

**Expect**: Plan card appears in chat. Resource section shows a document resource
with matching properties. Approve the plan. Workspace appears in sidebar.
Navigate to workspace detail — resources section shows the resource with "View"
link and document badge.
**If broken**: Check conversation agent skill, planner, provision-resources.ts.

### 12.2 Create workspace with prose resource via chat UI

**Trigger**: New chat:
> "Create a workspace that maintains a daily standup summary. The summary should
> be a markdown document that gets updated each morning."

**Expect**: Plan card shows a prose resource. After approval, workspace detail
shows the resource. Detail page shows prose format indicator and empty content.
**If broken**: Check planner prose handling.

### 12.3 Create workspace with linked external ref via chat UI

**Trigger**: New chat:
> "Create a workspace for recipe management. Track ingredients in Friday, and
> link to my Google Sheet for meal planning:
> https://docs.google.com/spreadsheets/d/1abc123/edit"

**Expect**: Plan card shows two resources: document for ingredients, external_ref
with Google Sheets icon and URL. After approval, workspace detail shows both.
External ref row shows "Open" link.
**If broken**: Check planner external_ref, plan card provider icon rendering.

### 12.4 Create workspace with unlinked external ref via chat UI

**Trigger**: New chat:
> "Create a workspace for meeting notes. Track action items in Friday. Create a
> new Notion database for the full meeting minutes."

**Expect**: Plan card shows two resources: document for action items, external_ref
for Notion with NO ref URL. After approval, Notion resource shows "Unlinked"
badge (orange).
**If broken**: Check planner — `provider: "notion"`, `ref` absent.

### 12.5 Create workspace with all three resource types

**Trigger**: New chat:
> "Create a workspace for my podcast production. Track episode details (title,
> guest, status, publish date) in Friday. Store the show notes as a markdown
> document. Link to my existing Notion page for research:
> https://notion.so/podcast-research-abc123"

**Expect**: Plan card shows three resources: tabular doc, prose doc, external_ref.
After approval, all three on workspace detail with correct type rendering.
**If broken**: Check planner mixed types, resources-section.svelte.

---

## Section 13: Browser — Plan Card Preview

### 13.1 Tabular document shows structured display

**Trigger**: Observe plan card from 12.1 before approving.

**Expect**: Resource section shows a mini-table with column names and types from
schema. Clear visual structure, not just a name.
**If broken**: Check `transformResourcesForDisplay()` in
`workspace-plan-resources.svelte.ts`.

### 13.2 Prose document shows document display

**Trigger**: Observe plan card from 12.2.

**Expect**: Resource shows as file icon + name + description. No column preview.
**If broken**: Check prose schema → document display kind.

### 13.3 External-ref shows provider icon

**Trigger**: Observe plan card from 12.3 or 12.4.

**Expect**: Resource shows with provider icon (Google Sheets, Notion).
Humanized provider name. If linked, shows ref indicator. If creating, shows
creation intent.
**If broken**: Check external_ref → external display kind with provider.

### 13.4 Mixed resources render correctly together

**Trigger**: Observe plan card from 12.5.

**Expect**: All three types render with type-appropriate displays — structured
table, file icon, provider icon. No layout break.
**If broken**: Check plan card heterogeneous layout.

### 13.5 Overflow count for 6+ resources

**Trigger**: New chat:
> "Track inventory, orders, customers, suppliers, shipments, returns, and
> refunds — each as a separate table in Friday"

**Expect**: Plan card shows first ~5 resources, then "+N more" overflow count.
**If broken**: Check overflow logic in workspace-plan-resources.svelte.ts.

---

## Section 14: Browser — Resource List & Detail

_All cases use claude-in-chrome. Navigate to `http://localhost:1420`._

### 14.1 Resource list on workspace detail page

**Trigger**: Navigate to `/spaces/{spaceId}` for a workspace with resources.

**Expect**: Resources section visible. Each resource shows name, type badge,
action buttons. Documents show "View". External refs show "Open" (linked) or
"Unlinked" badge. Artifact refs show "Read-only" badge.
**If broken**: Check `resources-section.svelte`, `resource-row.svelte`.

### 14.2 Document resource detail page — tabular

**Trigger**: Click "View" on a tabular document resource.

**Expect**: Schema header, data rows, version info. Correct columns displayed.
**If broken**: Check detail page route.

### 14.3 Document resource detail page — prose

**Trigger**: Navigate to a prose document resource detail page.

**Expect**: Schema indicates markdown. Data rendered as formatted markdown.
**If broken**: Check prose rendering path.

### 14.4 Upload resource via UI

**Trigger**: Click upload button in Resources section. Select a small CSV file.

**Expect**: Upload succeeds, new resource appears without page refresh (TanStack
Query invalidation). Correct name and type.
**If broken**: Check `resource-upload.ts`, mutation invalidation.

### 14.5 Replace resource via UI

**Trigger**: Click replace button on a tabular document. Select a different CSV.

**Expect**: Data fully replaced. Detail page shows new rows. Loading state
during mutation.
**If broken**: Check `replaceResource()`, mutation state.

### 14.6 CSV download from detail page

**Trigger**: On tabular detail page, click "Download as CSV".

**Expect**: Browser downloads a `.csv` file with proper headers and all rows.
**If broken**: Check download action hits export endpoint.

### 14.7 Delete resource with confirmation

**Trigger**: Click delete (trash icon) on a resource.

**Expect**: Confirmation dialog with resource name. "Remove" deletes it. "Cancel"
dismisses without action.
**If broken**: Check AlertDialog, delete mutation.

### 14.8 External ref badges — linked vs unlinked

**Trigger**: Workspace with both linked and unlinked external refs.

**Expect**: Linked shows "Open" link (opens new tab). Unlinked shows "Unlinked"
badge (orange). No replace button on external refs.
**If broken**: Check `resource-row.svelte` external_ref rendering.

### 14.9 Artifact-ref read-only badge

**Trigger**: Workspace with an artifact_ref resource.

**Expect**: "Read-only" badge. "View" navigates to `/library/{artifactId}`.
Replace and delete available.
**If broken**: Check artifact_ref rendering.

### 14.10 Empty state — no resources

**Trigger**: Workspace with no resources.

**Expect**: Dashed border box with "No resources yet" and upload button.
**If broken**: Check empty state in `resources-section.svelte`.

### 14.11 Plan card resource preview

**Trigger**: Start workspace creation and observe plan card before approval.

**Expect**: Resource section shows structured preview — property names/types for
documents, provider icon for external refs. Overflow count for 6+ resources.
**If broken**: Check `transformResourcesForDisplay()`.

### 14.12 External ref shows "Open" after agent links it

**Trigger**: After an agent links an external ref (7.8), navigate to workspace
detail.

**Expect**: Previously "Unlinked" badge now shows "Open" link. May need refresh.
**If broken**: Check query invalidation after agent turns.

---

## Section 15: Browser — Artifact-Ref

### 15.1 Upload binary file via browser → artifact-ref

**Trigger**: On workspace detail, click "Add". Select a PDF or image file.

**Expect**: New resource with "Read-only" badge. Name derived from filename. No
page refresh needed.
**If broken**: Check `resource-upload.ts`, `classifyUpload()`.

### 15.2 View artifact-ref navigates to library

**Trigger**: Click "View" on the artifact-ref resource.

**Expect**: Browser navigates to `/library/{artifactId}`. Artifact content
displayed.
**If broken**: Check artifact_ref "View" link uses `artifactId`.

### 15.3 Replace artifact-ref with new file

**Trigger**: Click replace on the artifact-ref. Select a different file.

**Expect**: Replace completes. Name unchanged, artifact backing updated. "View"
shows new content. Loading state during upload.
**If broken**: Check replace route for artifact_ref.

### 15.4 Unavailable artifact — deleted backing artifact

**Trigger**: Upload artifact-ref, then delete the backing artifact via API.
Navigate back to workspace detail.

**Expect**: Resource shows "Unavailable" badge (orange). "View" disabled/grayed.
Replace still functional.
**If broken**: Check `enrichCatalogEntries()`, unavailable rendering.

### 15.5 Unavailable artifact excluded from agent guidance

**Trigger**: After 15.4, trigger agent turn. Check logs.

**Expect**: Unavailable artifact-ref not in guidance. Other resources present.
**If broken**: Check `buildResourceGuidance()` filter.

### 15.6 Artifact-ref detail page returns 404

**Trigger**: Navigate to `/spaces/{spaceId}/resources/{artifactRefSlug}`.

**Expect**: 404. Detail page only works for document resources.
**If broken**: Check daemon GET route type guard.

---

## Section 16: Browser — External-Ref

### 16.1 Linked external-ref "Open" navigates to external URL

**Trigger**: Click "Open" on a linked external ref.

**Expect**: External URL opens in new tab (`target="_blank"`). Original page
stays open. URL matches stored ref.
**If broken**: Check `resource-row.svelte` link rendering.

### 16.2 Unlinked external-ref shows badge, no Open link

**Trigger**: Workspace with unlinked external ref.

**Expect**: "Unlinked" badge (orange). No "Open" link. Delete available. No
replace button.
**If broken**: Check conditional rendering.

### 16.3 External-ref has no replace button

**Trigger**: Observe action buttons on external-ref row.

**Expect**: Only delete (trash). No replace. External refs managed via
`resource_link_ref`.
**If broken**: Check replace button type guard.

### 16.4 Agent links unlinked external-ref, UI updates

**Trigger**: From workspace with unlinked Notion ref, trigger agent:

```bash
deno task atlas prompt --chat <chatId> "Create the Notion database for meeting minutes and link it to the workspace"
```

Navigate to workspace detail after completion.

**Expect**: "Unlinked" now shows "Open" with link. Verify `data.ref` populated.
**If broken**: Check `resource_link_ref` tool, TanStack Query refetch.

### 16.5 External-ref detail page returns 404

**Trigger**: Navigate to `/spaces/{spaceId}/resources/{externalRefSlug}`.

**Expect**: 404. External refs don't have detail pages.
**If broken**: Check detail route type guard.

---

## Section 17: Browser — Error UX

### 17.1 Upload slug collision — error or auto-retry

**Trigger**: Upload a CSV. Then upload another file with the same filename.

**Expect**: Either (a) error toast mentioning slug collision, or (b) auto-retry
with suffix and both resources appear. Check which behavior is implemented.
**If broken**: Check `uploadResource()` in `resource-upload.ts`.

### 17.2 Replace type mismatch shows error feedback

**Trigger**: On tabular document, click Replace and select a `.json` file.

**Expect**: Error feedback stating table resources require CSV. Original data
unchanged.
**If broken**: Check 422 response handling in `resource-upload.ts`.

### 17.3 Upload progress and loading state

**Trigger**: Upload a 1-2 MB CSV. Observe UI during upload.

**Expect**: Upload button shows loading/disabled state. No double-submit. State
clears on completion.
**If broken**: Check mutation state in `resources-section.svelte`.

### 17.4 Delete confirmation — cancel preserves resource

**Trigger**: Click delete, then click "Cancel" in dialog.

**Expect**: Dialog dismisses. Resource still present. No API call made.
**If broken**: Check AlertDialog cancel handler.

### 17.5 Empty state after deleting last resource

**Trigger**: Delete all resources one by one.

**Expect**: Empty state appears — "No resources yet" with upload button.
**If broken**: Check cache invalidation after delete.

---

## Section 18: Feature Flag

### 18.1 Resource nav hidden when flag is off

**Trigger**: Ensure `ENABLE_WORKSPACE_NAV_RESOURCES` is `false` (default).
Navigate to workspace with resources.

**Expect**: Resources navigation item NOT visible. Resources section on detail
page may still render.
**If broken**: Check `feature-flags.ts`, navigation components.

### 18.2 Resource nav visible when flag is on

**Trigger**: Set flag to `true`. Reload web client.

**Expect**: Navigation item appears. Clicking navigates to resources view.
**If broken**: Check flag override mechanism, nav conditional rendering.

---

## Section 19: Edge Cases & Error Handling

### 19.1 Schema evolves between versions

**Trigger**: Provision a resource, publish, then re-provision with updated schema
(add property). Mutate and publish again.

**Expect**: Version 1 has original schema. Version 2+ has updated schema. Each
version row retains its own schema independently.
**If broken**: Check schema stored per version row, provision upsert.

### 19.2 Nested document schema

**Trigger**: Provision a document with nested schema:

```bash
curl -X POST http://localhost:8080/api/ledger/resources/test-ws/provision \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": "default-user",
    "slug": "sprint-notes",
    "name": "Sprint Notes",
    "description": "Sprint planning with nested topics",
    "type": "document",
    "schema": {
      "type": "object",
      "properties": {
        "title": {"type": "string"},
        "attendees": {"type": "array", "items": {"type": "string"}},
        "topics": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {"type": "string"},
              "action_items": {"type": "array", "items": {"type": "string"}}
            }
          }
        }
      }
    },
    "initialData": {"title": "", "attendees": [], "topics": []}
  }'
```

**Expect**: Provision succeeds. Draft stores nested JSONB. Query can traverse
nested paths.
**If broken**: Check JSONB handling for non-array top-level data.

### 19.3 Error enrichment on bad query

**Trigger**:

```bash
curl -X POST http://localhost:8080/api/ledger/resources/test-ws/grocery-list/query \
  -H 'Content-Type: application/json' \
  -d '{"sql": "SELECTT * FROM draft"}'
```

**Expect**: Error response with SQLite error AND resource schema context for
agent self-correction.
**If broken**: Check error handling in `query()`.

### 19.4 Agent self-correcting on artifact_ref query

**Trigger**: Call query on an artifact_ref resource.

**Expect**: Error clearly states:
`Query is only supported on document resources, got type="artifact_ref"`.
**If broken**: Check type guard in `query()` and `mutate()`.

### 19.5 Missing artifact for artifact-ref resource

**Trigger**: Create artifact_ref, delete backing artifact, list resources.

**Expect**: Resource appears with `artifactType: "unavailable"`.
`buildResourceGuidance()` drops it from agent guidance. UI shows warning badge.
**If broken**: Check `enrichCatalogEntries()`.

### 19.6 CSV values are all strings

**Trigger**: Upload CSV with numeric values, query with numeric comparison.

**Expect**: String comparison behavior — `"12" > "5"` is false. Agent may need
CAST or `+0` coercion.
**If broken**: Known limitation — see 20.5.

---

## Section 20: Known Gaps & Discrepancies

_Intentional divergences or missing features. Not test failures._

### 20.1 Skill not injected into agent prompts

The Ledger serves a SQLite JSONB skill at `GET /v1/skill`, but no code fetches
or injects it. Agents rely on training + `buildResourceGuidance()`.

### ~~20.2 TXT files classified as artifact_ref, not prose~~ RESOLVED

Implementation already classifies `.txt` as prose alongside `.md` and
`.markdown` in `upload-strategy.ts:30`. Matches v6 design.

### 20.3 DOCX upload does not convert to markdown

v6 user story 5 specifies DOCX → prose conversion. Not implemented.

### 20.4 Prose resource replace requires CSV

Replace endpoint requires `mimeType === "text/csv"` for all `type: "document"`.
Prose documents can't be replaced with `.md` files — they get 422.

### 20.5 CSV values are all strings

PapaParse doesn't type-infer. All values stored as strings in JSONB. Schema may
declare `integer` but data contains `"12"`.

---

## Section 21: Postgres-Specific (Deferred)

_Run after production deployment._

- **RLS enforcement** — user A cannot see user B's resources
- **`SET TRANSACTION READ ONLY`** — agent SQL rejected on DML in Postgres
- **Partial unique index** — draft uniqueness via Postgres partial index
- **Immutability triggers** — Postgres trigger syntax for version protection
- **`withUserContext()`** — JWT → userId extraction → RLS scoping
- **TOAST performance** — JSONB blob handling at 5MB boundary

---

## Smoke Candidates

Cases durable enough for the smoke matrix:

- **1.1** (Provision tabular document) — core provision + auto-publish
- **1.4** (List resources) — fast catalog check
- **1.6 + 1.8** (Mutate + publish cycle) — draft/publish model
- **2.1** (Read-only enforcement) — security boundary
- **2.8** (Workspace isolation) — tenant isolation
- **3.4** (Skill endpoint) — agent skill serving
- **3.5** (Health endpoint) — service liveness
- **4.2** (Agent session starts clean) — crash recovery
- **5.1** (Small CSV upload) — most common upload path
- **5.11** (CSV export) — download path
- **9.1** (Multi-session persistence) — THE core value prop
- **9.4** (Browser reflects agent data) — CLI↔browser consistency
- **10.1** (Auto-publish after agent turn) — lifecycle hook
- **11.5** (Mixed guidance categorization) — prompt correctness
- **12.1** (Browser workspace creation) — full UI flow
- **14.1** (Resource list UI) — web client rendering
- **14.2** (Document detail page) — detail view
- **15.1** (Upload binary → artifact-ref) — upload classification in browser
- **16.1** (External-ref Open link) — linked ref navigation
- **17.1** (Upload error feedback) — error UX path
