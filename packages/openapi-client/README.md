# @atlas/oapi-client

> ⚠️ **DEPRECATED**: This package is deprecated. Use `@atlas/client/v2` instead.
>
> The new client uses Hono RPC for zero-cost type safety without code generation.
> See [@atlas/client](../client/README.md) for migration guide.

## Usage

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
