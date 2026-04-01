# HubSpot Conversations — Source of Record

**Feature**: HubSpot Help Desk conversation tools
**Completed**: 2026-03-31
**Branch**: `hubspot`
**Extends**: [2026-03-10-hubspot-crm-agent-design.md](./2026-03-10-hubspot-crm-agent-design.md)

---

## What Was Built

Extended the HubSpot bundled agent with 3 conversation tools backed by direct
HTTP calls to the HubSpot Conversations v3 REST API. The `@hubspot/api-client`
SDK has no Conversations API support, so tools use a module-private
`hubspotFetch<T>` helper with Zod response parsing.

### Tools

| Tool | Endpoint | Purpose |
|------|----------|---------|
| `get_conversation_threads` | `GET /conversations/v3/.../threads` | List/filter threads by ticket, inbox, contact, or status |
| `get_thread_messages` | `GET .../threads/{threadId}/messages` | Read messages with actor ID resolution (A-prefix → owner names) |
| `send_thread_comment` | `POST .../threads/{threadId}/messages` | Add internal-only notes (never sent to customer) |

### Key Decisions

- **Raw HTTP over SDK wrapper** — `hubspotFetch<T>(accessToken, path, schema, options?)` with Zod response parsing; no fake SDK abstraction for unsupported endpoints
- **Actor ID resolution** — Batch owner lookup per `get_thread_messages` invocation (~1 API call); resolves `A-` prefixed IDs to names, others pass through as-is
- **Text handling** — Plain text default, opt-in `includeRichText` for HTML content
- **Comment attribution** — Optional `senderActorId` for agent identity; defaults to Service Key creator or OAuth app
- **Always include `association=TICKET`** — Zero-cost enrichment providing ticket context in all thread queries
- **Message type schema** — `z.union` (not `z.discriminatedUnion`) for MESSAGE, COMMENT, THREAD_STATUS_CHANGE, WELCOME_MESSAGE
- **System prompt** — ~330 tokens: terminology glossary (thread ≠ ticket), cross-domain example, thread ID clarification, comment safety note

### Files

- `packages/bundled-agents/src/hubspot/tools.ts` — `hubspotFetch` helper + 3 tool factories
- `packages/bundled-agents/src/hubspot/tools.test.ts` — 12 tests with real API fixture data
- `packages/bundled-agents/src/hubspot/agent.ts` — Wiring + system prompt additions

### API Constraints Worth Remembering

- Messages endpoint returns no `total` count — only `results` and optional `paging`
- Email messages may have `truncationStatus: TRUNCATED_TO_MOST_RECENT_REPLY`
- `associatedContactId` filter requires `threadStatus` to also be set
- Sort by `latestMessageTimestamp` requires `latestMessageTimestampAfter`
- Actor ID prefixes: `A-` (agent/user), `V-` (visitor), `E-` (email), `I-` (integration), `L-` (Breeze AI), `S-` (system)

### Out of Scope (Deferred)

- Outbound messaging (type: MESSAGE) — different blast radius, requires channel config
- Thread status management, assignment, inbox management
- Webhook subscriptions (Service Keys don't support them)
- V-prefixed visitor-to-contact resolution (`GET /actors/{actorId}` is future path)
- Owner lookup caching across tool calls
- Full truncated message retrieval

### OAuth Scope Changes for Production

Add `conversations.read` and `conversations.write` — existing accounts need re-authorization.
