# Atlas Agent SDK

Build single-purpose agents that handle natural language prompts. Each agent focuses on a specific domain - GitHub operations, Slack messaging, security scanning, etc.

## What It Does

The SDK lets you create agents that:
- Interpret natural language prompts within their domain
- Access MCP tools to perform actions
- Stream responses back to Atlas in real-time
- Request supervisor approval for high-risk operations

Agents are **LLM-agnostic** - you bring your own LLM library (AI SDK, OpenAI SDK, etc.) and the SDK provides the infrastructure.

## Technical Architecture

### Core Design Principles

1. **Natural Language Interface**: Agents receive prompts, not structured inputs. No action routing or command parsing - the agent's LLM interprets the request.

2. **Domain Experts**: Each agent specializes in one area. A GitHub agent knows about repositories, PRs, and code. A Slack agent knows about channels and messaging.

3. **LLM-Agnostic**: The SDK doesn't provide LLM capabilities. Agents import their preferred LLM library and configuration.

4. **MCP Transport**: All agents are exposed through a unified MCP server as individual tools, maintaining session state across executions.

### How It Works

```typescript
// 1. Define your agent
export const githubAgent = createAgent({
  id: "github",
  version: "1.0.0",
  description: "GitHub operations expert",
  
  expertise: {
    domains: ["github", "vcs", "security"],
    capabilities: ["scan repositories", "review PRs", "manage issues"],
    examples: ["scan my repo for vulnerabilities", "review PR #123"]
  },
  
  // 2. Handler receives prompts and context
  handler: async (prompt, { tools, env, stream }) => {
    // 3. Bring your own LLM
    import { generateText } from 'ai';
    import { anthropic } from '@ai-sdk/anthropic';
    
    // 4. Access MCP tools
    const githubTools = tools; // Pre-loaded by server
    
    // 5. Execute with your LLM
    const result = await generateText({
      model: anthropic('claude-3-sonnet-20240229'),
      prompt,
      tools: githubTools
    });
    
    return result;
  }
});
```

### Agent Context

The SDK provides agents with a context object containing:

```typescript
interface AgentContext {
  // All available tools from MCP servers (unified access)
  tools: Record<string, AtlasTool>;
  
  // Session information (workspace, user, etc.)
  session: AgentSessionData;
  
  // Validated environment variables
  env: Record<string, string>;
  
  // Stream events back to Atlas
  stream: StreamEmitter;
  
  // Logger with session context
  logger: Logger;
}
```

### Streaming Events

Agents can stream various event types back to Atlas:

```typescript
handler: async (prompt, { stream }) => {
  // Progress updates
  stream.emit({ type: "text", content: "Starting analysis...\n" });
  
  // Stream LLM responses
  const result = await streamText({
    model: anthropic("claude-3-sonnet"),
    prompt,
    onChunk: ({ chunk }) => {
      if (chunk.text) {
        stream.emit({ type: "text", content: chunk.text });
      }
    }
  });
  
  // Usage stats
  stream.emit({ 
    type: "usage", 
    tokens: { input: 100, output: 200 }
  });
  
  stream.emit({ type: "finish" });
  return result;
}
```

### Environment Variables

Agents can require and validate environment variables:

```typescript
environment: {
  required: [
    {
      name: "GITHUB_TOKEN",
      description: "GitHub Personal Access Token",
      validation: "^ghp_[A-Za-z0-9]+$"  // Regex validation
    }
  ],
  optional: [
    {
      name: "GITHUB_ORG",
      description: "Default organization",
      default: "my-org"
    }
  ]
}
```

The server validates these at execution time and provides them in `context.env`.

### MCP Server Configuration

Agents can define their own MCP servers:

```typescript
mcp: {
  github: {
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"]
    },
    auth: {
      type: "bearer",
      token_env: "GITHUB_TOKEN"
    },
    tools: {
      allow: ["get_repository", "list_issues", "search_code"]
    }
  }
}
```

## Implementation Details

### Type System

The SDK uses Zod v4 for runtime validation of agent configurations:

- `AgentMetadataSchema` - Validates agent identity and expertise
- `AgentEnvironmentConfigSchema` - Validates environment requirements
- `MCPServerConfigSchema` - Validates MCP server configurations
- `CreateAgentConfigValidationSchema` - Validates the entire agent config

### Adapter Pattern

The SDK uses an adapter pattern to decouple from server implementations:

```typescript
interface AgentServerAdapter {
  registerAgent(agent: AtlasAgent): Promise<void>;
  executeAgent(
    agentId: string,
    prompt: string,
    sessionData: AgentSessionData,
    contextOverrides?: Partial<AgentContext>
  ): Promise<AgentExecutionResult>;
  // ... other methods
}
```

This allows different server types (MCP, HTTP, etc.) to host agents without the SDK knowing server-specific details.

### Approval Flow

Agents can request supervisor approval for high-risk operations:

```typescript
// Agent calls approval tool (provided by atlas-platform MCP server)
const result = await tools.request_supervisor_approval({
  action: "Delete repository",
  risk_level: "critical",
  rationale: "User requested repository deletion"
});

// This throws AwaitingSupervisorDecision exception
// Server catches it and returns structured response
// Supervisor handles approval/denial
// Agent resumes with decision
```

### Session Management

Agents maintain state across executions through session management:

- Sessions keyed by: `atlasSessionId + agentId`
- State persists between requests
- TTL-based cleanup for inactive sessions
- Memory context provided transparently

## Creating an Agent

### Basic Agent

```typescript
import { createAgent } from "@atlas/agent-sdk";

export const myAgent = createAgent({
  id: "my-agent",
  version: "1.0.0",
  description: "Does something specific",
  
  expertise: {
    domains: ["my-domain"],
    capabilities: ["capability-1", "capability-2"],
    examples: ["do this thing", "do that thing"]
  },
  
  handler: async (prompt, context) => {
    // Your agent logic here
    return { result: "Done" };
  }
});
```

### Agent with MCP Tools

```typescript
export const slackAgent = createAgent({
  id: "slack",
  version: "1.0.0",
  description: "Slack messaging expert",
  
  expertise: {
    domains: ["messaging", "communication"],
    capabilities: ["send messages", "manage channels"],
    examples: ["send a message to #general"]
  },
  
  mcp: {
    slack: {
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-slack"]
      }
    }
  },
  
  handler: async (prompt, { tools }) => {
    import { generateText } from 'ai';
    import { anthropic } from '@ai-sdk/anthropic';
    
    const result = await generateText({
      model: anthropic('claude-3-sonnet'),
      prompt,
      tools: tools  // Slack tools available here
    });
    
    return result;
  }
});
```

## Usage in Atlas

Agents are registered with the Atlas daemon and exposed through the unified MCP server:

1. Agent code is loaded on-demand when first used
2. Each agent becomes an MCP tool with the agent ID as the tool name
3. Tools accept a `prompt` parameter (natural language)
4. Session state persists across requests
5. Approval requests suspend execution until supervisor decides

## API Reference

### `createAgent(config)`

Creates an Atlas agent.

**Parameters:**
- `config: CreateAgentConfig` - Agent configuration

**Returns:**
- `AtlasAgent` - The agent instance

### Configuration Fields

- `id`: Agent identifier (lowercase, hyphens)
- `version`: Semantic version
- `description`: What the agent does
- `expertise`: Domains, capabilities, and examples
- `handler`: Function that processes prompts
- `environment?`: Required/optional env vars
- `mcp?`: MCP server configurations
- `llm?`: LLM config (for YAML agents)
- `metadata?`: Tags and author info

### Context Object

- `tools`: All available MCP tools
- `session`: Session data (IDs, workspace)
- `env`: Validated environment variables
- `stream`: Event emitter for streaming
- `logger`: Configured logger instance

### Stream Events

- `text`: Text content to display
- `tool-call`: Tool being called
- `tool-result`: Tool execution result
- `thinking`: Agent reasoning (if supported)
- `error`: Error occurred
- `finish`: Execution complete
- `usage`: Token usage stats
- `progress`: Progress updates
- `custom`: Custom event types

## Directory Structure

```
packages/agent-sdk/
├── src/
│   ├── index.ts           # Main exports
│   ├── types.ts           # TypeScript types and Zod schemas
│   ├── create-agent.ts    # createAgent implementation
│   ├── adapter.ts         # Server adapter interface
│   └── vercel-helpers/    # Helpers for Vercel AI SDK
├── examples/
│   ├── simple-agent.ts    # Basic text analysis agent
│   └── agent-with-environment-variables.ts  # Full feature demo
├── tests/
│   └── create-agent.test.ts  # Unit tests
└── deno.json              # Package configuration
```

## Development

### Testing

```bash
deno test
```

### Type Checking

```bash
deno check src/index.ts
```

### Linting

```bash
deno lint
```

## Design Decisions

### Why LLM-Agnostic?

Agents bring their own LLM libraries because:
- Future-proof: New LLM features work immediately
- No abstraction leakage: Provider-specific options stay with the agent
- Developer freedom: Use any LLM provider or configuration
- Simple SDK: We provide infrastructure, not LLM abstractions

### Why Natural Language?

Agents receive prompts, not structured commands because:
- Flexibility: Handle novel requests without code changes
- True autonomy: Agents decide how to accomplish tasks
- Simpler implementation: No action routing or dispatch logic
- Better UX: Natural language from user to agent

### Why MCP Transport?

MCP provides:
- Standardized protocol with tooling
- Built-in session support
- Streaming capabilities
- Tool discovery mechanisms
- Single connection for all agents