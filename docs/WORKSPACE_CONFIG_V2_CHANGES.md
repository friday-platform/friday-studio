# Workspace Configuration V2 Changes Summary

This document summarizes the key changes made in V2 of the comprehensive workspace example based on
feedback.

## Latest Updates (Post-V2 Feedback)

### Signal Configuration

- Moved timeout under config section for HTTP signals
- Removed retry configuration entirely
- Timeout now uses duration format ("30s") instead of milliseconds

### Job Configuration

- Moved timeout, supervision, and memory under a new `config` section
- Removed error retry and delay settings
- Success/error conditions now support both JSONLogic and prompt formats
- Added job-level context.files configuration

### Agent Configuration

- System agents: Moved `agent` identifier to top level (out of config)
- System agents: Description removed (provided by agent registry)
- Remote agents: Removed MCP protocol support (not working)
- Remote agents: Hoisted ACP options up a level (removed redundant nesting)
- All agent types: Success/error conditions support JSONLogic or prompt

### Condition Format

All conditions (triggers, success, error) now support two formats:

```yaml
condition:
  jsonlogic: # Cached and executed at runtime
    ">": [{ "var": "score" }, 0.8]
  # OR
  prompt: "Success when score is above 80%" # Converted to JSONLogic
```

## Major Structural Changes

### 1. Removed CLI Signal Provider

- CLI is not a provider type
- All signals can be triggered via CLI through discoverable configuration

### 2. Consistent Allow/Deny Terminology

- Changed `allowed`/`denied` to `allow`/`deny` throughout
- Added validation to ensure allow and deny are mutually exclusive

### 3. Duration Format for Timeouts

- Changed from milliseconds (`timeout_ms: 30000`) to duration strings (`timeout: "30s"`)
- Supports formats like "30s", "5m", "2h"

### 4. Tagged Union Pattern for Agents

- All agent-specific config moved under `config` field
- Type field determines the config schema
- Added success/error handlers to all agent types

### 5. Context-Based Agent Configuration

- Replaced `input_source` with structured `context` object
- Context specifies what data the agent receives:
  - `signal`: Include signal data
  - `steps`: "previous" or "all"
  - `agents`: Specific agent outputs
  - `files`: Include filesystem context
  - `task`: Additional prompt text

## Workspace vs Atlas Configuration

### Belongs in workspace.yml:

- Basic server.mcp enablement and discoverable config
- Tools configuration for calling external MCP servers
- All business logic (signals, jobs, agents)
- Basic memory configuration
- Federation sharing

### Belongs ONLY in atlas.yml:

- Server transport configuration
- Authentication and rate limiting
- MCP server access policies
- Platform agents
- Complex memory configuration
- Supervisor configuration
- Planning configuration
- Runtime settings
- System workspaces

## Signal Configuration Changes

### Before:

```yaml
cli-analyze:
  provider: "cli"
  command: "analyze"
  schema: { ... }

webhook-github:
  provider: "http"
  path: "/webhooks/github"
  method: "POST"
  headers: { ... }
```

### After:

```yaml
webhook-github:
  provider: "http"
  description: "GitHub webhook receiver"
  config:
    path: "/webhooks/github"
    # method always POST, headers removed
  schema: { ... } # optional
```

## Job Configuration Changes

### Triggers:

- Added condition types: `jsonlogic` or `prompt`
- Removed response configuration (client concern)
- Removed task_template

### Execution:

- Replaced session_prompts with single `prompt` string
- Added `nickname` for agents
- Replaced `input_source` with `context` object
- Tools now use `allow`/`deny` pattern

### Terminal States:

- Renamed `success_criteria` to `success`
- Added `error` section with retries and timeout
- Both support conditions and schemas

## Agent Configuration Changes

### LLM Agents:

```yaml
# Before:
data-analyzer:
  type: "llm"
  provider: "anthropic"
  model: "claude-3-5-sonnet"
  purpose: "Analyze data"
  prompts:
    system: "..."
    error_handling: "..."
  monitoring: { ... }

# After:
data-analyzer:
  type: "llm"
  description: "Analyze data" # Moved to top
  config: # All config under here
    provider: "anthropic"
    model: "claude-3-5-sonnet"
    prompt: "..." # Single string
    success:
      condition:
        jsonlogic: { ... } # or prompt: "..."
    error:
      condition:
        jsonlogic: { ... } # or prompt: "..."
```

### System Agents:

```yaml
# Before:
report-generator:
  type: "system"
  agent: "report-builder"
  version: "2.0.0"
  purpose: "..."
  config: { ... }

# After (Latest):
report-generator:
  type: "system"
  agent: "report-builder" # Top level now
  config: # Only optional overrides
    template_engine: "handlebars"
    output_formats: ["markdown", "html"]
```

## Best Practices

1. **Consistency**: Use `allow`/`deny` pattern everywhere
2. **Clarity**: Separate workspace concerns from platform concerns
3. **Simplicity**: Single prompt strings instead of multiple prompts
4. **Type Safety**: Tagged unions with config under type-specific field
5. **Validation**: Mutually exclusive allow/deny lists
6. **Flexibility**: Context-based agent data flow
7. **Standards**: Duration strings for all timeouts
8. **Conditions**: Support both JSONLogic and natural language prompts
9. **Structure**: Group related config (timeout, supervision, memory) together
10. **Remote Agents**: Only ACP protocol currently supported
