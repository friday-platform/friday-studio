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

1. **Command File Structure**: Use nested command structures for subcommands (e.g.,
   `src/cli/commands/workspace/add.tsx` for `atlas workspace add`). This follows the existing
   codebase pattern and provides better organization for complex command hierarchies.

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
   WorkspaceRuntime. Configuration loading uses dependency injection pattern with adapters.
8. Run `deno lint --fix` to autofix any linting errors and identify those that aren't autofixable.
   Do this after making changes.
9. **Code formatting**: Always run `deno fmt` to format all changed files before completing a task
10. **Client Package Usage**: When you see `loadWorkspaceConfigNoCwd` or similar direct workspace
    configuration access patterns, propose adding the functionality to the centralized daemon client
    in `@atlas/client` instead. This prevents validation conflicts, ensures consistent API usage,
    and avoids triggering unnecessary workspace agent/job validation.
11. **Mandatory Client Usage**: ALL CLI operations MUST go through the `@atlas/client` package.
    NEVER use direct file system access, `Deno.cwd()`, or other fallback patterns. Always use the
    appropriate client method to ensure consistent API usage and proper error handling.

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

### Configuration Architecture

The configuration system uses a clean, testable architecture:

- **`@atlas/config` package**: Contains all Zod schemas, types, and the ConfigLoader
- **`@atlas/storage` package**: Provides `ConfigurationAdapter` interface and implementations
- **Dependency Injection**: ConfigLoader accepts adapters, enabling multiple configuration sources
- **Type Safety**: All configurations validated with Zod v4 schemas at runtime
- **MCP Compliance**: Job names must follow MCP tool naming (letters, numbers, underscores, hyphens)

**Key patterns**:

```typescript
// Always use adapter pattern for configuration loading
import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";

const adapter = new FilesystemConfigAdapter();
const configLoader = new ConfigLoader(adapter, workspacePath);
const config = await configLoader.load();
```

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

## Import Pattern Guidelines

**Prefer static imports** (at the top of modules) over dynamic imports unless there's a specific
reason:

### When to use static imports (preferred):

```typescript
import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
```

Use static imports when:

- No circular dependency issues exist
- The imported modules are always used in the file
- No conditional loading logic is needed
- Better performance is desired (modules loaded once at startup)
- Better type safety and IDE support is needed

### When to use dynamic imports:

```typescript
const { ConfigLoader } = await import("@atlas/config");
```

Only use dynamic imports when:

- Breaking circular dependency chains
- Conditional loading based on runtime conditions
- Lazy loading for rarely used code paths
- Loading optional dependencies that might not be installed

**Default to static imports** for cleaner code, better performance, and improved developer
experience.

## TypeScript Type Error Resolution Best Practices

When fixing TypeScript type errors:

1. **Avoid `any` types**: Never use `any` to bypass type errors. Instead:
   - Use `unknown` when the type is truly unknown
   - Use proper type definitions or interfaces
   - Use generic types where appropriate

2. **Avoid `as` type assertions**: Instead of using `as` casts:
   - Use type guards for runtime type checking
   - Use Zod schemas for validation and type inference
   - Let TypeScript infer types where possible

3. **Prefer existing types**: Always check if types already exist in the codebase before creating
   new ones
   - Look for existing interfaces and type definitions
   - Check imported packages for exported types
   - Reuse types from `@atlas/config`, `@atlas/storage`, etc.

4. **Use Zod for API responses**: When handling external data (API responses, JSON parsing):
   ```typescript
   import { z } from "zod/v4";

   const ResponseSchema = z.object({
     field: z.string(),
     count: z.number(),
   });

   const response = await fetch(url);
   const data = await response.json();
   return ResponseSchema.parse(data); // Validates and types the response
   ```

5. **Record types in Zod v4**: When using `z.record()`, always provide both key and value types:
   ```typescript
   // Correct for Zod v4
   z.record(z.string(), z.unknown());

   // Incorrect (will cause type errors)
   z.record(z.unknown());
   ```

6. **Generic type parameters**: When creating reusable functions that work with different types:
   ```typescript
   // Good: Use generics instead of any
   async function fetchData<T>(url: string, schema: z.ZodSchema<T>): Promise<T> {
     const response = await fetch(url);
     const data = await response.json();
     return schema.parse(data);
   }
   ```
