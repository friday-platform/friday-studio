# QA Plan: HubSpot CRM Agent

**Context**: `docs/plans/2026-03-10-hubspot-crm-agent-design.md`
**Branch**: `feature/hubspot-crm-agent`
**Date**: 2026-03-11

## Prerequisites

- Daemon running: `deno task atlas daemon start --detached`
- Web client running: `cd apps/web-client && npm run dev` (for OAuth flow)
- HubSpot credentials configured in `apps/link/.env`:
  ```
  HUBSPOT_CLIENT_ID_FILE=/Users/sara/creds_atlas/hubspot-account-client-id
  HUBSPOT_CLIENT_SECRET_FILE=/Users/sara/creds_atlas/hubspot-account-client-secret
  ```
- Browser available (claude-in-chrome) for OAuth popup flow

## Cases

### Phase 1: OAuth & Provider Setup

#### 1. HubSpot provider loads with credentials
**Trigger**: Start daemon, then `curl http://localhost:8080/api/link/v1/credentials`
**Expect**: Response includes a `hubspot` provider entry. If no credential stored yet, provider should be listed as available for authorization.
**If broken**: Check `apps/link/.env` has correct env var names (`HUBSPOT_CLIENT_ID_FILE`, not `HUBSPOT_ACCOUNT_CLIENT_ID_FILE`). Check daemon logs: `deno task atlas logs --since 60s`

#### 2. OAuth authorization flow completes
**Trigger**: Navigate to `http://localhost:1420/settings` in browser. Click "Connect" for HubSpot. Complete the OAuth flow in the HubSpot authorization popup.
**Expect**: After authorizing, the Settings page shows HubSpot as connected. `curl http://localhost:8080/api/link/v1/credentials` returns a credential with provider `hubspot` and `healthy: true`.
**If broken**: Check Link service logs. Verify callback URL matches `LINK_CALLBACK_BASE` in `.env`. Check HubSpot developer portal for app redirect URI config. Check browser console for popup/postMessage errors.

### Phase 2: Read Operations

#### 3. Search contacts
**Trigger**: `deno task atlas prompt "Search for contacts in my HubSpot account. Show me the first 5 contacts."`
**Expect**: Agent responds with a list of contacts including names and emails. Response references actual HubSpot data, not hallucinated records.
**If broken**: `deno task atlas logs --since 60s --level error`. Check if credential resolution works — agent needs `HUBSPOT_ACCESS_TOKEN` resolved from Link. Check `search_crm_objects` tool execution in transcript: `deno task atlas chat <chatId> --human`

#### 4. Get object properties
**Trigger**: `deno task atlas prompt "What properties are available on contacts in my HubSpot?"`
**Expect**: Agent uses `get_properties` tool and returns a list of HubSpot contact properties (firstname, lastname, email, etc.). Should mention property types.
**If broken**: Check if `get_properties` tool is being called. Look at transcript for tool call/result shapes.

#### 5. Search owners
**Trigger**: `deno task atlas prompt "Who are the owners in my HubSpot account?"`
**Expect**: Agent uses `search_owners` tool and returns account owner(s) with names and emails.
**If broken**: Check `search_owners` tool execution. This may return empty if account has no assigned owners.

#### 6. Get pipelines
**Trigger**: `deno task atlas prompt "Show me the deal pipelines and their stages in my HubSpot."`
**Expect**: Agent uses `get_pipelines` tool and returns pipeline names with ordered stage lists.
**If broken**: Check `get_pipelines` tool. Verify HubSpot account has at least one deal pipeline configured.

### Phase 3: Write Operations

#### 7. Create a contact
**Trigger**: `deno task atlas prompt "Create a test contact in HubSpot: First name 'QA', last name 'TestBot', email 'qa-testbot@friday-test.example.com'"`
**Expect**: Agent uses `create_crm_objects` tool. Response confirms contact was created and includes the new record's ID.
**If broken**: Check tool execution in transcript. Look for HubSpot API error codes (409 = duplicate, 400 = missing required fields).

#### 8. Update a contact
**Trigger**: Continue the conversation: `deno task atlas prompt --chat <chatId> "Update that contact's job title to 'QA Engineer'"`
**Expect**: Agent uses `update_crm_objects` tool referencing the contact ID from Case 7. Confirms the update succeeded.
**If broken**: Check that agent correctly carries forward the contact ID from the previous turn. Look at `update_crm_objects` tool call parameters.

#### 9. Create and associate a note
**Trigger**: Continue the conversation: `deno task atlas prompt --chat <chatId> "Create a note saying 'QA test note - created by Friday automation' and associate it with the contact we just created"`
**Expect**: Agent creates a note via `create_crm_objects` then uses `manage_associations` to link the note to the contact. Confirms both operations.
**If broken**: Check if both tool calls appear in transcript. Association may fail if object types or direction are wrong — check `manage_associations` parameters.

### Phase 4: Upsert & Get-by-ID

#### 10. Upsert creates new record
**Trigger**: `deno task atlas prompt "Upsert a contact with email 'upsert-new@friday-test.example.com', first name 'Upsert', last name 'NewTest'. Use email as the identity property."`
**Expect**: Agent uses `upsert_crm_objects` with `idProperty: "email"`. Response confirms the contact was created (new: true) and returns the record ID.
**If broken**: Check `upsert_crm_objects` tool call in transcript. Verify `idProperty` is set to `"email"`. Look for HubSpot API 400 if the idProperty doesn't exist on contacts.

#### 11. Upsert updates existing record
**Trigger**: Continue the conversation: `deno task atlas prompt --chat <chatId> "Upsert a contact with email 'upsert-new@friday-test.example.com', set job title to 'Upserted Engineer'. Use email as identity."`
**Expect**: Agent uses `upsert_crm_objects` again. This time the response should indicate the record was updated (new: false), not created. The contact should have job title 'Upserted Engineer'.
**If broken**: Check if `_new` field is correctly read from SDK response. If the contact from Case 10 doesn't exist, upsert creates a duplicate instead of updating.

#### 12. Get single contact by ID with associations
**Trigger**: Continue the conversation: `deno task atlas prompt --chat <chatId> "Get the full details of that contact by ID, and include any associated notes"`
**Expect**: Agent uses `get_crm_object` with the contact ID from Case 10/11 and `associationTypes: ["notes"]`. Returns the contact properties and any linked note IDs.
**If broken**: Check that `get_crm_object` (not `get_crm_objects` batch) is called. Association results may be empty if no notes are linked — that's fine, the tool should still return the contact data.

### Phase 5: Complex Queries

#### 13. Multi-step search with filters
**Trigger**: `deno task atlas prompt "Find all deals in the negotiation stage, then show me the companies associated with those deals"`
**Expect**: Agent performs multiple tool calls — searches deals with stage filter, then fetches associated companies. Provides a coherent summary linking deals to companies.
**If broken**: Check if agent uses multiple tool calls in sequence. May hit AND-only filter limitation — transcript will show how agent works around it.

#### 14. Bulk operations
**Trigger**: `deno task atlas prompt "Create 3 test contacts: Alice Test (alice@friday-test.example.com), Bob Test (bob@friday-test.example.com), Carol Test (carol@friday-test.example.com)"`
**Expect**: Agent creates all 3 in a single `create_crm_objects` batch call (not 3 separate calls). Confirms all 3 with their IDs.
**If broken**: Check if agent batches correctly. Max batch size is 10 per call.

#### 15. Paginated search results
**Trigger**: `deno task atlas prompt "Search for ALL contacts in my HubSpot. I need every single one, keep paginating until you have them all."`
**Expect**: Agent uses `search_crm_objects` with pagination — first call returns results and a `nextCursor`, agent makes subsequent calls with `after` set to that cursor until no more pages. Final count should match HubSpot's total.
**If broken**: Check transcript for multiple `search_crm_objects` calls. If agent stops after first page, check if it's reading the `nextCursor` field from the response. Note: HubSpot search maxes out at 10,000 results.

### Phase 6: Associations (Unlink & List)

#### 16. List associations
**Trigger**: `deno task atlas prompt "Show me all associations for the QA TestBot contact (qa-testbot@friday-test.example.com) — what objects are linked to it?"`
**Expect**: Agent uses `manage_associations` with `action: "list"` and the contact ID. Should return the note linked in Case 9 (if still present from prior run).
**If broken**: Check `manage_associations` parameters — needs `fromObjectType`, `fromObjectId`, `toObjectType`. May need to search for the contact first to get the ID.

#### 17. Unlink association
**Trigger**: Continue: `deno task atlas prompt --chat <chatId> "Unlink that note from the QA TestBot contact"`
**Expect**: Agent uses `manage_associations` with `action: "unlink"`. Confirms the association was removed. A subsequent `list` should show no linked notes.
**If broken**: Check the association type IDs used. Unlinking requires the same fromObjectType/toObjectType as linking. Verify by re-listing associations.

### Phase 7: Error Handling & Edge Cases

#### 18. Read-only object enforcement
**Trigger**: `deno task atlas prompt "Create a new quote in HubSpot for $1000"`
**Expect**: Agent should refuse or explain that quotes are read-only. Should NOT attempt to call `create_crm_objects` with objectType "quotes".
**If broken**: Check tool validation — quotes should be blocked at the Zod schema level for write operations.

#### 19. Batch size limit exceeded
**Trigger**: `deno task atlas prompt "Create 15 test contacts: generate names test-01 through test-15 with emails test-01@friday-test.example.com through test-15@friday-test.example.com"`
**Expect**: Agent either splits into two batches (10 + 5) or the tool rejects the input with a Zod validation error (max 10 per call). Either behavior is acceptable — the key is it doesn't silently drop records.
**If broken**: Check `create_crm_objects` tool call parameters. If Zod rejects, the agent should explain the limit and retry with smaller batches. If it silently creates only 10, that's a bug.

#### 20. Create with missing required properties
**Trigger**: `deno task atlas prompt "Create a deal in HubSpot with no properties at all — just an empty deal"`
**Expect**: HubSpot API returns a 400 error because deals require at minimum a `dealname`. Agent should surface this error clearly, not crash. Ideally the agent calls `get_properties` first to discover required fields.
**If broken**: Check the error response from HubSpot. The tool wraps errors via `stringifyError()` — verify the error message is informative, not a raw stack trace.

#### 21. Token expiry resilience
**Trigger**: Wait 30+ minutes after OAuth (or if testing later in the session), then: `deno task atlas prompt "Search for contacts in my HubSpot"`
**Expect**: Agent still works — Link's proactive token refresh should have refreshed the access token automatically.
**If broken**: Check `deno task atlas logs --level error` for 401 errors from HubSpot API. Check Link's token refresh logic.

### Phase 8: Cleanup

#### 22. Clean up test data
**Trigger**: `deno task atlas prompt "Search for all contacts with email ending in @friday-test.example.com and tell me their IDs"`
**Expect**: Returns all test contacts created during QA (Cases 7, 10-11, 14, 19). Note: the agent can't delete them (no delete tool), but we verify they exist for manual cleanup.
**If broken**: Search filter on email may need exact match — check if the agent uses CONTAINS_TOKEN or HAS_PROPERTY filter operators correctly.

## Smoke Candidates

- Case 1 (provider loads) — fast prerequisite check, durable
- Case 3 (search contacts) — core read path, exercises credential resolution and tool execution
- Case 7 (create contact) — core write path, validates permissions and tool execution
- Case 9 (create + associate) — multi-tool interaction, catches association/linking regressions
- Case 10 (upsert new) — exercises upsert code path, critical for sync workflows

## Pre-QA Findings

- **ENV var mismatch (FIXED)**: `apps/link/.env` had `HUBSPOT_ACCOUNT_CLIENT_ID_FILE` but provider code reads `HUBSPOT_CLIENT_ID_FILE`. Updated .env to match code.
