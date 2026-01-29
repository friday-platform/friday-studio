# Friday

AI agent orchestration platform. Workspaces run autonomous agents triggered by
signals (HTTP, cron).

## Your Role

Challenge assumptions. Push back on complexity. Ask "who needs this?" and what's
the simplest version?" before building. Be a sparring partner, not a yes-man.

## Tech Stack

- Deno + TypeScript (core platform)
- Go (operator, auth, supporting services)
- @atlas/fsm-engine (state machines, workflows)
- Zod v4 (all external input validation)
- Hono (HTTP framework)

## Commands

```bash
# Deno/TypeScript
deno check              # Type check
deno task lint          # Lint
deno task test $file    # Run tests
deno task start         # Run daemon

# Go
go fmt ./...            # Format
golangci-lint run       # Lint
go test -race ./...     # Test with race detector
go build                # Build
```

## Hard Rules

- Use `@atlas/logger`, never `console.*`
- No `any` types - use `unknown` or proper types
- No `as` assertions - use Zod schemas for parsing
- Static imports only (top of file) - no `import("@pkg")` in type positions
- Validate all external input with Zod
- Use `process.env` from `node:process`, not `Deno.env` (migrating away from
  Deno APIs)
- Dependencies go in `package.json`, not `deno.json` (use `deno add npm:pkg`)

## Code Philosophy

**Do:**

- Explicit over implicit, simple over complex, flat over nested
- Parse, don't validate - Zod at boundaries, trust types internally
- Make impossible states impossible - discriminated unions over optional props
- Infer over annotate, `satisfies` when you want inference with validation
- Colocate until extraction earns itself
- Fail fast, recover gracefully

**Don't:**

- Abstract prematurely - rule of three, then extract
- Add "just in case" code or unrequested features - YAGNI
- Add backwards compatibility unless explicitly asked
- Write code that's hard to delete

**Before adding complexity, ask:**

- Is this solving a problem we have today?
- What's the simplest thing that works?
- What can I delete instead of add?

## Test Quality

Use the `testing-anti-patterns` and `vitest` skills for guidance.

## Communication

Direct and terse. Developer to developer - explain, don't sell. No buzzwords, no
"robust" or "comprehensive". Disagree when something's wrong.

## Git Workflow

Never push directly to `main` - it's protected.

```bash
git checkout -b feature/your-feature-name
# make changes, commit
git push -u origin feature/your-feature-name
gh pr create
```

If you accidentally commit to main locally:

```bash
git checkout -b feature/rescue-branch   # save your work
git checkout main
git reset --hard origin/main            # reset main
git checkout feature/rescue-branch
git push -u origin feature/rescue-branch
gh pr create
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
src/                  # atlasd internals (not a separate app)
  core/             # Workspace runtime (fsm-engine, sessions)
  cli/              # CLI commands
  services/         # Daemon services
```

## Config Files

- `atlas.yml` - Platform-wide settings (loaded from workspace directory,
  optional)
- `workspace.yml` - Per-workspace config (agents, signals, MCP servers)
- `docs/COMPREHENSIVE_ATLAS_EXAMPLE.yml` - Example atlas.yml with all available
  options

## Architecture

See `docs/ARCHITECTURE.md` for component details and data flow.

Quick mental model:

1. Signal arrives (HTTP/SSE/cron)
2. Daemon routes to workspace runtime
3. Workspace spawns session
4. Session supervisor plans execution
5. Agents execute with MCP tool access
6. Results returned via SSE stream

## Local Development with CLI

Daemon runs on `localhost:8080`. Auto-restarts on code changes.

```bash
# Check and see if the daemon is already running
deno task atlas daemon status

# Start daemon
deno task atlas daemon start --detached

# Send test prompt - returns chatId in cli-summary JSON
deno task atlas prompt "test your changes"

# Continue conversation
deno task atlas prompt --chat <chatId> "follow up"

# View transcript
deno task atlas chat <chatId>              # JSON
deno task atlas chat <chatId> --human      # readable

# List recent chats
deno task atlas chat

# Stop daemon
deno task atlas daemon stop
```

**CLI gaps:** Not all APIs have CLI commands. Check `apps/atlasd/routes/` and
curl `localhost:8080` directly when needed.

**Debugging:** Use the `debugging-friday` skill for log analysis (local + GCS).
