# ACP (Agent Communication Protocol) Types

This directory contains TypeScript types and utilities for the Agent Communication Protocol (ACP)
v0.2.0.

## Overview

The types in this directory are auto-generated from the official ACP OpenAPI specification
maintained by the [i-am-bee/acp](https://github.com/i-am-bee/acp) project. This ensures 100%
compatibility with the ACP protocol specification.

## Files

- **`types.gen.ts`** - Auto-generated TypeScript types from the ACP OpenAPI spec
- **`index.ts`** - Convenient type aliases and re-exports for easier consumption
- **`client.ts`** - Type-safe ACP client using openapi-fetch
- **`README.md`** - This documentation file

## Generated Types

The `types.gen.ts` file contains complete TypeScript interfaces for:

- **API Endpoints**: All ACP REST endpoints with proper request/response types
- **Schema Types**: Agent, Run, Message, Event, and all other ACP entities
- **Operation Types**: Type-safe operation definitions for each endpoint
- **Component Types**: Reusable schema components and response formats

## Convenient Type Aliases

The `index.ts` file provides convenient aliases for commonly used types:

```typescript
import type {
  ACPAgent,
  ACPEvent,
  ACPMessage,
  ACPRun,
  ACPRunCreateRequest,
  // ... and many more
} from "./acp/index.ts";
```

## Usage Example

### Using the Type-Safe Client

```typescript
import { type ACPAgent, type ACPRunCreateRequest, createACPClient } from "./acp/client.ts";

// Create a type-safe client
const client = createACPClient({
  baseUrl: "https://api.example.com",
  headers: {
    "Authorization": "Bearer your-token-here",
  },
});

// All operations are fully type-safe with IntelliSense support
const agentsResponse = await client.GET("/agents", {
  params: {
    query: {
      limit: 10,
      offset: 0,
    },
  },
});

if (agentsResponse.data) {
  console.log("Available agents:", agentsResponse.data.agents);
}

// Get specific agent details
const agentResponse = await client.GET("/agents/{name}", {
  params: {
    path: {
      name: "chat",
    },
  },
});

// Create and execute a run
const runResponse = await client.POST("/runs", {
  body: {
    agent_name: "chat",
    input: [
      {
        parts: [
          {
            content_type: "text/plain",
            content: "Hello, how are you?",
          },
        ],
        role: "user",
      },
    ],
    mode: "sync",
  },
});

if (runResponse.data) {
  console.log("Run result:", runResponse.data.output);
}
```

### Using Types Directly

```typescript
import type { ACPAgent, ACPEvent, ACPRunCreateRequest } from "./acp/index.ts";

// Type-safe agent representation
const agent: ACPAgent = {
  name: "chat",
  description: "A conversational agent",
  metadata: {
    capabilities: [
      {
        name: "Conversation",
        description: "Multi-turn conversation support",
      },
    ],
  },
};

// Type-safe run creation
const runRequest: ACPRunCreateRequest = {
  agent_name: "chat",
  input: [
    {
      parts: [
        {
          content_type: "text/plain",
          content: "Hello, how are you?",
        },
      ],
      role: "user",
    },
  ],
};

// Type-safe event handling
function handleEvent(event: ACPEvent) {
  switch (event.type) {
    case "message.part":
      console.log("Received content:", event.part.content);
      break;
    case "run.completed":
      console.log("Run completed:", event.run.run_id);
      break;
    case "error":
      console.error("Error:", event.error.message);
      break;
  }
}
```

## Regenerating Types

To update the types when the ACP specification changes:

```bash
# From the Atlas root directory
npx openapi-typescript https://raw.githubusercontent.com/i-am-bee/acp/refs/heads/main/docs/spec/openapi.yaml \
  --output src/core/agents/remote/adapters/acp/types.gen.ts
```

## Integration with Atlas

These types are used by:

- **ACP Adapter** (`../acp-adapter.ts`) - Implements the ACP protocol client
- **Remote Agent** (`../remote-agent.ts`) - Integrates with Atlas agent system
- **Configuration Schema** - Validates ACP-specific workspace configuration

## Benefits

### Type-Safe Client with openapi-fetch

The `client.ts` provides a type-safe ACP client built on openapi-fetch:

- **Full Type Safety**: All requests and responses are type-checked at compile time
- **Automatic Serialization**: JSON serialization/deserialization handled automatically
- **Error Handling**: Proper error types and status code handling
- **IntelliSense Support**: Complete autocomplete for all endpoints and parameters
- **Zero Runtime Overhead**: Types are compile-time only, no runtime type checking

### Generated Types

Using these generated types provides:

- **Type Safety**: Compile-time validation of all ACP interactions
- **IntelliSense**: Full IDE support with autocomplete and documentation
- **Protocol Compliance**: Guaranteed compatibility with ACP specification
- **Future-Proofing**: Easy updates when ACP specification evolves
- **Perfect Deno Compatibility**: Works seamlessly in Deno runtime

## ACP Specification

For complete details on the Agent Communication Protocol, see:

- [ACP Documentation](https://agentcommunicationprotocol.dev)
- [ACP GitHub Repository](https://github.com/i-am-bee/acp)
- [OpenAPI Specification](https://raw.githubusercontent.com/i-am-bee/acp/refs/heads/main/docs/spec/openapi.yaml)
