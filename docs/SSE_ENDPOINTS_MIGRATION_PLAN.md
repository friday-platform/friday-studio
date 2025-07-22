# SSE Endpoints Migration Plan

## Overview

This document outlines the plan to migrate the Server-Sent Events (SSE) endpoints in Atlas Daemon to
follow the OpenAPI integration pattern.

## Current SSE Endpoints

1. **POST `/api/streams`** - Create a new stream session
2. **GET `/api/stream/:streamId/stream`** - SSE endpoint for stream subscriptions
3. **POST `/api/stream/:streamId`** - Conversation message endpoint (triggers conversation agent)
4. **POST `/api/stream/:streamId/emit`** - SSE event emission endpoint (used by agents)

## Endpoint Context in Atlas

### POST `/api/stream/:streamId` - Conversation Message Endpoint

This endpoint is the primary entry point for conversation messages in Atlas:

- **Purpose**: Accepts user messages and triggers the conversation agent to process them
- **Flow**:
  1. Receives a message with optional userId, conversationId, scope, and metadata
  2. Triggers the `conversation-stream` signal on the `atlas-conversation` workspace
  3. The conversation agent processes the message and streams responses back via SSE
- **Usage**: Used by CLI, web interfaces, or any client that wants to interact with Atlas
  conversationally

### POST `/api/stream/:streamId/emit` - Agent SSE Emission

This endpoint enables agents to send real-time updates to connected clients:

- **Purpose**: Allows agents to emit SSE events to specific stream subscribers
- **Usage**: Called by daemon capabilities (e.g., `stream_reply`) to send typed responses, metadata,
  and completion events
- **Example**: When an agent wants to stream a response word-by-word for a natural typing effect

## Architecture Decisions

### 1. SSE Client Registry Location

- **Decision**: Keep `sseClients` Map in AtlasDaemon, accessible via AppContext
- **Rationale**: While only used by SSE endpoints directly, the registry is part of the daemon's SSE
  infrastructure that provides streaming services to the entire system
- **Usage Analysis**:
  - Direct users: SSE endpoints only
  - Indirect users: Agents (via HTTP calls to emit endpoint)
  - Not a truly "shared" resource, but core SSE infrastructure
- **Access Pattern**: Route handlers access via `c.get("app").sseClients`

### 2. Event Emission Method

- **Decision**: Keep `emitSSEEvent` as a public method on AtlasDaemon
- **Rationale**: Internal implementation method called by the emit endpoint
- **Access Pattern**: Route handlers access via `c.get("app").emitSSEEvent()`

### 3. SSE Response Documentation

- **Decision**: Document SSE endpoints with proper content-type headers and event schemas
- **Approach**: Define Zod schemas for event payloads, document as "text/event-stream" responses

## Migration Steps

### Step 1: Create SSE Route Module

Create `apps/atlasd/routes/streams.ts`:

```typescript
import { z } from "zod/v4";
import { daemonFactory } from "../src/factory.ts";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi/zod";
import { AtlasLogger } from "../../../src/utils/logger.ts";

const streamsRoutes = daemonFactory.createApp();

// Export routes
export { streamsRoutes };
```

### Step 2: Define Zod Schemas

```typescript
// Request schemas
export const createStreamSchema = z.object({
  streamId: z.string().optional().meta({
    description: "Optional stream ID. If not provided, a UUID will be generated",
  }),
  createOnly: z.boolean().optional().meta({
    description: "If true, only create the stream without triggering any signals",
  }),
  workspaceId: z.string().optional().meta({
    description: "Workspace ID to trigger signal on",
  }),
  signal: z.string().optional().meta({
    description: "Signal ID to trigger",
  }),
}).meta({
  description: "Create stream request body",
});

export const streamMessageSchema = z.object({
  message: z.string().meta({ description: "Message content" }),
  userId: z.string().optional().meta({ description: "User ID sending the message" }),
  conversationId: z.string().optional().meta({ description: "Conversation ID" }),
  scope: z.unknown().optional().meta({ description: "Message scope" }),
  metadata: z.unknown().optional().meta({ description: "Additional metadata" }),
}).meta({
  description: "Stream message request body",
});

export const emitEventSchema = z.object({
  type: z.string().meta({ description: "Event type" }),
  data: z.unknown().meta({ description: "Event data payload" }),
  timestamp: z.string().optional().meta({ description: "Event timestamp" }),
}).meta({
  description: "SSE event to emit",
});

// Response schemas
export const createStreamResponseSchema = z.object({
  success: z.boolean(),
  stream_id: z.string().meta({ description: "Generated or provided stream ID" }),
  sse_url: z.string().meta({ description: "URL for SSE subscription" }),
}).meta({
  description: "Stream creation response",
});

export const streamMessageResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  messageId: z.string().meta({ description: "Generated message ID" }),
}).meta({
  description: "Stream message response",
});

// SSE Event schemas (for documentation)
export const sseEventSchema = z.object({
  type: z.string().meta({ description: "Event type" }),
  data: z.unknown().meta({ description: "Event data" }),
  timestamp: z.string().optional().meta({ description: "Event timestamp" }),
}).meta({
  description: "Server-Sent Event format",
});

// Error schema
export const errorResponseSchema = z.object({
  error: z.string().meta({ description: "Error message" }),
}).meta({
  description: "Error response",
});
```

### Step 3: Implement Route Handlers

```typescript
// Create stream session
streamsRoutes.post(
  "/",
  describeRoute({
    tags: ["Streams"],
    summary: "Create a new stream session",
    description: "Creates a new SSE stream session with optional signal triggering",
    responses: {
      200: {
        description: "Stream created successfully",
        content: {
          "application/json": {
            schema: resolver(createStreamResponseSchema),
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
        description: "Internal server error",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  validator("json", createStreamSchema),
  async (c) => {
    const ctx = c.get("app");
    const body = c.req.valid("json");

    try {
      const streamId = body.streamId || crypto.randomUUID();

      if (body.createOnly) {
        return c.json({
          success: true,
          stream_id: streamId,
          sse_url: `/api/stream/${streamId}/stream`,
        });
      }

      if (body.workspaceId && body.signal) {
        const runtime = ctx.runtimes.get(body.workspaceId);
        if (!runtime) {
          return c.json({ error: `Workspace not found: ${body.workspaceId}` }, 404);
        }

        runtime.triggerSignal(body.signal, {
          ...body,
          streamId,
        }).catch((error) => {
          AtlasLogger.getInstance().error("Signal trigger failed", { error });
        });
      }

      return c.json({
        success: true,
        stream_id: streamId,
        sse_url: `/api/stream/${streamId}/stream`,
      });
    } catch (error) {
      AtlasLogger.getInstance().error("Failed to create stream", { error });
      return c.json({ error: "Failed to create stream" }, 500);
    }
  },
);

// SSE subscription endpoint
streamsRoutes.get(
  "/:streamId/stream",
  describeRoute({
    tags: ["Streams"],
    summary: "Subscribe to stream events",
    description: "Opens a Server-Sent Events stream for receiving real-time updates",
    responses: {
      200: {
        description: "SSE stream opened",
        headers: {
          "Content-Type": {
            description: "Event stream content type",
            schema: { type: "string", enum: ["text/event-stream"] },
          },
          "Cache-Control": {
            description: "Caching policy",
            schema: { type: "string", enum: ["no-cache"] },
          },
          "Connection": {
            description: "Connection type",
            schema: { type: "string", enum: ["keep-alive"] },
          },
        },
      },
    },
  }),
  validator(
    "param",
    z.object({
      streamId: z.string().meta({ description: "Stream ID to subscribe to" }),
    }),
  ),
  (c) => {
    const ctx = c.get("app");
    const { streamId } = c.req.valid("param");

    // Use the existing handleGenericSSERequest logic
    return handleSSERequest(ctx, streamId);
  },
);

// Stream message endpoint
streamsRoutes.post(
  "/:streamId",
  describeRoute({
    tags: ["Streams"],
    summary: "Send message to stream",
    description: "Sends a message through the stream, typically triggering conversation processing",
    responses: {
      200: {
        description: "Message sent successfully",
        content: {
          "application/json": {
            schema: resolver(streamMessageResponseSchema),
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
  validator(
    "param",
    z.object({
      streamId: z.string().meta({ description: "Stream ID" }),
    }),
  ),
  validator("json", streamMessageSchema),
  async (c) => {
    const ctx = c.get("app");
    const { streamId } = c.req.valid("param");
    const body = c.req.valid("json");

    try {
      // Get or create conversation workspace runtime
      const conversationWorkspace = await ctx.getOrCreateWorkspaceRuntime("atlas-conversation");

      await conversationWorkspace.triggerSignal("conversation-stream", {
        streamId,
        message: body.message,
        userId: body.userId || "cli-user",
        conversationId: body.conversationId,
        scope: body.scope,
        metadata: body.metadata,
      });

      return c.json({
        success: true,
        message: "Reply streamed successfully",
        messageId: crypto.randomUUID(),
      });
    } catch (error) {
      AtlasLogger.getInstance().error("Stream API error", { streamId, error: error.message });
      return c.json({
        error: `Stream API error: ${error instanceof Error ? error.message : String(error)}`,
      }, 500);
    }
  },
);

// Emit SSE event endpoint
streamsRoutes.post(
  "/:streamId/emit",
  describeRoute({
    tags: ["Streams"],
    summary: "Emit SSE event",
    description: "Emits a Server-Sent Event to all connected clients for a stream",
    responses: {
      200: {
        description: "Event emitted successfully",
        content: {
          "application/json": {
            schema: resolver(z.object({ success: z.boolean() })),
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
  validator(
    "param",
    z.object({
      streamId: z.string().meta({ description: "Stream ID" }),
    }),
  ),
  validator("json", emitEventSchema),
  async (c) => {
    const ctx = c.get("app");
    const { streamId } = c.req.valid("param");
    const event = c.req.valid("json");

    try {
      ctx.emitSSEEvent(streamId, event);
      return c.json({ success: true });
    } catch (error) {
      AtlasLogger.getInstance().error("SSE emit error", { streamId, error: error.message });
      return c.json({
        error: `SSE emit error: ${error instanceof Error ? error.message : String(error)}`,
      }, 500);
    }
  },
);

// Helper function for SSE handling
function handleSSERequest(ctx: AppContext, sessionId: string): Response {
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      streamController = controller;

      // Add client to SSE clients map
      if (!ctx.sseClients.has(sessionId)) {
        ctx.sseClients.set(sessionId, []);
      }
      ctx.sseClients.get(sessionId)!.push({ controller });

      // Send initial connection event
      const initialEvent = {
        type: "connection_opened",
        data: { sessionId, timestamp: new Date().toISOString() },
      };
      try {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(initialEvent)}\n\n`));
      } catch (error) {
        AtlasLogger.getInstance().error(`Failed to send initial SSE event:`, error);
      }
    },
    cancel: () => {
      // Remove client from SSE clients map
      const clients = ctx.sseClients.get(sessionId);
      if (clients && streamController) {
        const filteredClients = clients.filter((client) => client.controller !== streamController);
        if (filteredClients.length === 0) {
          ctx.sseClients.delete(sessionId);
        } else {
          ctx.sseClients.set(sessionId, filteredClients);
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Cache-Control",
    },
  });
}
```

### Step 4: Update AppContext Interface

Update `apps/atlasd/src/factory.ts` to ensure `getOrCreateWorkspaceRuntime` is available:

```typescript
export interface AppContext {
  runtimes: Map<string, WorkspaceRuntime>;
  startTime: number;
  sseClients: Map<
    string,
    Array<{ controller: ReadableStreamDefaultController<Uint8Array> }>
  >;
  emitSSEEvent: (sessionId: string, event: unknown) => void;
  getOrCreateWorkspaceRuntime: (workspaceId: string) => Promise<WorkspaceRuntime>;
}
```

### Step 5: Update Atlas Daemon

1. Import the new routes module
2. Mount the routes
3. Remove inline implementations
4. Ensure methods are available on AppContext

```typescript
// In atlas-daemon.ts
import { streamsRoutes } from "../routes/streams.ts";

// In setupRoutes()
// Mount stream routes
this.app.route("/api/streams", streamsRoutes);
this.app.route("/api/stream", streamsRoutes);

// Remove the inline route implementations for:
// - POST /api/streams
// - GET /api/stream/:streamId/stream
// - POST /api/stream/:streamId
// - POST /api/stream/:streamId/emit
```

### Step 6: Generate OpenAPI Client Types

```bash
cd packages/openapi-client
deno task generate
```

## Implementation Notes

### SSE Event Types

The system emits various event types:

- `connection_opened` - Initial connection established
- `message` - Chat messages
- `agent_response` - Agent replies
- `error` - Error events
- Custom events via the emit endpoint

### Error Handling

- Connection errors are handled gracefully
- Disconnected clients are automatically removed from the registry
- Failed event emissions are logged but don't crash the stream

### Security Considerations

- Stream IDs should be unguessable (UUIDs)
- Consider adding authentication for production use
- Rate limiting may be needed for the emit endpoint

## Testing Plan

1. Test stream creation with and without `createOnly`
2. Test SSE subscription and event delivery
3. Test message sending through conversation workspace
4. Test custom event emission
5. Test client disconnection handling
6. Verify OpenAPI documentation accuracy

## Migration Checklist

- [ ] Create streams route module
- [ ] Define all Zod schemas
- [ ] Implement route handlers
- [ ] Update AppContext interface
- [ ] Mount routes in atlas-daemon.ts
- [ ] Remove inline implementations
- [ ] Generate OpenAPI client types
- [ ] Test all endpoints
- [ ] Update OpenAPI documentation tags if needed
