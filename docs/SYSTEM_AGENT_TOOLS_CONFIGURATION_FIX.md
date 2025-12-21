# System Agent Tools Configuration Fix

> **Status: COMPLETED**
>
> This document describes a historical schema migration that has been implemented.
> The fix moved `tools` from the agent level into the `config` section for consistency
> with V2 configuration principles. All schemas now use `z.strictObject()` for strict
> validation.

## Overview

This document outlines the fix for system agents not receiving their configured tools.
The issue stemmed from a schema inconsistency where tools were defined at the agent level
but only the `config` section was passed to system agent constructors.

## Problem Statement (Historical)

### Original Issue

In early configurations, system agents had tools defined outside the `config` section:

```yaml
# OLD FORMAT (INVALID - do not use)
conversation-agent:
  type: "system"
  agent: "conversation"
  config:
    model: "claude-sonnet-4-5"
    temperature: 0.7
  tools:  # WRONG: tools outside config
    - "conversation_storage"
    - "stream_reply"
```

This caused tools to be silently dropped because only `agentConfig.config` was passed to
system agent constructors.

## Solution (Implemented)

Tools are now defined inside the `config` section for all agent types:

```yaml
# CORRECT FORMAT
agents:
  conversation-agent:
    type: "system"
    agent: "conversation"
    description: "Handle conversations with scope awareness"
    config:
      model: "claude-sonnet-4-20250514"
      temperature: 0.7
      max_tokens: 8000
      tools:  # CORRECT: tools inside config
        - "conversation_storage"
        - "stream_reply"
        - "atlas_workspace_describe"
      prompt: "..."
```

## Current Agent Schema Reference

### LLM Agent

```yaml
agents:
  my-llm-agent:
    type: "llm"
    description: "Agent description (required)"
    config:
      provider: "anthropic"           # Required
      model: "claude-sonnet-4-20250514"  # Required
      prompt: "System prompt..."      # Required
      temperature: 0.3                # Optional (0-0.7)
      max_tokens: 4000                # Optional
      max_steps: 10                   # Optional
      tool_choice: "auto"             # Optional: auto | required | none
      tools:                          # Optional: array of tool names
        - "tool_name_1"
        - "tool_name_2"
      max_retries: 3                  # Optional
      timeout: "30s"                  # Optional
```

### System Agent

```yaml
agents:
  my-system-agent:
    type: "system"
    agent: "conversation"             # Required: system agent identifier
    description: "Agent description (required)"
    config:                           # Optional
      model: "claude-sonnet-4-20250514"
      temperature: 0.5
      max_tokens: 4000
      tools:
        - "tool_name_1"
        - "tool_name_2"
      use_reasoning: true
      max_reasoning_steps: 5
      prompt: "Optional prompt..."
```

### Atlas Agent

```yaml
agents:
  my-atlas-agent:
    type: "atlas"
    agent: "registered-agent-id"      # Required: Atlas Agent ID from registry
    description: "Agent description (required)"
    prompt: "Agent prompt (required)"
    env:                              # Optional: environment variables
      API_KEY: "${API_KEY}"
```

## Schema Validation

All configuration files are validated using `z.strictObject()` which rejects unknown keys.
If you see an error like:

```
ConfigValidationError: Workspace configuration validation failed
Unrecognized key: "tools"
  at agents["my-agent"]
```

This means `tools` is at the wrong level. Move it inside the `config` block.

## Implementation Details

The fix involved:

1. **Schema Update** (`packages/config/src/agents.ts`):
   - `SystemAgentConfigObjectSchema` includes `tools: z.array(z.string()).optional()`
   - `LLMAgentConfigSchema.config` includes `tools: z.array(z.string()).optional()`

2. **Strict Validation** (`packages/config/src/*.ts`):
   - All schemas use `z.strictObject()` to reject unknown keys
   - This catches configuration errors that previously went unnoticed

3. **Configuration Migration**:
   - `packages/system/workspaces/conversation.yml` updated
   - All example configurations updated

## Related Files

- `packages/config/src/agents.ts` - Agent schema definitions
- `packages/config/src/workspace.ts` - Workspace configuration schema
- `packages/config/src/config-loader.ts` - Configuration loading and validation
- `examples/telephone/workspace.yml` - Example with correct format
- `packages/system/workspaces/conversation.yml` - System workspace example
