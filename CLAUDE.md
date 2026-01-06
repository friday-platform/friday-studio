# Friday

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
- Static imports only (top of file, no inline `import("pkg")` in types)
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

Use the `friday-debugging` skill for local and remote debugging instructions.

## Issue Tracking with bd (beads)

All issue tracking goes through **bd**. No other TODO systems.

Key invariants:

- Whenever you run a Beads command (`bd`) always run it with the `--no-daemon`
  flag. Eg: `bd --no-daemon <command>`.

### Basics

Check ready work:

```bash
bd --no-daemon ready --json
```

Create issues:

```bash
bd --no-daemon create "Issue title" -t bug|feature|task -p 0-4 --json
bd --no-daemon create "Issue title" -p 1 --deps discovered-from:bv-123 --json
```

Update:

```bash
bd --no-daemon update bv-42 --status in_progress --json
bd --no-daemon update bv-42 --priority 1 --json
```

Complete:

```bash
bd --no-daemon close bv-42 --reason "Completed" --json
```

Types:

- `bug`, `feature`, `task`, `epic`, `chore`

Priorities:

- `0` critical (security, data loss, broken builds)
- `1` high
- `2` medium (default)
- `3` low
- `4` backlog

Agent workflow:

1. `bd --no-daemon ready` to find unblocked work.
2. Claim: `bd --no-daemon update <id> --status in_progress`.
3. Implement + test.
4. If you discover new work, create a new bead with
   `discovered-from:<parent-id>`.
5. Close when done.

Never:

- Use markdown TODO lists.
- Use other trackers.
- Duplicate tracking.

---

## Using bv as an AI Sidecar

bv is a graph-aware triage engine for Beads projects (.beads/beads.jsonl).
Instead of parsing JSONL or hallucinating graph traversal, use robot flags for
deterministic, dependency-aware outputs with precomputed metrics (PageRank,
betweenness, critical path, cycles, HITS, eigenvector, k-core).

**Scope boundary:** bv handles _what to work on_ (triage, priority, planning).
For agent-to-agent coordination (messaging, work claiming, file reservations),
use MCP Agent Mail.

**⚠️ CRITICAL: Use ONLY `--robot-*` flags. Bare `bv` launches an interactive TUI
that blocks your session.**

### The Workflow: Start With Triage

**`bv --robot-triage` is your single entry point.** It returns everything you
need in one call:

- `quick_ref`: at-a-glance counts + top 3 picks
- `recommendations`: ranked actionable items with scores, reasons, unblock info
- `quick_wins`: low-effort high-impact items
- `blockers_to_clear`: items that unblock the most downstream work
- `project_health`: status/type/priority distributions, graph metrics
- `commands`: copy-paste shell commands for next steps

```bash
bv --robot-triage        # THE MEGA-COMMAND: start here
bv --robot-next          # Minimal: just the single top pick + claim command
```

### Other Commands

**Planning:**

| Command            | Returns                                         |
| ------------------ | ----------------------------------------------- |
| `--robot-plan`     | Parallel execution tracks with `unblocks` lists |
| `--robot-priority` | Priority misalignment detection with confidence |

**Graph Analysis:**

| Command                                         | Returns                                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--robot-insights`                              | Full metrics: PageRank, betweenness, HITS, eigenvector, critical path, cycles, k-core, articulation points, slack |
| `--robot-label-health`                          | Per-label health: `health_level` (healthy\|warning\|critical), `velocity_score`, `staleness`, `blocked_count`     |
| `--robot-label-flow`                            | Cross-label dependency: `flow_matrix`, `dependencies`, `bottleneck_labels`                                        |
| `--robot-label-attention [--attention-limit=N]` | Attention-ranked labels by: (pagerank × staleness × block_impact) / velocity                                      |

### Scoping & Filtering

```bash
bv --robot-plan --label backend              # Scope to label's subgraph
bv --robot-insights --as-of HEAD~30          # Historical point-in-time
bv --recipe actionable --robot-plan          # Pre-filter: ready to work (no blockers)
bv --recipe high-impact --robot-triage       # Pre-filter: top PageRank scores
bv --robot-triage --robot-triage-by-track    # Group by parallel work streams
bv --robot-triage --robot-triage-by-label    # Group by domain
```

### jq Quick Reference

```bash
bv --robot-triage | jq '.quick_ref'                        # At-a-glance summary
bv --robot-triage | jq '.recommendations[0]'               # Top recommendation
bv --robot-plan | jq '.plan.summary.highest_impact'        # Best unblock target
bv --robot-insights | jq '.status'                         # Check metric readiness
bv --robot-insights | jq '.Cycles'                         # Circular deps (must fix!)
bv --robot-label-health | jq '.results.labels[] | select(.health_level == "critical")'
```

**Performance:** Phase 1 instant, Phase 2 async (500ms timeout). Prefer
`--robot-plan` over `--robot-insights` when speed matters. Results cached by
data hash. Use `bv --profile-startup` for diagnostics.

Use bv instead of parsing beads.jsonl—it computes PageRank, critical paths,
cycles, and parallel tracks deterministically.
