# Atlas Agent MCP Server

This package provides the MCP (Model Context Protocol) server implementation for hosting Atlas
agents. It implements the `AgentServerAdapter` interface from the open-source `@atlas/agent-sdk`
package.

## Architecture Overview

```
Session Supervisor
    ↓ (executes agents via + passes AbortSignal)
Agent Execution Manager
    ↓ (creates/manages + propagates cancellation)
Agent Execution Machines (XState actors)
    ↓ (when approval needed)
Approval Queue Manager (stores suspended states)
```

The agent server provides:

1. **MCP Tool Exposure**: Each agent is exposed as an MCP tool that accepts natural language prompts
2. **Session Management**: State persistence across agent executions using Atlas Session IDs
3. **Lazy Loading**: Agent code is loaded on-demand for efficient resource usage
4. **Approval Flows**: Built-in support for human-in-the-loop approval via supervisor exceptions
5. **Resource Discovery**: MCP resources for agent discovery and capability inspection
6. **Cancellation Support**: Handles MCP cancellation notifications to abort running executions

## Key Components

### AtlasAgentsMCPServer (`server.ts`)

The main MCP server that:

- Implements `AgentServerAdapter` from the SDK
- Registers agents as MCP tools
- Manages MCP protocol and session authentication
- Routes requests to execution manager

### Agent Execution Manager (`agent-execution-manager.ts`)

Orchestrates agent execution using XState actors:

- Creates and manages execution state machines
- Handles lazy loading of agent code
- Coordinates with approval queue for human-in-the-loop flows
- Tracks active agent executions with AbortControllers
- Maps requestIds to executions for cancellation correlation
- Propagates AbortSignals to agent handlers

### Agent Execution Machine (`agent-execution-machine.ts`)

Pure XState machine definition for agent lifecycle:

- **States**: idle → loading → ready → preparing → executing → persisting → completed
- **Approval flow**: executing → awaiting → executing (on resume)
- **Error handling**: Any state can transition to failed
- **Memory integration**: Preparing state builds context, persisting stores results

### Approval Queue Manager (`approval-queue-manager.ts`)

Manages suspended agent executions awaiting approval:

- Captures XState snapshots for state preservation
- Queues approval requests with metadata
- Restores and resumes executions after decisions
- Provides monitoring and cleanup capabilities

## Usage

```typescript
import { AtlasAgentsMCPServer } from "@atlas/agent-server";
import { MyAgentRegistry } from "./my-registry.ts";
import { AtlasLogger } from "@atlas/core";

// Create the MCP server
const server = new AtlasAgentsMCPServer({
  agentRegistry: new MyAgentRegistry(),
  logger: AtlasLogger.getInstance(),
  port: 8082,
  daemonUrl: "http://localhost:8080",
});

// Start the server
await server.start();

// Server exposes agents as MCP tools
// Clients can call agents like: client.callTool("github", { prompt: "scan my repo" })
```

## Integration with Atlas Daemon

The Atlas daemon starts both the platform MCP server and the agents MCP server:

```typescript
// Platform MCP server on port 8081
this.fastMCPServer = new AtlasMCPServer({ port: 8081 });

// Agents MCP server on port 8082
this.agentsMCPServer = new AtlasAgentsMCPServer({ port: 8082 });
```

## Session Flow

1. Client connects to MCP server with session headers
2. Server authenticates and creates session context
3. Agent tools are called with natural language prompts
4. Session state persists across calls within same session
5. Approval exceptions bubble up to supervisor
6. Sessions timeout after 30 minutes of inactivity

## MCP Protocol

Agents are exposed as tools with this schema:

```typescript
{
  name: "agent-name",
  parameters: {
    prompt: string,      // Natural language prompt
    context?: any,       // Optional additional context
    _approvalId?: string,    // For approval resumption
    _approvalDecision?: any, // Approval decision
  },
  _meta?: {
    requestId?: string,  // Correlation ID for cancellation
  }
}
```

### Cancellation Protocol

The server implements MCP cancellation handling:

1. **Request Tracking**: Each tool call can include a `requestId` in the `_meta` property
2. **Cancellation Notification**: Clients send `notifications/cancelled` with the requestId
3. **Abort Propagation**: Server aborts the matching execution via AbortController
4. **Agent Context**: AbortSignal is passed to agent handlers in their execution context

Example cancellation flow:
```typescript
// Client initiates execution with requestId
await client.callTool({
  name: "my-agent",
  arguments: { prompt: "analyze data" },
  _meta: { requestId: "req-123" }
});

// Client cancels the execution
await client.notification({
  method: "notifications/cancelled",
  params: { requestId: "req-123", reason: "User cancelled" }
});

// Agent handler receives abort signal
handler: async (prompt, { abortSignal }) => {
  if (abortSignal?.aborted) {
    throw new Error("Operation cancelled");
  }
  // ... agent logic
}
```

## Resources

The server exposes these MCP resources:

- `agents/list` - List all available agents with metadata
- `agents/{agentId}/expertise` - Get agent's domains, capabilities, and examples

## Testing

Integration tests that use both SDK and server:

```typescript
import { createAgent } from "@atlas/agent-sdk";
import { AtlasAgentsMCPServer } from "@atlas/agent-server";

// Create agent using SDK
const agent = createAgent({
  name: "test-agent",
  handler: async (prompt, context) => {
    // Check for cancellation
    if (context.abortSignal?.aborted) {
      throw new Error("Cancelled");
    }
    return { response: `Processed: ${prompt}` };
  },
});

// Register with server
await server.registerAgent(agent);

// Execute via MCP with cancellation support
const requestId = crypto.randomUUID();
const executePromise = server.executeAgent(
  "test-agent",
  "Hello",
  sessionData,
  { requestId }
);

// Cancel the execution
await server.handleCancellation(requestId);

// Execution will throw cancellation error
try {
  await executePromise;
} catch (error) {
  console.log("Execution cancelled");
}
```
