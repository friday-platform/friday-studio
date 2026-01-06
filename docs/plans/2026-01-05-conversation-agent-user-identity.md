# Conversation Agent User Identity

**Status:** Implemented **Date:** 2026-01-05

## Problem

Two friction points in the conversation agent experience:

1. **User identity unknown** - When users say "email me", Friday asks for their
   email despite this being extractable from `ATLAS_KEY` JWT.

2. **Email agent overpromises** - The conversation agent sees email agent
   examples like "send to john@example.com" but doesn't know about domain
   restrictions that silently override external recipients.

**Failure modes:**

- User asks to email `client@external.com`, Friday confirms, but email silently
  goes to user instead
- User asks to CC multiple people, Friday attempts it and fails silently
- User says "email me" and Friday asks "what's your email?"

## Solution

Two complementary improvements:

1. **User identity endpoint** - `/api/me` extracts identity from `ATLAS_KEY` JWT
   and injects it into the conversation agent's system prompt.

2. **Agent constraints field** - New `constraints` metadata field for agents to
   declare limitations that flow into the capabilities section of the system
   prompt.

## Implementation

### 1. User Identity Endpoint

**Route:** `GET /api/me`

**Files:**

- `apps/atlasd/routes/me/index.ts` - Route handler
- `apps/atlasd/routes/me/adapter.ts` - JWT extraction logic
- `apps/atlasd/routes/me/schemas.ts` - Zod schema for UserIdentity

**Data flow:**

```
ATLAS_KEY JWT → decodeJwtPayload() → UserIdentity → /api/me response
```

**UserIdentity schema:**

```typescript
type UserIdentity = {
  id: string; // tempest_user_id from JWT or sub claim
  full_name: string; // Derived from email prefix
  email: string; // From JWT email claim
  display_name: string | null; // Same as full_name
  profile_photo: string | null; // Always null (not in JWT)
  created_at: string; // Current timestamp
  updated_at: string; // Current timestamp
};
```

**Env-var switching:**

- Default: Decodes `ATLAS_KEY` JWT
- `TEMP_USER_IDENTITY=remote`: Returns null (future bounce integration)

**Response format:**

```json
// Success (200)
{ "success": true, "user": { ... } }

// No ATLAS_KEY or invalid JWT (503)
{ "success": false, "error": "User identity unavailable" }
```

### 2. Agent Constraints Field

**Schema change** (`packages/agent-sdk/src/types.ts`):

```typescript
export const AgentMetadataSchema = z.object({
  // ... existing fields
  constraints: z
    .string()
    .optional()
    .meta({
      description:
        "Human-readable limitations or restrictions on agent capabilities",
    }),
  // ...
});
```

**Email agent constraints**
(`packages/bundled-agents/src/email/communicator.ts`):

```typescript
constraints: "Recipients restricted to authenticated user's email or same organization domain. External recipients are automatically redirected to sender. Single recipient only - no CC, BCC, or multi-send supported.";
```

**Updated examples** (reflect realistic use cases):

```typescript
examples: [
  "Send me an email summary of today's meeting notes",
  "Email me a reminder about the 2pm deadline",
  "Send a status update email to my team",
  "Compose a weekly report email and send it to me",
];
```

### 3. Capabilities Section Update

**File:** `packages/system/agents/conversation/capabilities.ts`

Constraints now included inline in agent XML:

```typescript
const constraints = agent.metadata.constraints
  ? `\n  <constraints>${agent.metadata.constraints}</constraints>`
  : "";
return `<agent id="${agent.metadata.id}" domains="${domains}">${agent.metadata.description}${constraints}</agent>`;
```

**Result in system prompt:**

```xml
<bundled_agents>
<agent id="email" domains="email, notifications, sendgrid">Compose and send email notifications...
  <constraints>Recipients restricted to authenticated user's email or same organization domain. External recipients are automatically redirected to sender. Single recipient only - no CC, BCC, or multi-send supported.</constraints></agent>
</bundled_agents>
```

### 4. Conversation Agent Integration

**File:** `packages/system/agents/conversation/user-identity.ts`

New function that fetches and formats identity:

```typescript
export async function fetchUserIdentitySection(logger: Logger): Promise<string | undefined> {
  const result = await parseResult(client.me.index.$get());
  if (!result.ok || !result.data.user) {
    logger.warn("User identity unavailable", { ... });
    return undefined;
  }

  const { full_name, email, display_name } = result.data.user;
  return `<user_identity>
Name: ${display_name ?? full_name}
Email: ${email}
</user_identity>`;
}
```

**System prompt integration** (`conversation.agent.ts`):

Added to parallel fetch at startup:

```typescript
const [{ workspaces, jobsByWorkspace }, linkSummary, userIdentitySection] =
  await Promise.all([
    fetchWorkspacesAndJobs(logger),
    fetchLinkSummary(logger),
    fetchUserIdentitySection(logger),
  ]);
```

`getSystemPrompt()` updated to accept and append user identity section at the
end:

```typescript
function getSystemPrompt(
  streamId?: string,
  workspacesSection?: string,
  agentsSection?: string,
  integrationsSection?: string,
  skillsSection?: string,
  supportedDomainsSection?: string,
  userIdentitySection?: string,  // New parameter
): string { ... }
```

### 5. Client Integration

**File:** `packages/client/v2/mod.ts`

Added `me` client:

```typescript
export const client = {
  // ... existing clients
  me: hc<MeRoutes>(`${baseUrl}/api/me`),
};
```

**Type exports** (`apps/atlasd/mod.ts`):

```typescript
export type { MeRoutes, UserIdentity } from "./routes/me/index.ts";
```

## System Prompt Order

Context sections appended in order:

1. Base prompt (prompt.txt)
2. Stream ID instruction (if present)
3. Workspaces section
4. Agents section
5. Integrations section
6. Skills section
7. Supported domains (bundled_agents + mcp_servers with constraints)
8. User identity section

## Graceful Degradation

- If `ATLAS_KEY` is missing or invalid, `/api/me` returns 503
- Conversation agent continues without personalization
- User identity section omitted from system prompt
- Existing conversation agent behavior unchanged

## Testing

Manual testing (conversation agent evals currently broken):

1. **API endpoint:** `curl http://localhost:8123/api/me | jq .`
2. **Identity recognition:** "What's my name?" / "What's my email?"
3. **External recipient constraint:** "Send an email to client@external.com"
4. **Multi-recipient constraint:** "Email report to john@company.com and CC
   sarah"
5. **Valid requests (no false positives):** "Email me a reminder" should proceed
   without caveats
6. **Graceful degradation:** `TEMP_USER_IDENTITY=remote` should return
   unavailable

## Files Changed

```
apps/atlasd/
├── mod.ts                           # Export MeRoutes, UserIdentity
├── routes/me/
│   ├── index.ts                     # Route handler
│   ├── adapter.ts                   # JWT extraction
│   └── schemas.ts                   # UserIdentity schema
└── src/atlas-daemon.ts              # Mount route

packages/agent-sdk/src/
├── types.ts                         # constraints field in AgentMetadataSchema
└── create-agent.ts                  # Pass constraints to metadata

packages/bundled-agents/src/email/
└── communicator.ts                  # Add constraints, update examples

packages/client/v2/
└── mod.ts                           # Add me client

packages/system/agents/conversation/
├── capabilities.ts                  # Include constraints in agent XML
├── conversation.agent.ts            # Fetch + inject user identity
└── user-identity.ts                 # New: fetch/format user identity
```
