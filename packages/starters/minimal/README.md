# Minimal Workspace Template

A fully documented Atlas workspace configuration with all available options commented out for easy
reference and customization.

## Overview

This template provides:

- Complete workspace configuration reference
- All available options with descriptions
- Commented examples for every feature
- Best practices and usage patterns

## Getting Started

### 1. Review Configuration

Open `workspace.yml` and explore the available options:

- **Signals**: How to receive external triggers
- **Jobs**: Workflows that process signals
- **Agents**: AI agents that do the work
- **Tools**: MCP servers for extended capabilities
- **Resources**: External data and contexts

### 2. Uncomment What You Need

Start with the basics:

```yaml
# Uncomment to add an HTTP webhook
signals:
  webhook:
    description: "Receives webhooks"
    provider: "http"
    path: "/webhook"
    method: "POST"
```

### 3. Configure API Keys

Add required keys to `.env`:

```bash
ANTHROPIC_API_KEY=your-key      # For Claude models
OPENAI_API_KEY=your-key         # For GPT models
GITHUB_TOKEN=your-token         # For GitHub integration
```

### 4. Test Your Configuration

```bash
atlas workspace validate         # Check syntax
atlas daemon start              # Start Atlas
atlas signal trigger my-signal  # Test signal
```

## Configuration Sections Explained

### Signals

Three types of signals can trigger your jobs:

**CLI Signals** - Manual triggers:

```yaml
signals:
  my-signal:
    provider: "cli"
```

**HTTP Signals** - Webhooks and APIs:

```yaml
signals:
  webhook:
    provider: "http"
    path: "/webhook"
    method: "POST"
```

**Scheduled Signals** - Cron jobs:

```yaml
signals:
  daily:
    provider: "schedule"
    schedule: "0 0 * * *"
```

### Jobs

Define workflows with different execution strategies:

**Single Agent**:

```yaml
execution:
  strategy: "single"
  agents:
    - id: "main-agent"
```

**Sequential Pipeline**:

```yaml
execution:
  strategy: "sequential"
  agents:
    - id: "analyze"
    - id: "process"
    - id: "report"
```

**Parallel Execution**:

```yaml
execution:
  strategy: "parallel"
  agents:
    - id: "worker-1"
    - id: "worker-2"
```

### Agents

Three types of agents available:

**LLM Agents** - AI language models:

```yaml
agents:
  assistant:
    type: "llm"
    model: "claude-3-5-haiku-20241022"
```

**Tempest Agents** - Code execution:

```yaml
agents:
  runner:
    type: "tempest"
    image: "docker.io/tempestai/agent:latest"
```

**Remote Agents** - External services:

```yaml
agents:
  api:
    type: "remote"
    endpoint: "https://api.example.com"
```

### Tools (MCP Servers)

Extend agent capabilities with tools:

```yaml
tools:
  mcp:
    servers:
      filesystem:
        transport:
          type: "stdio"
          command: "npx"
          args: ["@modelcontextprotocol/server-filesystem"]
```

### Advanced Features

**Conditional Triggers**:

```yaml
triggers:
  - signal: "process"
    condition:
      and:
        - { "var": "priority" }
        - { "==": [{ "var": "priority" }, "high"] }
```

**Input Transformations**:

```yaml
agents:
  - id: "formatter"
    input_transform:
      template: "Format this data: {{json_data}}"
```

**Rate Limiting**:

```yaml
server:
  mcp:
    rate_limits:
      requests_per_hour: 100
      concurrent_sessions: 5
```

## Common Patterns

### 1. API Integration Pattern

```yaml
signals:
  api-webhook:
    provider: "http"
    path: "/api/webhook"

jobs:
  process-api:
    triggers:
      - signal: "api-webhook"
    execution:
      agents:
        - id: "api-processor"

agents:
  api-processor:
    type: "llm"
    model: "claude-3-5-haiku-20241022"
    system_prompt: |
      Process API webhook data and respond appropriately.
```

### 2. Scheduled Task Pattern

```yaml
signals:
  daily-report:
    provider: "schedule"
    schedule: "0 9 * * *" # 9 AM daily

jobs:
  generate-report:
    triggers:
      - signal: "daily-report"
    execution:
      agents:
        - id: "reporter"
```

### 3. Multi-Stage Processing

```yaml
execution:
  strategy: "sequential"
  agents:
    - id: "validator"
      input_source: "signal"
    - id: "processor"
      input_source: "previous"
    - id: "notifier"
      input_source: "all"
```

## Best Practices

1. **Start Simple**: Begin with one signal, one job, one agent
2. **Use Comments**: Document your configuration choices
3. **Test Incrementally**: Validate after each change
4. **Monitor Performance**: Use `atlas ps` and logs
5. **Version Control**: Track workspace.yml changes

## Troubleshooting

**Configuration Errors**:

```bash
atlas workspace validate  # Check syntax
```

**Runtime Issues**:

```bash
atlas daemon logs        # Check daemon logs
atlas logs <session-id>  # Check session logs
```

**Performance**:

- Use appropriate models (Haiku for speed, Sonnet for complexity)
- Implement rate limiting for production use
- Monitor concurrent sessions

## Next Steps

1. Uncomment sections you need
2. Add your custom agents and jobs
3. Integrate with your tools via MCP
4. Deploy and monitor your workspace

For more examples, check out:

- `echo` template - Simple single-agent example
- `telephone` template - Multi-agent pipeline example
