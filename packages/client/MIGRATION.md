# Migration Guide: Hono RPC Client

This guide explains how to migrate routes from OpenAPI or direct daemon routes to the Hono RPC pattern.

## Key Differences

### Old Patterns

1. **OpenAPI Routes**: Multiple files with `describeRoute`, `resolver`, `validator`
2. **Direct Daemon Routes**: Inline `this.app.get("/path", handler)` in atlas-daemon.ts

### New Pattern

Single file with chained route definitions, zValidator, and exported types.

## Migration Steps

### 1. Convert OpenAPI Routes to RPC Routes

#### Before (OpenAPI)

```typescript
// routes/agents/list.ts
import { describeRoute, resolver, validator } from "hono-openapi";
import { daemonFactory } from "../../src/factory.ts";

const listAgents = daemonFactory.createApp();

listAgents.get(
  "/",
  describeRoute({
    tags: ["Agents"],
    summary: "List all available agents",
    responses: {
      200: {
        description: "Successfully retrieved agents",
        content: {
          "application/json": { schema: resolver(agentListResponseSchema) },
        },
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": { schema: resolver(errorResponseSchema) },
        },
      },
    },
  }),
  async (c) => {
    // handler logic
  },
);

export { listAgents };
```

#### After (RPC)

```typescript
// routes/agents.ts
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";

const agentRoutes = daemonFactory
  .createApp()
  .get("/", async (c) => {
    try {
      // handler logic
      return c.json({ agents, total: agents.length }, 200);
    } catch (error) {
      return c.json({ error: stringifyError(error) }, 500);
    }
  })
  .get("/:id", zValidator("param", z.object({ id: z.string() })), async (c) => {
    const { id } = c.req.valid("param");
    // handler logic
  });

export { agentRoutes };
export type AgentRoutes = typeof agentRoutes;
```

### 2. Convert Direct Daemon Routes

#### Before (Direct)

```typescript
// atlas-daemon.ts
this.app.get("/api/sessions/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  // handler logic
  return c.json(response);
});
```

#### After (RPC)

```typescript
// routes/sessions.ts
const sessionRoutes = daemonFactory
  .createApp()
  .get(
    "/:sessionId",
    zValidator("param", z.object({ sessionId: z.string() })),
    (c) => {
      const { sessionId } = c.req.valid("param");
      // handler logic
      return c.json(response, 200);
    },
  );

export { sessionRoutes };
export type SessionRoutes = typeof sessionRoutes;
```

Then mount in daemon:

```typescript
this.app.route("/api/sessions", sessionRoutes);
```

### 3. Key Changes in Route Definition

1. **Remove OpenAPI decorators**: No `describeRoute`, `resolver`
2. **Replace validator with zValidator**: Use `zValidator("param" | "json" | "query", schema)`
3. **Chain routes**: All operations chain off single `daemonFactory.createApp()`
4. **Export type**: Add `export type XxxRoutes = typeof xxxRoutes`
5. **Explicit status codes**: Always include status code in `c.json(data, statusCode)`
6. **Error handling**: Wrap handlers in try/catch, return error JSON with status

### 4. Client Usage Changes

#### Before (OpenAPI Client)

```typescript
import { AtlasdApi } from "@atlas/openapi-client";

const api = new AtlasdApi({ baseURL: "http://localhost:8080" });
const response = await api.getChatStorage({ streamId: "123" });
```

#### After (RPC Client)

```typescript
import { client, parseResult } from "@atlas/client/v2";

const result = await parseResult(
  client.chatStorage[":streamId"].$get({ param: { streamId: "123" } }),
);

if (result.ok) {
  console.log(result.value);
} else {
  console.error(result.error);
}
```

### 5. Adding New Routes to Client

In `packages/client/v2/mod.ts`:

```typescript
import type { ChatStorageRoutes } from "@atlas/atlasd";
import type { AgentRoutes } from "@atlas/atlasd"; // Add import

export const client = {
  chatStorage: hc<ChatStorageRoutes>("http://localhost:8080/api/chat-storage"),
  agents: hc<AgentRoutes>("http://localhost:8080/api/agents"), // Add route
};
```

## Migration Checklist

### For Each Route Group:

- [ ] Combine separate operation files into single route file
- [ ] Replace `describeRoute` and OpenAPI decorators with plain handlers
- [ ] Replace `validator` with `zValidator`
- [ ] Chain all operations off single `daemonFactory.createApp()`
- [ ] Add explicit status codes to all responses
- [ ] Export routes and type definition
- [ ] Export type from `apps/atlasd/mod.ts` (e.g., `export type { AgentRoutes } from "./routes/agents.ts"`)
- [ ] Update daemon to use `app.route()` instead of inline handlers
- [ ] Add route type to client in `packages/client/v2/mod.ts`
- [ ] Update consumers to use new client pattern with `parseResult`

## Common Patterns

### Parameter Validation

```typescript
// Path params
.get("/:id", zValidator("param", z.object({ id: z.string() })), handler)

// Query params
.get("/", zValidator("query", z.object({ limit: z.number().optional() })), handler)

// JSON body
.post("/", zValidator("json", z.object({ name: z.string() })), handler)
```

### Error Responses

Always return consistent error shape:

```typescript
catch (error) {
  return c.json({ error: stringifyError(error) }, 500);
}
```

### Multiple Validators

Chain validators for routes with multiple inputs:

```typescript
.put("/:id",
  zValidator("param", z.object({ id: z.string() })),
  zValidator("json", z.object({ data: z.string() })),
  handler
)
```

## Benefits

1. **Type Safety**: Full type inference from route to client
2. **Simplicity**: No code generation, no OpenAPI specs
3. **Single Source of Truth**: Route types are the API contract
4. **Better DX**: Autocomplete and type checking in client usage
5. **Smaller Bundle**: No OpenAPI runtime overhead

## Notes

- The AI SDK UIMessage types aren't exported, use `z.unknown()` with type assertions where needed
- Always use `stringifyError` from `@atlas/utils` for error messages
- Keep route files focused on HTTP concerns, business logic stays in core packages
- Route types must be exported from `apps/atlasd/mod.ts` to be available as `@atlas/atlasd` imports

## Trade-offs

### Lost with Migration

- OpenAPI documentation generation (no more Swagger/Scalar UI)
- OpenAPI client generation for other languages
- Detailed response schema documentation in code

### Gained with Migration

- Zero-cost type safety (no runtime overhead)
- No code generation step
- Simpler mental model (routes are the contract)
- Better IDE support with direct type inference
- Faster builds (no OpenAPI processing)
