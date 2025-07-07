# OpenAPI Integration Pattern for Atlas Daemon

This document outlines the standardized approach for integrating OpenAPI documentation into the
Atlas daemon API endpoints using Zod schemas, hono-openapi, and Scalar UI.

## Overview

The pattern provides:

- Type-safe API documentation using Zod schemas
- Automatic OpenAPI spec generation from route definitions
- Interactive API documentation via Scalar UI
- Centralized OpenAPI configuration

## Implementation Steps

### 1. Fix Type Compatibility Issues

**Problem**: Type collision between JSR and npm dependencies for Hono.

**Solution**: Override Hono imports in `apps/atlasd/deno.json` to use npm:

```json
{
  "name": "@atlas/atlasd",
  "version": "1.0.0",
  "exports": "./mod.ts",
  "imports": {
    "@hono/zod-openapi": "npm:@hono/zod-openapi@^1.0.0-beta.1",
    "hono-openapi": "npm:hono-openapi@^0.4.8",
    "zod-openapi": "npm:zod-openapi@^5.0.1"
  }
}
```

Also ensure the root `deno.json` uses npm for Hono:

```json
{
  "imports": {
    "hono": "npm:hono@^4.8.4",
    "hono/cors": "npm:hono@^4.8.4/cors"
    // ... other hono imports
  }
}
```

### 2. Create Route-Level Documentation

For each route file (e.g., `routes/health.ts`):

1. **Import required dependencies**:

```typescript
import { z } from "zod/v4";
import { daemonFactory } from "../src/factory.ts";
import { describeRoute } from "hono-openapi";
import { resolver } from "hono-openapi/zod";
```

2. **Define Zod schemas with metadata**:

```typescript
export const healthResponseSchema = z.object({
  activeWorkspaces: z.int().min(0).meta({
    description: "Number of currently active workspaces",
  }),
  uptime: z.int().min(0).meta({
    description: "Daemon uptime in milliseconds",
  }),
  timestamp: z.iso.datetime().meta({
    description: "Current server timestamp in ISO 8601 format",
  }),
  // ... other fields
}).meta({
  description: "Health check response containing daemon status and metrics",
});
```

3. **Wrap route handlers with `describeRoute()`**:

```typescript
healthRoutes.get(
  "/",
  describeRoute({
    tags: ["System"],
    summary: "Health check",
    description: "Returns the current health status of the Atlas daemon",
    responses: {
      200: {
        description: "Daemon is healthy and operational",
        content: {
          "application/json": { schema: resolver(healthResponseSchema) },
        },
      },
    },
  }),
  (c) => {
    // Route handler implementation
  },
);
```

### 3. Create Centralized OpenAPI Configuration

Create `routes/openapi.ts`:

```typescript
import { openAPISpecs } from "hono-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import type { Hono } from "hono";
import type { AppVariables } from "../src/factory.ts";

export const createOpenAPIHandlers = (
  mainApp: Hono<AppVariables>,
  options: { hostname?: string; port?: number } = {},
) => {
  const hostname = options.hostname || "localhost";
  const port = options.port || 8080;

  // OpenAPI spec handler
  const openAPIHandler = openAPISpecs(mainApp, {
    documentation: {
      info: {
        title: "Atlas Daemon API",
        version: "1.0.0",
        description: "API for managing workspaces, sessions, and AI agent orchestration",
      },
      servers: [
        {
          url: `http://${hostname}:${port}`,
          description: "Atlas Daemon Server",
        },
      ],
      tags: [
        { name: "System", description: "System health and status endpoints" },
        { name: "Workspaces", description: "Workspace management operations" },
        { name: "Sessions", description: "Session management operations" },
        { name: "Library", description: "Library storage operations" },
        { name: "Daemon", description: "Daemon control operations" },
      ],
    },
  });

  // Scalar UI handler
  const scalarHandler = Scalar({
    url: "/openapi.json",
    theme: "alternate",
  });

  return { openAPIHandler, scalarHandler };
};
```

### 4. Mount OpenAPI Endpoints in Main Daemon

In `atlas-daemon.ts`, after all routes are mounted:

```typescript
import { createOpenAPIHandlers } from "../routes/openapi.ts";

// In setupRoutes() method, after all other routes:
// OpenAPI documentation - after all routes are mounted
const { openAPIHandler, scalarHandler } = createOpenAPIHandlers(this.app, {
  hostname: this.options.hostname,
  port: this.options.port,
});

// Mount OpenAPI spec endpoint
this.app.get("/openapi.json", openAPIHandler);

// Mount Scalar UI endpoint
this.app.get("/openapi", scalarHandler);
```

### 5. Factory Pattern for Type Safety

Ensure all routes use the factory pattern for consistent typing:

```typescript
// In factory.ts
export interface AppContext {
  runtimes: Map<string, WorkspaceRuntime>;
  startTime: number;
  sseClients: Map<string, Array<{ controller: ReadableStreamDefaultController<Uint8Array> }>>;
}

export type AppVariables = {
  Variables: { app: AppContext };
};

export const daemonFactory = createFactory<AppVariables>();
```

## Migration Checklist for Remaining Routes

To migrate other daemon routes to use OpenAPI:

1. [ ] **Workspace Routes** (`/api/workspaces/*`)
   - Define schemas for workspace list, creation, deletion responses
   - Add `describeRoute()` to each endpoint
   - Document query parameters and request bodies

2. [ ] **Session Routes** (`/api/sessions/*`)
   - Create schemas for session status, artifacts
   - Document streaming responses appropriately

3. [ ] **Library Routes** (`/api/library/*`)
   - Define schemas for library items, search results
   - Document complex query parameters

4. [ ] **Signal Routes** (`/api/workspaces/:id/signals/*`)
   - Schema for signal payloads and responses
   - Document async behavior

5. [ ] **Daemon Management Routes** (`/api/daemon/*`)
   - Status response schemas
   - Document shutdown behavior

## Best Practices

1. **Zod Schema Design**:
   - Always add `.meta({ description: "..." })` to fields
   - Use specific types (e.g., `z.iso.datetime()` instead of `z.string()`)
   - Export schemas for reuse across routes

2. **Route Documentation**:
   - Use appropriate tags for grouping
   - Provide clear summaries and descriptions
   - Document all possible response codes

3. **Error Responses**:
   - Create standardized error schemas
   - Document error responses consistently:
   ```typescript
   responses: {
     200: { /* success */ },
     400: {
       description: "Bad request",
       content: {
         "application/json": { 
           schema: resolver(errorResponseSchema) 
         },
       },
     },
     500: { /* server error */ },
   }
   ```

4. **Request Body Documentation**:
   ```typescript
   describeRoute({
     requestBody: {
       content: {
         "application/json": {
           schema: resolver(createWorkspaceSchema),
         },
       },
     },
   });
   ```

## Benefits

- **Type Safety**: Zod schemas provide runtime validation and TypeScript types
- **Auto-generated Docs**: No manual OpenAPI spec maintenance
- **Interactive UI**: Scalar provides a modern, searchable API explorer
- **Single Source of Truth**: Route definitions include both implementation and documentation
- **Dynamic Configuration**: Server URL updates based on daemon configuration

## Endpoints

After implementation:

- **OpenAPI Spec**: `http://localhost:8080/openapi.json`
- **Interactive Docs**: `http://localhost:8080/openapi`
