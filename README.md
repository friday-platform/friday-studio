# Atlas

AI agent orchestration platform that transforms software delivery through human/AI collaboration.

## Overview

Atlas enables engineers to create workspaces where humans collaborate seamlessly with specialized,
autonomous agents in a secure, auditable, and scalable environment.

### Key Features

- **Daemon Architecture** - Central daemon manages all workspace lifecycles
- **Hierarchical Supervision** - Intelligent supervisors coordinate agent execution
- **Worker Isolation** - Each agent runs in isolated Deno Web Workers
- **Session Management** - Track and manage concurrent agent workflows
- **Configurable Signals** - Trigger workflows via CLI, webhooks, or schedules
- **Beautiful CLI** - Full-featured Ink-based terminal UI with tables and colors
- **Memory & Context** - Hierarchical memory management across sessions
- **Config Caching** - Secure, performant workspace configuration management

## Getting Started

### Prerequisites

- [Deno](https://deno.land/) 2.4.0+ installed
- Anthropic API key (for Claude) - [Get one here](https://console.anthropic.com/)

### Installation

#### Option 1: Direct Binary (Recommended)

Download from [releases](https://github.com/tempestteam/atlas/releases):

**macOS:**
- Download the `.pkg` installer (recommended) - supports both Intel and Apple Silicon
- Or download the `.tar.gz` archive and extract to `/usr/local/bin/`

**Linux:**
- Download the `.tar.gz` archive for your architecture (amd64 or arm64)
- Extract and move to `/usr/local/bin/`

**Windows:**
- Download the `.msi` installer (recommended) 
- Or download the `.zip` archive and add to PATH

All binaries are signed and notarized for security.

#### Option 2: Homebrew

Atlas is available in three channels to suit different usage patterns:

```bash
# Add the Tempest tap
brew tap tempestteam/tap

# Choose your channel:

# Stable Channel (Default) - Official releases only
HOMEBREW_GITHUB_API_TOKEN=$(gh auth token) brew install tempest-atlas

# Nightly Channel - Daily builds  
HOMEBREW_GITHUB_API_TOKEN=$(gh auth token) brew install tempest-atlas-nightly

# Edge Channel - Bleeding edge builds from every commit (⚠️ unstable)
HOMEBREW_GITHUB_API_TOKEN=$(gh auth token) brew install tempest-atlas-edge

# Verify installation
atlas --help
atlas --version  # Shows channel-specific version info
```

#### Option 3: From Source

```bash
git clone https://github.com/tempestteam/atlas
cd atlas
deno task atlas --version
```

### Quick Start

1. **Set up environment**

```bash
# Add your Anthropic API key
export ANTHROPIC_API_KEY="your-api-key-here"

# Optional: Configure custom model defaults
export ATLAS_DEFAULT_MODEL="claude-3-5-sonnet-20241022"
```

2. **Start the Atlas daemon**

```bash
# Start daemon in background
atlas daemon start

# Check daemon status
atlas daemon status
```

3. **Initialize a workspace**

```bash
# Create new workspace
mkdir my-workspace && cd my-workspace
atlas init

# Or try an example workspace
cd examples/workspaces/telephone
```

4. **Launch Atlas Interactive Mode**

```bash
# Interactive terminal interface
atlas
```

This launches an interactive terminal interface that:

- ✅ **Auto-detects** registered workspaces
- ✅ **Real-time logs** in dual-panel layout
- ✅ **Vi-style navigation** (j/k/gg/G/Ctrl+D/U)
- ✅ **Slash commands** for all Atlas operations
- ✅ **Help system** - type `help` to see available commands
- ✅ **Copy to clipboard** - press `y` on any selected line

**TUI Navigation:**

- `Tab` / `Shift+Tab` - Switch between panels
- `j/k` - Navigate up/down
- `gg` / `G` - Jump to top/bottom
- `Ctrl+D/U` - Page up/down
- `/` - Start typing commands
- `y` - Copy selected line to clipboard
- `Enter` - Expand long content or copy command
- `Esc` - Close expanded view

**Try these commands in the TUI:**

```bash
help                                    # Show all commands
/signal list                           # List available signals
/signal trigger telephone-message --data {"message": "Hello"}
/session list                          # View active sessions
/ps                                    # List sessions (shorthand)
```

## CLI Commands

### Daemon Management

```bash
atlas daemon start                 # Start Atlas daemon
atlas daemon stop                  # Stop Atlas daemon  
atlas daemon status                # Check daemon status
atlas daemon restart               # Restart daemon
```

### Interactive Interface

```bash
atlas                              # Launch interactive mode
# Features: workspace detection, dual-panel logs, vi navigation, slash commands
```

### Workspace Management

```bash
atlas init [name]                  # Initialize workspace in current directory
atlas ps                           # List all active sessions across workspaces
atlas config validate              # Validate workspace configuration
```

### Session Monitoring

```bash
atlas ps                           # List all active sessions
atlas logs <session-id>            # Stream session logs with colors
```

### Signal Management

```bash
atlas signal trigger <name>        # Trigger a signal in current workspace
atlas signal trigger <name> --workspace <id>  # Trigger in specific workspace
atlas signal trigger <name> --data '{"key":"value"}'  # Trigger with payload
```

## Workspace Configuration

Workspaces are configured via `workspace.yml` (workspace ID is auto-generated):

```yaml
version: "1.0"

workspace:
  name: "My Workspace"
  description: "AI agent workspace"

agents:
  my-agent:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Agent purpose description"
    prompts:
      system: "You are an AI agent that..."

signals:
  my-signal:
    provider: "cli"
    description: "Trigger description"

jobs:
  my-job:
    triggers:
      - signal: "my-signal"
        condition: { "var": "payload" }
    execution:
      strategy: "sequential"
      agents:
        - id: "my-agent"
          input_source: "signal"
```

## Architecture

Atlas uses a modern daemon-based architecture:

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Atlas CLI     │───▶│  Atlas Daemon   │───▶│ Workspace Mgr   │
│  (Commands)     │    │   (HTTP API)    │    │ (KV Storage)    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                │
                                ▼
                       ┌─────────────────┐
                       │ Workspace       │
                       │ Runtime         │
                       │ (Web Workers)   │
                       └─────────────────┘
```

### Key Benefits

- **Config Caching**: Workspace configurations loaded once and cached with SHA-256 hashing
- **No File I/O at Signal Time**: Secure and performant signal processing
- **Unified API**: All CLI commands route through daemon API
- **Persistent State**: Workspace registrations survive daemon restarts
- **Auto-Discovery**: Automatic workspace detection and import

## Examples

Explore example workspaces in `examples/workspaces/`:

- **[telephone](examples/workspaces/telephone/)** - Multi-agent telephone game with provider
  diversity
- **[k8s-assistant](examples/workspaces/k8s-assistant/)** - Kubernetes management with real-time
  monitoring
- **[playwright-mcp](examples/workspaces/playwright-mcp/)** - Web automation via MCP integration
- **[multi-purpose-dev](examples/workspaces/multi-purpose-dev/)** - Comprehensive development
  workspace

Each workspace includes:

- Complete `workspace.yml` configuration
- Agent definitions and prompts
- Signal and job specifications
- Setup and usage instructions

## Development

### Running from Source

```bash
# Start daemon
deno task atlas daemon start

# Run interactive mode
deno task atlas

# Run specific commands
deno task atlas ps
deno task atlas signal trigger test
```

### Testing

```bash
# Run all tests
deno test --allow-all

# Run with type checking
deno check src/cli.tsx && deno test --allow-all

# Format code
deno fmt
```

### Architecture Documentation

See [`CLAUDE.md`](CLAUDE.md) for comprehensive development guidelines and architecture details.

## Troubleshooting

### Common Issues

1. **Daemon not running**: Use `atlas daemon start` to start the daemon
2. **Workspace not found**: Use `atlas` to see registered workspaces
3. **Signal failures**: Check workspace configuration with `atlas config validate`
4. **Permission errors**: Ensure proper file permissions in workspace directory

### Debug Mode

```bash
# Enable verbose logging
ATLAS_LOG_LEVEL=debug atlas daemon start

# Check daemon logs
atlas daemon logs
```

### Getting Help

- Use `atlas --help` for command reference
- Use `help` command in interactive mode
- Check [`CLAUDE.md`](CLAUDE.md) for development guidelines
- View example workspaces for configuration patterns

## License

This project is licensed under the MIT License - see the LICENSE file for details.

# Test trigger
