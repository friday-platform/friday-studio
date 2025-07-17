# System Agent Tools Configuration Fix

## Overview

This document outlines the comprehensive fix for system agents not receiving their configured tools.
The issue stems from a schema inconsistency where tools are defined at the agent level but only the
`config` section is passed to system agent constructors.

## Problem Statement

### Current Issue

In `packages/system/workspaces/conversation.yml`, system agents have tools defined outside the
`config` section:

```yaml
conversation-agent:
  type: "system"
  agent: "conversation"
  config:
    model: "claude-3-5-sonnet-20241022"
    temperature: 0.7
    # ... other config
  tools: # <- Tools are HERE (outside config)
    - "conversation_storage"
    - "stream_reply"
    # ... more tools
```

However, in `src/core/actors/agent-execution-actor.ts:112-115`, only the `config` section is passed
to system agents:

```typescript
const fullConfig = agentConfig.config || {};
const systemAgent = SystemAgentRegistry.createAgent(
  systemAgentId,
  fullConfig, // <- Only config is passed, tools are missing!
);
```

### Configuration Flow Analysis

1. **conversation.yml** defines tools at agent level (sibling to config)
2. **agent-execution-actor.ts** passes only `agentConfig.config` to system agent constructor
3. **conversation-agent.ts** constructor merges received config with defaults:
   ```typescript
   this.config = {
     // ... defaults including tools: []
     ...config, // <- Merges with passed config (which lacks tools!)
   };
   ```
4. **Tools are used** in methods like `getDaemonCapabilityTools()` via `this.config.tools`
5. **LLM calls** use `this.config` properties for model, temperature, etc.

### Root Cause

1. **Schema Inconsistency**: Tools are defined at agent level but expected in config
2. **Config Passing**: Only `agentConfig.config` is passed to system agents
3. **Missing Tools**: System agents never receive their configured tools
4. **Type Safety**: The current structure doesn't align with type safety improvements

### Impact on LLM Provider

The conversation agent uses `this.config` properties when making LLM calls:

- `this.config.model` → LLM model selection
- `this.config.temperature` → LLM temperature
- `this.config.tools` → Converted to daemon tools for LLM tool calling
- System prompt comes from `this.prompts.system` (set via `this.setPrompts()`)

Since tools are missing from the config, the agent operates with an empty tools array, preventing
tool-enabled LLM interactions.

## Solution Overview

**Comprehensive Fix**: Move tools inside the `config` section for system agents, making the schema
consistent with V2 configuration principles.

### Target Configuration Structure

```yaml
# Updated system agent structure
conversation-agent:
  type: "system"
  agent: "conversation"
  config:
    model: "claude-3-5-sonnet-20241022"
    temperature: 0.7
    tools: # <- Tools moved inside config
      - "conversation_storage"
      - "stream_reply"
      # ... more tools
```

## Implementation Plan

### Phase 1: Schema Definition and Type Updates

#### 1.1 Update Config Schema Types

- **File**: `packages/config/src/v2/schema.ts`
- **Action**: Update `SystemAgentConfig` to include tools in config section with specific schema

**Before:**

```typescript
export const SystemAgentConfigSchema = z.object({
  type: z.literal("system"),
  agent: z.string(),
  config: z.record(z.unknown()).optional(),
  tools: z.array(z.string()).optional(), // <- Tools at agent level
});
```

**After:**

```typescript
// Specific schema based on conversation agent usage
const SystemAgentConfigObjectSchema = z.object({
  // LLM Configuration
  model: z.string().optional().describe("LLM model to use"),
  temperature: z.number().min(0).max(2).optional().describe("LLM temperature"),
  max_tokens: z.number().min(1).optional().describe("Maximum tokens for LLM response"),

  // Tools Configuration
  tools: z.array(z.string()).optional().describe("Array of tool names available to the agent"),

  // Reasoning Configuration
  use_reasoning: z.boolean().optional().describe("Enable reasoning capabilities"),
  max_reasoning_steps: z.number().min(1).max(20).optional().describe("Maximum reasoning steps"),

  // Prompt Configuration
  prompts: z.object({
    system: z.string().optional().describe("System prompt for the agent"),
    user: z.string().optional().describe("User prompt template"),
  }).optional().describe("Structured prompts configuration"),
}).passthrough().describe("System agent configuration");

export const SystemAgentConfigSchema = z.object({
  type: z.literal("system"),
  agent: z.string(),
  config: SystemAgentConfigObjectSchema.optional(),
});
```

#### 1.2 Update Type Definitions

- **File**: `packages/core/src/types/actors.ts`
- **Action**: Update `AgentExecutionConfig` to reflect new structure

### Phase 2: Config Loader Updates

#### 2.1 Remove Config Loader Normalization

- **File**: `packages/config/src/v2/loader.ts`
- **Action**: Remove any existing normalization logic for system agent tools
- **Note**: No normalization needed - tools will be defined in config section only

### Phase 3: Agent Execution Actor Updates

#### 3.1 Update System Agent Execution

- **File**: `src/core/actors/agent-execution-actor.ts`
- **Action**: Update to use new config structure (should work automatically with schema changes)
- **Note**: No additional validation needed - schema validation handles this

### Phase 4: System Workspace Updates

#### 4.1 Update System Workspaces

- **File**: `packages/system/workspaces/conversation.yml`
- **Action**: Move tools from agent level to config level

**Current:**

```yaml
agents:
  conversation-agent:
    type: "system"
    agent: "conversation"
    config:
      model: "claude-3-5-sonnet-20241022"
      temperature: 0.7
      max_tokens: 8000
      use_reasoning: true
      max_reasoning_steps: 5
    tools:
      - "conversation_storage"
      - "stream_reply"
      # ... more tools
```

**Updated:**

```yaml
agents:
  conversation-agent:
    type: "system"
    agent: "conversation"
    config:
      model: "claude-3-5-sonnet-20241022"
      temperature: 0.7
      max_tokens: 8000
      use_reasoning: true
      max_reasoning_steps: 5
      tools: # <- Moved inside config
        - "conversation_storage"
        - "stream_reply"
        # ... more tools
```

#### 4.2 Update Other System Workspaces

- **Action**: Check for and update any other system workspaces with similar structure

### Phase 5: Testing and Validation

#### 5.1 Unit Tests

- **File**: `src/core/actors/__tests__/agent-execution-actor.test.ts`
- **Action**: Add tests for system agent tools configuration

#### 5.2 Integration Tests

- **Action**: Test conversation agent with tools to ensure they're properly passed

#### 5.3 Configuration Validation

- **Action**: Verify schema validation works with new structure

## Implementation Tasks

### Task 1: Schema and Type Updates

- [ ] Update `SystemAgentConfigSchema` in `packages/config/src/v2/schema.ts`
- [ ] Update related type definitions in `packages/core/src/types/actors.ts`
- [ ] Run type checking to ensure consistency

### Task 2: Config Loader Clean-up

- [ ] Remove any existing normalization logic for system agent tools
- [ ] Clean up config loading code
- [ ] Test config loading with new structure

### Task 3: Agent Execution Updates

- [ ] Verify `executeSystemAgent()` method works with new config structure
- [ ] Test agent execution with tools

### Task 4: System Workspace Updates

- [ ] Update `packages/system/workspaces/conversation.yml`
- [ ] Check for other system workspaces that need updating
- [ ] Validate updated configurations

### Task 5: Testing

- [ ] Add unit tests for new configuration structure
- [ ] Add integration tests for system agent tool access
- [ ] Test conversation agent functionality

### Task 6: Documentation Updates

- [ ] Update `WORKSPACE_CONFIG_V2_CHANGES.md` with new system agent structure
- [ ] Update any other relevant documentation

## Benefits

1. **Schema Consistency**: All agent config in one place
2. **Type Safety**: Proper type definitions for system agent tools
3. **Tool Access**: System agents now receive their configured tools
4. **Future-Proof**: Aligns with V2 configuration principles
5. **Debugging**: Better logging and validation for tools configuration

## Risk Mitigation

1. **Breaking Changes**: Acceptable since work hasn't shipped
2. **Testing**: Comprehensive tests ensure functionality works
3. **Documentation**: Clear structure for future users

## Success Criteria

- [ ] System agents receive their configured tools
- [ ] Tools are properly passed to system agent constructors
- [ ] Schema validation passes with new structure
- [ ] All tests pass
- [ ] Conversation agent works with full tool access
- [ ] Configuration is consistent with V2 principles

## Notes

- This fix addresses the immediate issue while also improving long-term schema consistency
- The change aligns with the V2 configuration architecture goals
- All system agents will benefit from this fix, not just conversation agents
- The implementation should be done incrementally to ensure stability
