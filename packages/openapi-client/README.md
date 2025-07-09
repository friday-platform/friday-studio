# @atlas/oapi-client

Type-safe client for the Atlas daemon API, automatically generated from the OpenAPI specification.

## Features

- **Full Type Safety**: TypeScript types generated directly from the OpenAPI spec
- **Auto-completion**: IDE support for all API endpoints and parameters
- **Type Inference**: Response types are automatically inferred

## Installation

This package is part of the Atlas workspace. Import it directly:

```typescript
import { createAtlasClient } from "@atlas/oapi-client";
```

## Usage

### Basic Example

```typescript
import { createAtlasClient } from "@atlas/oapi-client";

const client = createAtlasClient({
  baseUrl: "http://localhost:8080",
});

// Type-safe API calls
const { data, error } = await client.GET("/health");
if (data) {
  console.log(`Active workspaces: ${data.activeWorkspaces}`);
}
```

### Custom Configuration

```typescript
const client = createAtlasClient({
  baseUrl: process.env.ATLAS_DAEMON_URL,
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
```

## Type Generation

To regenerate types from the latest OpenAPI spec:

```bash
cd packages/openapi-client
deno task generate
```

This will:

1. Create an AtlasDaemon instance
2. Extract the OpenAPI specification
3. Generate TypeScript types
4. Write them to `src/atlasd-types.gen.d.ts`

## Development

### Adding New Endpoints

1. Ensure the endpoint in `apps/atlasd` uses `hono-openapi` decorators
2. Run `deno task generate` to update types
3. The new endpoint will be automatically available with full type safety

### Testing

```bash
deno task test
```
