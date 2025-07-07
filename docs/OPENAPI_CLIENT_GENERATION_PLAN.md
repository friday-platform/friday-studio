# OpenAPI Client Generation Plan

## Overview

This document outlines the plan to integrate `openapi-typescript` and `openapi-fetch` to create a
type-safe client for the Atlas daemon API. The goal is to programmatically generate TypeScript types
from the in-memory OpenAPI specification and export a ready-to-use typed client from the
`@atlas/openapi-client` package.

## Architecture

### Key Components

1. **OpenAPI Spec Generation** - Using `hono-openapi` to generate the spec in-memory
2. **Type Generation** - Using `openapi-typescript` Node API to create TypeScript types
3. **Client Creation** - Using `openapi-fetch` to create a typed fetch client
4. **Export Strategy** - Providing a ready-to-use client instance and configuration options

### Benefits

- **Zero File I/O**: Generate everything in memory without intermediate files
- **Type Safety**: Full TypeScript type inference for all API endpoints
- **Lightweight**: Small bundle size (~6kb for openapi-fetch)
- **Developer Experience**: Autocomplete and type checking for API calls

## Implementation Plan

### 1. Update Dependencies

Add required packages to `@atlas/openapi-client/deno.json`:

```json
{
  "name": "@atlas/oapi-client",
  "version": "1.0.0",
  "exports": "./mod.ts",
  "imports": {
    "openapi-typescript": "npm:openapi-typescript@^7.4.0",
    "openapi-fetch": "npm:openapi-fetch@^0.14.0"
  }
}
```

### 2. Create Type Generation Script

Create `@atlas/openapi-client/src/generate-types.ts`:

```typescript
import openapiTS, { astToString } from "openapi-typescript";
import { generateSpecs } from "hono-openapi";
import { type AppContext, createApp } from "@atlas/atlasd/src/factory.ts";
import { healthRoutes } from "@atlas/atlasd/routes/health.ts";
import { createOpenAPIHandlers } from "@atlas/atlasd/routes/openapi.ts";

/**
 * Generate TypeScript types from the Atlas daemon OpenAPI spec
 * This runs entirely in memory without file I/O
 */
export async function generateTypes(): Promise<string> {
  // Create minimal app context for spec generation
  const mockContext: AppContext = {
    runtimes: new Map(),
    startTime: Date.now(),
    sseClients: new Map(),
  };

  // Create app with all routes
  const app = createApp(mockContext);
  app.route("/health", healthRoutes);

  // Generate OpenAPI spec in memory
  const spec = await generateSpecs(app, {
    documentation: {
      info: {
        title: "Atlas Daemon API",
        version: "1.0.0",
        description: "API for managing workspaces, sessions, and AI agent orchestration",
      },
      servers: [
        {
          url: "http://localhost:8080",
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

  // Generate TypeScript types from spec
  const ast = await openapiTS(spec, {
    transform(schemaObject, metadata) {
      // Custom transformations if needed
      // Example: Convert date-time strings to Date objects
      if (schemaObject.format === "date-time") {
        return metadata.ctx.factory.createTypeReferenceNode("Date");
      }
    },
  });

  // Convert AST to TypeScript string
  return astToString(ast);
}
```

### 3. Create Client Factory

Create `@atlas/openapi-client/src/client.ts`:

```typescript
import createClient from "openapi-fetch";
import type { paths } from "./generated-types";

export interface AtlasClientConfig {
  baseUrl?: string;
  headers?: Record<string, string>;
  // Additional fetch options
  fetchOptions?: RequestInit;
}

/**
 * Create a typed Atlas daemon API client
 */
export function createAtlasClient(config: AtlasClientConfig = {}) {
  const baseUrl = config.baseUrl || "http://localhost:8080";

  const client = createClient<paths>({
    baseUrl,
    headers: config.headers,
    ...config.fetchOptions,
  });

  // Add convenience methods if needed
  return {
    ...client,
    // Helper methods
    async getWorkspaces() {
      return client.GET("/api/workspaces");
    },
    async createWorkspace(data: any) {
      return client.POST("/api/workspaces", { body: data });
    },
    async triggerSignal(workspaceId: string, signalId: string, payload: any) {
      return client.POST("/api/workspaces/{workspaceId}/signals/{signalId}", {
        params: {
          path: { workspaceId, signalId },
        },
        body: payload,
      });
    },
    // Stream helpers
    createStream(streamId?: string) {
      return client.POST("/api/streams", {
        body: { streamId, createOnly: true },
      });
    },
  };
}

export type AtlasClient = ReturnType<typeof createAtlasClient>;
```

### 4. Build Process Integration

Create `@atlas/openapi-client/scripts/build.ts`:

```typescript
import { generateTypes } from "../src/generate-types.ts";

// Generate types at build time
const types = await generateTypes();

// Write to a temporary location for the TypeScript compiler
await Deno.writeTextFile("./src/generated-types.d.ts", types);

console.log("✅ Generated OpenAPI types successfully");
```

### 5. Module Export Strategy

Update `@atlas/openapi-client/mod.ts`:

```typescript
/**
 * @atlas/oapi-client - Type-safe client for the Atlas daemon API
 * @module
 */

export { type AtlasClient, type AtlasClientConfig, createAtlasClient } from "./src/client.ts";

// Re-export types for direct usage
export type { components, paths } from "./src/generated-types";

// Default client instance for common use cases
import { createAtlasClient } from "./src/client.ts";
export const defaultClient = createAtlasClient();
```

## Usage Examples

### Basic Usage

```typescript
import { createAtlasClient } from "@atlas/oapi-client";

const client = createAtlasClient({
  baseUrl: "http://localhost:8080",
});

// Type-safe API calls
const { data, error } = await client.GET("/api/workspaces");
if (data) {
  // data is fully typed
  console.log(data);
}
```

### With Custom Configuration

```typescript
import { createAtlasClient } from "@atlas/oapi-client";

const client = createAtlasClient({
  baseUrl: process.env.ATLAS_DAEMON_URL,
  headers: {
    "Authorization": `Bearer ${token}`,
  },
});

// Create a workspace
const { data, error } = await client.POST("/api/workspaces", {
  body: {
    name: "my-workspace",
    description: "Test workspace",
  },
});
```

### Stream Handling

```typescript
const client = createAtlasClient();

// Create a stream
const { data: stream } = await client.createStream();
if (stream?.stream_id) {
  // Connect to SSE endpoint
  const eventSource = new EventSource(`${client.baseUrl}${stream.sse_url}`);
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log("Received:", data);
  };
}
```

## Development Workflow

### Initial Setup

1. Install dependencies in `@atlas/openapi-client`
2. Run the build script to generate initial types
3. Commit the generated types for IDE support

### Continuous Development

1. **Automatic Regeneration**: Add a watch mode that regenerates types when routes change
2. **CI Integration**: Generate types as part of the build process
3. **Type Validation**: Add tests to ensure generated types match runtime behavior

### Future Enhancements

1. **Mock Server**: Use generated types to create a mock server for testing
2. **Middleware Support**: Add request/response interceptors
3. **Retry Logic**: Built-in retry mechanisms for failed requests
4. **WebSocket Support**: Typed WebSocket connections for real-time features
5. **Error Handling**: Typed error responses with discriminated unions

## Testing Strategy

1. **Type Tests**: Ensure generated types compile correctly
2. **Runtime Tests**: Validate that API calls match the generated types
3. **Integration Tests**: Test against running Atlas daemon
4. **Mock Tests**: Test client behavior with mocked responses

## Migration Path

For existing code using direct fetch calls:

1. Install `@atlas/oapi-client`
2. Replace fetch calls with typed client methods
3. Remove manual type definitions
4. Benefit from automatic type safety

## In-Memory Generation Pattern

### Problem Statement

Traditional OpenAPI client generation requires:

1. Writing OpenAPI spec to disk (YAML/JSON)
2. Reading the file back in for type generation
3. Writing generated types to disk
4. Multiple file I/O operations that slow down the build process

### Solution: Full In-Memory Pipeline

The key insight is that both `hono-openapi` and `openapi-typescript` can work with JavaScript
objects directly, eliminating all file I/O.

#### Step-by-Step Process

1. **Generate Spec Object**: Use `generateSpecs()` to create the OpenAPI spec as a JavaScript object
2. **Pass Object to TypeScript Generator**: Feed the spec object directly to `openapiTS()`
3. **Generate AST**: Get the TypeScript AST without any file operations
4. **Convert to String**: Use `astToString()` to get the TypeScript code as a string
5. **Dynamic Import**: Use the generated types without writing to disk (advanced)

#### Implementation Details

```typescript
// Advanced: Completely in-memory without any file writes
import { generateTypes } from "./generate-types.ts";
import { transpile } from "typescript";

async function createDynamicClient() {
  // Generate types as string
  const typeDefinitions = await generateTypes();

  // Create a virtual module with the types
  const moduleCode = `
    ${typeDefinitions}
    export { paths, components };
  `;

  // Transpile TypeScript to JavaScript (in-memory)
  const jsCode = transpile(moduleCode, {
    module: "esnext",
    target: "esnext",
  });

  // Create data URL for dynamic import
  const dataUrl = `data:text/javascript,${encodeURIComponent(jsCode)}`;

  // Dynamically import the types
  const { paths } = await import(dataUrl);

  // Create client with dynamically loaded types
  return createClient<typeof paths>({ baseUrl: "http://localhost:8080" });
}
```

### Benefits of In-Memory Generation

1. **Performance**: No disk I/O means faster generation
2. **Atomicity**: No partial files if generation fails
3. **Flexibility**: Can generate different types based on runtime conditions
4. **Security**: No temporary files with potentially sensitive API schemas
5. **Portability**: Works in environments with restricted file system access

### Challenges and Solutions

#### Challenge 1: TypeScript Compilation

**Problem**: TypeScript needs type definitions at compile time **Solution**: Generate types as part
of the build process and commit them, or use dynamic imports

#### Challenge 2: IDE Support

**Problem**: IDEs need physical `.d.ts` files for IntelliSense **Solution**: Generate types once
during development and commit them to the repository

#### Challenge 3: Type Distribution

**Problem**: How to distribute types with the package **Solution**: Include generated types in the
package exports

### Hybrid Approach (Recommended)

For the best developer experience, use a hybrid approach:

1. **Development**: Generate types to disk for IDE support
2. **Runtime**: Support in-memory generation for dynamic scenarios
3. **Build**: Option to generate either way based on environment

```typescript
export async function generateTypes(options?: { writeToDisk?: boolean }) {
  const types = await generateTypesInMemory();

  if (options?.writeToDisk) {
    await Deno.writeTextFile("./src/generated-types.d.ts", types);
  }

  return types;
}
```

## Implementation Phases

### Phase 1: Basic Implementation

- Set up the package structure
- Implement basic type generation with file writes
- Create simple client wrapper
- Test with core endpoints

### Phase 2: In-Memory Optimization

- Implement full in-memory generation
- Add dynamic type loading support
- Optimize build process
- Benchmark performance improvements

### Phase 3: Advanced Features

- Add middleware support
- Implement retry logic
- Add request/response transformers
- Support for streaming endpoints

### Phase 4: Integration

- Update existing packages to use the new client
- Migrate CLI commands to use typed client
- Add comprehensive test suite
- Documentation and examples

## Technical Considerations

### Type Safety Guarantees

1. **Compile-time Safety**: All API calls are type-checked at compile time
2. **Runtime Validation**: Consider adding runtime validation for critical endpoints
3. **Version Compatibility**: Handle API version changes gracefully

### Performance Optimizations

1. **Lazy Loading**: Only load types for endpoints actually used
2. **Tree Shaking**: Ensure unused endpoints don't increase bundle size
3. **Caching**: Cache generated types between builds when specs haven't changed

### Error Handling Strategy

```typescript
// Typed error responses
type ApiError = {
  error: string;
  details?: unknown;
  statusCode: number;
};

// Discriminated union for responses
type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: ApiError };
```

## Conclusion

This comprehensive approach provides a robust, type-safe client for the Atlas daemon API with the
flexibility of in-memory generation. The pattern eliminates file I/O overhead while maintaining
excellent developer experience through IDE support and type safety. The implementation can start
simple with file-based generation and progressively enhance to full in-memory operation as needed.
