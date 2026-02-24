# Atlas CLI Documentation

This documentation covers the Atlas Command Line Interface (CLI) implementation.

## Overview

The Atlas CLI provides command execution for managing Atlas workspaces and AI agent orchestration.

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
│   └── help.tsx        # Help and usage information
├── components/         # Shared UI components
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


# Troubleshooting

## Common Issues

1. **Workspace not loading**: Verify `workspace.yml` syntax and permissions
2. **Server connection issues**: Check port availability and firewall settings

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
