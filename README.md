# Atlas

AI agent orchestration platform that transforms software delivery through human/AI collaboration.

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
- Anthropic API key (for Claude)

### Installation

```bash
git clone https://github.com/your-org/atlas.git
cd atlas
```

### Quick Start - Telephone Game Example

1. **Navigate to example workspace**

```bash
cd examples/workspaces/telephone
```

2. **Initialize workspace** (or use existing config)

```bash
deno task atlas workspace init
# This creates workspace.yml if it doesn't exist
```

3. **Configure API key**

```bash
# Edit .env file
ANTHROPIC_API_KEY=your_actual_api_key_here
```

4. **Start workspace server**

```bash
deno task atlas workspace serve
# Server starts on http://localhost:8080
```

5. **Trigger a signal** (new terminal)

```bash
deno task atlas signal trigger telephone-message --data '{"message": "The cat sat on the mat"}'
```

6. **Monitor execution**

```bash
# List active sessions
deno task atlas ps

# Stream session logs  
deno task atlas logs <session-id>
```

## CLI Commands

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
    type: "local"
    path: "./agents/my-agent.ts"
    model: "claude-4-sonnet-20250514"
    purpose: "Agent purpose description"

signals:
  my-signal:
    provider: "cli"
    description: "Trigger description"
    mappings:
      - agents: ["my-agent"]
        strategy: "sequential"
        prompt: "Process this signal by..."

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
deno task atlas workspace serve
# In another terminal
deno task atlas signal trigger telephone-message --data '{"message": "Hello world"}'
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
