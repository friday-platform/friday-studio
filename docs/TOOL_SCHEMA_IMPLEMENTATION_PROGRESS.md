# Tool Schema Architecture Implementation Progress

## Overview

This document provides step-by-step engineering tasks to complete the tool schema architecture
migration. Each task is specific, actionable, and can be completed independently. The goal is to
standardize tool handling across the Atlas codebase by having all capabilities directly return AI
SDK `Tool` objects.

## Implementation Status Summary

- **Overall Progress**: ~85% Complete
- **Daemon Capabilities**: ✅ Fully Converted (2 capabilities)
- **Workspace Capabilities**: ✅ Fully Converted (21 capabilities)
- **LLM Provider**: ✅ Simplified
- **ConversationAgent**: ✅ Fully Updated
- **Legacy Code Removal**: ✅ Completed (4 files removed)

## Step-by-Step Engineering Tasks

### Phase 1: Convert Workspace Capabilities ✅ COMPLETED

All workspace capabilities in `src/core/workspace-capabilities.ts` have been successfully converted
to implement the `toTool()` method.

#### Task 1.1: Convert `workspace_draft_create`

**File**: `src/core/workspace-capabilities.ts` **Lines**: Find the `workspace_draft_create`
capability definition **Steps**:

1. Add import at top of file: `import { type Tool } from "ai";`
2. Remove the `inputSchema` and `implementation` properties
3. Add `toTool: (context: AgentExecutionContext): Tool => { ... }` with explicit return type
4. Move parameter schema to `parameters: z.object({ name: z.string().describe("..."), ... })`
5. Move implementation logic into `execute: async (args) => { ... }`
6. Use context closure instead of passing context as parameter
7. Run `deno check src/core/workspace-capabilities.ts` - fix any type errors without using `as` or
   `any`
8. Run `deno lint src/core/workspace-capabilities.ts` - fix any linting issues

**Before:**

```typescript
{
  id: "workspace_draft_create",
  name: "Create Draft Workspace",
  description: "Create a new draft workspace configuration",
  category: "workspace",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the workspace" },
      description: { type: "string", description: "Description of the workspace" },
      initialConfig: { type: "object", description: "Initial workspace configuration" }
    },
    required: ["name", "description"]
  },
  implementation: async (context: AgentExecutionContext, name: string, description: string, initialConfig?: any) => {
    const draftStore = context.services?.draftStore;
    if (!draftStore) {
      throw new Error("Draft store not available");
    }
    const draft = await draftStore.createDraft({
      name,
      description,
      config: initialConfig || {},
      createdBy: context.agentId
    });
    return { draftId: draft.id, name: draft.name };
  }
}
```

**After:**

```typescript
{
  id: "workspace_draft_create",
  name: "Create Draft Workspace",
  description: "Create a new draft workspace configuration",
  category: "workspace",
  toTool: (context: AgentExecutionContext): Tool => {
    return {
      description: "Create a new draft workspace configuration",
      parameters: z.object({
        name: z.string().describe("Name of the workspace"),
        description: z.string().describe("Description of the workspace"),
        initialConfig: z.record(z.string(), z.unknown()).optional().describe("Initial workspace configuration")
      }),
      execute: async (args) => {
        const { name, description, initialConfig } = args;
        const draftStore = context.services?.draftStore;
        if (!draftStore) {
          throw new Error("Draft store not available");
        }
        const draft = await draftStore.createDraft({
          name,
          description,
          config: initialConfig || {},
          createdBy: context.agentId
        });
        return { draftId: draft.id, name: draft.name };
      }
    };
  }
}
```

#### Task 1.2: Convert `workspace_draft_update`

**File**: `src/core/workspace-capabilities.ts` **Special Note**: This capability had special
handling in LLM Provider - ensure the new implementation works with Gemini **Steps**:

1. Ensure Tool import exists at top of file
2. Follow same pattern as Task 1.1 with explicit `: Tool` return type
3. Ensure `updates` parameter uses `z.record(z.string(), z.unknown())`
4. Test with Gemini provider after conversion
5. Run `deno check src/core/workspace-capabilities.ts` after changes
6. Run `deno lint src/core/workspace-capabilities.ts` after changes

#### Task 1.3: Convert `validate_draft_config`

**File**: `src/core/workspace-capabilities.ts` **Steps**:

1. Same as Task 1.1 (including explicit `: Tool` return type)
2. Run `deno check` and `deno lint` after changes

#### Task 1.4: Convert `pre_publish_check`

**File**: `src/core/workspace-capabilities.ts` **Steps**:

1. Same as Task 1.1 (including explicit `: Tool` return type)
2. Run `deno check` and `deno lint` after changes

#### Task 1.5: Convert `show_draft_config`

**File**: `src/core/workspace-capabilities.ts` **Steps**:

1. Same as Task 1.1 (including explicit `: Tool` return type)
2. Run `deno check` and `deno lint` after changes

#### Task 1.6: Convert `list_session_drafts`

**File**: `src/core/workspace-capabilities.ts` **Steps**:

1. Same as Task 1.1 (including explicit `: Tool` return type)
2. Note: this capability takes no parameters - use empty `z.object({})`
3. Run `deno check` and `deno lint` after changes

#### Task 1.7: Convert `publish_workspace`

**File**: `src/core/workspace-capabilities.ts` **Steps**:

1. Same as Task 1.1 (including explicit `: Tool` return type)
2. Run `deno check` and `deno lint` after changes

#### Task 1.8: Convert `library_list`

**File**: `src/core/workspace-capabilities.ts` **Steps**:

1. Same as Task 1.1 (including explicit `: Tool` return type)
2. Run `deno check` and `deno lint` after changes

#### Task 1.9: Convert `library_get`

**File**: `src/core/workspace-capabilities.ts` **Steps**:

1. Same as Task 1.1 (including explicit `: Tool` return type)
2. Run `deno check` and `deno lint` after changes

#### Task 1.10: Convert `library_search`

**File**: `src/core/workspace-capabilities.ts` **Steps**:

1. Same as Task 1.1 (including explicit `: Tool` return type)
2. Run `deno check` and `deno lint` after changes

#### Task 1.11: Convert `workspace_jobs_list`

**File**: `src/core/workspace-capabilities.ts` **Steps**:

1. Same as Task 1.1 (including explicit `: Tool` return type)
2. Run `deno check` and `deno lint` after changes

#### Task 1.12: Convert `workspace_jobs_describe`

**File**: `src/core/workspace-capabilities.ts` **Steps**:

1. Same as Task 1.1 (including explicit `: Tool` return type)
2. Run `deno check` and `deno lint` after changes

#### Task 1.13: Convert `workspace_sessions_list`

**File**: `src/core/workspace-capabilities.ts` **Steps**:

1. Same as Task 1.1 (including explicit `: Tool` return type)
2. Run `deno check` and `deno lint` after changes

#### Task 1.14: Convert `workspace_sessions_describe`

**File**: `src/core/workspace-capabilities.ts` **Steps**:

1. Same as Task 1.1 (including explicit `: Tool` return type)
2. Run `deno check` and `deno lint` after changes

### Phase 2: Complete ConversationAgent Migration (3 tasks)

#### Task 2.1: Update workspace capability handling in `getDaemonCapabilityTools()`

**File**: `packages/system/agents/conversation-agent.ts` **Lines**: Around line 140-150 (look for
`// TODO: Use workspaceCapability.toTool(workspaceContext)`) **Steps**:

1. Replace the TODO with: `tools[toolName] = workspaceCapability.toTool(workspaceContext);`
2. Remove any old conversion logic for workspace capabilities

#### Task 2.2: Remove `zodSchemaToJsonSchema()` method

**File**: `packages/system/agents/conversation-agent.ts` **Steps**:

1. Find and delete the entire `zodSchemaToJsonSchema()` method
2. Remove any imports related to this method
3. Ensure no references remain

#### Task 2.3: Clean up old parameter mapping logic

**File**: `packages/system/agents/conversation-agent.ts` **Steps**:

1. Remove the large if/else block that handles individual workspace capabilities
2. Remove special handling for `publish_workspace`, `workspace_draft_create`, etc.
3. Ensure all capabilities use the unified `toTool()` approach

### Phase 3: Remove Legacy Code (4 tasks)

#### Task 3.1: Delete capability-to-tool adapter

**File**: `src/core/utils/capability-to-tool.ts` **Steps**:

1. Check for any imports of this file
2. Delete the entire file
3. Remove from any export statements

#### Task 3.2: Remove temporary conversion scripts

**Files**:

- `comprehensive-capability-update.ts`
- `convert-remaining-capabilities.ts`
- `final-capability-conversion.ts`
- `update-capabilities.ts` **Steps**:

1. Delete all four files from the root directory
2. These were temporary scripts and are no longer needed

#### Task 3.3: Clean up LLM Provider imports

**File**: `packages/core/src/llm-provider.ts` **Steps**:

1. Remove `jsonSchema` import from "ai" package
2. Remove any other unused imports
3. Run `deno lint --fix` to clean up

#### Task 3.4: Update type exports

**File**: `src/core/workspace-capabilities.ts` **Steps**:

1. Remove old input/output type exports for each capability
2. Ensure only the capability registry and types are exported

### Phase 4: Testing and Validation (5 tasks)

#### Task 4.1: Add workspace capability tests

**File**: Create `integration-tests/workspace-capabilities-tool-integration.test.ts` **Steps**:

1. Copy the pattern from `llm-provider-tool-integration.test.ts`
2. Test at least 3 workspace capabilities
3. Verify toTool() produces valid AI SDK Tools

#### Task 4.2: Update existing ConversationAgent tests

**File**: Find ConversationAgent test files **Steps**:

1. Update tests to use new capability pattern
2. Remove tests for old conversion logic
3. Add tests for unified tool handling

#### Task 4.3: Run full integration test suite

**Command**: `deno test integration-tests/` **Steps**:

1. Fix any failing tests
2. Document any behavioral changes

#### Task 4.4: Manual testing with real LLM

**Steps**:

1. Start the Atlas daemon
2. Test conversation agent with workspace capabilities
3. Verify tools execute correctly
4. Test with different LLM providers (especially Gemini)

#### Task 4.5: Update documentation

**Files**:

- `CLAUDE.md`
- Any other relevant docs **Steps**:

1. Update capability documentation
2. Remove references to old patterns
3. Add migration guide if needed

### Phase 5: Final Cleanup (2 tasks)

#### Task 5.1: Run linting and formatting

**Commands**:

```bash
deno lint --fix
deno fmt
```

**Steps**:

1. Fix any linting errors
2. Ensure consistent formatting

#### Task 5.2: Create PR and migration notes

**Steps**:

1. Create comprehensive PR description
2. List all breaking changes
3. Provide migration examples
4. Tag relevant reviewers

## Completed Implementation Details

### ✅ Successfully Implemented

#### 1. Updated Capability Interfaces

Both capability interfaces have been updated to include the `toTool` method:

```typescript
// DaemonCapability interface
export interface DaemonCapability {
  id: string;
  name: string;
  description: string;
  category: "streaming" | "system" | "management";
  // Direct AI SDK Tool factory method - follows MCP pattern
  toTool: (context: DaemonExecutionContext) => import("ai").Tool;
}

// WorkspaceCapability interface
export interface WorkspaceCapability {
  id: string;
  name: string;
  description: string;
  category: "jobs" | "sessions" | "memory" | "signals" | "workspace";
  // Direct AI SDK Tool factory method - follows MCP pattern
  toTool: (context: AgentExecutionContext) => import("ai").Tool;
}
```

#### 2. Daemon Capabilities Conversion

Successfully converted daemon capabilities to the new pattern:

- **stream_reply**: Fully implemented with proper Zod schema and context closure
- **conversation_storage**: Fully implemented with action-based parameters

Example implementation:

```typescript
toTool: ((context: DaemonExecutionContext) => {
  return {
    description: "Send a streaming reply to a stream via SSE",
    parameters: z.object({
      stream_id: z.string().min(1).describe("Stream ID for the reply"),
      message: z.string().min(1).describe("Message content to stream"),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional metadata"),
      conversationId: z
        .string()
        .optional()
        .describe("Optional conversation ID"),
    }),
    execute: async (args) => {
      const { stream_id, message, metadata, conversationId } = args;
      await context.streams.send(stream_id, {
        type: "message",
        content: message,
        metadata,
        conversationId: conversationId || context.conversationId,
      });
      return { success: true, stream_id };
    },
  };
});
```

#### 3. LLM Provider Simplification

The `prepareTools()` method has been dramatically simplified:

**Before**: Complex conditional logic with symbol checking and special cases **After**: Simple tool
aggregation

```typescript
private static async prepareTools(context: {
  tools?: Record<string, Tool>;
  mcpServers?: string[];
}): Promise<Record<string, Tool>> {
  const allTools: Record<string, Tool> = {};

  // All tools are already AI SDK Tools - no conversion needed
  if (context.tools) {
    Object.assign(allTools, context.tools);
  }

  // MCP tools already return AI SDK Tools
  if (context.mcpServers?.length > 0) {
    const mcpTools = await this.mcpManager.getToolsForServers(context.mcpServers);
    Object.assign(allTools, mcpTools);
  }

  return allTools;
}
```

#### 4. Helper Infrastructure

Added `createStreamsImplementation()` helper to provide stream functionality for daemon context:

- Handles SSE event emission
- Provides word-by-word streaming for realistic typing feel
- Manages message completion events

#### 5. Integration Test Suite

Created comprehensive integration tests in
`integration-tests/llm-provider-tool-integration.test.ts`:

- Tests daemon capability tool conversion
- Validates toTool() method produces proper AI SDK Tools
- Tests tool execution with new pattern
- Created MCP test utilities (though SSE transport has compatibility issues)

#### 6. Workspace Capabilities Conversion (Phase 1 Complete)

Successfully converted all 21 workspace capabilities to the new pattern:

**Key Implementation Details:**

- Added `import { type Tool } from "ai";` to workspace-capabilities.ts
- Converted all capabilities to use `toTool(context: AgentExecutionContext): Tool` pattern
- Replaced JSON Schema with Zod schemas using `.describe()` on each field
- Updated `executeCapability` method with temporary compatibility layer
- Fixed type checking issues related to daemon capability filtering

**Capabilities Converted:**

1. **Draft Management**: `workspace_draft_create`, `workspace_draft_update`,
   `validate_draft_config`, `pre_publish_check`, `show_draft_config`, `list_session_drafts`,
   `publish_workspace`
2. **Library Access**: `library_list`, `library_get`, `library_search`
3. **Jobs Management**: `workspace_jobs_list`, `workspace_jobs_describe`, `workspace_jobs_trigger`
4. **Sessions Management**: `workspace_sessions_list`, `workspace_sessions_describe`,
   `workspace_sessions_cancel`
5. **Memory Operations**: `workspace_memory_recall`, `workspace_memory_store`
6. **Signals Management**: `workspace_signals_list`, `workspace_signals_trigger`
7. **Workspace Info**: `workspace_describe`

**Type Safety Improvements:**

- All capabilities now use explicit `: Tool` return type
- Replaced `any` types with `unknown` where appropriate
- Proper Zod schema validation for all parameters
- Context passed via closure instead of parameters

### ✅ Successfully Implemented - ConversationAgent Updates

The ConversationAgent has been fully updated:

- ✅ Uses `capability.toTool(context)` for daemon capabilities
- ✅ Creates proper execution context
- ✅ All old conversion logic removed
- ✅ Workspace capability handling complete

Current implementation:

```typescript
// Daemon capabilities
if (capability) {
  tools[capability.id] = capability.toTool(daemonContext);
  continue;
}

// Workspace capabilities fully implemented
const workspaceCapability = WorkspaceCapabilityRegistry.getCapability(toolName);
if (workspaceCapability) {
  const workspaceContext: AgentExecutionContext = {
    workspaceId: "atlas-conversation",
    sessionId: streamId || this.id,
    agentId: this.id,
    conversationId: streamId || this.id,
  };
  tools[workspaceCapability.id] = workspaceCapability.toTool(workspaceContext);
}
```

## Task Tracking Checklist

### Phase 1: Workspace Capabilities ✅ COMPLETED

- [x] Task 1.1: Convert `workspace_draft_create`
- [x] Task 1.2: Convert `workspace_draft_update` (special Gemini handling)
- [x] Task 1.3: Convert `validate_draft_config`
- [x] Task 1.4: Convert `pre_publish_check`
- [x] Task 1.5: Convert `show_draft_config`
- [x] Task 1.6: Convert `list_session_drafts`
- [x] Task 1.7: Convert `publish_workspace`
- [x] Task 1.8: Convert `library_list`
- [x] Task 1.9: Convert `library_get`
- [x] Task 1.10: Convert `library_search`
- [x] Task 1.11: Convert `workspace_jobs_list`
- [x] Task 1.12: Convert `workspace_jobs_describe`
- [x] Task 1.13: Convert `workspace_sessions_list`
- [x] Task 1.14: Convert `workspace_sessions_describe`

#### Additional Capabilities Converted

- [x] `workspace_jobs_trigger`
- [x] `workspace_sessions_cancel`
- [x] `workspace_memory_recall`
- [x] `workspace_memory_store`
- [x] `workspace_signals_list`
- [x] `workspace_signals_trigger`
- [x] `workspace_describe`

### Phase 2: ConversationAgent ✅ COMPLETED

- [x] Task 2.1: Update workspace capability handling
- [x] Task 2.2: Remove `zodSchemaToJsonSchema()` method
- [x] Task 2.3: Clean up old parameter mapping logic

### Phase 3: Legacy Code Removal ✅ COMPLETED

- [x] Task 3.1: Delete capability-to-tool adapter
- [x] Task 3.2: Remove temporary conversion scripts
- [x] Task 3.3: Clean up LLM Provider imports
- [x] Task 3.4: Update type exports

### Phase 4: Testing

- [ ] Task 4.1: Add workspace capability tests
- [ ] Task 4.2: Update existing ConversationAgent tests
- [ ] Task 4.3: Run full integration test suite
- [ ] Task 4.4: Manual testing with real LLM
- [ ] Task 4.5: Update documentation

### Phase 5: Final Cleanup

- [ ] Task 5.1: Run linting and formatting
- [ ] Task 5.2: Create PR and migration notes

## Important Notes for All Tasks

### Required Imports

Ensure these imports are at the top of the files you're modifying:

```typescript
import { type Tool } from "ai";
import { z } from "zod/v4";
```

### Type Safety Rules

1. **Always use explicit return type**: `toTool: (context: AgentExecutionContext): Tool => { ... }`
2. **No `any` types**: Replace with `unknown` or proper types
3. **No `as` casts**: Use proper type definitions or type guards
4. **Run validation after each change**:
   ```bash
   deno check src/core/workspace-capabilities.ts
   deno lint src/core/workspace-capabilities.ts
   ```

## Example Pattern for Workspace Capability Conversion

Here's the exact pattern to follow when converting workspace capabilities:

### Before (Old Pattern):

```typescript
const workspaceDraftCreateCapability: WorkspaceCapability = {
  id: "workspace_draft_create",
  name: "Create Draft Workspace",
  description: "Create a new draft workspace configuration",
  category: "workspace",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the workspace" },
      description: {
        type: "string",
        description: "Description of the workspace",
      },
      initialConfig: { type: "object", description: "Initial configuration" },
    },
    required: ["name", "description"],
  },
  implementation: async (
    context: AgentExecutionContext,
    name: string,
    description: string,
    initialConfig?: any,
  ) => {
    // Implementation logic here
    return result;
  },
};
```

### After (New Pattern):

```typescript
// At top of file:
import { type Tool } from "ai";
import { z } from "zod/v4";

const workspaceDraftCreateCapability: WorkspaceCapability = {
  id: "workspace_draft_create",
  name: "Create Draft Workspace",
  description: "Create a new draft workspace configuration",
  category: "workspace",
  toTool: (context: AgentExecutionContext): Tool => {
    // Note explicit `: Tool` return type
    return {
      description: "Create a new draft workspace configuration",
      parameters: z.object({
        name: z.string().describe("Name of the workspace"),
        description: z.string().describe("Description of the workspace"),
        initialConfig: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Initial configuration"),
      }),
      execute: async (args) => {
        const { name, description, initialConfig } = args;
        // Same implementation logic here, but using args instead of parameters
        // Use context from closure instead of passing it
        return result;
      },
    };
  },
};
```

## Time Estimates

- **Phase 1**: 4-6 hours (20-30 minutes per capability)
- **Phase 2**: 1-2 hours
- **Phase 3**: 1 hour
- **Phase 4**: 2-3 hours
- **Phase 5**: 30 minutes

**Total Estimated Time**: 8-12 hours

## Validation Checklist

### After Each File Change

- [ ] `deno check <file>` passes without type errors
- [ ] `deno lint <file>` passes without lint errors
- [ ] No `any` types used
- [ ] No `as` type assertions used
- [ ] Explicit `: Tool` return type on all `toTool` methods

### After Completing All Tasks

- [x] Run `deno check src/core/workspace-capabilities.ts` - should pass (workspace-capabilities.ts
      passes, other files have unrelated errors)
- [ ] Run `deno check packages/system/agents/conversation-agent.ts` - should pass
- [ ] Run `deno test integration-tests/` - all tests should pass
- [ ] Start daemon and test conversation agent - tools should work
- [ ] No references to old patterns remain in codebase
- [ ] All temporary conversion scripts deleted

## Remaining Work Summary

With Phases 1, 2, and 3 complete, the following work remains:

1. **Phase 4: Testing and Validation** (~2-3 hours)
   - Add workspace capability integration tests
   - Update ConversationAgent tests
   - Run full test suite
   - Manual testing with real LLM providers
   - Update documentation

2. **Phase 5: Final Cleanup** (~30 minutes)
   - Run linting and formatting
   - Create PR and migration documentation

**Total Remaining Time**: ~2.5-3.5 hours
