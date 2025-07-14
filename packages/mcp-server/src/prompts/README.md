# Atlas MCP Server Prompts

This directory contains MCP (Model Context Protocol) prompts for the Atlas platform, organized by
domain. Each prompt provides a structured interface for LLMs to interact with Atlas workspace
components.

## Structure

```
prompts/
├── agent/           # Agent-related prompts
├── job/             # Job-related prompts
├── library/         # Library-related prompts
├── session/         # Session-related prompts
├── signals/         # Signal-related prompts
├── workspace/       # Workspace-related prompts
├── status/          # Status and system prompts
├── types.ts         # Shared types and utilities
└── index.ts         # Export all prompts
```

## Domain Coverage

### Agent Prompts

- `agent_list` - List all agents in a workspace
- `agent_describe` - Get detailed agent information

### Job Prompts

- `job_list` - List all jobs in a workspace
- `job_describe` - Get detailed job information

### Library Prompts

- `library_list` - List library items in a workspace
- `library_get` - Retrieve specific library item
- `library_search` - Search library items

### Session Prompts

- `session_list` - List sessions in a workspace
- `session_describe` - Get detailed session information

### Signals Prompts

- `signals_list` - List all signals in a workspace

### Workspace Prompts

- `workspace_list` - List all workspaces
- `workspace_describe` - Get detailed workspace information

## Prompt Pattern

Each prompt follows a consistent pattern:

```typescript
export function registerXxxPrompt(server: McpServer, ctx: PromptContext) {
  server.registerPrompt(
    "prompt_name",
    {
      title: "Human Readable Title",
      description: "Detailed description of what this prompt does...",
      argsSchema: {
        param: z.string().describe("Parameter description"),
      },
    },
    ({ param }) => {
      ctx.logger.info("MCP prompt_name called", { param });

      return createSuccessResponse(`Please return ${param} information`);
    },
  );
}
```

## Usage

Import and register all prompts in your MCP server:

```typescript
import {
  registerAgentListPrompt,
  registerJobListPrompt,
  // ... other prompts
} from "./prompts/index.ts";

// Register all prompts
registerAgentListPrompt(server, ctx);
registerJobListPrompt(server, ctx);
// ... register other prompts
```

## Command Mapping

These prompts correspond to the slash commands in the CLI:

| Slash Command | MCP Prompt       | Description             |
| ------------- | ---------------- | ----------------------- |
| `/agent`      | `agent_list`     | List workspace agents   |
| `/job`        | `job_list`       | List workspace jobs     |
| `/library`    | `library_list`   | List library items      |
| `/session`    | `session_list`   | List workspace sessions |
| `/signal`     | `signals_list`   | List workspace signals  |
| `/workspaces` | `workspace_list` | List all workspaces     |
| `/status`     | `daemon_status`  | Check daemon status     |
| `/version`    | `version`        | Get version info        |

## Adding New Prompts

1. Create appropriate domain directory if needed
2. Create prompt file following the pattern above
3. Add export to `index.ts`
4. Update this README
5. Register in the MCP server

## Notes

- All prompts use Zod schemas for parameter validation
- Prompts return structured responses via `createSuccessResponse`
- Logging is handled consistently across all prompts
- Descriptions are detailed to help LLMs understand context and usage
