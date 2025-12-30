# Friday

AI agent orchestration platform that transforms software delivery through human/AI collaboration.

## Overview

Friday enables engineers to create workspaces where humans collaborate seamlessly with specialized,
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
- Anthropic API key (for Claude) - [Get one here](https://hellofriday.ai/)

### Installation

#### Option 1: Direct Binary (Recommended)

Download from [releases](https://github.com/tempestteam/atlas/releases):

**macOS:**

- Download the Friday installer `.zip` file (recommended) - Professional installation experience
  with:
  - License agreement integration
  - Optional API key collection and secure storage
  - Automatic PATH configuration
  - Automatic service installation and startup
  - Support for both Intel and Apple Silicon
- Or download the `.tar.gz` archive and extract to `/usr/local/bin/`

**Linux:**

- Download the native package for your distribution (recommended):
  - `.deb` file for Debian/Ubuntu - Features interactive installation with:
    - License agreement acceptance
    - API key configuration
    - Automatic systemd service setup
    - Dedicated atlas system user
  - `.rpm` file for RedHat/Fedora - Features post-install configuration
- Or download the `.tar.gz` archive for your architecture (amd64 or arm64) and extract to
  `/usr/local/bin/`

**Windows:**

- Download the Friday installer `.exe` file (recommended) - Complete installation experience
  featuring:
  - License agreement and professional UI
  - API key collection and secure storage in ~/.atlas/.env
  - Automatic PATH configuration and system integration
  - Automatic scheduled task creation for service startup
- Or download the `.zip` archive and add to PATH

All binaries are signed and notarized for security.

#### Option 2: Homebrew

Friday is available in three channels to suit different usage patterns:

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
export ATLAS_DEFAULT_MODEL="claude-sonnet-4-5"

# Optional: Specify custom directories for workspace discovery
# Unix/Linux/macOS (use colon separator for multiple paths)
export ATLAS_WORKSPACES_DIR="/path/to/workspaces:/another/path"
# Windows (use semicolon separator for multiple paths)
export ATLAS_WORKSPACES_DIR="C:\path\to\workspaces;D:\another\path"
```

2. **Start the Friday daemon**

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

4. **Launch Friday Interactive Mode**

```bash
# Interactive terminal interface
atlas
```

This launches an interactive terminal interface that:

- ✅ **Auto-detects** registered workspaces
- ✅ **Real-time logs** in dual-panel layout
- ✅ **Vi-style navigation** (j/k/gg/G/Ctrl+D/U)
- ✅ **Slash commands** for all Friday operations
- ✅ **Help system** - type `help` to see available commands
- ✅ **Copy to clipboard** - press `y` on any selected line

**Try these commands:**

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
atlas daemon start                 # Start Friday daemon
atlas daemon stop                  # Stop Friday daemon
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
    model: "claude-sonnet-4-5"
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

Friday uses a modern daemon-based architecture:

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Friday CLI     │───▶│  Friday Daemon   │───▶│ Workspace Mgr   │
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

### Actor System Type Safety

Friday implements a type-safe actor hierarchy with full TypeScript support:

#### Actor Hierarchy

```typescript
WorkspaceRuntime → WorkspaceSupervisor → SessionSupervisor → AgentExecutionActor
```

Each actor level has:

- **Strongly-typed interfaces** with discriminated unions
- **Type-safe configuration slices** (no `any` types)
- **Validated payloads** using Zod schemas
- **Context-aware XState machines** with typed events

#### Key Type Safety Features

1. **Discriminated Actor Types**
   ```typescript
   type ActorConfig =
     | { type: "workspace"; config: WorkspaceSupervisorConfig }
     | { type: "session"; config: SessionSupervisorConfig }
     | { type: "agent"; config: AgentExecutionConfig };
   ```

2. **Type-Safe Payloads**
   - All inter-actor messages validated with Zod
   - Consistent camelCase field naming
   - Session context preserved through hierarchy

3. **Configuration Encapsulation**
   - Each actor receives only its required config slice
   - No configuration reconstruction or transformation
   - Direct type-safe access using Config V2 helpers

4. **XState Integration**
   - Typed actor references (no `any` refs)
   - Context narrowing in state transitions
   - Type-safe event discrimination

See [`docs/ACTOR_TYPE_SAFETY_PLAN.md`](docs/ACTOR_TYPE_SAFETY_PLAN.md) for implementation details.

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

## AI-Assisted Development Workflow

This repo includes Claude slash commands that support a structured planning-to-execution flow:

### 1. Design Phase: `/brainstorm`

Start with a rough idea. Claude uses Socratic questioning to refine it into a concrete design:
- One question at a time (multiple choice when possible)
- Explores 2-3 approaches with trade-offs
- Presents design in small sections for incremental validation
- Outputs a plan document to `docs/plans/`

```
/brainstorm I want to add real-time collaboration to workspaces
```

### 2. Planning Phase: `/make-beads`

Convert the validated design into trackable work items:
- Creates an epic with tasks and subtasks
- Establishes dependency structure
- Adds implementation details to each bead

```
/make-beads docs/plans/2024-12-30-realtime-collab-design.md
```

### 3. Refinement: `/improve-beads`

Polish beads for worker consumption (1-3 iterations until satisfied):
- Makes instructions unambiguous and implementation-ready
- Researches codebase to fill gaps
- Surfaces unresolved questions

```
/improve-beads
```

### 4. Prioritization: `/whats-next`

Uses `bv` and `bd` to identify which beads are ready and highest priority based on the dependency graph.

```
/whats-next
```

### 5. Execution: `/spawn-worker`

Spawns sub-agents to execute beads in parallel:
- One agent per bead
- Each agent: claims → implements → commits → closes

```
/spawn-worker pick up bv-12 and bv-15, they can be done in parallel
```

## Development

### Prerequisites

Before contributing, install these tools:

**Beads** (issue tracking):

```bash
brew install steveyegge/beads/bd
```

**Beads Viewer** (TUI for beads):

```bash
curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_viewer/main/install.sh?$(date +%s)" | bash
```

**Git Hooks** (run once after cloning):

```bash
npx husky
```

This configures pre-commit hooks for linting and post-checkout hooks that auto-initialize beads when switching branches.

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

### Code Quality with Knip

[Knip](https://knip.dev/) is a dead code detection tool that finds and removes unused dependencies, exports, and files in JavaScript and TypeScript projects. Friday uses Knip to maintain a clean codebase by identifying code that's no longer referenced.

#### Running Knip

```bash
# Analyze all code (production + tests)
npx knip

# Analyze only production code
npx knip --production

# Show detailed debug output
npx knip --debug
```

#### Understanding Knip Modes

Friday configures Knip with two distinct analysis modes:

**Regular Mode** (`npx knip`):
- Analyzes all code including tests and test utilities
- Test files are treated as entry points
- Code imported by tests is marked as "used"
- Identifies truly dead code that nothing references
- Best for: Finding code not used anywhere in the project

**Production Mode** (`npx knip --production`):
- Analyzes only code marked with `!` in `knip.json`
- Excludes test files and test utilities
- Identifies code only used by tests (not in production)
- Shows test helpers as "unused" since they're not production code
- Best for: Finding code that can be removed from production builds

#### Configuration

The `knip.json` file uses these patterns:

```json
{
  "entry": [
    "mod.ts!",           // Production entry (! marker)
    "tests/**/*.test.ts" // Test entry (no marker)
  ],
  "project": [
    "src/**/*.ts!",      // Production code (! marker)
    "tests/**/*.ts"      // Test code (no marker)
  ]
}
```

Production code is marked with `!` suffixes, while test code remains unmarked. This distinction enables Knip to differentiate between production and test dependencies.

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
