# Connect MCP Server Tool Design

Add MCP servers to the platform registry via conversation.

## Overview

A conversation tool that lets users add MCP servers by pasting connection info
(JSON, URL, CLI command, or natural language). The tool uses a single LLM call
to parse input, select a template, and generate metadata. If input is too vague,
the tool fails with specific guidance.

## Data Flow

```
User pastes connection info
        │
        ▼
┌───────────────────────────────┐
│  connect_mcp_server tool      │
│  1. Check blessed registry    │
│     (URL match only, fast)    │
│  2. LLM extracts + selects    │
│     template (single call)    │
│  3. POST to daemon registry   │
│  4. POST to Link provider     │
│     (if auth needed)          │
└───────────────────────────────┘
        │
        ▼
┌──────────────┐  ┌──────────────┐
│ Atlas Daemon │  │ Link Service │
│ MCP Registry │  │ Provider Reg │
│ (global)     │  │ (user-scope) │
└──────────────┘  └──────────────┘
```

## Key Decisions

| Decision | Choice |
|----------|--------|
| **Input** | Freeform text - LLM normalizes JSON, URLs, CLI, or descriptions |
| **Blessed check** | URL-only matching to avoid false positives |
| **LLM strategy** | Template selection + flat value extraction (5 templates) |
| **Fail behavior** | If input can't produce meaningful metadata, fail with guidance |
| **Validation** | None for MVP (no reachability or OAuth discovery checks) |
| **Trust model** | User-added entries get `source: "agents"`, `securityRating: "unverified"` |
| **ID collisions** | Daemon returns 409 with suggested alternative |
| **Auth optional** | Templates support no-auth for local/dev tools |
| **Provider sharing** | None - each server gets its own provider if auth needed |

## Templates

5 config patterns the LLM selects from:

| Template | Transport | Auth | Link Provider |
|----------|-----------|------|---------------|
| `http-oauth` | HTTP | Bearer (OAuth discovery) | OAuth with discovery mode |
| `http-apikey` | HTTP | Bearer (API key) | API key |
| `http-none` | HTTP | None | None |
| `stdio-apikey` | Stdio | Env var from Link | API key |
| `stdio-none` | Stdio | None | None |

## LLM Extraction Schema

```typescript
const LLMExtractionResultSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    template: z.enum(["http-oauth", "http-apikey", "http-none", "stdio-apikey", "stdio-none"]),
    id: z.string().regex(/^[a-z0-9-]+$/).max(64),
    name: z.string().min(1).max(100),
    description: z.string().max(200),
    domains: z.array(z.string()).min(1).max(10),
    url: z.string().url().optional(),           // Required for http-*
    command: z.string().optional(),             // Required for stdio-*
    args: z.array(z.string()).optional(),
    tokenEnvVar: z.string().optional(),         // Env var NAME (e.g., "ACME_API_KEY")
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
    missingInfo: z.array(z.string()),
  }),
]);
```

## Blessed Registry Check

URL-only matching for zero false positives:

```typescript
function checkBlessedRegistry(input: string, servers: Record<string, MCPServerMetadata>): BlessedMatch | null {
  const lowerInput = input.toLowerCase();

  for (const server of Object.values(servers)) {
    const transport = server.configTemplate.transport;
    if (transport.type === "http" && transport.url) {
      if (lowerInput.includes(transport.url.toLowerCase())) {
        return toBlessedMatch(server);
      }
    }
  }
  return null;
}
```

Natural language like "add Linear" falls through to LLM extraction. This avoids
false positives where "linear workflow" would incorrectly match the Linear service.

## Tool Output

```typescript
type ConnectMcpServerResult =
  | {
      success: true;
      server: { id: string; name: string };
      provider: { id: string; type: string } | null;
      authType: "oauth" | "apikey" | "none";
      nextSteps: string[];
      isBlessed: boolean;
    }
  | {
      success: false;
      error: string;
      stage: "extraction" | "registry";
      missingInfo?: string[];
      hint?: string;
      suggestion?: string;
    };
```

## Error Handling

| Stage | Failure | Behavior |
|-------|---------|----------|
| `extraction` | Insufficient info | Fail with `missingInfo` array |
| `extraction` | LLM can't identify service | Fail with guidance |
| `registry` | ID in blessed registry | Daemon returns 409 |
| `registry` | ID collision (dynamic) | Daemon returns 409 with suggestion |
| Link | Provider creation fails | Soft fail - server still added |

## Storage

### MCP Registry Storage Adapter

```typescript
interface MCPRegistryStorageAdapter {
  add(entry: MCPServerMetadata): Promise<void>;  // Throws if ID exists
  get(id: string): Promise<MCPServerMetadata | null>;
  list(): Promise<MCPServerMetadata[]>;
  delete(id: string): Promise<boolean>;
}
```

**Local adapter**: Deno KV at `~/.atlas/mcp-registry.db`
- Uses atomic check-and-set for idempotent `add()`
- Key structure: `["mcp_registry", id]`

**Cortex adapter**: Remote blob storage with metadata tags
- Metadata: `entity_type`, `registry_id`, `server_name`, `source`, `created_at`
- Uses `Promise.allSettled` in `list()` for graceful partial failures

**Factory**: Auto-detects based on `CORTEX_URL` env var.

### Link Provider Storage

Dynamic providers stored in Deno KV at `~/.atlas/link-providers.db`:
- Key structure: `["dynamic_providers", providerId]`
- Stores `DynamicProviderInput`, hydrated to `ProviderDefinition` on read

```typescript
// ProviderRegistry.storeDynamicProvider(input): Promise<boolean>
// Returns true if stored successfully
// Returns false if provider ID exists in static providers or KV (no throw)
```

## Daemon API

### Routes

| Method | Path | Status | Purpose |
|--------|------|--------|---------|
| POST | `/v1/mcp-registry` | 201/409 | Add entry |
| GET | `/v1/mcp-registry` | 200 | List all (static + dynamic) |
| GET | `/v1/mcp-registry/:id` | 200/404 | Get by ID |

### POST Request/Response

```typescript
// Request
{
  entry: {
    id: string,              // /^[a-z0-9-]+$/, max 64
    name: string,            // 1-100 chars
    domains: string[],       // 1-10 keywords
    source: "web" | "agents",
    securityRating: "high" | "medium" | "low" | "unverified",
    configTemplate: MCPServerConfig,
    requiredConfig?: RequiredConfigField[]
  }
}

// Response (201 Created)
{ ok: true, server: MCPServerMetadata }

// Response (409 Conflict)
{ ok: false, error: string, suggestion?: string }
```

### GET / Response

```typescript
{
  servers: MCPServerMetadata[],  // Static + dynamic merged
  metadata: {
    version: string,
    staticCount: number,
    dynamicCount: number
  }
}
```

### GET /:id Response

```typescript
// 200: Full MCPServerMetadata
// 404: { error: "Server not found" }
```

## Link Provider API

### POST /v1/providers

Uses discriminated union based on provider type:

```typescript
// OAuth (discovery mode only - static mode requires pre-configured provider)
{
  provider: {
    type: "oauth",
    id: string,                    // /^[a-z0-9-]+$/, max 64
    displayName: string,           // 1-100 chars
    description: string,           // max 200 chars
    oauthConfig: {
      mode: "discovery",           // Only discovery for dynamic providers
      serverUrl: string,           // Valid URL
      scopes?: string[],
    },
  }
}

// API Key
{
  provider: {
    type: "apikey",
    id: string,                    // /^[a-z0-9-]+$/, max 64
    displayName: string,           // 1-100 chars
    description: string,           // max 200 chars
    secretSchema?: Record<string, "string">,  // Default: { api_key: "string" }
    setupInstructions?: string,
  }
}

// Response (201 Created)
{ ok: true, provider: { id, type, displayName } }

// Response (409 Conflict)
{ ok: false, error: "Provider already exists" }
```

**OAuth identity resolution**: Tries userinfo endpoint (`sub` or `email`), falls
back to SHA-256 hash of access token.

## File Structure

```
packages/core/src/mcp-registry/storage/
├── adapter.ts              # Interface
├── local-adapter.ts        # Deno KV
├── cortex-adapter.ts       # Remote Cortex
└── index.ts                # Factory

packages/system/agents/conversation/tools/
├── connect-mcp-server.ts       # Tool implementation
├── connect-mcp-server-utils.ts # Pure functions (avoids circular deps)
└── connect-mcp-server.test.ts  # Unit tests

apps/atlasd/routes/
└── mcp-registry.ts         # Daemon routes

apps/link/src/providers/
├── dynamic.ts              # hydrateDynamicProvider
├── registry.ts             # Async registry with KV
└── types.ts                # DynamicProviderInput schemas

tools/evals-2/tools/
└── connect-mcp-server.eval.ts  # Evalite tests
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CORTEX_URL` | No | If set, uses Cortex adapter for storage |
| `ATLAS_KEY` | If CORTEX_URL | JWT for Cortex auth |

LLM uses `groq:openai/gpt-oss-120b` via `@atlas/llm` registry.

## Out of Scope (MVP)

- Web enrichment
- Server validation/reachability checks
- OAuth discovery validation
- Update/delete from conversation (routes exist but not exposed via tool)
- Bulk import
- Workspace-scoped registry
- Provider sharing between servers

## Future Enhancements

1. **OAuth discovery validation**: Background validation after registration. Warn if
   server doesn't support MCP OAuth discovery, but don't block registration.

2. **User-triggered enrichment**: Optional `enrich: true` parameter to fetch
   additional metadata from server documentation.

3. **Lazy enrichment**: Store minimal metadata, enrich on first use.

4. **Background enrichment**: Queue for async processing, update registry later.

5. **Update/delete via tool**: Expose existing daemon routes through conversation
   tool for modifying and removing dynamic entries.

6. **Word-boundary blessed matching**: Re-add natural language matching with
   improved false-positive prevention (e.g., "add Linear" → Linear server).

7. **Workspace-scoped registry**: Per-workspace MCP server configurations instead
   of global registry.

8. **Provider sharing**: Allow multiple MCP servers to share a single Link provider
   for services with multiple endpoints.
