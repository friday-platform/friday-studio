# @atlas/client

Type-safe RPC client for the Atlas daemon API using Hono RPC.

## Quick Start

```typescript
import { client, parseResult } from "@atlas/client/v2";

// Make a request and handle errors
const result = await parseResult(
  client.chatStorage[":streamId"].$get({ param: { streamId: "123" } }),
);

if (result.ok) {
  console.log(result.value.messages);
} else {
  console.error(result.error);
}
```

## How It Works

Hono RPC creates type-safe clients from server route definitions. No code generation, no OpenAPI specs - just TypeScript inference.

1. **Server defines routes** with types
2. **Routes export their type** as `typeof routes`
3. **Client imports types** and creates typed client
4. **TypeScript validates** all calls at compile time

## API

### `client`

Pre-configured client instances for each route group:

```typescript
import { client } from "@atlas/client/v2";

// Available routes (will expand as we migrate)
client.chatStorage; // Chat storage operations
```

### `parseResult()`

Wraps async responses in a Result type (like Rust/Go) for explicit error handling:

```typescript
const result = await parseResult(
  client.chatStorage[":streamId"].$get({ param: { streamId } }),
);

if (result.ok) {
  // result.value is typed based on the route response
  const { messages, messageCount } = result.value;
} else {
  // result.error contains the failure details
  logger.error("Request failed", { error: result.error });
}
```

### Why Result Types?

- **No try/catch needed** - Errors are values, not exceptions
- **Type-safe errors** - Know what can fail at compile time
- **Explicit handling** - Can't accidentally ignore errors
- **Better composition** - Chain operations without nested try blocks

## Usage Examples

### GET with Path Parameters

```typescript
const result = await parseResult(
  client.chatStorage[":streamId"].$get({
    param: { streamId: "abc-123" },
  }),
);
```

### PUT with JSON Body

```typescript
const result = await parseResult(
  client.chatStorage[":streamId"].$put({
    param: { streamId: "abc-123" },
    json: { messages: [...] }
  })
);
```

### List All Conversations

```typescript
const result = await parseResult(client.chatStorage.$get());
if (result.ok) {
  console.log(`Found ${result.value.conversationCount} conversations`);
}
```

## Migration Status

This is the recommended client for all new development. The legacy clients will be removed:

- ✅ `@atlas/client/v2` - Current, uses Hono RPC
- ⚠️ `@atlas/client/src` - Deprecated v1 client
- ⚠️ `@atlas/openapi-client` - Deprecated OpenAPI client

## How Hono RPC Works Under the Hood

Traditional API clients require either:

- Manual type definitions (error-prone)
- Code generation from OpenAPI specs (build step complexity)

Hono RPC uses TypeScript's type system directly:

```typescript
// Server (apps/atlasd/routes/chat-storage.ts)
const chatStorageRoutes = daemonFactory
  .createApp()
  .get("/:streamId", zValidator(...), (c) => {
    return c.json({ messages, messageCount });
  });

export type ChatStorageRoutes = typeof chatStorageRoutes;

// Client (packages/client/v2/mod.ts)
import type { ChatStorageRoutes } from "@atlas/atlasd";
const client = hc<ChatStorageRoutes>("http://localhost:8080/api/chat-storage");

// Usage - fully typed!
const res = await client[":streamId"].$get({ param: { streamId: "123" } });
```

The route definition IS the API contract. Change the server, get compile errors in the client.

## Adding New Routes

1. Create route in `apps/atlasd/routes/`
2. Export type from `apps/atlasd/mod.ts`
3. Add to client in `packages/client/v2/mod.ts`
4. Use with full type safety

See [MIGRATION.md](./MIGRATION.md) for detailed migration guide.
