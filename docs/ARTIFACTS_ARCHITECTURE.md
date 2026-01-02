# Atlas Artifacts Architecture

## Overview

Artifacts are immutable, versioned pieces of data that track important outputs and configurations within Atlas workspaces. Each artifact revision represents a point-in-time snapshot that cannot be modified after creation. Updates create new revisions while preserving history.

## Core Data Model

### Artifact Base Schema

```typescript
interface ArtifactBase {
  id: string; // Unique identifier (crypto.randomUUID())
  type: string; // Artifact type discriminator
  revision: number; // Incrementing revision number (starts at 1)
  workspaceId?: string; // Optional workspace association
  chatId?: string; // Optional chat association
  createdAt: Date; // Creation timestamp (Date.now())
  deletedAt?: Date; // Soft delete timestamp
  revisionMessage?: string; // Optional revision intent (updates only, not initial creation)
  data: unknown; // Type-specific data (validated by schema)
}
```

### Tagged Union Pattern

Each artifact type has a Zod schema with a literal type field for discrimination:

```typescript
const WorkspacePlanArtifact = z.object({
  type: z.literal("workspace-plan"),
  version: z.literal(1),
  data: z.object({
    // Empty for now, will be filled later
  }),
});

// Union of all artifact types
const ArtifactSchema = z.discriminatedUnion("type", [
  WorkspacePlanArtifact,
  // Future artifact types added here
]);
```

### Schema Sharing Strategy

To avoid duplication between REST endpoints and MCP tools, schemas are defined once in `@packages/core/src/artifacts/schemas.ts`:

```typescript
// Core business logic schemas (shared)
export const CreateArtifactInputSchema = z.object({
  type: z.literal("workspace-plan"),
  data: z.object({}),
  workspaceId: z.string().optional(),
  chatId: z.string().optional(),
});

export const UpdateArtifactInputSchema = z.object({
  data: z.object({}),
  revisionMessage: z.string().optional(),
});

// REST endpoint uses directly
validator("json", CreateArtifactInputSchema);

// MCP tool extends with streaming context
const MCPCreateArtifactInput = CreateArtifactInputSchema.extend({
  streamId: z.string().describe("SSE Stream ID for real-time updates"),
});
```

This approach:

- Defines schemas once at the business logic layer
- REST routes import and use directly for validation
- MCP tools extend with MCP-specific fields (streamId)
- Both layers use the Hono RPC client for type-safe daemon communication
- Progressive enhancement: Other routes can be migrated to RPC pattern gradually

## Storage Layer

### Deno.kv Key Structure

Primary storage:

```
["artifact", artifactId, revision] → ArtifactData
["artifact_latest", artifactId] → latestRevisionNumber
```

Secondary indices:

```
["artifact_by_workspace", workspaceId, artifactId, revision] → true
["artifact_by_chat", chatId, artifactId, revision] → true
["artifact_deleted", artifactId] → deletedAt
```

### Storage Operations

Located in `@packages/core/src/artifacts/storage.ts`:

```typescript
// Core operations
createArtifact(type, data, workspaceId?, chatId?) → ArtifactWithRevision
updateArtifact(artifactId, data, revisionMessage?) → ArtifactWithRevision
getArtifact(artifactId, revision?) → ArtifactWithRevision | null
getArtifactsByWorkspace(workspaceId, limit = 100) → ArtifactWithRevision[]
getArtifactsByChatId(chatId, limit = 100) → ArtifactWithRevision[]
softDeleteArtifact(artifactId) → void
```

Key behaviors:

- Creating an artifact starts at revision 1
- Updates increment revision, preserving all previous revisions
- Soft delete marks the artifact ID as deleted (all revisions)
- Latest revision tracked separately for quick access
- Secondary indices use Deno.kv list() for efficient prefix scanning
- All operations use `using db = await Deno.openKv()` for automatic cleanup
- Failed updates don't corrupt existing revisions (atomic operations)

## API Routes (Hono RPC)

Located in `@apps/atlasd/routes/artifacts/`:

### Route Structure

Using Hono RPC for type-safe client generation without code generation:

```typescript
// apps/atlasd/routes/artifacts/index.ts
import { validator } from "@hono/zod-validator";
import {
  CreateArtifactInputSchema,
  UpdateArtifactInputSchema,
} from "@atlas/core/artifacts/schemas";

const artifactsApp = daemonFactory
  .createApp()
  .post("/", validator("json", CreateArtifactInputSchema), async (c) => {
    const data = c.req.valid("json");
    const artifact = await createArtifact(
      data.type,
      data.data,
      data.workspaceId,
      data.chatId,
    );
    return c.json(artifact);
  })
  .put(
    "/:id",
    validator("param", z.object({ id: z.string() })),
    validator("json", UpdateArtifactInputSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const data = c.req.valid("json");
      const artifact = await updateArtifact(
        id,
        data.data,
        data.revisionMessage,
      );
      return c.json(artifact);
    },
  )
  .get("/:id", async (c) => {
    const { id } = c.param();
    const artifact = await getArtifact(id);
    return c.json(artifact);
  })
  .get(
    "/",
    validator(
      "query",
      z.object({
        workspaceId: z.string().optional(),
        chatId: z.string().optional(),
        limit: z.number().optional(),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query");
      const artifacts = query.workspaceId
        ? await getArtifactsByWorkspace(query.workspaceId, query.limit)
        : await getArtifactsByChatId(query.chatId!, query.limit);
      return c.json(artifacts);
    },
  )
  .delete("/:id", async (c) => {
    const { id } = c.param();
    await softDeleteArtifact(id);
    return c.json({ success: true });
  });

// Export the app and its type for RPC client
export { artifactsApp };
export type ArtifactsApp = typeof artifactsApp;
```

### RPC Client

```typescript
// packages/rpc-client/src/index.ts
import { hc } from "hono/client";
import type { ArtifactsApp } from "@apps/atlasd/routes/artifacts";

const DAEMON_URL = process.env.ATLAS_DAEMON_URL || "http://localhost:8080";

export const rpcClient = {
  artifacts: hc<ArtifactsApp>(`${DAEMON_URL}/api/artifacts`),
};

// Usage example
const artifact = await rpcClient.artifacts.$post({
  json: { type: "workspace-plan", data: {} },
});
const data = await artifact.json();
```

## Implementation Files

```
packages/core/src/artifacts/
├── types.ts       # Type definitions and discriminated union
├── schemas.ts     # Shared Zod schemas for validation
├── storage.ts     # Deno.kv operations
└── index.ts       # Public exports

apps/atlasd/routes/artifacts/
├── index.ts       # Route definitions with type export

packages/rpc-client/
├── src/
│   └── index.ts   # Hono RPC client initialization
├── package.json   # Package config
└── deno.json      # Deno config

packages/mcp-server/src/tools/artifacts/
├── index.ts       # Tool registration
├── create.ts      # Create artifact tool
├── update.ts      # Update artifact tool
├── get.ts         # Get latest artifact tool
├── get-by-chat.ts # Get artifacts by chat tool
└── delete.ts      # Delete artifact tool
```

## MCP Tools

MCP tools provide a thin wrapper around the daemon API using the Hono RPC client:

### Tool Definitions

```typescript
// packages/mcp-server/src/tools/artifacts/create.ts
import { rpcClient } from "@atlas/rpc-client";
import { CreateArtifactInputSchema } from "@atlas/core/artifacts/schemas";

export function registerArtifactsCreateTool(
  server: McpServer,
  ctx: ToolContext,
) {
  server.registerTool(
    "artifacts_create",
    {
      description: "Create a new artifact",
      inputSchema: CreateArtifactInputSchema.extend({
        streamId: z.string().describe("SSE Stream ID for real-time updates"),
      }),
    },
    async ({ type, data, workspaceId, chatId, streamId }) => {
      const response = await rpcClient.artifacts.$post({
        json: { type, data, workspaceId, chatId },
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const artifact = await response.json();

      return createSuccessResponse({
        ...artifact,
        streamId,
        source: "daemon_api",
      });
    },
  );
}
```

### Available MCP Tools

1. **artifacts_create** - Create new artifact
   - Input: type, data, workspaceId?, chatId?, streamId
   - Returns: artifact with id, revision (1), createdAt

2. **artifacts_update** - Update artifact (new revision)
   - Input: artifactId, data, revisionMessage?, streamId
   - Returns: updated artifact with incremented revision

3. **artifacts_get** - Get latest artifact revision
   - Input: artifactId, streamId
   - Returns: latest artifact revision or null if deleted

4. **artifacts_get_by_chat** - Get artifacts by chat ID
   - Input: chatId, limit?, streamId
   - Returns: array of artifacts associated with chat

5. **artifacts_delete** - Soft delete artifact
   - Input: artifactId, streamId
   - Returns: success confirmation

## Usage Examples

### Basic CRUD Operations

```typescript
import {
  createArtifact,
  updateArtifact,
  getArtifact,
} from "@atlas/core/artifacts";

// Create initial workspace plan
const artifact = await createArtifact(
  "workspace-plan",
  {
    /* plan data */
  },
  workspaceId,
);

// Update the plan (creates revision 2)
const updated = await updateArtifact(
  artifact.id,
  {
    /* updated plan */
  },
  "Added authentication flow to workspace plan",
);

// Get latest revision
const latest = await getArtifact(artifact.id);

// Get specific revision
const firstRevision = await getArtifact(artifact.id, 1);
```

### Integration with Workspace Creation Agent

```typescript
// In workspace-creation.agent.ts
const planArtifact = await createArtifact(
  "workspace-plan",
  {
    // Initial empty object, will be populated later
  },
  config.workspace.id,
  stream.chatId,
);

// After user provides more requirements
const updatedPlan = await updateArtifact(
  planArtifact.id,
  {
    // Populated plan data
  },
  "User clarified requirements for data processing pipeline",
);
```

### MCP Tool Usage in Agents

```typescript
// Agent using MCP tools via SDK
const result = await ctx.mcpClient.callTool("artifacts_create", {
  type: "workspace-plan",
  data: {
    /* plan details */
  },
  workspaceId: ctx.workspaceId,
  chatId: ctx.chatId,
  streamId: ctx.streamId,
});

// Retrieve artifacts for current chat
const chatArtifacts = await ctx.mcpClient.callTool("artifacts_get_by_chat", {
  chatId: ctx.chatId,
  limit: 10,
  streamId: ctx.streamId,
});
```

## Design Decisions

### Why Hono RPC over OpenAPI?

- No code generation step required
- Types flow directly from route definitions
- Changes to routes automatically update client types
- Simpler setup without OpenAPI decorators
- Progressive migration path for existing routes
- Still use Zod for validation, just without the OpenAPI wrapper

### Why Immutable Revisions?

- Provides audit trail of changes
- Enables rollback to previous states
- Prevents concurrent write conflicts
- Maintains data integrity

### Why Soft Delete?

- Preserves history for auditing
- Allows potential recovery
- Maintains referential integrity

### Why Secondary Indices?

- Efficient retrieval by workspace/chat without full scans
- Trade storage space for query performance
- Simplified application logic

### Why Tagged Unions?

- Type-safe discrimination between artifact types
- Compile-time exhaustiveness checking
- Clear extension path for new types
