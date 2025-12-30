# Friday Getting Started Guide

Welcome to **Friday** - the comprehensive AI agent orchestration platform that transforms software
delivery through human/AI collaboration.

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Daemon Management](#daemon-management)
- [Troubleshooting](#troubleshooting)

## 🚀 Quick Start

Get Friday running in 5 minutes:

```bash
# 1. Install Friday (Homebrew recommended)
brew tap tempestteam/tap
HOMEBREW_GITHUB_API_TOKEN=$(gh auth token) brew install tempest-atlas

# 2. Set up environment
export ANTHROPIC_API_KEY="your-key-here"

# 3. Start the Friday daemon
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

- **OS**: macOS, Linux
- **Memory**: 4GB RAM minimum, 8GB recommended
- **Storage**: 2GB free space for Friday and workspace data

### Environment Setup

```bash
# Required: Anthropic API key
export ANTHROPIC_API_KEY="your-api-key-here"

# Optional: Default model configuration
export ATLAS_DEFAULT_MODEL="claude-sonnet-4-5"

# Optional: Friday configuration directory
export ATLAS_HOME="$HOME/.atlas"

# Optional: Custom workspace discovery directories
# Unix/Linux/macOS (colon-separated paths)
export ATLAS_WORKSPACES_DIR="/path/to/workspaces:/another/workspace/dir"
```

## 🤖 Daemon Management

Friday uses a daemon architecture for centralized workspace management:

```bash
# Start the Friday daemon
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

### Triggering Signals

```bash
# Trigger via CLI
atlas signal trigger manual

# Trigger with data
atlas signal trigger webhook --data '{"type":"deployment","env":"prod"}'

# Trigger in specific workspace
atlas signal trigger test --workspace my-workspace-id
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

Welcome to Friday! 🚀
