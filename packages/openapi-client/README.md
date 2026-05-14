# @atlas/oapi-client

> ⚠️ **DEPRECATED**: This package is deprecated. Use `@atlas/client/v2` instead.
>
> The new client uses Hono RPC for zero-cost type safety without code generation.
> See [@atlas/client](../client/README.md) for migration guide.

## Usage

```typescript
import { createAtlasClient, getAtlasDaemonUrl } from "@atlas/oapi-client";

// getAtlasDaemonUrl() reads FRIDAYD_URL + FRIDAY_TLS_CERT and returns the
// right scheme/port automatically. Pass an explicit baseUrl only when
// targeting a non-local daemon.
const client = createAtlasClient({
  baseUrl: getAtlasDaemonUrl(),
});

// Type-safe API calls
const { data, error } = await client.GET("/health");
if (data) {
  console.log(`Active workspaces: ${data.activeWorkspaces}`);
}
```
