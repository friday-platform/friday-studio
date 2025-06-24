# Atlas CLI Power User Guide

This guide covers advanced usage patterns, shortcuts, and tips for maximizing productivity with the
Atlas CLI.

## Command Aliases

Atlas provides convenient aliases for frequently used commands:

### Main Command Aliases

| Full Command | Aliases        | Description                        |
| ------------ | -------------- | ---------------------------------- |
| `workspace`  | `work`, `w`    | Manage Atlas workspaces            |
| `session`    | `sesh`, `sess` | Manage Atlas sessions              |
| `signal`     | `sig`          | Manage workspace signals           |
| `agent`      | `ag`           | Manage workspace agents            |
| `library`    | `lib`          | Manage library items and templates |
| `logs`       | `log`          | View session logs                  |
| `version`    | `v`            | Show version information           |
| `help`       | `h`            | Show help information              |

### Special Shortcuts

- `atlas ps` - Alias for `atlas session list` (similar to Unix `ps` command)
- `atlas work` - Defaults to `atlas workspace serve` (most common operation)
- `atlas sig <name>` - Smart detection: if `<name>` isn't a subcommand, triggers the signal

## Smart Defaults

Many commands have intelligent defaults to save typing:

```bash
# These are equivalent:
atlas workspace serve
atlas work

# When in a workspace directory:
atlas signal list
atlas sig  # Shows signal list by default

# Session commands default to list:
atlas session
atlas sesh
```

## Cross-Directory Operations

All commands support the `--workspace` flag for operating on workspaces from any directory:

```bash
# Work with a workspace from anywhere
atlas workspace status --workspace my-project
atlas agent list -w my-project
atlas signal trigger deploy-signal -w production

# The flag accepts both workspace ID and name
atlas session list --workspace prod_abc123
atlas logs sess_xyz789 -w "My Production Workspace"
```

## JSON Output for Scripting

All data-retrieval commands support `--json` output for scripting:

```bash
# Get workspace status as JSON
atlas workspace status --json | jq '.serverRunning'

# List all agents and filter by type
atlas agent list --json | jq '.agents[] | select(.type == "llm")'

# Get session count
atlas ps --json | jq '.count'

# Search library and process results
atlas lib search "error handling" --json | jq '.items[].name'
```

## Piping and Composition

Atlas commands are designed to work well with Unix pipes:

```bash
# Find all running sessions for a specific agent
atlas ps --json | jq -r '.sessions[] | select(.status == "executing") | .id' | \
  xargs -I {} atlas logs {} --tail 5

# Get all workspace names
atlas workspace list --json | jq -r '.workspaces[].name'

# Monitor session creation in real-time
watch -n 2 "atlas ps --json | jq '.count'"
```

## Interactive Features

### Workspace Initialization

The `atlas workspace init` command provides a beautiful interactive experience:

```bash
atlas workspace init
# Interactive prompts guide you through:
# - Workspace name
# - Description
# - Agent selection
# - Signal configuration
```

### Signal Triggering

Trigger signals with inline data or interactively:

```bash
# Inline JSON data
atlas sig trigger webhook --data '{"event": "deployment", "version": "1.2.3"}'

# Interactive mode (when no data provided)
atlas sig trigger webhook
# Prompts for JSON data with validation
```

## Advanced Patterns

### Session Management

```bash
# Quick session health check
atlas ps --json | jq -r '.sessions[] | "\(.id): \(.status)"'

# Cancel all sessions in error state
atlas ps --json | jq -r '.sessions[] | select(.status == "error") | .id' | \
  xargs -I {} atlas session cancel {} --yes

# Follow logs for the most recent session
atlas ps --json | jq -r '.sessions[0].id' | xargs atlas logs -f
```

### Library Operations

```bash
# Search and retrieve in one command
atlas lib search "config" --json | jq -r '.items[0].id' | \
  xargs atlas lib get --content

# Generate from template with piped data
echo '{"name": "MyService", "port": 8080}' | \
  atlas lib generate rest-api-template /dev/stdin
```

### Workspace Operations

```bash
# Start all registered workspaces
atlas workspace list --json | jq -r '.workspaces[].id' | \
  xargs -P 4 -I {} atlas workspace serve -w {} -d

# Check health of all workspaces
for ws in $(atlas workspace list --json | jq -r '.workspaces[].name'); do
  echo -n "$ws: "
  atlas workspace status -w "$ws" --json | jq -r '.status'
done
```

## Environment Variables

Set defaults via environment variables:

```bash
export ATLAS_WORKSPACE=my-default-workspace
export ATLAS_OUTPUT=json  # Always output JSON
export ATLAS_NO_COLOR=1   # Disable colored output

# Now these commands use the defaults
atlas agent list  # Uses ATLAS_WORKSPACE
atlas ps          # Outputs JSON due to ATLAS_OUTPUT
```

## Shell Completions

For maximum efficiency, install shell completions:

```bash
# Bash
atlas completion bash > ~/.atlas-completion.bash
echo "source ~/.atlas-completion.bash" >> ~/.bashrc

# Zsh
atlas completion zsh > ~/.atlas-completion.zsh
echo "source ~/.atlas-completion.zsh" >> ~/.zshrc

# Fish
atlas completion fish > ~/.config/fish/completions/atlas.fish
```

## Debugging Tips

### Verbose Output

```bash
# Enable debug logging
ATLAS_LOG_LEVEL=debug atlas workspace serve

# Trace all HTTP requests
ATLAS_TRACE_HTTP=1 atlas signal trigger my-signal
```

### Dry Run Mode

```bash
# Preview what would happen without executing
atlas workspace remove my-workspace --dry-run
atlas signal trigger critical-signal --dry-run
```

## Performance Tips

1. **Use JSON output for scripts** - It's faster than parsing human-readable output
2. **Batch operations** - Use `xargs -P` for parallel execution
3. **Cache workspace lookups** - Store workspace IDs in variables for repeated use
4. **Minimize workspace switches** - Use `--workspace` flag instead of `cd`

## Common Workflows

### Quick Workspace Setup

```bash
# One-liner workspace creation and start
atlas workspace init my-app && cd my-app && atlas work -d
```

### Signal Testing Loop

```bash
# Test signal processing in a loop
while true; do
  SESSION=$(atlas sig trigger test-signal --json | jq -r '.sessionId')
  atlas logs $SESSION -f --tail 50
  read -p "Again? [y/N] " -n 1 -r
  [[ ! $REPLY =~ ^[Yy]$ ]] && break
done
```

### Monitoring Dashboard

Create a simple monitoring script:

```bash
#!/bin/bash
# atlas-monitor.sh
while true; do
  clear
  echo "=== Atlas Workspace Monitor ==="
  echo
  echo "Active Sessions:"
  atlas ps --json | jq -r '.sessions[] | "  \(.id): \(.status) (Agent: \(.currentAgent))"'
  echo
  echo "Workspace Status:"
  atlas workspace status --json | jq -r '"  Server: \(.serverRunning) | Port: \(.port)"'
  sleep 5
done
```

## Tips & Tricks

1. **Tab Completion**: Use tab completion liberally - it knows about workspace names, session IDs,
   and signal names

2. **Partial ID Matching**: Most commands accept partial IDs:
   ```bash
   atlas session get sess_a  # Matches sess_abc123def456
   atlas logs sess_a         # Same session
   ```

3. **Silent Mode**: Add `2>/dev/null` to suppress progress indicators in scripts:
   ```bash
   atlas workspace list --json 2>/dev/null | process_workspaces.py
   ```

4. **Quick Status Check**: The fastest way to check if a workspace is running:
   ```bash
   atlas workspace status -w my-app --json | jq -r '.serverRunning' || echo "false"
   ```

5. **Workspace Jumping**: Create shell functions for quick workspace navigation:
   ```bash
   # Add to ~/.bashrc or ~/.zshrc
   aw() {
     local ws="${1:-$(atlas workspace list --json | jq -r '.workspaces[].name' | fzf)}"
     cd "$(atlas workspace list --json | jq -r ".workspaces[] | select(.name == \"$ws\") | .path")"
   }
   ```

## Troubleshooting

### Command Not Found Errors

Atlas now provides intelligent suggestions for typos:

```bash
$ atlas worksapce list
Error: Unknown command: 'worksapce'

Did you mean?
  workspace (aliases: work, w) - Manage Atlas workspaces

Run 'atlas --help' for available commands.
```

### Debugging Command Resolution

To see how Atlas resolves your commands:

```bash
ATLAS_DEBUG_COMMANDS=1 atlas work
# Shows: Resolved 'work' → 'workspace' → 'workspace serve'
```

### Getting Help

Every command supports `--help`:

```bash
atlas workspace --help        # Workspace command help
atlas workspace serve --help  # Specific subcommand help
atlas --help                  # General help with all commands
```

## Advanced Configuration

### Custom Aliases (Shell Level)

Add your own aliases in your shell configuration:

```bash
# ~/.bashrc or ~/.zshrc
alias at='atlas'
alias atw='atlas workspace'
alias ats='atlas session'
alias atp='atlas ps'
alias atl='atlas logs'

# Even shorter for common operations
alias wserve='atlas workspace serve -d'
alias wstatus='atlas workspace status --json | jq'
```

### Workspace Templates

Create template scripts for common workspace types:

```bash
#!/bin/bash
# create-api-workspace.sh
atlas workspace init "$1" && cd "$1" && cat > workspace.yml << EOF
id: $1
name: $1
description: API workspace with standard agents
agents:
  api-agent:
    type: llm
    model: claude-3-5-sonnet-20241022
    purpose: API development and testing
  test-agent:
    type: tempest
    source: github.com/myorg/test-agent
signals:
  http:
    provider: http
    port: 8080
  deploy:
    provider: cli
    description: Deployment signal
EOF
```

Remember: The key to being a power user is understanding the composability of Atlas commands and
leveraging Unix philosophy - each command does one thing well and can be combined with others for
powerful workflows.
