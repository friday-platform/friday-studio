# Development Team Workspace

Multi-agent workspace simulating a development team with specialized agents.

## What This Example Demonstrates

- Multiple agents in one workspace
- Agent specialization and roles
- Coordinated workflows between agents
- Real AI integration (Claude) for development tasks

## Agents in This Workspace

### Code Review Agent (Claude)

- Reviews code for bugs, style, and best practices
- Suggests improvements and optimizations
- Handles TypeScript/JavaScript expertise

### Documentation Agent (Claude)

- Writes and reviews documentation
- Creates README files and API docs
- Explains complex technical concepts

### Test Agent (Echo)

- Simulates test planning and execution
- Will be upgraded to real testing agent later

## Setup

```bash
# Requires ANTHROPIC_API_KEY in .env file
cp ../../../.env.example ../../../.env
# Edit .env and add your ANTHROPIC_API_KEY

./setup.sh
```

## Testing

```bash
./test.sh
```

This runs scenarios like:

- Code review workflow
- Documentation generation
- Team coordination

## Example Workflows

### Code Review

```bash
atlas chat --message "Review this TypeScript function: function add(a: number, b: number) { return a + b; }" \
  --workspace <workspace-id> --agent <code-review-agent-id>
```

### Documentation

```bash
atlas chat --message "Write API documentation for a user authentication endpoint" \
  --workspace <workspace-id> --agent <docs-agent-id>
```

### Test Planning

```bash
atlas chat --message "Create test plan for user registration feature" \
  --workspace <workspace-id> --agent <test-agent-id>
```

## Prerequisites

- Anthropic API key for Claude agents
- Environment file configured (`.env`)

## Troubleshooting

If Claude agents fail:

1. Check `ANTHROPIC_API_KEY` in `.env` file
2. Verify API key has credit/permissions
3. Check network connectivity
