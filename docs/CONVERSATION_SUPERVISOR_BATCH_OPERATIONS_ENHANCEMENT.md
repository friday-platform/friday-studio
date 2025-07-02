# Conversation Supervisor Batch Operations Enhancement Plan

## Problem Statement

The current conversation supervisor implementation forces sequential tool calls even when users
provide comprehensive workspace descriptions. This leads to inefficient interactions where a single
user request results in 4+ sequential tool calls.

### Current Flow Example

User: "I want to create a new workspace. I want it to play the game of telephone with 3 members. The
first slightly mishears the users message, the second embellishes it, and the third turns the
embellished message into a haiku."

Results in:

1. `workspace_draft_create` - Creates empty draft
2. `update_workspace_config` - Add first agent (operation: "add_agent")
3. `update_workspace_config` - Add second agent (operation: "add_agent")
4. `update_workspace_config` - Add third agent (operation: "add_agent")
5. `update_workspace_config` - Add job (operation: "add_job")
6. `update_workspace_config` - Set trigger (operation: "set_trigger")
7. `publish_workspace` - Publish

## Proposed Solution

Simplify to just three tools that leverage the LLM's capabilities to build and modify configurations
directly, reducing most workspace creation to 2 tool calls.

### Enhanced Flow Example

Same user request results in:

1. `workspace_draft_create` - Creates draft with complete initial configuration
2. `publish_workspace` - Publish

## Implementation Design

### 1. Enhanced Draft Creation Tool

Enhance `workspace_draft_create` to accept optional initial configuration using the existing
WorkspaceConfig type:

```typescript
workspace_draft_create: {
  description: "Create a new workspace draft with optional initial configuration",
  parameters: {
    name: string;
    description: string;
    initialConfig?: Partial<WorkspaceConfig>; // Uses existing type from @atlas/config
  }
}
```

### 2. Direct Configuration Update Tool

Replace all specific operations (add_agent, update_agent, etc.) with a single flexible update tool:

```typescript
workspace_draft_update: {
  description: "Update the draft workspace configuration based on user feedback",
  parameters: {
    draftId: string;
    updates: Partial<WorkspaceConfig>; // Direct config updates
    updateDescription: string; // Natural language description of what changed
  }
}
```

### 3. Keep Existing Tools

- `show_draft_config` - Display current configuration
- `publish_workspace` - Publish draft to filesystem
- `list_session_drafts` - List all drafts
- `validate_draft_config` - Validate configuration

## Enhanced Conversation Supervisor Prompt

Update the system prompt to include the workspace template and leverage LLM capabilities:

```typescript
const ENHANCED_SYSTEM_PROMPT = `
You are Addy, the Atlas AI assistant specialized in creating sophisticated multi-agent workspaces.

## WORKSPACE CREATION EFFICIENCY

When a user describes a workspace, analyze their request and create as complete a configuration as possible in the initial draft.

### Workspace Configuration Template
Here's the structure of a workspace configuration to guide your creation:

\`\`\`yaml
version: "1.0"

workspace:
  name: "workspace-name"
  description: "Clear description of purpose"

signals:
  my-signal:
    description: "How this workspace is triggered"
    provider: "cli"  # or "http", "schedule"

jobs:
  main-job:
    name: "main-job"
    description: "What this job accomplishes"
    triggers:
      - signal: "my-signal"
    execution:
      strategy: "sequential"  # or "parallel"
      agents:
        - id: "agent-1"
          input_source: "signal"  # First agent gets signal
        - id: "agent-2"  
          input_source: "previous"  # Subsequent agents get previous output

agents:
  agent-1:
    type: "llm"
    model: "claude-3-5-haiku-20241022"  # or claude-3-5-sonnet-20241022
    purpose: "What this agent does"
    system_prompt: |
      Detailed instructions for the agent's behavior
  
  agent-2:
    type: "llm"
    model: "claude-3-5-haiku-20241022"
    purpose: "What this agent does"
    system_prompt: |
      Detailed instructions for this agent

# Optional: MCP tools
tools:
  mcp:
    servers:
      filesystem:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-filesystem"]
\`\`\`

### Decision Framework

1. **Complete Request Analysis**
   When user provides specific details about agents and workflow:
   - Create all agents with appropriate purposes and prompts
   - Set up job with correct execution strategy
   - Configure signal and triggers
   - Include everything in initialConfig of workspace_draft_create

2. **Partial Request Handling**
   When user provides general idea but missing specifics:
   - Create what you can infer
   - Ask ONE clarifying question
   - Use workspace_draft_update to add details after response

3. **Configuration Building Guidelines**
   - Agent names should be descriptive (e.g., "mishear-agent", "embellish-agent")
   - Signal names follow pattern: "{workspace-name}-trigger"
   - Job names follow pattern: "{workspace-name}-process"
   - Always include system prompts that clearly define agent behavior
   - Default to "sequential" execution for pipeline-like workflows
   - Default to "parallel" execution for analysis/ensemble workflows

### Example: Complete Telephone Game Creation

User: "Create a telephone game workspace with 3 agents that mishear, embellish, and create haikus"

Your workspace_draft_create call:
{
  name: "telephone-game",
  description: "A game of telephone where messages are transformed through mishearing, embellishment, and haiku creation",
  initialConfig: {
    version: "1.0",
    workspace: {
      name: "telephone-game",
      description: "A game of telephone where messages are transformed through mishearing, embellishment, and haiku creation"
    },
    signals: {
      "telephone-game-trigger": {
        description: "Start the telephone game with a message",
        provider: "cli"
      }
    },
    agents: {
      "mishear-agent": {
        type: "llm",
        model: "claude-3-5-haiku-20241022",
        purpose: "Slightly mishears and garbles the incoming message",
        system_prompt: "You are playing telephone and have slightly misheard the message. Introduce small, humorous errors like mishearing similar-sounding words, dropping articles, or slightly changing phrases. Keep the general structure but make it sound like you didn't quite catch everything correctly."
      },
      "embellish-agent": {
        type: "llm", 
        model: "claude-3-5-haiku-20241022",
        purpose: "Embellishes and exaggerates the misheard message",
        system_prompt: "You love to embellish stories. Take the message you received and make it more dramatic, add colorful details, use superlatives, and generally make it sound more exciting than it was. Don't change the core story, just make it more theatrical."
      },
      "haiku-agent": {
        type: "llm",
        model: "claude-3-5-haiku-20241022", 
        purpose: "Transforms the embellished message into a haiku",
        system_prompt: "You are a haiku poet. Take the message you received and distill its essence into a traditional haiku (5-7-5 syllables). Capture the key imagery or emotion from the embellished story."
      }
    },
    jobs: {
      "telephone-game-process": {
        name: "telephone-game-process",
        description: "Run messages through the telephone game transformation",
        triggers: [{ signal: "telephone-game-trigger" }],
        execution: {
          strategy: "sequential",
          agents: [
            { id: "mishear-agent", input_source: "signal" },
            { id: "embellish-agent", input_source: "previous" },
            { id: "haiku-agent", input_source: "previous" }
          ]
        }
      }
    }
  }
}

## Workspace Update Guidelines

When users request changes, use workspace_draft_update with direct configuration updates:

Example: "Add an error handler agent"

Your workspace_draft_update call:
{
  draftId: "...",
  updates: {
    agents: {
      ...existingAgents,  // LLM understands to preserve existing
      "error-handler": {
        type: "llm",
        model: "claude-3-5-haiku-20241022",
        purpose: "Handle and log errors gracefully",
        system_prompt: "When you receive an error, log it clearly and provide helpful context."
      }
    }
  },
  updateDescription: "Added error-handler agent to handle errors gracefully"
}

## IMPORTANT: Minimize Tool Calls

- IDEAL: 2 calls (create with full config, publish)
- ACCEPTABLE: 3-4 calls for complex iterations
- AVOID: 5+ sequential calls

Always err on the side of creating more complete configurations upfront based on reasonable interpretations of user intent.
`;
```

## Implementation Changes

### 1. Update WorkspaceDraftStore

```typescript
import type { WorkspaceConfig } from "@atlas/config";

export class WorkspaceDraftStore {
  async createDraft(params: {
    name: string;
    description: string;
    sessionId: string;
    userId: string;
    initialConfig?: Partial<WorkspaceConfig>; // NEW: Accept initial config
  }): Promise<WorkspaceDraft> {
    // Start with minimal base config
    const baseConfig: Partial<WorkspaceConfig> = {
      version: "1.0",
      workspace: {
        name: params.name,
        description: params.description,
      },
    };

    // Merge with provided initial config if any
    const config = params.initialConfig
      ? this.deepMerge(baseConfig, params.initialConfig)
      : baseConfig;

    const draft: WorkspaceDraft = {
      id: crypto.randomUUID(),
      name: params.name,
      description: params.description,
      config,
      iterations: params.initialConfig
        ? [{
          timestamp: new Date().toISOString(),
          operation: "initial_config",
          config: params.initialConfig,
          summary: "Created with initial configuration",
        }]
        : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "draft",
      sessionId: params.sessionId,
      userId: params.userId,
    };

    const key = ["workspace_drafts", draft.id];
    await this.kv.set(key, draft);

    // Index by session
    const sessionKey = ["workspace_drafts_by_session", params.sessionId, draft.id];
    await this.kv.set(sessionKey, draft.id);

    return draft;
  }

  async updateDraft(
    draftId: string,
    updates: Partial<WorkspaceConfig>,
    updateDescription: string,
  ): Promise<WorkspaceDraft> {
    const key = ["workspace_drafts", draftId];
    const entry = await this.kv.get<WorkspaceDraft>(key);

    if (!entry.value) {
      throw new Error(`Draft ${draftId} not found`);
    }

    const draft = entry.value;

    // Deep merge the updates into existing config
    draft.config = this.deepMerge(draft.config, updates);

    // Add to iteration history
    draft.iterations.push({
      timestamp: new Date().toISOString(),
      operation: "update_config",
      config: updates,
      summary: updateDescription,
    });

    draft.updatedAt = new Date().toISOString();
    await this.kv.set(key, draft);
    return draft;
  }

  private deepMerge(
    target: Partial<WorkspaceConfig>,
    source: Partial<WorkspaceConfig>,
  ): Partial<WorkspaceConfig> {
    const result = { ...target };

    for (const key in source) {
      const sourceValue = source[key as keyof WorkspaceConfig];
      const targetValue = target[key as keyof WorkspaceConfig];

      if (
        sourceValue &&
        typeof sourceValue === "object" &&
        !Array.isArray(sourceValue) &&
        targetValue &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        // Recursively merge objects
        result[key as keyof WorkspaceConfig] = {
          ...targetValue,
          ...sourceValue,
        } as any;
      } else {
        // Direct assignment for primitives and arrays
        result[key as keyof WorkspaceConfig] = sourceValue;
      }
    }

    return result;
  }

  // Remove the old applyOperation method and operation-specific logic
}
```

### 2. Update Conversation Supervisor Tools

```typescript
import { WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";
import { jsonSchema } from "ai";
import { z } from "zod/v4";

// Simplified tools focusing on direct config manipulation
const createCxTools = (sessionId: string): Record<string, Tool> => ({
  // ... existing cx_reply tool ...

  workspace_draft_create: {
    description: "Create a new workspace draft with optional initial configuration",
    parameters: jsonSchema({
      type: "object",
      properties: {
        name: {
          type: "string",
          pattern: "^[a-zA-Z][a-zA-Z0-9_-]*$",
          description: "Workspace name (lowercase with hyphens, no dots)",
        },
        description: {
          type: "string",
          description: "Clear description of the workspace's purpose",
        },
        initialConfig: {
          type: "object",
          description:
            "Optional initial workspace configuration following the WorkspaceConfig schema",
        },
      },
      required: ["name", "description"],
      additionalProperties: false,
    }),
    execute: async ({ name, description, initialConfig }) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: workspace_draft_create called", {
        name,
        description,
        hasInitialConfig: !!initialConfig,
      });

      try {
        const adapter = await getDraftStorageAdapter();
        const draft = await adapter.createDraft({
          name,
          description,
          sessionId,
          userId: "system",
          initialConfig,
        });

        // Validate if initial config was provided
        let validationStatus = { valid: true, errors: [] };
        if (initialConfig) {
          validationStatus = await validateDraftConfig(draft.config);
        }

        return {
          success: true,
          draftId: draft.id,
          message: initialConfig
            ? `Created draft workspace '${name}' with initial configuration.`
            : `Created draft workspace '${name}'. Now let's design the agents and workflow.`,
          validation: validationStatus,
          configSummary: initialConfig
            ? {
              agentCount: Object.keys(draft.config.agents || {}).length,
              jobCount: Object.keys(draft.config.jobs || {}).length,
              hasSignals: Object.keys(draft.config.signals || {}).length > 0,
            }
            : undefined,
        };
      } catch (error) {
        logger.error("Error creating workspace draft", { error });
        return {
          success: false,
          error: `Error creating draft: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },

  workspace_draft_update: {
    description: "Update the draft workspace configuration based on user feedback",
    parameters: jsonSchema({
      type: "object",
      properties: {
        draftId: {
          type: "string",
          format: "uuid",
          description: "Draft workspace ID",
        },
        updates: {
          type: "object",
          description: "Configuration updates to apply (Partial<WorkspaceConfig>)",
        },
        updateDescription: {
          type: "string",
          description: "Natural language description of what changed",
        },
      },
      required: ["draftId", "updates", "updateDescription"],
      additionalProperties: false,
    }),
    execute: async ({ draftId, updates, updateDescription }) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: workspace_draft_update called", {
        draftId,
        updateDescription,
      });

      try {
        const adapter = await getDraftStorageAdapter();
        const draft = await adapter.updateDraft(draftId, updates, updateDescription);

        // Validate the updated configuration
        const validationResult = await validateDraftConfig(draft.config);
        const crossRefErrors = validateCrossReferences(draft.config);

        const isValid = validationResult.valid && crossRefErrors.length === 0;

        return {
          success: true,
          draftId: draft.id,
          message: updateDescription,
          validation: {
            valid: isValid,
            errors: [
              ...(validationResult.errors || []),
              ...crossRefErrors.map((msg) => ({ message: msg })),
            ],
          },
          configSummary: {
            agentCount: Object.keys(draft.config.agents || {}).length,
            jobCount: Object.keys(draft.config.jobs || {}).length,
            hasSignals: Object.keys(draft.config.signals || {}).length > 0,
          },
          nextSteps: isValid
            ? ["Configuration is valid. Ready to publish or make further changes."]
            : ["Fix validation errors before publishing."],
        };
      } catch (error) {
        logger.error("Error updating workspace draft", { error });
        return {
          success: false,
          error: `Error updating draft: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },
  // Keep existing tools: show_draft_config, publish_workspace, list_session_drafts, validate_draft_config, pre_publish_check
});
```

### 3. Remove Operation-Specific Logic

The key simplification is removing all the operation-specific logic:

- No more "add_agent", "update_agent", "remove_agent" operations
- No more "add_job", "update_job", "remove_job" operations
- No more "set_trigger", "add_tool", "remove_tool" operations

Instead, the LLM directly manipulates the configuration structure based on user intent.

## Benefits

### 1. Dramatic Reduction in Tool Calls

- **Simple workspaces**: 2 calls (create with config, publish)
- **Complex workspaces**: 2-3 calls (create, optional update, publish)
- **Current approach**: 5-10+ calls

### 2. Simplified Implementation

- Fewer tool definitions to maintain
- Less complex state management
- Direct configuration manipulation

### 3. Better LLM Utilization

- Leverages the LLM's ability to understand configuration structures
- More natural conversation flow
- Flexible updates based on user feedback

### 4. Improved User Experience

- Faster workspace creation
- Less waiting between steps
- More intuitive interactions

## Example Interactions

### Complete Workspace Creation

**User**: "Create a code review pipeline that checks security, performance, and style"

**Assistant** (1 tool call - workspace_draft_create with full config):

```json
{
  "name": "code-review-pipeline",
  "description": "Automated code review checking security, performance, and style",
  "initialConfig": {
    "version": "1.0",
    "workspace": {
      "name": "code-review-pipeline",
      "description": "Automated code review checking security, performance, and style"
    },
    "signals": {
      "code-review-pipeline-trigger": {
        "description": "Trigger code review analysis",
        "provider": "cli"
      }
    },
    "agents": {
      "security-checker": {/* full config */},
      "performance-analyzer": {/* full config */},
      "style-checker": {/* full config */},
      "review-summarizer": {/* full config */}
    },
    "jobs": {
      "code-review-pipeline-process": {/* full config */}
    }
  }
}
```

**Assistant**: "I've created your code review pipeline with 4 specialized agents. Ready to publish?"

**User**: "Yes"

**Assistant** (1 tool call - publish_workspace)

Total: 2 tool calls instead of 8+

### Iterative Refinement

**User**: "Add error handling to that"

**Assistant** (1 tool call - workspace_draft_update):

```json
{
  "draftId": "...",
  "updates": {
    "agents": {
      "error-handler": {
        "type": "llm",
        "model": "claude-3-5-haiku-20241022",
        "purpose": "Handle and report errors during review",
        "system_prompt": "..."
      }
    }
  },
  "updateDescription": "Added error-handler agent for graceful error handling"
}
```

Total: Still efficient with direct updates

## Summary

This enhancement plan simplifies workspace creation from 7+ sequential tool calls down to just 2-3
by:

1. **Leveraging LLM capabilities** - The LLM understands workspace configuration structure and can
   build complete configs
2. **Direct configuration manipulation** - No more operation-specific updates, just direct config
   changes
3. **Workspace template in prompt** - Guides the LLM to create valid configurations
4. **Simplified tool set** - Just 3 main tools: create, update, publish

The key insight is that the LLM is fully capable of:

- Analyzing user intent to build complete configurations
- Understanding the WorkspaceConfig schema structure
- Making appropriate updates based on user feedback
- Generating valid YAML configurations

This approach provides a much better user experience with faster workspace creation while
simplifying the implementation.
