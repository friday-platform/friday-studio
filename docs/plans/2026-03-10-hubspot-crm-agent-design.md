# HubSpot Agent — Design Document

**Date**: 2026-03-10
**Status**: Implemented

---

## Problem Statement

Friday's current HubSpot integration uses HubSpot's official MCP server
(`mcp.hubspot.com`), which requires user-level OAuth apps. User-level apps
**cannot have write scopes** — this is a platform-level restriction, not a
temporary limitation. As a result, agents can only read CRM data (search
contacts, view deals, list properties) but cannot create, update, or log
activities.

Users need agents that can take action in HubSpot — create contacts from
inbound leads, update deal stages, log meeting notes, associate engagements with
records — the same capabilities available in HubSpot's own Claude connector.

## Solution

Build a **bundled HubSpot agent** with 10 tools backed by the official
`@hubspot/api-client` SDK (`^13.4.0`), bypassing the read-only MCP server. Use
account-level OAuth (via the `hubspot-account` Link provider) to get full
read/write access across all CRM object types.

The tool design mirrors the existing MCP's pattern (generic over object types,
minimal tool count) while adding create, update, and association management
capabilities.

---

## User Stories

1. As a sales rep, I want to ask Friday to create a new contact from an inbound
   email, so that leads are captured in HubSpot without manual data entry.
2. As a sales rep, I want to update a deal stage by telling Friday, so that my
   pipeline stays current without switching to HubSpot.
3. As an account manager, I want Friday to log a meeting note and associate it
   with a contact and company, so that engagement history is complete.
4. As a sales rep, I want to search for contacts by company or deal stage, so
   that I can quickly find relevant records during calls.
5. As a team lead, I want to look up which rep owns a deal, so that I know who
   to follow up with.
6. As a sales rep, I want to create a task in HubSpot linked to a deal, so that
   follow-up actions are tracked.
7. As a support agent, I want to create a ticket and associate it with a
   contact, so that customer issues are tracked in HubSpot.
8. As a sales rep, I want to view property definitions before creating records,
   so that I know which fields are required and what values are valid.
9. As a user, I want to update multiple contacts at once (up to 10), so that
   bulk changes are efficient.
10. As a sales rep, I want to log a call engagement with notes and associate it
    with a contact and deal, so that call history is captured.
11. As a team lead, I want to view all deals in a specific pipeline stage, so
    that I can assess pipeline health.
12. As a user, I want to read email engagement history for a contact, so that I
    can review past communication before a meeting.
13. As a user, I want to search for line items on a deal, so that I can
    understand the deal's financial details.
14. As a user, I want to read quote and invoice data, so that I can check
    billing status without opening HubSpot.
15. As an admin, I want to connect my HubSpot account once, so that all agents
    in the workspace can access CRM data without individual OAuth flows.

---

## Implementation Decisions

### Tool Set (10 tools)

All tools delegate to the official `@hubspot/api-client` SDK (`^13.4.0`), which
handles HTTP, auth headers, rate limiting (Bottleneck, 9 req/s), and automatic
retry on 429/5xx. The `objectType` parameter makes them generic across all
supported CRM object types.

| # | Tool | HTTP Method & Endpoint | Purpose |
|---|------|------------------------|---------|
| 1 | `search_crm_objects` | `POST /crm/v3/objects/{objectType}/search` | Search with filters, sorts, pagination. Returns matching records with requested properties. |
| 2 | `get_crm_objects` | `POST /crm/v3/objects/{objectType}/batch/read` | Fetch 1+ objects by ID with specific properties. |
| 3 | `get_crm_object` | `GET /crm/v3/objects/{objectType}/{id}` | Fetch a single record by ID with optional associations. More efficient than batch read + list associations for single-record lookups. |
| 4 | `create_crm_objects` | `POST /crm/v3/objects/{objectType}/batch/create` | Create 1–10 records with properties and optional inline associations. |
| 5 | `update_crm_objects` | `POST /crm/v3/objects/{objectType}/batch/update` | Update 1–10 records by ID with changed properties. |
| 6 | `upsert_crm_objects` | `POST /crm/v3/objects/{objectType}/batch/upsert` | Create-or-update 1–10 records matched by a unique property (e.g. email). |
| 7 | `get_properties` | `GET /crm/v3/properties/{objectType}` | List property definitions (field names, types, options, required flags). Filters hidden properties. |
| 8 | `search_owners` | `GET /crm/v3/owners` | List/search owners with optional email filter. |
| 9 | `get_pipelines` | `GET /crm/v3/pipelines/{objectType}` | Get pipeline definitions and stages for deals or tickets. |
| 10 | `manage_associations` | `PUT/DELETE /crm/v4/objects/{from}/{id}/associations/{to}/{toId}` | Link, unlink, or list associations between records. |

### Supported Object Types & Permissions Matrix

12 object types supported (reduced from original 17 after removing non-standard
types that lacked reliable SDK support).

| objectType | Read | Create | Update |
|------------|------|--------|--------|
| `contacts` | ✓ | ✓ | ✓ |
| `companies` | ✓ | ✓ | ✓ |
| `deals` | ✓ | ✓ | ✓ |
| `tickets` | ✓ | ✓ | ✓ |
| `products` | ✓ | ✓ | ✓ |
| `line_items` | ✓ | ✓ | ✓ |
| `notes` | ✓ | ✓ | ✓ |
| `calls` | ✓ | ✓ | ✓ |
| `meetings` | ✓ | ✓ | ✓ |
| `tasks` | ✓ | ✓ | ✓ |
| `emails` | ✓ | ✓ | ✓ |
| `quotes` | ✓ | — | — |

Users (read-only) are covered by the `search_owners` tool.

Write operations on read-only types are rejected at the tool level with a clear
error message, not just prompt-level guardrails.

### Batch Limits

- Create: max 10 records per tool call
- Update: max 10 records per tool call
- The LLM can call the tool multiple times for larger batches

### OAuth Provider: `hubspot` (upgraded in-place)

The existing `hubspot` Link provider is upgraded to account-level OAuth with
read/write scopes. This replaces the old user-level OAuth (which was read-only
via MCP). Existing workspaces will be prompted for wider scopes on re-auth.

| Field | Value |
|-------|-------|
| Provider ID | `hubspot` |
| OAuth mode | Static (account-level app) |
| Auth endpoint | `https://app.hubspot.com/oauth/authorize` |
| Token endpoint | `https://api.hubapi.com/oauth/v1/token` |
| Credential env vars | `HUBSPOT_CLIENT_ID_FILE`, `HUBSPOT_CLIENT_SECRET_FILE` |
| Credential key in Link | `HUBSPOT_ACCESS_TOKEN` |

**Scopes (22 total):**

Read + Write:
- `crm.objects.contacts.read`, `crm.objects.contacts.write`
- `crm.objects.companies.read`, `crm.objects.companies.write`
- `crm.objects.deals.read`, `crm.objects.deals.write`
- `crm.objects.line_items.read`, `crm.objects.line_items.write`
- `crm.objects.orders.read`, `crm.objects.orders.write`
- `crm.objects.quotes.read`, `crm.objects.quotes.write`
- `crm.lists.read`, `crm.lists.write`

Read-Only:
- `crm.objects.owners.read`
- `crm.objects.users.read`
- `crm.objects.carts.read`
- `crm.objects.subscriptions.read`
- `crm.objects.invoices.read`
- `tickets` (legacy broad scope — covers read + write)

Utility:
- `oauth`

**Key scope insight:** Engagement objects (notes, calls, meetings, tasks,
emails) do not have their own scopes. They are accessed through
`crm.objects.contacts.read` / `.write`. This is a HubSpot platform design
decision — dedicated engagement scopes do not exist.

**Health check:** `GET /crm/v3/objects/contacts?limit=1` — simpler and faster
than MCP `listTools()`.

**Identity:** `GET /oauth/v1/access-tokens/{token}` → returns `user_id` of the
authorizing admin.

**Account-level auth model:** One admin authorizes once per HubSpot account.
The token grants full access within the granted scopes regardless of which
HubSpot user triggered it. Per-user HubSpot permissions are NOT enforced.

### Agent Architecture

Bundled agent following the Slack agent pattern.

```
packages/bundled-agents/src/hubspot/
├── agent.ts          # createAgent() definition, handler with generateText()
├── tools.ts          # 10 tool definitions using tool() from AI SDK, Zod schemas, enums
├── tools.test.ts     # Unit tests for all 10 tools
└── index.ts          # Exports
```

**SDK usage:** Tools call the `@hubspot/api-client` SDK `Client` directly — no
intermediate wrapper. Each tool's `execute` function receives the SDK client and
delegates to the appropriate sub-client (e.g. `client.crm.objects.searchApi.doSearch()`).
Zod schemas in `tools.ts` validate inputs; batch responses are normalized through
a shared helper.

**Agent handler flow:**
1. Receives natural language prompt
2. Calls `generateText()` with the 10 tools + system prompt
3. System prompt describes CRM semantics, object types, write permissions
4. LLM selects tools and constructs parameters
5. Tools call SDK Client directly → SDK handles HTTP + retry
6. LLM synthesizes response

**System prompt guidance for the LLM:**
- Call `get_properties` before creating/updating an unfamiliar object type
- Use `manage_associations` after creating engagements to link them to records
- Respect the permissions matrix — don't attempt writes on read-only types

### Relationship to Existing HubSpot Integration

The existing `hubspot` Link provider is upgraded in-place from user-level
(read-only, MCP) to account-level (read+write, SDK). Existing workspaces will
be prompted for wider scopes on re-auth. The old MCP registry entry has been
removed to prevent duplicate matches during workspace creation.

| Aspect | Before | After |
|--------|--------|-------|
| Auth model | User-level OAuth | Account-level OAuth |
| Transport | MCP (`mcp.hubspot.com`) | `@hubspot/api-client` SDK |
| Capabilities | Read-only (6 tools) | Read + Write (10 tools) |
| Link provider | `hubspot` | `hubspot` (same, upgraded scopes) |
| Credential key | `HUBSPOT_ACCESS_TOKEN` | `HUBSPOT_ACCESS_TOKEN` (same) |
| MCP registry | Entry present | Removed |

---

## Testing Decisions

### What Makes a Good Test

Tests exercise the tool-to-SDK contract — given a tool input, verify the correct
SDK call is made and the response is correctly parsed. Mock the SDK `Client`
shape (not raw HTTP), providing only the sub-client methods each tool uses.

### Modules to Test

- **`tools.ts`** — All 10 tools: input validation (batch limits, objectType
  allowlists, write permission checks), correct SDK method dispatch, response
  normalization, and error handling. Full coverage in `tools.test.ts` (55+ tests).

### Prior Art

- `packages/bundled-agents/src/slack/` — similar pattern of bundled agent
  with tool orchestration
- `apps/link/src/providers/` tests — OAuth provider health/identity tests

---

## Out of Scope

- **Delete operations** — not supported by the HubSpot connector, excluded here
- **Custom objects** — requires `crm.schemas.custom.write` pilot program access
- **Workflows / automation API** — different API surface
- **Marketing APIs** (forms, campaigns, content) — different scopes, different
  agent
- **Per-user permission enforcement** — account-level tokens bypass HubSpot
  user permissions; authorization layer is a separate concern

---

## Further Notes

### Token Lifecycle

- Access tokens expire in 30 minutes (changed from 6 hours in late 2024)
- Refresh tokens do not expire (until app uninstall)
- Link's proactive token refresh (5-minute window) handles the short TTL
- HubSpot has signaled OAuth 2.1 alignment (refresh token rotation) — no
  enforcement date yet

### Rate Limiting

HubSpot API rate limits are per-app, not per-token:
- 100 requests per 10 seconds (standard)
- Batch endpoints count as 1 request regardless of record count
- 429 responses include `Retry-After` header

The `@hubspot/api-client` SDK handles rate limiting automatically via Bottleneck
(9 req/s, 6 concurrent) and retries 429/5xx responses with exponential backoff.
Batch endpoints are preferred over individual CRUD calls for efficiency.

### EU Region

The `friday-crm-direct` app is in EU region (account 147457406). The auth
endpoint auto-redirects based on account region, but API calls should use
`api.hubapi.com` (not region-specific URLs) — HubSpot handles routing.

### SDK Quirks

- SDK model classes (`PublicObjectSearchRequest`, `Filter`, `FilterGroup`) use
  no-arg constructors with property assignment — the SDK's `ObjectSerializer`
  walks `attributeTypeMap`, so plain objects don't work.
- SDK `SimplePublicObject` returns `Date` objects for `createdAt`/`updatedAt` —
  need `.toISOString()` conversion.
- SDK sorts are colon-separated strings (`"propertyName:DIRECTION"`), not
  objects.
- SDK batch read requires `propertiesWithHistory` (empty array OK). SDK batch
  create inputs need `associations` field (empty array OK).
- SDK owners `getPage()` param order is `(email, after, limit)`.
- SDK associations v4 `basicApi.createDefault()` is cleaner than manual
  `associationCategory`/`associationTypeId`.
- Import model classes from
  `@hubspot/api-client/lib/codegen/crm/objects/models/all` — SDK doesn't
  re-export them from top level.
