# Atlas

AI agent orchestration platform that transforms software delivery through human/AI collaboration. Fixed binary compilation.

## Overview

Atlas enables engineers to create workspaces where humans collaborate seamlessly with specialized,
autonomous agents in a secure, auditable, and scalable environment.

### Key Features

- **Hierarchical Supervision** - Intelligent supervisors coordinate agent execution
- **Worker Isolation** - Each agent runs in isolated Deno Web Workers
- **Session Management** - Track and manage concurrent agent workflows
- **Configurable Signals** - Trigger workflows via CLI, webhooks, or schedules
- **Beautiful CLI** - Full-featured Ink-based terminal UI with tables and colors
- **Memory & Context** - Hierarchical memory management across sessions

## Getting Started

### Prerequisites

- [Deno](https://deno.land/) v2.0+
- Anthropic API key (for Claude) - [Get one here](https://console.anthropic.com/)

### Installation

```bash
git clone https://github.com/your-org/atlas.git
cd atlas
```

### Running Examples

All examples include helper scripts with OpenTelemetry integration enabled:

- **`start-server.sh`** - Starts the workspace server with proper flags
- **`trigger-signal.sh`** - Triggers the example workflow
- Both scripts include `OTEL_DENO=true` and `--unstable-otel` for telemetry

### Quick Start - Terminal UI (TUI)

The fastest way to get started is with Atlas's built-in terminal interface:

1. **Navigate to example workspace**

```bash
cd examples/workspaces/telephone
```

2. **Configure API key**

```bash
# Edit .env file with your actual Anthropic API key
ANTHROPIC_API_KEY=sk-ant-api03-...
```

3. **Launch Atlas TUI**

```bash
deno task atlas tui
```

This launches an interactive terminal interface that:

- ✅ **Auto-starts** the workspace server
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

### Alternative: Manual Command Line

If you prefer manual control or separate terminals:

1. **Start workspace server (Terminal 1)**

```bash
./start-server.sh
# Server starts on http://localhost:8080 with OpenTelemetry enabled
```

2. **Trigger a signal (Terminal 2)**

```bash
./trigger-signal.sh
# Runs the telephone game: mishearing → embellishment → reinterpretation
```

3. **Alternative: Use curl directly**

```bash
curl -X POST http://localhost:8080/signals/telephone-message \
  -H "Content-Type: application/json" \
  -d '{"message": "The cat sat on the mat"}'
```

4. **Monitor execution**

```bash
# List active sessions
deno task atlas ps

# Stream session logs  
deno task atlas logs <session-id>
```

## CLI Commands

### Terminal UI

```bash
atlas tui                       # Launch interactive terminal interface
# Features: auto-server startup, dual-panel logs, vi navigation, slash commands
```

### Workspace Management

```bash
atlas workspace init [name]     # Initialize workspace in current directory
atlas workspace serve           # Start workspace server
atlas workspace list            # List all workspaces  
atlas workspace status          # Show current workspace status
```

### Session Monitoring

```bash
atlas session list              # List all active sessions
atlas ps                        # Shorthand for session list
atlas session get <id>          # Show session details
atlas session cancel <id>       # Cancel running session
atlas logs <session-id>         # Stream session logs with colors
```

### Signal Management

```bash
atlas signal list               # List configured signals
atlas signal trigger <name> --data '{...}'  # Trigger a signal
atlas signal history            # Show trigger history
```

### Agent Management

```bash
atlas agent list                # List all agents
atlas agent describe <name>     # Show agent details
atlas agent test <name> -m "text"  # Test agent directly
```

## Workspace Configuration

Workspaces are configured via `workspace.yml`:

```yaml
version: "1.0"
workspace:
  id: "${WORKSPACE_ID}"
  name: "My Workspace"
  description: "AI agent workspace"

supervisor:
  model: "claude-4-sonnet-20250514"
  prompts:
    system: "You are the WorkspaceSupervisor..."
    intent: "Coordinate agents to achieve..."
    evaluation: "Mark complete when..."

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

runtime:
  server:
    port: 8080
    host: "localhost"
```

## Creating Custom Agents

```typescript
// agents/my-agent.ts
import { BaseAgent } from "atlas/core/agents/base-agent.ts";
import { AgentRegistry } from "atlas/core/agent-registry.ts";

export class MyAgent extends BaseAgent {
  name() {
    return "MyAgent";
  }
  purpose() {
    return "Performs specific task";
  }

  async *invokeStream(message: string) {
    // Your agent logic here
    const response = await this.generateLLM(
      "claude-4-sonnet-20250514",
      this.prompts.system,
      message,
    );
    yield response;
  }
}

// Register the agent
AgentRegistry.register("my", MyAgent);
```

## Architecture

```
┌─────────────────────────────────────────────┐
│            Workspace Server (HTTP)           │
├─────────────────────────────────────────────┤
│            WorkspaceRuntime (FSM)           │
├─────────────────────────────────────────────┤
│         WorkspaceSupervisor (Worker)        │
│                     ↓                       │
│  ┌────────────────────────────────────┐    │
│  │    SessionSupervisor (Worker)      │    │
│  │              ↓                     │    │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐  │
│  │  │ Agent 1 │ │ Agent 2 │ │ Agent 3 │  │
│  │  │(Worker) │ │(Worker) │ │(Worker) │  │
│  │  └─────────┘ └─────────┘ └─────────┘  │
│  └────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

### Key Components

- **WorkspaceServer** - HTTP server for signals and monitoring
- **WorkspaceRuntime** - Orchestrates supervisor and sessions
- **WorkspaceSupervisor** - AI-powered coordinator with global view
- **SessionSupervisor** - Manages individual signal processing sessions
- **Agents** - Isolated workers that execute specific tasks
- **BroadcastChannels** - Inter-worker communication

## Examples

### Telephone Game

Demonstrates agent chaining where messages transform through multiple agents:

```bash
cd examples/workspaces/telephone
# Add your ANTHROPIC_API_KEY to .env file first
deno task atlas workspace serve          # Terminal 1
curl -X POST http://localhost:8080/telephone -d '{"message": "The cat sat on the mat"}' # Terminal 2
```

**What happens:**

1. **Mishearing Agent** - Introduces phonetic errors and mishearing
2. **Embellishment Agent** - Adds creative details and context
3. **Reinterpretation Agent** - Dramatically transforms the meaning

Your message gets hilariously transformed through this chain!

**Sample Configuration:**

```yaml
# workspace.yml
jobs:
  telephone:
    triggers:
      - signal: "telephone-message"
        condition: {
          "and": [{ "var": "message" }, { ">": [{ "length": { "var": "message" } }, 0] }],
        }
    execution:
      strategy: "sequential"
      agents:
        - id: "mishearing-agent"
          input_source: "signal"
        - id: "embellishment-agent"
          input_source: "previous"
        - id: "reinterpretation-agent"
          input_source: "previous"
```

### More Examples Coming Soon

- Code Review Assistant
- Documentation Generator
- Test Suite Runner
- Deployment Pipeline

## Development

### Running Tests

```bash
deno test src/cli/tests/
```

### Code Style

```bash
deno fmt
deno lint
```

## Troubleshooting

- **"No workspace.yml found"** - Ensure you're in a workspace directory
- **"Cannot connect to server"** - Run `atlas workspace serve` first
- **"Agent not found"** - Check agent paths in workspace.yml
- **API errors** - Verify your Anthropic API key in .env
