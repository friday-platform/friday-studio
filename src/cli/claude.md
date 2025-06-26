# Atlas CLI Documentation

This documentation covers the Atlas Command Line Interface (CLI) and Terminal User Interface (TUI)
implementation.

## Overview

The Atlas CLI provides both direct command execution and an interactive Terminal User Interface
(TUI) for managing Atlas workspaces and AI agent orchestration. The CLI offers standalone commands
for workspace management, while the TUI provides an interactive environment for real-time monitoring
and control.

## Architecture

### Core Components

#### CLI Entry Point (`src/cli.tsx`)

- Main CLI application using Meow for argument parsing
- Command routing and execution
- Integrates with WorkspaceRuntime for orchestration

#### Command Components (`src/cli/commands/`)

- **workspace.tsx**: Workspace management operations
- **session.tsx**: Session lifecycle and monitoring
- **signal.tsx**: Signal triggering and configuration
- **agent.tsx**: Agent discovery and management
- **logs.tsx**: Session log viewing and analysis

#### TUI Implementation (`src/cli/commands/tui.tsx`)

- Full-screen terminal interface built with Ink and React
- Two modes: Splash Screen (no workspace) and Normal TUI (workspace loaded)
- Real-time server monitoring and command execution

#### Component Structure

```
src/cli/
├── commands/           # CLI command implementations
│   ├── workspace.tsx   # Workspace operations
│   ├── workspaces.tsx  # List available workspaces
│   ├── session.tsx     # Session management
│   ├── signal.tsx      # Signal operations
│   ├── agent.tsx       # Agent management
│   ├── logs.tsx        # Log viewing
│   ├── help.tsx        # Help and usage information
│   └── tui.tsx         # Terminal User Interface
├── components/         # Shared UI components
│   ├── tabs.tsx        # Tab navigation (TUI)
│   ├── splash-screen.tsx # Workspace selection (TUI)
│   ├── Table.tsx       # Data display
│   ├── StatusBadge.tsx # Status indicators
│   └── LogViewer.tsx   # Log display
└── claude.md          # This documentation file
```

---

# CLI Commands

The Atlas CLI provides comprehensive workspace and session management through standalone commands.

## Command Structure

```bash
atlas <command> [subcommand] [args] [flags]
```

## Core Commands

### `workspace` | `work`

Workspace lifecycle management.

```bash
atlas workspace status             # Show workspace status
atlas workspace list               # List available workspaces
atlas workspace init [name]        # Initialize new workspace
atlas workspace validate           # Validate workspace configuration
```

### `session` | `sesh` | `sess`

Session monitoring and management.

```bash
atlas session list                 # List active sessions
atlas session get <session-id>     # Get session details
atlas session kill <session-id>    # Terminate session
atlas session watch <session-id>   # Watch session in real-time

# Aliases
atlas sesh list                    # Same as session list
atlas sess get <id>                # Same as session get <id>
```

### `ps`

Process status - alias for `session list`.

```bash
atlas ps                           # List all active sessions
```

### `signal` | `sig`

Signal management and triggering.

```bash
atlas signal list                  # List configured signals
atlas signal trigger <name>        # Trigger signal manually
atlas signal trigger <name> --data '{"key":"value"}'  # Trigger with payload
atlas signal describe <name>       # Show signal configuration
atlas signal test <name>           # Test signal configuration

# Aliases
atlas sig list                     # Same as signal list
atlas sig trigger <name>           # Same as signal trigger <name>
```

### `agent`

Agent discovery and management.

```bash
atlas agent list                   # List workspace agents
atlas agent describe <name>        # Show agent details
atlas agent status <name>          # Check agent health
atlas agent test <name>            # Test agent connectivity
```

### `logs` | `log`

Session log viewing and analysis.

```bash
atlas logs <session-id>            # View session logs
atlas log <session-id>             # Same as logs
atlas logs <session-id> --follow   # Follow logs in real-time
atlas logs <session-id> --filter performance  # Filter by type
```

### `workspaces`

List all available workspaces.

```bash
atlas workspaces                   # List all available workspaces with descriptions
```

### `tui`

Launch the Terminal User Interface.

```bash
atlas tui                          # Start interactive TUI
atlas tui --workspace <name>       # Start TUI with specific workspace loaded
```

## Global Flags

```bash
--help, -h                         # Show help for command
--version, -v                      # Show Atlas version
--workspace, -w <path>             # Specify workspace directory
--config, -c <file>                # Use custom configuration file
--verbose                          # Enable verbose output
--json                             # Output in JSON format
--no-color                         # Disable colored output
```

## Usage Examples

### Basic Workspace Operations

```bash
# Initialize and start a workspace
atlas workspace init my-project
cd my-project
atlas daemon start

# Check status
atlas workspace status
```

### Signal Operations

```bash
# List and trigger signals
atlas signal list
atlas signal trigger webhook-handler --data '{"event": "deploy"}'

# Using aliases
atlas sig trigger my-signal
```

### Session Management

```bash
# Monitor sessions
atlas ps                           # List all sessions
atlas session get sess_123         # Get specific session
atlas logs sess_123 --follow       # Follow session logs
```

### Agent Management

```bash
# Discover and test agents
atlas agent list
atlas agent describe k8s-agent
atlas agent test k8s-agent
```

---

# Terminal User Interface (TUI)

The TUI provides an interactive environment for real-time workspace monitoring and control.

## Launch TUI

```bash
atlas tui                          # Start from any directory
```

## TUI Modes

### Splash Screen Mode

Activated when no `workspace.yml` exists in current directory:

- **Workspace Discovery**: Automatically scans `examples/workspaces/` for available workspaces
- **Interactive Selection**: Navigate with j/k or arrow keys, Enter to load
- **Quick Start Options**: `/init` command and reload functionality
- **Visual Layout**: 70% left column (info/commands), 30% right column (workspaces)

### Normal TUI Mode

Activated when workspace is loaded:

- **Dual-Tab Interface**:
  - **Conversation Tab**: User commands, CLI responses, and system messages
  - **Server Output Tab**: Real-time daemon logs with performance indicators

- **Advanced Navigation**:
  - `j/k` or arrow keys: Navigate logs
  - `gg/G`: Jump to top/bottom
  - `J/K` (Shift): Page up/down
  - `Ctrl+D/U`: Page navigation
  - `y`: Copy selected log to clipboard
  - `Tab`: Switch between tabs or refocus input

## TUI Command System

### Startup Behavior

The TUI automatically:

1. **Detects existing servers**: Checks `/health` endpoint on port 8080
2. **Connects to running servers**: Shows server state and session count
3. **Falls back gracefully**: Starts new server if none found
4. **Provides feedback**: Clear status messages for all connection states

### Slash Commands (Normal Mode)

All commands must be prefixed with `/`:

```bash
/workspace status          # Show workspace status
/workspace list           # List available workspaces
/signal list             # List configured signals
/signal trigger <name>   # Trigger a signal manually
/session list            # List active sessions
/session get <id>        # Get session details
/agent list              # List workspace agents
/agent describe <name>   # Describe specific agent
/ps                      # Show process status
/logs <session-id>       # View session logs
/help                    # Show command help
```

### Special Commands (Splash Mode)

```bash
/init                    # Initialize new workspace
reload                   # Reload TUI after workspace creation
help                     # Show help information
```

## TUI Input Handling

### Command Parsing

- Preserves JSON structure in arguments
- Handles quoted strings and nested objects
- Supports complex signal payloads

### Paste Detection

- Automatically detects rapid input (paste operations)
- Shows visual indicators for pasted content
- Prevents accidental command execution on large pastes

### Signal Integration

- Direct HTTP API calls to Atlas daemon
- Real-time signal triggering with JSON payload validation
- Automatic server port detection and routing

## TUI Implementation Details

### State Management

```typescript
interface LogEntry {
  type: "server" | "user" | "command" | "error";
  content: string;
  timestamp: string;
  fullContent?: string;
  isPasted?: boolean;
}

interface ServerStatus {
  running: boolean;
  port?: number;
  workspace?: string;
  error?: string;
}
```

### Server Integration

- **Smart Connection**: Automatically detects existing Atlas daemon via `/health` endpoint
- **Process Management**: Connects to Atlas daemon for workspace management
- **Output Streaming**: Real-time log capture with ANSI escape sequence cleaning
- **Health Monitoring**: Automatic server status detection and port discovery
- **Signal Handling**: Clean shutdown with Ctrl+C
- **Fallback Logic**: Gracefully falls back to starting new server if connection fails

### Performance Features

- **Log Filtering**: Special indicators for `[PERF]`, `[DEBUG]`, and OpenTelemetry logs
- **Memory Management**: Limits server logs to last 150 entries, keeps all conversation logs
- **Auto-scrolling**: Configurable with Ctrl+A toggle
- **Responsive UI**: Immediate character input with paste detection

### Workspace Management

#### Discovery Algorithm

1. Find git repository root
2. Scan `examples/workspaces/` directory
3. Parse `workspace.yml` files for metadata
4. Sort alphabetically by workspace name

#### Loading Process

1. Change working directory to workspace path
2. Verify `workspace.yml` exists
3. Exit splash screen mode
4. Connect to Atlas daemon
5. Initialize normal TUI mode

---

# Development Guidelines

## TUI Component Rules

1. **Always wrap `<Text>` components in `<Box>`** for proper layout
2. **No unnecessary emojis** unless explicitly requested
3. **Consistent color scheme**:
   - Cyan: User input and navigation hints
   - Magenta: Commands and system messages
   - Red: Errors
   - Yellow: Warnings and workspace names
   - Green: Success and status indicators

## Interactive CLI Guidelines

When working with the interactive CLI component (src/cli/commands/interactive.tsx):

1. **Preserve Interactive History**: NEVER clear the interactive history state (`setOutput([])`).
   The interactive CLI should ALWAYS append new outputs to the existing history.
2. **Clear Command Behavior**: The `/clear` command should only clear the terminal display using
   `console.clear()`, not the React state that contains the interactive history.
3. **Append Only**: All command outputs should be appended to the existing output array using
   `setOutput(prev => [...prev, newOutput])` pattern.

## Error Handling

- Graceful degradation when workspace unavailable
- Timeout handling for long-running operations (10s default)
- Network error recovery for signal operations
- Invalid JSON payload validation

## Testing Considerations

- All signals manually triggerable for testing
- Workspace switching without CLI restart
- Server process isolation and cleanup
- Cross-platform compatibility (macOS, Linux)

---

# Configuration Integration

## Workspace Requirements

- Valid `workspace.yml` in workspace directory
- Proper agent configurations (Tempest, LLM, Remote)
- Signal-to-job mappings for TUI command routing

## Environment Variables

```bash
OTEL_DENO=true                              # Enable OpenTelemetry
OTEL_SERVICE_NAME=atlas-tui                 # Service identification
OTEL_SERVICE_VERSION=1.0.0                  # Version tracking
ANTHROPIC_API_KEY=<key>                     # LLM functionality
```

---

# Future Enhancements

Based on the Atlas platform architecture outlined in the root CLAUDE.md, the CLI will be enhanced to
provide comprehensive workspace and session management capabilities.

## Core Session Management

### Session Execution

```bash
# Start new session in specific workspace
deno task atlas run --workspace=[workspace_id]
deno task atlas run --workspace=k8s-assistant

# Start session with specific signal/job
deno task atlas run --workspace=[workspace_id] --signal=[signal_name]
deno task atlas run --workspace=k8s-assistant --signal=http-k8s
```

### Session Discovery and Navigation

```bash
# List all sessions for a workspace
deno task atlas sessions --workspace=[workspace_id]
deno task atlas sessions --workspace=k8s-assistant

# Navigate/view specific session details
deno task atlas sessions --session_id=[session_id]
deno task atlas sessions --session_id=sess_abc123

# Filter sessions by status, agent, or time range
deno task atlas sessions --workspace=[workspace_id] --status=active
deno task atlas sessions --workspace=[workspace_id] --agent=k8s-main-agent
deno task atlas sessions --workspace=[workspace_id] --since=2024-01-01
```

## Workspace Management

### Agent Management

```bash
# Add new agents to workspace
deno task atlas add-agent --workspace=[workspace_id] --source=[url]
deno task atlas add-agent --workspace=k8s-assistant --source=https://github.com/company/custom-agent
deno task atlas add-agent --workspace=k8s-assistant --source=./local-agent.yml

# List and manage workspace agents
deno task atlas agents --workspace=[workspace_id]
deno task atlas remove-agent --workspace=[workspace_id] --agent=[agent_name]
deno task atlas update-agent --workspace=[workspace_id] --agent=[agent_name]
```

### Workspace Configuration

```bash
# Validate workspace configuration
deno task atlas validate --workspace=[workspace_id]

# Export/import workspace configurations
deno task atlas export --workspace=[workspace_id] --output=workspace-backup.yml
deno task atlas import --workspace=[workspace_id] --config=workspace-backup.yml

# Clone workspace configurations
deno task atlas clone --source=[workspace_id] --target=[new_workspace_id]
```

## Advanced Signal and Job Management

### Signal Operations

```bash
# Advanced signal triggering with workspace context
deno task atlas trigger --workspace=[workspace_id] --signal=[signal_name] --data='{"key":"value"}'

# Signal history and analytics
deno task atlas signal-history --workspace=[workspace_id] --signal=[signal_name]
deno task atlas signal-analytics --workspace=[workspace_id] --timeframe=7d
```

### Job Management

```bash
# List and manage jobs within workspaces
deno task atlas jobs --workspace=[workspace_id]
deno task atlas job-status --workspace=[workspace_id] --job=[job_name]

# Create jobs from natural language descriptions
deno task atlas create-job --workspace=[workspace_id] --description="Monitor K8s pods and alert on failures"
```

## Memory and Context Management

### Session Memory

```bash
# Query session memory and context
deno task atlas memory --session_id=[session_id]
deno task atlas context --session_id=[session_id] --agent=[agent_name]

# Manage workspace-level memory
deno task atlas memory --workspace=[workspace_id] --type=shared
deno task atlas memory-cleanup --workspace=[workspace_id] --older-than=30d
```

### Cross-Session Intelligence

```bash
# Find related sessions based on context similarity
deno task atlas related-sessions --session_id=[session_id]
deno task atlas session-patterns --workspace=[workspace_id] --pattern="deployment-failures"
```

## Performance and Monitoring

### Real-time Monitoring

```bash
# Monitor workspace performance in real-time
deno task atlas monitor --workspace=[workspace_id]
deno task atlas monitor --workspace=[workspace_id] --agent=[agent_name]

# Performance analytics and cost tracking
deno task atlas analytics --workspace=[workspace_id] --metrics=performance,cost,usage
deno task atlas cost-report --workspace=[workspace_id] --period=monthly
```

### Debug and Troubleshooting

```bash
# Advanced debugging capabilities
deno task atlas debug --session_id=[session_id] --verbose
deno task atlas trace --workspace=[workspace_id] --operation=[operation_id]

# Health checks and diagnostics
deno task atlas health-check --workspace=[workspace_id]
deno task atlas diagnose --workspace=[workspace_id] --issue-type=performance
```

## Workspace Templates and Collaboration

### Template System

```bash
# Create workspace from templates
deno task atlas create --template=kubernetes-ops --workspace=[new_workspace_id]
deno task atlas create --template=web-deployment --workspace=[new_workspace_id]

# Export workspace as template
deno task atlas create-template --workspace=[workspace_id] --template-name=custom-template
```

### Collaboration Features

```bash
# Share workspaces and sessions
deno task atlas share --workspace=[workspace_id] --with=[user_email]
deno task atlas share-session --session_id=[session_id] --with=[user_email]

# Workspace access management
deno task atlas permissions --workspace=[workspace_id] --user=[user_email] --role=viewer
```

## Integration Capabilities

### MCP Gateway Integration

```bash
# Configure Model Context Protocol servers
deno task atlas mcp add --workspace=[workspace_id] --server=[mcp_server_url]
deno task atlas mcp list --workspace=[workspace_id]
```

### CI/CD Integration

```bash
# Use workspace agents as intelligent checks
deno task atlas check --workspace=[workspace_id] --target=pull-request
deno task atlas validate-deployment --workspace=[workspace_id] --manifest=k8s-manifest.yml
```

### External System Integration

```bash
# Connect to external monitoring and alerting
deno task atlas connect --workspace=[workspace_id] --service=datadog --api-key=[key]
deno task atlas webhook --workspace=[workspace_id] --endpoint=[webhook_url]
```

## Advanced Analytics and Intelligence

### Pattern Recognition

```bash
# Identify patterns in session data
deno task atlas patterns --workspace=[workspace_id] --type=failures
deno task atlas recommendations --workspace=[workspace_id] --based-on=session-history
```

### Predictive Capabilities

```bash
# Predict potential issues based on historical data
deno task atlas predict --workspace=[workspace_id] --scenario=deployment-risk
deno task atlas optimize --workspace=[workspace_id] --target=cost,performance
```

## Implementation Priority

### Phase 1: Core Session Management (Q1 2025)

- Session execution with workspace targeting
- Session listing and navigation
- Basic workspace agent management

### Phase 2: Advanced Workspace Operations (Q2 2025)

- Dynamic agent addition from external sources
- Workspace configuration management
- Memory and context querying

### Phase 3: Intelligence and Analytics (Q3 2025)

- Pattern recognition and recommendations
- Performance monitoring and cost tracking
- Cross-session intelligence features

### Phase 4: Enterprise Integration (Q4 2025)

- Template system and collaboration features
- CI/CD and external system integration
- Predictive analytics and optimization

These enhancements will transform the Atlas CLI from a basic workspace management tool into a
comprehensive AI agent orchestration platform, providing full programmatic access to all Atlas
capabilities described in the root CLAUDE.md documentation.

---

# Troubleshooting

## Common Issues

1. **TUI won't start**: Check TypeScript compilation with `deno check`
2. **Workspace not loading**: Verify `workspace.yml` syntax and permissions
3. **Commands not working**: Ensure `/` prefix for slash commands
4. **Server connection issues**: Check port availability and firewall settings

## Debug Features

- **Debug Mode**: Extensive key event logging
- **Performance Monitoring**: Built-in `[PERF]` log filtering
- **OpenTelemetry**: Comprehensive tracing and metrics
- **Error Boundaries**: Graceful failure handling with recovery options

## Log Analysis

- **Conversation Logs**: User interactions and command history
- **Server Logs**: Workspace runtime events and agent communications
- **Performance Logs**: Timing, memory usage, and optimization opportunities
- **Debug Logs**: Detailed execution traces for troubleshooting
