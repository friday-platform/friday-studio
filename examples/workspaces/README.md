# Atlas Workspace Examples

This directory contains example workspace configurations that demonstrate different Atlas agent
orchestration patterns.

## Quick Start

1. **Initialize a workspace** from any example directory:
   ```bash
   cd examples/workspaces/basic-chat
   ./setup.sh
   ```

2. **Test the workspace**:
   ```bash
   ./test.sh
   ```

## Available Examples

### Basic Chat (`basic-chat/`)

Simple workspace with an echo agent for testing basic functionality:

- Single echo agent
- Basic chat interaction
- Good for testing Atlas installation

### Development Team (`dev-team/`)

Multi-agent workspace simulating a development team:

- Code review agent (Claude)
- Documentation agent (Claude)
- Testing agent (Echo for now)
- Example workflows for common dev tasks

### Deployment Pipeline (`deploy-pipeline/`)

Agent coordination for deployment workflows:

- Security scan agent
- Build verification agent
- Deployment coordination agent
- Example signal processing

## Creating New Workspaces

Each workspace example contains:

- `README.md` - Workspace description and usage
- `setup.sh` - Script to initialize the workspace
- `test.sh` - Script to test workspace functionality
- `config.json` - Workspace configuration (optional)

## Usage Patterns

### Interactive Testing

```bash
# Initialize workspace
cd examples/workspaces/basic-chat
./setup.sh

# Chat with agents
atlas chat --message "Hello!" --workspace <workspace-id> --agent <agent-id>
```

### Automation Testing

```bash
# Run all tests
cd examples/workspaces
./test-all.sh
```
