# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project Overview

**Atlas** is a comprehensive AI agent orchestration platform that transforms software delivery
through human/AI collaboration. Atlas enables engineers to create workspaces where humans
collaborate seamlessly with specialized, autonomous agents in a secure, auditable, and scalable
environment.

## CLI Development Guidelines

When developing CLI commands:

1. **Command File Structure**: Prefer flat command files (e.g., `src/cli/commands/version.ts`) over
   subdirectories with index.ts files (e.g., `src/cli/commands/version/index.ts`). This reduces file
   nesting and improves code organization clarity.

## Claude Code execution guidelines

0. **MANDATORY SESSION START**: At the beginning of EVERY session, read and update
   `.DEV_FEEDBACK.md` with any new feedback, complaints, or guidance from the user. This file tracks
   behavioral improvements across sessions. **IMPORTANT**: Summarize feedback in
   SFW/work-appropriate language.
1. Use `deno check` to statically verify code validity before running (see Known Issues for React
   components)
2. Run with required Deno flags:
   `--unstable-broadcast-channel --unstable-worker-options --allow-all --env-file`
3. Ensure `ANTHROPIC_API_KEY` is set in .env file for LLM functionality
4. When debugging worker communication, check logs in `~/.atlas/logs/workspaces/`
5. **Agent loading**: Agents are loaded by WorkspaceRuntime during initialization, NOT by CLI
6. **Signal handling**: Server handles all signal processing via HttpServer.shutdown(), CLI exits
   immediately
7. **Configuration**: workspace.yml uses job specifications in jobs/ directory, agents loaded via
   WorkspaceRuntime
8. Run `deno lint --fix` to autofix any linting errors and identify those that aren't autofixable.
   Do this after making changes.
9. **Code formatting**: Always run `deno fmt` to format all changed files before completing a task

## TUI Development Guidelines

When working with Ink-based TUI components (src/cli/commands/tui.tsx and related files):

1. **Text Component Wrapping**: Always wrap `<Text>` components in a `<Box>` component for proper
   layout and rendering
2. **STRICT NO EMOJIS POLICY**: NEVER add emojis to any text content, components, or UI elements
   unless the user explicitly requests them. This includes error messages, alerts, status
   indicators, headers, and all other text. Use clean text-only styling.
3. **Absolute Positioned Components**: Components with `position="absolute"` (like ErrorAlert,
   modals, overlays) MUST be placed at the very end of the JSX return statement, just before the
   closing tag of the root container. This ensures proper z-index layering and overlay behavior.
4. **Component Declaration Pattern**: NEVER use `React.FC` type annotation. Instead, apply Props
   interface directly to the function parameters. Use
   `export const Component = ({ prop1, prop2 }: Props) => { ... }` instead of
   `export const Component: React.FC<Props> = ({ prop1, prop2 }) => { ... }`
5. **Testing Changes**: Always test changes by running `deno task atlas` to ensure the interface
   works correctly

## Known Issues

### React TypeScript Integration

**Issue**: Deno's type checker cannot resolve React types from npm packages

- **Error**: `Failed resolving types. [ERR_TYPES_NOT_FOUND] Could not find types for react`
- **Workaround**: Use `--no-check` flag when running React components
- **Impact**: Components work perfectly at runtime, only type checking is affected
- **Resolution**: Run CLI with `deno run --allow-all --no-check` for React components

### Development Commands

```bash
# For React components - use --no-check
deno run --allow-all --no-check src/cli.tsx interactive

# For non-React code - normal type checking works
deno check src/core/workspace-server.ts
```

## Current Architecture Status

The codebase implements enterprise-grade architecture with:

- **Hierarchical Supervision**: WorkspaceSupervisor → SessionSupervisor → AgentSupervisor
- **Worker Isolation**: All agents run in isolated Web Workers with proper lifecycle management
- **LLM-Enabled Supervision**: Intelligent analysis and safety assessment before execution
- **Structured Logging**: Professional debugging capabilities with timing and context
- **Type Safety**: Full TypeScript coverage with proper interfaces
- **Clean Signal Handling**: Reliable termination without hanging processes

## Input Validation Standards

### Zod v4 Schema Validation

**IMPORTANT**: Use Zod v4 for parsing and validating all unknown input wherever possible. This
provides both compile-time and runtime type safety.

**Modern API Pattern**: When implementing MCP servers or similar protocol handlers, use the modern
API approach:

```typescript
import { z } from "zod/v4";

// Use Zod schemas for type-safe input validation
const InputSchema = z.object({
  location: z.string().describe("The location to get weather for"),
  days: z.number().optional().default(3),
});

// Register tools with schema validation
server.registerTool(
  "get_weather",
  {
    description: "Get current weather for a location",
    inputSchema: InputSchema,
  },
  ({ location, days = 3 }) => {
    // Input is automatically validated and typed
    return {
      /* response */
    };
  },
);
```

**Key Benefits**:

- Compile-time type safety with TypeScript inference
- Runtime validation prevents invalid data
- Automatic type coercion and defaults
- Clear API contracts with descriptive schemas
- Eliminates need for `any` types or unsafe casting

## System Architecture Principles

**Atlas** is a comprehensive AI agent orchestration platform that transforms software delivery
through human/AI collaboration. Key principles:

1. **Hierarchical Supervision**: WorkspaceSupervisor → SessionSupervisor → AgentSupervisor
   architecture
2. **Stateless Agents**: Agents are stateless; memory/context provided by supervisors before
   invocation
3. **Signal-Driven**: External events (Signals) trigger workspaces with configurable processing
4. **Session Isolation**: Each Signal spawns a WorkspaceSession with unique context
5. **Configuration-Driven**: All behavior defined through YAML/JSON configuration files
6. **Worker Isolation**: Each agent runs in separate Deno Web Worker for security and stability
7. **Full Observability**: All workspace components observed, traced, and audit logged

## Core Architecture

### Hierarchical Supervision

Three-tier supervision hierarchy with LLM intelligence:

1. **WorkspaceRuntime**: Manages workspace lifecycle, spawns WorkspaceSupervisor, handles signal
   routing
2. **WorkspaceSupervisor**: Analyzes signals using LLM, creates session contexts, coordinates
   multiple sessions
3. **SessionSupervisor**: Creates execution plans via LLM, orchestrates agents, evaluates progress
4. **Agents**: Stateless executors in isolated workers, receive context from supervisors

### Worker Architecture

- **BaseWorker**: XState FSM foundation (uninitialized → initializing → ready → busy → terminated)
- **WorkerManager**: Orchestrates worker lifecycle with XState FSM
- **BroadcastChannels**: Session-wide event broadcasting
- **MessagePorts**: Direct worker-to-worker communication
- **Isolation**: Each worker runs in separate Deno Web Worker for security

### Resource Management

Atlas manages three resource types:

- **Memory**: Internal learned state managed by Atlas
- **Context**: External reference materials fetched for tasks
- **Tools**: MCP providers that perform operations or fetch data

## Technology Stack

- **Language**: TypeScript
- **Runtime**: Deno with Web Workers for isolation
- **State Management**: XState 5 for FSM-based lifecycle management
- **LLM Integration**: Vercel AI SDK with Anthropic Claude
- **Architecture**: Actor system with hierarchical scoping
- **Communication**: BroadcastChannels and MessagePorts for worker communication
- **Memory**: Pluggable storage adapters with external persistence
- **Protocols**: MCP (Model Context Protocol) gateway support
- **Configuration**: YAML/JSON with provider-based plugin system
- **Testing**: Integration tests with worker communication verification
- **Logging**: Structured JSON logging with workspace separation

## CLI Interface

The Atlas CLI provides workspace management capabilities:

```bash
atlas                    # Interactive interface
atlas init               # Initialize workspace in current directory
atlas daemon start       # Start Atlas daemon
atlas ps                 # List all active sessions
atlas signal trigger     # Manually trigger a signal
atlas config validate    # Validate workspace configuration
```

## Engineering Standards

Apply rigorous engineering judgment to all design decisions. Challenge proposals that compromise
system quality, even if they come from the user. Prioritize:

- Architectural correctness and consistency
- Performance implications at scale
- Maintainability and debugging complexity
- Security and isolation boundaries
- Clear abstraction layers and separation of concerns

When the user's approach is sound, acknowledge it directly. When it has flaws, identify them
specifically with alternative solutions. Aim for the engineering excellence expected at
organizations like Google Research, not merely functional code.
