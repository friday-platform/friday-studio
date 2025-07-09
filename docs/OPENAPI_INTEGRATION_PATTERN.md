# OpenAPI Integration Pattern for Atlas Daemon

This document outlines the standardized approach for migrating Atlas daemon API endpoints to use
OpenAPI documentation with Zod schemas, hono-openapi, and Scalar UI.

## Overview

The pattern provides:

- Type-safe API documentation using Zod schemas
- Automatic OpenAPI spec generation from route definitions
- Interactive API documentation via Scalar UI
- Centralized OpenAPI configuration
- Auto-generated TypeScript client types

## Migration Process

**IMPORTANT**: Always complete ALL steps, especially Step 7 (Generate OpenAPI Client Types), to
maintain type safety across the codebase.

### Step 1: Create Route Module

Create a new route file in `apps/atlasd/routes/` (e.g., `workspaces.ts`):

```typescript
import { z } from "zod/v4";
import { daemonFactory } from "../src/factory.ts";
import { describeRoute } from "hono-openapi";
import { resolver, zValidator } from "hono-openapi/zod";

// Create app instance using factory
const workspacesRoutes = daemonFactory.createApp();

// Define your routes here...

export { workspacesRoutes };
```

### Step 2: Define Zod Schemas

Create schemas for request/response bodies with proper metadata:

```typescript
// Response schemas
export const workspaceResponseSchema = z.object({
  id: z.string().meta({ description: "Unique workspace identifier" }),
  name: z.string().meta({ description: "Workspace name" }),
  status: z.enum(["active", "inactive"]).meta({ description: "Workspace status" }),
  // ... other fields
}).meta({
  description: "Workspace information",
});

// Request body schemas
export const createWorkspaceSchema = z.object({
  path: z.string().meta({ description: "Filesystem path to workspace" }),
  name: z.string().optional().meta({ description: "Optional workspace name" }),
  description: z.string().optional().meta({ description: "Optional description" }),
});

// Query parameter schemas
export const workspaceQuerySchema = z.object({
  force: z.boolean().optional().meta({ description: "Force delete workspace" }),
});

// Type inference
type WorkspaceResponse = z.infer<typeof workspaceResponseSchema>;
type CreateWorkspaceRequest = z.infer<typeof createWorkspaceSchema>;
```

### Step 3: Implement Routes with OpenAPI Descriptions

Extract route logic from `atlas-daemon.ts` and wrap with `describeRoute()`.

**Important**: Use `zValidator` middleware for validating parameters, query strings, and request
bodies. The validators should be placed AFTER the `describeRoute()` configuration:

```typescript
workspacesRoutes.get(
  "/",
  describeRoute({
    tags: ["Workspaces"],
    summary: "List all workspaces",
    description: "Returns a list of all registered workspaces",
    responses: {
      200: {
        description: "Successfully retrieved workspaces",
        content: {
          "application/json": {
            schema: resolver(z.array(workspaceResponseSchema)),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  async (c) => {
    const ctx = c.get("app");
    // Move implementation from atlas-daemon.ts
    try {
      const manager = getWorkspaceManager();
      const workspaces = await manager.listWorkspaces();
      return c.json(workspaces);
    } catch (error) {
      return c.json({
        error: `Failed to list workspaces: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }, 500);
    }
  },
);

// For routes with parameters
workspacesRoutes.delete(
  "/:workspaceId",
  describeRoute({
    tags: ["Workspaces"],
    summary: "Delete a workspace",
    description: "Deletes a workspace by ID",
    responses: {
      200: {
        description: "Workspace deleted successfully",
        content: {
          "application/json": {
            schema: resolver(z.object({
              message: z.string(),
            })),
          },
        },
      },
      404: {
        description: "Workspace not found",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
      500: {
        description: "Failed to delete workspace",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  zValidator(
    "param",
    z.object({
      workspaceId: z.string().meta({ description: "Workspace ID" }),
    }),
  ),
  zValidator("query", workspaceQuerySchema),
  async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { force } = c.req.valid("query");
    // Implementation...
  },
);

// For routes with request bodies
workspacesRoutes.post(
  "/",
  describeRoute({
    tags: ["Workspaces"],
    summary: "Create a new workspace",
    description: "Creates a new workspace from configuration",
    responses: {
      201: {
        description: "Workspace created successfully",
        content: {
          "application/json": {
            schema: resolver(workspaceResponseSchema),
          },
        },
      },
      400: {
        description: "Invalid request",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  zValidator("json", createWorkspaceSchema),
  async (c) => {
    const body = c.req.valid("json");
    // Implementation...
  },
);
```

### Using Multiple Validators

You can chain multiple validators for routes that need to validate different parts of the request:

```typescript
// Route with path params, query params, and request body
workspacesRoutes.put(
  "/:workspaceId/settings",
  describeRoute({
    tags: ["Workspaces"],
    summary: "Update workspace settings",
    description: "Updates settings for a specific workspace",
    responses: {
      200: {
        description: "Settings updated successfully",
        content: {
          "application/json": {
            schema: resolver(workspaceResponseSchema),
          },
        },
      },
      400: {
        description: "Invalid request",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  zValidator(
    "param",
    z.object({
      workspaceId: z.string(),
    }),
  ),
  zValidator(
    "query",
    z.object({
      notify: z.coerce.boolean().optional().default(false),
    }),
  ),
  zValidator("json", updateSettingsSchema),
  async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { notify } = c.req.valid("query");
    const settings = c.req.valid("json");
    // Implementation...
  },
);
```

### Validation Types

- `zValidator("param", schema)` - Validates path parameters
- `zValidator("query", schema)` - Validates query string parameters
- `zValidator("json", schema)` - Validates JSON request body
- `zValidator("form", schema)` - Validates form data
- `zValidator("header", schema)` - Validates headers
- `zValidator("cookie", schema)` - Validates cookies

**Note**: You don't need validators for routes that have no parameters, query strings, or request
bodies (like simple GET endpoints that return static data).

### Step 4: Update Factory Context (if needed)

If the route needs additional context, update `apps/atlasd/src/factory.ts`:

```typescript
export interface AppContext {
  runtimes: Map<string, WorkspaceRuntime>;
  startTime: number;
  sseClients: Map<string, Array<{ controller: ReadableStreamDefaultController<Uint8Array> }>>;
  // Add new context items here if needed
  libraryStorage?: LibraryStorageAdapter;
}
```

### Step 5: Mount Routes in Atlas Daemon

In `apps/atlasd/src/atlas-daemon.ts`:

1. Import the new route module:

```typescript
import { workspacesRoutes } from "../routes/workspaces.ts";
```

2. Mount the routes in `setupRoutes()`:

```typescript
// Mount workspace routes
this.app.route("/api/workspaces", workspacesRoutes);
```

3. Remove the inline route implementations that were migrated.

### Step 6: Update OpenAPI Tags (if needed)

If introducing new route categories, update `apps/atlasd/src/openapi-config.ts`:

```typescript
export const OPENAPI_DOCUMENTATION = {
  info: {
    title: "Atlas Daemon API",
    version: "1.0.0",
    description: "API for managing workspaces, sessions, and AI agent orchestration",
  },
  tags: [
    { name: "System", description: "System health and status endpoints" },
    { name: "Workspaces", description: "Workspace management operations" },
    { name: "Sessions", description: "Session management operations" },
    { name: "Library", description: "Library storage operations" },
    { name: "Agents", description: "Agent management operations" }, // New tag
    // ... other tags
  ],
};
```

### Step 7: Generate OpenAPI Client Types (REQUIRED)

**IMPORTANT**: This step MUST be completed after EVERY route migration to ensure client types stay
in sync with the API.

After completing the migration, regenerate the TypeScript client types:

```bash
cd packages/openapi-client
deno task generate
```

This updates `src/atlasd-types.gen.d.ts` with the new route types.

**Note**: Failing to regenerate client types will cause TypeScript errors in any code that depends
on the OpenAPI client package.

## Common Patterns

### Standard Error Response Schema

Create a reusable error response schema:

```typescript
export const errorResponseSchema = z.object({
  error: z.string().meta({ description: "Error message" }),
  code: z.string().optional().meta({ description: "Error code" }),
  details: z.any().optional().meta({ description: "Additional error details" }),
}).meta({
  description: "Standard error response",
});
```

### Pagination Schema

For paginated endpoints:

```typescript
export const paginationSchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(50).meta({
    description: "Number of items per page",
  }),
  offset: z.coerce.number().min(0).default(0).meta({
    description: "Number of items to skip",
  }),
});

export const paginatedResponseSchema = <T extends z.ZodType>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    total: z.number().meta({ description: "Total number of items" }),
    limit: z.number().meta({ description: "Items per page" }),
    offset: z.number().meta({ description: "Items skipped" }),
  });
```

### Streaming/SSE Responses

For Server-Sent Events endpoints:

```typescript
describeRoute({
  tags: ["Streams"],
  summary: "Subscribe to session events",
  description: "Opens a Server-Sent Events stream for session updates",
  responses: {
    200: {
      description: "SSE stream opened",
      headers: {
        "Content-Type": {
          description: "Event stream content type",
          schema: { type: "string", enum: ["text/event-stream"] },
        },
      },
    },
  },
});
```

## Migration Checklist

### Priority 1 - Core CRUD Operations

- [ ] **Workspace Routes** (`/api/workspaces/*`)
  - [x] GET `/api/workspaces` - List workspaces ✅
  - [ ] GET `/api/workspaces/:id` - Get workspace details
  - [ ] POST `/api/workspaces` - Create workspace
  - [ ] DELETE `/api/workspaces/:id` - Delete workspace
  - [ ] POST `/api/workspaces/add` - Add existing workspace
  - [ ] POST `/api/workspaces/add-batch` - Batch add workspaces

- [ ] **Session Routes** (`/api/sessions/*`)
  - [ ] GET `/api/sessions` - List all sessions
  - [ ] GET `/api/sessions/:id` - Get session details
  - [ ] DELETE `/api/sessions/:id` - Cancel session

### Priority 2 - Extended Operations

- [ ] **Library Routes** (`/api/library/*`)
  - [ ] GET `/api/library` - Search library items
  - [ ] GET `/api/library/:id` - Get library item
  - [ ] POST `/api/library` - Create library item
  - [ ] DELETE `/api/library/:id` - Delete library item
  - [ ] GET `/api/library/stats` - Get library statistics

- [ ] **Template Routes** (`/api/templates/*`)
  - [ ] GET `/api/templates` - List templates
  - [ ] POST `/api/workspaces/create-from-template` - Create from template

### Priority 3 - Advanced Features

- [ ] **Signal Routes** (`/api/workspaces/:id/signals/*`)
  - [ ] GET `/api/workspaces/:id/signals` - List signals
  - [ ] POST `/api/workspaces/:id/signals/:signalId` - Trigger signal

- [ ] **Agent Routes** (`/api/workspaces/:id/agents/*`)
  - [ ] GET `/api/workspaces/:id/agents` - List agents
  - [ ] GET `/api/workspaces/:id/agents/:agentId` - Get agent details

- [ ] **Stream Routes** (`/api/stream/*`)
  - [ ] POST `/api/streams` - Create stream session
  - [ ] GET `/api/stream/:id/stream` - SSE endpoint
  - [ ] POST `/api/stream/:id` - Send message
  - [ ] POST `/api/stream/:id/emit` - Emit SSE event

### Priority 4 - System Routes

- [ ] **Daemon Routes** (`/api/daemon/*`)
  - [ ] GET `/api/daemon/status` - Daemon status
  - [ ] POST `/api/daemon/shutdown` - Shutdown daemon

- [ ] **MCP Routes** (`/mcp`)
  - [ ] ALL `/mcp` - MCP protocol endpoint

## Best Practices

1. **Schema Organization**:
   - Group related schemas in the same file
   - Export schemas for reuse
   - Use descriptive names ending with `Schema`
   - Create type aliases using `z.infer<typeof schema>`

2. **Route Organization**:
   - One route module per resource type
   - Keep route files focused and cohesive
   - Extract complex logic to service functions

3. **Documentation Quality**:
   - Write clear, actionable summaries
   - Include example values in descriptions
   - Document all edge cases and errors
   - Specify required vs optional fields

4. **Type Safety**:
   - Use `z.coerce` for query parameters
   - Validate request bodies with schemas
   - Type handler responses explicitly
   - Avoid `any` types

5. **Consistency**:
   - Use consistent naming conventions
   - Standardize error responses
   - Follow REST conventions
   - Use proper HTTP status codes

## Migrating CLI Components to Use OpenAPI Client

When updating CLI commands to use the OpenAPI client instead of the old daemon-client:

### Step 1: Replace Client Import

Replace the old daemon client with the OpenAPI client:

```typescript
// Old:
import { getDaemonClient } from "../../utils/daemon-client.ts";

// New:
import { createAtlasClient, type paths } from "@atlas/oapi-client";
```

### Step 2: Extract Response Types from OpenAPI

Use TypeScript's indexed access types to extract response types from the generated OpenAPI types:

```typescript
// Extract the response type for a specific endpoint
type WorkspaceResponse =
  paths["/api/workspaces"]["get"]["responses"]["200"]["content"]["application/json"][number];
```

### Step 3: Update API Calls

Replace daemon client calls with OpenAPI client calls:

```typescript
// Old:
const client = getDaemonClient();
const workspaces = await client.listWorkspaces();

// New:
const client = createAtlasClient();
const { data, error } = await client.GET("/api/workspaces");

if (error) {
  throw new Error(error.error || "Failed to fetch workspaces");
}

const workspaces = data;
```

### Step 4: Handle Different Error Patterns

The OpenAPI client doesn't auto-start the daemon, so provide helpful error messages:

```typescript
if (errorMessage.includes("Failed to fetch") || errorMessage.includes("NetworkError")) {
  console.error(
    "Error: Unable to connect to Atlas daemon. Make sure it's running with 'atlas daemon start'",
  );
}
```

### Step 5: Use Ink Hooks for Output

When implementing JSON output in Ink-based CLI components, use the `useStdout` hook instead of
`console.log`:

```typescript
import { useStdout } from "ink";
import React from "react";

function JsonOutput({ data }: { data: any }) {
  const { write } = useStdout();

  React.useEffect(() => {
    const output = JSON.stringify(data, null, 2);
    write(output);
  }, [data, write]);

  return null;
}
```

### CLI Migration Best Practices

1. **Remove Intermediary Types**: Use the OpenAPI response types directly rather than creating local
   type aliases
2. **Avoid Type Duplication**: Don't re-export types that are already available in the OpenAPI
   client
3. **Use Response Data Directly**: The OpenAPI client returns the exact API response structure - use
   it as-is
4. **Handle Loading States**: The OpenAPI client doesn't show loading states, so implement them in
   your UI if needed
5. **Consistent Error Handling**: Always check the `error` property before accessing `data`

### Example: Complete CLI Component Migration

```typescript
import { Box, render, Text, useStdout } from "ink";
import React from "react";
import { createAtlasClient, type paths } from "@atlas/oapi-client";

// Extract type from OpenAPI
type WorkspaceResponse =
  paths["/api/workspaces"]["get"]["responses"]["200"]["content"]["application/json"][number];

export const handler = async (argv: { json?: boolean }) => {
  try {
    const client = createAtlasClient();
    const { data, error } = await client.GET("/api/workspaces");

    if (error) {
      throw new Error(error.error || "Failed to fetch workspaces");
    }

    const { unmount } = render(
      argv.json ? <JsonOutput workspaces={data} /> : <WorkspaceList workspaces={data} />,
    );

    setTimeout(() => unmount(), 100);
  } catch (error) {
    // Handle connection errors gracefully
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("Failed to fetch")) {
      console.error("Error: Atlas daemon not running. Start with 'atlas daemon start'");
    } else {
      console.error(`Error: ${errorMessage}`);
    }
    Deno.exit(1);
  }
};
```

## Testing Migration

After migrating routes:

1. Start the daemon: `deno task atlas daemon start`
2. View API docs: `http://localhost:8080/openapi`
3. Test endpoints using the Scalar UI
4. **REQUIRED**: Generate client types: `cd packages/openapi-client && deno task generate`
5. Run integration tests to ensure compatibility
6. Verify no TypeScript errors in client code that uses the API
7. Test CLI commands to ensure they work with the new OpenAPI client

## Benefits

- **Type Safety**: Compile-time and runtime validation
- **Auto-generated Documentation**: Always up-to-date
- **Client SDK Generation**: TypeScript types for API consumers
- **Interactive Testing**: Built-in API explorer
- **Single Source of Truth**: Code is documentation

## Endpoints

After implementation:

- **OpenAPI Spec**: `http://localhost:8080/openapi.json`
- **Interactive Docs**: `http://localhost:8080/openapi`
