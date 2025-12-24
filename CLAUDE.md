<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

# Atlas

AI agent orchestration platform. Workspaces run autonomous agents triggered by
signals (HTTP, SSE, cron).

## Role

Challenge assumptions. Push back on complexity. Ask "who needs this?" and what's
the simplest version?" before building. Be a sparring partner, not a yes-man.

## Tech Stack

- Deno + TypeScript (core platform)
- Go (operator, auth, supporting services)
- XState 5 (state machines)
- Zod v4 (all external input validation)
- Hono (HTTP framework)

## Commands

```bash
# Deno/TypeScript
deno check              # Type check
deno lint               # Lint
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
- Static imports only (top of file)
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
  @atlas/memory     # CoALA/MECMF memory system
  @atlas/signals    # Signal types and routing
  @atlas/storage    # Persistence layer
src/
  core/             # Workspace runtime (XState machine, sessions)
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
6. Results stored in memory system

## Agent Feedback Loop

`deno task atlas prompt` and `deno task atlas logs` let agents test Atlas
changes without human intervention. No more waiting for humans to copy/paste
logs or restart daemons.

### Commands

- `deno task atlas prompt "message"` — headless chat, JSON output
- `deno task atlas prompt --chat <id> "follow-up"` — continue conversation
- `deno task atlas logs --since 30s` — recent logs (JSON lines)
- `deno task atlas logs --level error,warn` — filter by level
- `deno task atlas logs --human` — human-readable (debugging only)
- `deno task atlas chat <id>` — view chat transcript (JSON lines)
- `deno task atlas chat <id> --human` — human-readable transcript

### Output

`deno task atlas prompt` emits JSON messages, then `cli-summary`:

```json
{
  "type": "cli-summary",
  "chatId": "...",
  "toolsCalled": ["do_task"],
  "error": null,
  "continuation": { "canContinue": true, "command": "atlas prompt --chat ..." }
}
```

`deno task atlas logs` emits JSON lines:

```json
{
  "timestamp": "...",
  "level": "error",
  "message": "...",
  "context": { "workspaceId": "..." }
}
```

### Workflow

```bash
# Start a detatched process
deno task atlas daemon start --detached
# make changes (daemon auto-restarts)
deno task atlas prompt "test artifact extraction"
# if issues:
deno task atlas logs --since 30s --level error
# Stop the daemon (can time out after 10sec)
deno task atlas daemon stop
```

### Best Practices

- Parse `cli-summary` for `chatId`; use `--chat` for multi-turn
- Scope logs with `--since 30s` to recent run
- Filter with `--level error,warn` to reduce noise
- JSON is default; `--human` only for debugging
- Exit code non-zero means stream error

### Viewing Chat History

After a prompt session, you can review the full transcript:

```bash
# Get chatId from cli-summary
deno task atlas prompt "test the API"
# output includes: {"type":"cli-summary","chatId":"abc123",...}

# View full conversation
deno task atlas chat abc123

# Or human-readable
deno task atlas chat abc123 --human
```

Use this to debug:
- What tools were called and their outputs
- How the agent reasoned about the task
- What the full conversation looked like
