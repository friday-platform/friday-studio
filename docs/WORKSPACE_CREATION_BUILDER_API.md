# Atlas Workspace Creation: Corrected Builder API Design

## Executive Summary

**CORRECTED APPROACH**: Instead of recreating Zod schemas, we leverage the existing comprehensive
schemas from `@atlas/config` directly. This ensures single source of truth, automatic consistency,
and reduced maintenance overhead.

## Schema Reuse Strategy

### Import Existing Schemas

```typescript
// File: packages/tools/src/internal/workspace-builder-tools.ts
import {
  // Utility schemas
  DurationSchema,
  // Helper functions
  getAgent,
  getJob,
  getSignal,
  isLLMAgent,
  isRemoteAgent,
  isSystemAgent,
  JobSpecificationSchema,
  MCPServerConfigSchema,
  MCPToolNameSchema,
  validateSignalPayload,
  WorkspaceAgentConfigSchema,
  // Core schemas - use directly
  WorkspaceConfigSchema,
  WorkspaceIdentitySchema,
  WorkspaceSignalConfigSchema,
} from "@atlas/config";
import { tool } from "ai";
import { z } from "zod/v4";
```

## Corrected Tool Definitions

### Foundation Tool - Using WorkspaceIdentitySchema

```typescript
export const workspaceBuilderTools = {
  initializeWorkspace: tool({
    description: "Initialize a new Atlas workspace with identity metadata. This MUST be the first tool called.",
    parameters: WorkspaceIdentitySchema.pick({
      name: true,
      description: true,
    }).extend({
      // Add tool-specific descriptions without recreating validation
      name: z.string().describe("Workspace name in kebab-case, e.g., 'nike-shoe-monitor'"),
      description: z.string().describe("Brief description of what this workspace automates"),
    }),
    execute: async ({ name, description }) => {
      const result = workspaceBuilder.initialize({ name, description });
      
      if (!result.success) {
        throw new Error(`Workspace initialization failed: ${result.errors.join('; ')}`);
      }
      
      return {
        status: "initialized",
        message: `Workspace '${name}' initialized successfully`,
      };
    },
  }),
```

### Signal Tools - Using WorkspaceSignalConfigSchema

```typescript
  // Schedule signal using existing schema
  addScheduleSignal: tool({
    description: "Add a schedule-based signal that triggers jobs on a cron schedule.",
    parameters: z.object({
      signalName: z.string().describe("Unique signal identifier"),
      signalConfig: WorkspaceSignalConfigSchema.extend({
        provider: z.literal("schedule"), // Constrain to schedule type
      }),
    }),
    execute: async ({ signalName, signalConfig }) => {
      const result = workspaceBuilder.addSignal(signalName, signalConfig);
      
      if (!result.success) {
        throw new Error(`Schedule signal creation failed: ${result.errors.join('; ')}`);
      }

      return {
        status: "added",
        signalName,
        message: `Schedule signal '${signalName}' added`,
      };
    },
  }),

  // HTTP signal using existing schema  
  addWebhookSignal: tool({
    description: "Add an HTTP webhook signal that triggers jobs on incoming requests.",
    parameters: z.object({
      signalName: z.string().describe("Unique signal identifier"),
      signalConfig: WorkspaceSignalConfigSchema.extend({
        provider: z.literal("http"), // Constrain to HTTP type
      }),
    }),
    execute: async ({ signalName, signalConfig }) => {
      const result = workspaceBuilder.addSignal(signalName, signalConfig);
      
      if (!result.success) {
        throw new Error(`Webhook signal creation failed: ${result.errors.join('; ')}`);
      }

      return {
        status: "added", 
        signalName,
        message: `Webhook signal '${signalName}' added`,
      };
    },
  }),
```

### Agent Tools - Using WorkspaceAgentConfigSchema

```typescript
  // LLM agent using existing schema
  addLLMAgent: tool({
    description: "Add an AI agent that uses language models for processing and decision-making.",
    parameters: z.object({
      agentId: z.string().describe("Unique agent identifier"),
      agentConfig: WorkspaceAgentConfigSchema.extend({
        type: z.literal("llm"), // Constrain to LLM type
      }),
    }),
    execute: async ({ agentId, agentConfig }) => {
      const result = workspaceBuilder.addAgent(agentId, agentConfig);
      
      if (!result.success) {
        throw new Error(`LLM agent creation failed: ${result.errors.join('; ')}`);
      }

      return {
        status: "added",
        agentId, 
        message: `LLM agent '${agentId}' added`,
      };
    },
  }),

  // System agent using existing schema
  addSystemAgent: tool({
    description: "Add a built-in Atlas system agent with predefined capabilities.",
    parameters: z.object({
      agentId: z.string().describe("Unique agent identifier"),
      agentConfig: WorkspaceAgentConfigSchema.extend({
        type: z.literal("system"), // Constrain to system type
      }),
    }),
    execute: async ({ agentId, agentConfig }) => {
      const result = workspaceBuilder.addAgent(agentId, agentConfig);
      
      if (!result.success) {
        throw new Error(`System agent creation failed: ${result.errors.join('; ')}`);
      }

      return {
        status: "added",
        agentId,
        message: `System agent '${agentId}' added`,
      };
    },
  }),

  // Remote agent using existing schema
  addRemoteAgent: tool({
    description: "Add a remote agent that connects to external services via ACP protocol.",
    parameters: z.object({
      agentId: z.string().describe("Unique agent identifier"),
      agentConfig: WorkspaceAgentConfigSchema.extend({
        type: z.literal("remote"), // Constrain to remote type
      }),
    }),
    execute: async ({ agentId, agentConfig }) => {
      const result = workspaceBuilder.addAgent(agentId, agentConfig);
      
      if (!result.success) {
        throw new Error(`Remote agent creation failed: ${result.errors.join('; ')}`);
      }

      return {
        status: "added",
        agentId,
        message: `Remote agent '${agentId}' added`,
      };
    },
  }),
```

### Job Creation - Using JobSpecificationSchema

```typescript
  // Job creation using existing schema
  createJob: tool({
    description: "Create a job that connects signals to agents in an execution pipeline.",
    parameters: z.object({
      jobName: MCPToolNameSchema.describe("Unique job name following MCP naming conventions"),
      jobConfig: JobSpecificationSchema,
    }),
    execute: async ({ jobName, jobConfig }) => {
      const result = workspaceBuilder.addJob(jobName, jobConfig);
      
      if (!result.success) {
        throw new Error(`Job creation failed: ${result.errors.join('; ')}`);
      }

      return {
        status: "created",
        jobName,
        message: `Job '${jobName}' created successfully`,
      };
    },
  }),
```

### MCP Integration - Using MCPServerConfigSchema

```typescript
  // MCP integration using existing schema
  addMCPIntegration: tool({
    description: "Add external MCP server integration for additional capabilities.",
    parameters: z.object({
      serverName: z.string().describe("MCP server identifier"),
      serverConfig: MCPServerConfigSchema,
    }),
    execute: async ({ serverName, serverConfig }) => {
      const result = workspaceBuilder.addMCPIntegration(serverName, serverConfig);
      
      if (!result.success) {
        throw new Error(`MCP integration failed: ${result.errors.join('; ')}`);
      }

      return {
        status: "added",
        serverName,
        message: `MCP integration '${serverName}' added`,
      };
    },
  }),
```

## Corrected WorkspaceBuilder Implementation

### Using Config Schema Validation Directly

```typescript
// File: packages/tools/src/internal/workspace-builder.ts
import {
  getAgent,
  getJob,
  getSignal,
  isLLMAgent,
  JobSpecificationSchema,
  MCPServerConfigSchema,
  validateSignalPayload,
  WorkspaceAgentConfigSchema,
  type WorkspaceConfig,
  WorkspaceConfigSchema,
  WorkspaceIdentitySchema,
  WorkspaceSignalConfigSchema,
} from "@atlas/config";

export class WorkspaceBuilder {
  private state: Partial<WorkspaceConfig> = {
    version: "1.0",
    signals: {},
    jobs: {},
    agents: {},
  };

  // Initialize using WorkspaceIdentitySchema validation
  initialize(identity: z.infer<typeof WorkspaceIdentitySchema>): ValidationResult {
    const result = WorkspaceIdentitySchema.safeParse(identity);
    if (!result.success) {
      return {
        success: false,
        errors: result.error.errors.map((e) => `Identity validation: ${e.message}`),
      };
    }

    this.state.workspace = result.data;
    return { success: true, errors: [], warnings: [] };
  }

  // Add signal using WorkspaceSignalConfigSchema validation
  addSignal(name: string, config: z.infer<typeof WorkspaceSignalConfigSchema>): ValidationResult {
    // Use existing schema validation
    const signalResult = WorkspaceSignalConfigSchema.safeParse(config);
    if (!signalResult.success) {
      return {
        success: false,
        errors: signalResult.error.errors.map((e) => `Signal validation: ${e.message}`),
      };
    }

    // Check for duplicates using helper function
    if (getSignal(this.state as WorkspaceConfig, name)) {
      return { success: false, errors: [`Signal '${name}' already exists`] };
    }

    this.state.signals![name] = signalResult.data;
    return { success: true, errors: [], warnings: [] };
  }

  // Add agent using WorkspaceAgentConfigSchema validation
  addAgent(id: string, config: z.infer<typeof WorkspaceAgentConfigSchema>): ValidationResult {
    // Use existing schema validation
    const agentResult = WorkspaceAgentConfigSchema.safeParse(config);
    if (!agentResult.success) {
      return {
        success: false,
        errors: agentResult.error.errors.map((e) => `Agent validation: ${e.message}`),
      };
    }

    // Check for duplicates using helper function
    if (getAgent(this.state as WorkspaceConfig, id)) {
      return { success: false, errors: [`Agent '${id}' already exists`] };
    }

    this.state.agents![id] = agentResult.data;
    return { success: true, errors: [], warnings: [] };
  }

  // Add job using JobSpecificationSchema validation
  addJob(name: string, config: z.infer<typeof JobSpecificationSchema>): ValidationResult {
    // Use existing schema validation
    const jobResult = JobSpecificationSchema.safeParse(config);
    if (!jobResult.success) {
      return {
        success: false,
        errors: jobResult.error.errors.map((e) => `Job validation: ${e.message}`),
      };
    }

    // Check for duplicates using helper function
    if (getJob(this.state as WorkspaceConfig, name)) {
      return { success: false, errors: [`Job '${name}' already exists`] };
    }

    // Validate signal references
    for (const trigger of jobResult.data.triggers || []) {
      if (!getSignal(this.state as WorkspaceConfig, trigger.signal)) {
        return {
          success: false,
          errors: [`Job '${name}' references undefined signal '${trigger.signal}'`],
        };
      }
    }

    // Validate agent references using helper functions
    for (const agent of jobResult.data.execution?.agents || []) {
      const agentId = typeof agent === "string" ? agent : agent.id;
      if (!getAgent(this.state as WorkspaceConfig, agentId)) {
        return {
          success: false,
          errors: [`Job '${name}' references undefined agent '${agentId}'`],
        };
      }
    }

    this.state.jobs![name] = jobResult.data;
    return { success: true, errors: [], warnings: [] };
  }

  // Add MCP integration using MCPServerConfigSchema validation
  addMCPIntegration(
    serverName: string,
    config: z.infer<typeof MCPServerConfigSchema>,
  ): ValidationResult {
    // Use existing schema validation
    const mcpResult = MCPServerConfigSchema.safeParse(config);
    if (!mcpResult.success) {
      return {
        success: false,
        errors: mcpResult.error.errors.map((e) => `MCP validation: ${e.message}`),
      };
    }

    if (!this.state.tools) {
      this.state.tools = { mcp: { servers: {} } };
    }
    if (!this.state.tools.mcp) {
      this.state.tools.mcp = { servers: {} };
    }

    this.state.tools.mcp.servers![serverName] = mcpResult.data;
    return { success: true, errors: [], warnings: [] };
  }

  // Validate using WorkspaceConfigSchema
  validateWorkspace(): ValidationResult {
    // Use the main workspace schema for complete validation
    const configResult = WorkspaceConfigSchema.safeParse(this.state);

    if (!configResult.success) {
      return {
        success: false,
        errors: configResult.error.errors.map((e) =>
          `Schema validation: ${e.path.join(".")}: ${e.message}`
        ),
        warnings: [],
      };
    }

    // Additional semantic validation can be added here
    return { success: true, errors: [], warnings: [] };
  }

  // Export using WorkspaceConfigSchema validation
  exportConfig(): WorkspaceConfig {
    const configResult = WorkspaceConfigSchema.safeParse(this.state);

    if (!configResult.success) {
      throw new Error(
        `Cannot export invalid configuration: ${
          configResult.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")
        }`,
      );
    }

    return configResult.data;
  }
}
```

## Key Benefits of This Corrected Approach

### 1. **Single Source of Truth**

- All validation logic lives in `@atlas/config`
- No duplicate schema definitions to maintain
- Automatic consistency across the codebase

### 2. **Automatic Schema Evolution**

- When config schemas change, tools automatically get updated validation
- No need to manually sync schema changes
- Reduces risk of version mismatch bugs

### 3. **Leverages Existing Validation**

- Built-in error messages from config schemas
- Proper default values and optional fields
- Tagged union discrimination already implemented

### 4. **Uses Helper Functions**

- `getAgent()`, `getSignal()`, `getJob()` for lookups
- `isLLMAgent()`, `isSystemAgent()` for type checking
- `validateSignalPayload()` for runtime validation

### 5. **Better Type Safety**

```typescript
// Automatic type inference from existing schemas
const agentConfig: z.infer<typeof WorkspaceAgentConfigSchema> = {
  type: "llm",
  description: "AI analyst",
  config: {
    provider: "anthropic", // Defaults from schema
    model: "claude-3-5-sonnet-latest",
    prompt: "You are an AI analyst...",
    // All other fields get proper typing and defaults
  },
};
```

### 6. **Simplified Tool Implementation**

```typescript
// Instead of recreating complex parameter schemas:
parameters: WorkspaceAgentConfigSchema.extend({
  type: z.literal("llm"), // Just constrain the discriminant
});

// vs. recreating entire schema structure (wrong approach)
parameters: z.object({
  description: z.string().min(10).max(200),
  provider: z.enum(["anthropic", "openai", "google"]),
  model: z.string(),
  // ... 20+ more fields recreated
});
```

## Migration Strategy

### Phase 1: Replace Schema Recreations

1. Remove all duplicate schema definitions
2. Import schemas directly from `@atlas/config`
3. Use `.pick()`, `.omit()`, `.extend()` for customization
4. Test that validation behavior is identical

### Phase 2: Leverage Helper Functions

1. Replace manual lookups with `getAgent()`, `getSignal()`, etc.
2. Use type guards (`isLLMAgent()`) instead of manual type checking
3. Use `validateSignalPayload()` for runtime validation

### Phase 3: Enhance Config Schemas if Needed

1. If tools need additional validation, enhance schemas in `@atlas/config`
2. Add tool-specific descriptions using `.describe()` method
3. Maintain backward compatibility with existing usage

This corrected approach eliminates unnecessary code duplication while leveraging the robust,
well-tested schemas that already exist in the Atlas configuration system.
