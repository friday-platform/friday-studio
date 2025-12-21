# Atlas Getting Started Guide

Welcome to **Atlas** - the comprehensive AI agent orchestration platform that transforms software
delivery through human/AI collaboration.

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Daemon Management](#daemon-management)
- [Creating Your First Workspace](#creating-your-first-workspace)
- [Understanding Jobs and Signals](#understanding-jobs-and-signals)
- [Example Workflows](#example-workflows)
- [Troubleshooting](#troubleshooting)

## 🚀 Quick Start

Get Atlas running in 5 minutes:

```bash
# 1. Install Atlas (Homebrew recommended)
brew tap tempestteam/tap
HOMEBREW_GITHUB_API_TOKEN=$(gh auth token) brew install tempest-atlas

# 2. Set up environment
export ANTHROPIC_API_KEY="your-key-here"

# 3. Start the Atlas daemon
atlas daemon start

# 4. Try an example workspace
cd examples/workspaces/telephone
```

## 📦 Prerequisites

- **Deno** v1.40+ (latest LTS recommended)
- **Anthropic API Key** for LLM functionality
- **Git** for workspace management
- **Optional**: Docker for containerized agents

### System Requirements

- **OS**: macOS, Linux, or Windows (WSL recommended)
- **Memory**: 4GB RAM minimum, 8GB recommended
- **Storage**: 2GB free space for Atlas and workspace data

## 🔧 Installation

### Option 1: Homebrew (Recommended)

```bash
# Add the Tempest tap
brew tap tempestteam/tap

# Install Atlas (choose your channel)
HOMEBREW_GITHUB_API_TOKEN=$(gh auth token) brew install tempest-atlas      # Stable
HOMEBREW_GITHUB_API_TOKEN=$(gh auth token) brew install tempest-atlas-nightly  # Nightly
HOMEBREW_GITHUB_API_TOKEN=$(gh auth token) brew install tempest-atlas-edge     # Edge

# Verify installation
atlas --version
```

### Option 2: Direct Binary

1. Download the latest release for your platform from
   [GitHub Releases](https://github.com/tempestteam/atlas/releases)
2. Extract and add the binary to your PATH
3. Verify: `atlas --version`

### Option 3: From Source

```bash
git clone https://github.com/tempestteam/atlas
cd atlas
deno task atlas --version
```

### Environment Setup

```bash
# Required: Anthropic API key
export ANTHROPIC_API_KEY="your-api-key-here"

# Optional: Default model configuration
export ATLAS_DEFAULT_MODEL="claude-sonnet-4-5"

# Optional: Atlas configuration directory
export ATLAS_HOME="$HOME/.atlas"

# Optional: Custom workspace discovery directories
# Unix/Linux/macOS (colon-separated paths)
export ATLAS_WORKSPACES_DIR="/path/to/workspaces:/another/workspace/dir"
# Windows (semicolon-separated paths)
export ATLAS_WORKSPACES_DIR="C:\workspaces;D:\projects\atlas-workspaces"
```

## 🤖 Daemon Management

Atlas uses a daemon architecture for centralized workspace management:

```bash
# Start the Atlas daemon
atlas daemon start

# Check daemon status
atlas daemon status

# Stop the daemon
atlas daemon stop

# Restart the daemon
atlas daemon restart

# View daemon logs
atlas daemon logs
```

The daemon:

- Manages all workspace lifecycles
- Provides HTTP API for CLI commands
- Caches workspace configurations securely
- Persists state across restarts

## 🏗️ Creating Your First Workspace

### Initialize a New Workspace

```bash
# Create workspace directory
mkdir my-workspace && cd my-workspace

# Initialize with Atlas
atlas init

# Or initialize with custom name
atlas init "My Custom Workspace"
```

This creates a `workspace.yml` file with basic configuration:

```yaml
version: "1.0"

workspace:
  name: "My Workspace"
  description: "AI agent workspace"

agents:
  assistant:
    type: "llm"
    model: "claude-sonnet-4-5"
    purpose: "General purpose AI assistant"
    prompts:
      system: "You are a helpful AI assistant."

signals:
  chat:
    provider: "cli"
    description: "Chat with the assistant"

jobs:
  chat-job:
    triggers:
      - signal: "chat"
    execution:
      strategy: "sequential"
      agents:
        - id: "assistant"
          input_source: "signal"
```

### Validate Configuration

```bash
# Check workspace configuration
atlas config validate

# See workspace info
atlas
```

## 🎯 Understanding Jobs and Signals

### Signals

Signals are triggers that start workflows:

```yaml
signals:
  webhook:
    provider: "http"
    endpoint: "/webhook"
    description: "Handle incoming webhooks"

  schedule:
    provider: "schedule"
    config:
      schedule: "0 9 * * MON"
    description: "Weekly Monday report"

  manual:
    provider: "cli"
    description: "Manual trigger"
```

### Jobs

Jobs define what happens when signals trigger:

```yaml
jobs:
  process-webhook:
    triggers:
      - signal: "webhook"
        condition: { "type": "deployment" }
    execution:
      strategy: "sequential"
      agents:
        - id: "validator"
          input_source: "signal"
        - id: "processor"
          input_source: "previous"
```

### Triggering Signals

```bash
# Trigger via CLI
atlas signal trigger manual

# Trigger with data
atlas signal trigger webhook --data '{"type":"deployment","env":"prod"}'

# Trigger in specific workspace
atlas signal trigger test --workspace my-workspace-id
```

## 📋 Example Workflows

### 1. Simple Chat Agent

```yaml
# workspace.yml
workspace:
  name: "Chat Assistant"

agents:
  chat-bot:
    type: "llm"
    model: "claude-sonnet-4-5"
    purpose: "Conversational assistant"
    prompts:
      system: "You are a helpful, friendly AI assistant."

signals:
  chat:
    provider: "cli"

jobs:
  chat-session:
    triggers:
      - signal: "chat"
    execution:
      agents:
        - id: "chat-bot"
```

```bash
# Usage
atlas signal trigger chat --data '{"message": "Hello!"}'
```

### 2. Multi-Agent Pipeline

```yaml
agents:
  analyzer:
    type: "llm"
    purpose: "Analyze input data"
    prompts:
      system: "Analyze the provided data and extract key insights."

  reporter:
    type: "llm"
    purpose: "Generate reports"
    prompts:
      system: "Create a comprehensive report based on the analysis."

jobs:
  analysis-pipeline:
    triggers:
      - signal: "analyze"
    execution:
      strategy: "sequential"
      agents:
        - id: "analyzer"
          input_source: "signal"
        - id: "reporter"
          input_source: "previous"
```

### 3. Scheduled Monitoring

```yaml
signals:
  daily-check:
    provider: "schedule"
    config:
      schedule: "0 9 * * *" # 9 AM daily

jobs:
  health-monitor:
    triggers:
      - signal: "daily-check"
    execution:
      agents:
        - id: "monitor"
          input_source: "signal"
```

## 🚨 Troubleshooting

### Common Issues

#### 1. Daemon Not Running

```bash
# Check daemon status
atlas daemon status

# Start if not running
atlas daemon start

# Check logs for errors
atlas daemon logs
```

#### 2. Workspace Not Found

```bash
# List registered workspaces
atlas

# Register current directory
cd my-workspace
atlas  # Auto-registers if workspace.yml exists
```

#### 3. Signal Trigger Failures

```bash
# Validate workspace config
atlas config validate

# Check signal definitions
atlas signal list

# Use correct signal name
atlas signal trigger correct-name --data '{}'
```

#### 4. Session Stuck or Failed

```bash
# List active sessions
atlas ps

# View session logs
atlas logs <session-id>

# Cancel if needed (sessions auto-cleanup)
```

### Debug Mode

```bash
# Start daemon with debug logging
ATLAS_LOG_LEVEL=debug atlas daemon start

# Run commands with verbose output
ATLAS_LOG_LEVEL=debug atlas signal trigger test
```

### Configuration Issues

```bash
# Validate workspace configuration
atlas config validate

# Check workspace detection
atlas daemon status

# Refresh workspace cache
atlas daemon restart
```

### Getting Help

- **Built-in Help**: Use `atlas --help`
- **Examples**: Check `examples/workspaces/` for working configurations
- **Documentation**: See `CLAUDE.md` for technical details
- **Community**: Join discussions on GitHub Issues

### Performance Tips

1. **Daemon Management**: Keep daemon running for best performance
2. **Config Caching**: Avoid frequent workspace.yml changes
3. **Session Monitoring**: Use `atlas ps` to track active sessions
4. **Log Management**: Logs auto-rotate; use specific session IDs

## 🎉 Next Steps

Once you're comfortable with the basics:

1. **Explore Examples**: Try the telephone game, k8s-assistant, or other example workspaces
2. **Custom Agents**: Create specialized agents for your use cases
3. **Advanced Signals**: Set up webhooks, cron schedules, or stream processing
4. **MCP Integration**: Connect to Model Context Protocol servers
5. **Memory & Context**: Configure persistent memory across sessions

For advanced topics, see [`CLAUDE.md`](CLAUDE.md) and the `docs/` directory.

Welcome to Atlas! 🚀
