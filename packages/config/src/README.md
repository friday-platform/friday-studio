# Atlas Configuration v2 Schemas

This directory contains the v2 configuration schemas for Atlas, implementing comprehensive
improvements for type safety, clarity, and developer experience.

## Key Improvements

### 1. Tagged Unions for Type Safety

**Signals**: Use discriminated unions on the `provider` field:

- `http` - Webhook/API endpoints
- `schedule` - Cron-based triggers
- `system` - Internal Atlas signals (system workspaces only)

**Agents**: Use discriminated unions on the `type` field:

- `llm` - AI-powered agents with model configuration
- `system` - Built-in Atlas functionality
- `remote` - External agents via ACP protocol (MCP remote not supported)

### 2. Clear MCP Naming

Atlas uses "MCP" for two different purposes, now clearly distinguished:

**Protocol MCP** (`tools.mcp`): External tool integration

- Agents calling out to MCP servers
- GitHub, Slack, filesystem servers
- Configured via `MCPClientConfigSchema`

**Platform MCP** (`server.mcp`): Atlas exposing capabilities

- External systems calling into Atlas
- Workspace jobs exposed as MCP tools
- Configured via `PlatformMCPConfigSchema`

### 3. Consistent Patterns

- **Allow/Deny**: Unified terminology with mutual exclusion validation
- **Duration Format**: All timeouts use duration strings (`"30s"`, `"5m"`, `"2h"`)
- **Conditions**: Support both JSONLogic and natural language prompts
- **Context**: Structured agent context configuration replacing `input_source`

### 4. Type Exports

All enums and types are properly exported:

```typescript
export const AgentType = z.enum(["llm", "system", "remote"]);
export type AgentType = z.infer<typeof AgentType>;
```

### 5. Runtime Validation

Signal schemas are validated at runtime using the `jsonSchemaToZod` utility:

```typescript
const result = validateSignalPayload(signal, payload);
if (!result.success) {
  throw new Error(`Validation failed: ${result.error}`);
}
```

## File Structure

- `base.ts` - Core types, enums, and shared schemas
- `mcp.ts` - MCP configurations (Platform and Protocol)
- `signals.ts` - Signal provider schemas with tagged unions
- `agents.ts` - Agent type schemas with tagged unions
- `jobs.ts` - Job specification schemas
- `atlas.ts` - Atlas-specific schemas (supervisors, planning, etc.)
- `workspace.ts` - Main configuration schemas
- `index.ts` - Re-exports and helper functions

## Usage Examples

### Validating a Workspace Configuration

```typescript
import { WorkspaceConfigSchema } from "@atlas/config";

const config = {
  version: "1.0",
  workspace: {
    name: "my-workspace",
    description: "Example workspace",
  },
  signals: {
    webhook: {
      provider: "http",
      description: "GitHub webhook",
      config: {
        path: "/webhooks/github",
        timeout: "30s",
      },
    },
  },
};

const result = WorkspaceConfigSchema.safeParse(config);
if (!result.success) {
  console.error("Invalid configuration:", result.error);
}
```

### Working with Tagged Unions

```typescript
import { isLLMAgent, WorkspaceAgentConfig } from "@atlas/config";

function processAgent(agent: WorkspaceAgentConfig) {
  if (isLLMAgent(agent)) {
    // TypeScript knows this is an LLM agent
    console.log(`Model: ${agent.config.model}`);
  }
}
```

### Helper Functions

```typescript
import { getAgent, getJob, getSignal } from "@atlas/config";

const job = getJob(config, "analyze-data");
const signal = getSignal(config, "webhook-github");
const agent = getAgent(config, "data-analyzer");
```

## Migration Guide

### Signals

- Remove `provider: "cli"` - CLI is not a provider
- Move all provider-specific fields under `config`
- Change `provider: "internal"` to `provider: "system"`

### Agents

- Move all configuration under the `config` field
- System agents: Move `agent` identifier to top level
- Remote agents: Only `protocol: "acp"` is supported
- Tools are now a simple array of strings

### Jobs

- Move `timeout` and `supervision` under `config`
- Replace `input_source` with structured `context`
- Use `allow`/`deny` instead of `allowed`/`denied`

### Timeouts

- Change milliseconds to duration strings
- `timeout_ms: 30000` → `timeout: "30s"`
- `analysis_ms: 10000` → `analysis: "10s"`
