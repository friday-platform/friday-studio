# Friday

AI agent orchestration platform. Workspaces run autonomous agents triggered by
signals (HTTP, cron).

The daemon manages workspace lifecycles — each workspace defines agents,
signals, and jobs in a `workspace.yml`. Signals arrive (HTTP, CLI, cron), the
daemon routes them to the workspace runtime, which spawns sessions where agents
execute with MCP tool access.

## Commands

```bash
# Run
deno task dev:full              # Start daemon (auto-restarts on changes)
deno task atlas daemon status   # Check if daemon is running
deno task atlas prompt "test"   # Send a test prompt

# Develop
deno check                      # Type check
deno task lint                  # Lint
deno task test $file            # Run specific test
deno task fmt                   # Format

# Go services
go test -race ./...             # Test with race detector
golangci-lint run               # Lint
```

## Project Structure

```
apps/
  atlasd/           # Daemon - HTTP API, workspace lifecycle
  atlas-operator/   # K8s operator (Go)
  bounce/           # Auth service (Go)
  gist/             # File service (Go)
  web-client/       # Svelte web UI
packages/
  @atlas/config     # YAML config loading + Zod schemas
  @atlas/core       # Core types, artifacts, errors
  @atlas/logger     # Structured logging
  @atlas/mcp        # MCP client implementation
  @atlas/signals    # Signal types and routing
  @atlas/storage    # Persistence layer
src/                # atlasd internals
  core/             # Workspace runtime (fsm-engine, sessions)
  cli/              # CLI commands
  services/         # Daemon services
```

Config: `atlas.yml` (platform-wide) · `workspace.yml` (per-workspace) ·
[`CLAUDE.md`](CLAUDE.md) (dev guidelines + hard rules)

## AI Workflow

Claude Code skills support a structured planning-to-execution pipeline:

1. **Design** — `/brainstorm` refines a rough idea into a design doc via
   Socratic questioning. Outputs to `docs/plans/`.

2. **Iterate** — `/improve-plan` critiques the design, surfaces gaps, and
   outputs an improved version. Keep iterating until the questions become
   trivial.

3. **Tasks** — `/make-tasks` converts the validated design into tracked work
   items with dependency graphs.

4. **Execute** — `/implement-tasks` spawns parallel agents. Each claims a task,
   implements, commits, moves on.

5. **Polish** — `/polish` runs a self-review team (lint, slop, tests, design)
   before PR.

6. **Ship** — `/open-pr` creates a PR with summary and test plan.

Post-ship: `/code-review` for reviewing others' PRs. `/remember-learnings` mines
agent commit footers into CLAUDE.md.

## Development

**Prerequisites:** Deno 2.4.0+, Go 1.22+ (for operator/auth/gist services)

```bash
git clone https://github.com/tempestteam/atlas && cd atlas
deno install                    # Install dependencies
npx husky                       # Set up git hooks
```

See [`CLAUDE.md`](CLAUDE.md) for hard rules, code philosophy, and architecture.
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for component details and
data flow.
