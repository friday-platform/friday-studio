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

## Test Writing Guidelines

When writing tests:

1. **Keep tests simple and focused**: Write concise tests that verify behavior, not implementation
   details
2. **Avoid type checking in tests**: TypeScript already provides compile-time type safety. Don't
   write tests like `assertEquals(typeof json.status, "string")` - instead test actual values and
   behavior
3. **Focus on impactful tests**: Prefer 2-3 meaningful tests over many trivial ones. Good tests
   check:
   - Core functionality works correctly
   - Edge cases are handled properly
   - Integration between components works as expected
4. **Use clear test names**: Test names should describe what behavior is being tested, not how it's
   implemented

## Claude Code execution guidelines

0. **MANDATORY SESSION START**: At the beginning of EVERY session, read and update
   `.DEV_FEEDBACK.md` with any new feedback, complaints, or guidance from the user. This file tracks
   behavioral improvements across sessions. **IMPORTANT**: Summarize feedback in
   SFW/work-appropriate language. 0.5. **PACKAGE DOCUMENTATION**: When working with packages in the
   `packages/` directory, always check for and read package-specific README.md files (e.g.,
   `packages/cron/README.md`). These contain critical architectural context, API documentation, and
   usage guidelines specific to each package that supplement this main CLAUDE.md file. 0.6.
   **FEATURE SPECIFICATIONS**: When working on features or components, check the `specs/` directory
   for feature-specific documents (e.g., `specs/conversation-agent.md`). These contain guiding
   principles, design intent, and implementation requirements that define how features should
   behave.
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
12. **NEVER USE CONSOLE.LOG**: Console.log statements do not work in this environment and are not
    visible. NEVER add console.log, console.error, console.warn, or any console methods for
    debugging. Use other debugging strategies instead.
13. **Clean up test files**: Always clean up test files created during debugging or development.
    Remove any test-_.ts, test-_.sh, or other temporary test files before completing a task. Use
    `rm -f test-*` to clean up test files.

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

### Workspace Management

The WorkspaceManager has been refactored for simplicity:

- **`@atlas/core` package**: Contains the new WorkspaceManager
- **System Workspaces**: Built-in workspaces (like atlas-conversation) are embedded at build time
- **Unified API**: Single `find()` method replaces findById, findByName, findByPath
- **Type Safety**: All workspace types defined in `@atlas/core/types/workspace.ts`

**Key patterns**:

```typescript
// Import from @atlas/core package
import { WorkspaceManager } from "@atlas/core";

// Use unified find() method
const workspace = await manager.find({ id: "workspace-id" });
const workspace = await manager.find({ name: "My Workspace" });
const workspace = await manager.find({ path: "/path/to/workspace" });

// List workspaces (excludes system workspaces by default)
const userWorkspaces = await manager.list();
const allWorkspaces = await manager.list({ includeSystem: true });
```

**System Workspaces**:

- Defined as YAML files in `packages/system/workspaces/`
- Embedded at build time using Deno's text imports
- Identified by `metadata.system = true` and `system://` path prefix
- Cannot be deleted without force option

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

**STRONGLY PREFER static imports** (at the top of modules). Dynamic imports should be **AVOIDED** in
this codebase.

### Always use static imports:

```typescript
import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { load } from "@std/dotenv";
import { join } from "@std/path";
```

**Benefits of static imports:**

- Better performance (modules loaded once at startup)
- Superior type safety and IDE support
- Cleaner, more maintainable code
- Easier dependency tracking
- Better tree-shaking and bundle optimization

### When dynamic imports are absolutely necessary:

Dynamic imports (`await import()`) should **ONLY** be used in these rare cases:

1. **Breaking circular dependencies** (but prefer restructuring code instead)
2. **Loading optional plugins** that may not be installed
3. **True conditional loading** based on runtime configuration

**IMPORTANT**: If you find yourself using dynamic imports, first consider whether the code can be
restructured to avoid them. In 99% of cases, static imports are the correct choice.

Example of converting dynamic to static:

```typescript
// ❌ AVOID - Dynamic import
const { ConfigLoader } = await import("@atlas/config");

// ✅ PREFERRED - Static import at top of file
import { ConfigLoader } from "@atlas/config";
```

**Default to static imports** for cleaner code, better performance, and improved developer
experience. Dynamic imports should be considered a code smell in this codebase.

### Avoid Barrel Imports

**IMPORTANT**: Avoid using barrel imports (index.ts files that re-export other modules) in favor of
direct imports from specific files:

```typescript
// ❌ Avoid barrel imports
import { Component, SomeUtility } from "./components/index.ts";

// ✅ Prefer direct imports
import { Component } from "./components/component.tsx";
import { SomeUtility } from "./utils/some-utility.ts";
```

**Why avoid barrel imports:**

- **Bundle size**: Can lead to importing unused code
- **Circular dependencies**: Makes dependency graphs harder to reason about
- **Build performance**: Can slow down bundling and tree-shaking
- **IDE performance**: Can cause slower autocomplete and navigation
- **Debugging**: Makes it harder to trace where code actually comes from

**Exception**: Only use barrel imports for external package entry points or when creating a clean
public API for packages intended for external consumption.

### Avoid prefixed Imports

#### Avoid npm: prefixed imports

**IMPORTANT**: Avoid adding imports from packages using the `npm:` prefix. Instead, check if the
package is already in `deno.json`, otherwise add the package via `deno add npm:{{package_name}}` and
import it without the `npm:` prefix in the file where it's used:

```typescript
// ❌ Avoid prefixed imports
import { dependency } from "npm:package_name";

// ✅ Prefer non-prefixed imports
import { dependency } from "package_name";
```

#### Avoid jsr: prefixed imports

**IMPORTANT**: Avoid adding imports from packages using the `jsr:` prefix. Instead, check if the
package is already in `deno.json`, otherwise add the package via `deno add jsr:{{package_name}}` and
import it without the `jsr:` prefix in the file where it's used:

```typescript
// ❌ Avoid prefixed imports
import { dependency } from "jsr:package_name";

// ✅ Prefer non-prefixed imports
import { dependency } from "package_name";
```

#### Avoid url imports

**IMPORTANT**: Avoid adding imports directly from `http://` or `https://` sources. Instead, check if
the package is already in `deno.json`, otherwise add the package via `deno add {{package_name}}` and
import it directly

```typescript
// ❌ Avoid prefixed imports
import { dependency } from "https//deno.land/package_name";

// ✅ Prefer non-prefixed imports
import { dependency } from "package_name";
```

**Why avoid prefixed imports:**

- It can create inaccurate dependency tree graphs in the `deno.lock` file
- It can cause multiple versions of a dependency to be used in the same codebase

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
   async function fetchData<T>(
     url: string,
     schema: z.ZodSchema<T>,
   ): Promise<T> {
     const response = await fetch(url);
     const data = await response.json();
     return schema.parse(data);
   }
   ```
