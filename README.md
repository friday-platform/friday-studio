# Friday

AI agent orchestration platform. Workspaces run autonomous agents triggered by
signals (HTTP, cron).

The daemon manages workspace lifecycles — each workspace defines agents,
signals, and jobs in a `workspace.yml`. Signals arrive (HTTP, CLI, cron), the
daemon routes them to the workspace runtime, which spawns sessions where agents
execute with MCP tool access.

## Quickstart

### Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| [Deno](https://deno.com/) | `2.7.0+` | Runs the daemon, CLI, and TypeScript packages |
| [Go](https://go.dev/) | `1.26+` | Builds the Go services under `tools/` (pty-server, webhook-tunnel, friday-launcher) |
| [Node.js](https://nodejs.org/) | `24+` | Needed for `npx`, Vite, and the web playground |
| [git](https://git-scm.com/) | any recent | — |
| Docker (optional) | any recent | Alternative path: run the full stack with `docker compose up` |

You do **not** need Postgres for local development — the daemon uses SQLite by
default. Postgres is only required when running the `link` credential service
in production.

### 1. Clone and install

```bash
git clone https://github.com/friday-platform/friday-studio
cd friday-studio
deno install                    # install JS/TS deps (also runs husky via prepare hook)
```

### 2. Configure environment

```bash
cp .env.example .env
# open .env and set ANTHROPIC_API_KEY (or another provider key)
```

The example file documents every variable the daemon reads. The minimum to run
a real agent is one LLM provider key.

### 3. Start the daemon

```bash
deno task atlas daemon start --detached
```

Verify it's up:

```bash
curl -sf http://localhost:8080/health && echo "  daemon ok"
deno task atlas daemon status
```

### 4. Run your first agent

Send a prompt through the CLI — the daemon routes it to the bundled chat
workspace and returns a chat id you can follow up on.

```bash
deno task atlas prompt "Write a haiku about TypeScript"
deno task atlas chat                    # list recent chats
deno task atlas chat <chatId> --human   # readable transcript
```

To run one of the bundled example workspaces (HTTP-triggered Claude Code
agent):

```bash
deno task atlas workspace add ./examples/claude-code-smoke
curl -X POST http://localhost:8080/webhooks/run-code \
  -H "Content-Type: application/json" \
  -d '{"prompt": "explain this repo in two sentences"}'
```

Browse `examples/` for more — `pr-review-github`, `jira-bugfix-labeled`,
`claude-code-with-skills`, and others — each is a self-contained
`workspace.yml` you can copy and edit.

### 5. Stop the daemon

```bash
deno task atlas daemon stop
```

### Alternative: Docker

```bash
docker compose up
```

This runs the daemon, web UI (Studio), credential service, PTY server, and
webhook tunnel together. Ports default to `1xxxx` to avoid host collisions —
see [`docker-compose.yml`](docker-compose.yml).

### Web playground (optional)

For interactive development with the Svelte UI, hot-reload daemon, and webhook
tunnel running side by side:

```bash
deno task dev:playground
```

Open http://localhost:5200.

## Commands

```bash
# Daemon lifecycle
deno task atlas daemon start --detached   # start (background)
deno task atlas:dev daemon start          # start with auto-restart (session-aware)
deno task atlas daemon status             # health check
deno task atlas daemon stop               # stop

# Interact
deno task atlas prompt "your prompt"      # send a one-shot prompt
deno task atlas chat                      # list recent chats
deno task atlas chat <chatId> --human     # show transcript

# Develop
deno task typecheck                       # deno check + svelte-check
deno task lint                            # deno lint + biome check --write
deno task fmt                             # biome format --write
deno task test $file                      # run a vitest file

# Go services
go test -race ./...
golangci-lint run
```

## Project Structure

```
apps/
  atlasd/             # Daemon — HTTP API, workspace lifecycle (TS/Deno)
  atlas-cli/          # CLI entry point — `deno task atlas` (TS/Deno)
  link/               # Credential / OAuth service (TS/Deno)
  ledger/             # Resource & activity storage service (TS/Deno)
  studio-installer/   # Friday Studio launcher app — tray, daemon
                      # supervisor, autostart (Tauri/Rust)
packages/             # @atlas/* libraries — core, agent-sdk, config,
                      # fsm-engine, llm, logger, mcp, memory, skills,
                      # storage, workspace, signals, …
agents/               # Bundled Python WASM agents (planner, dispatcher,
                      # reflector, skill-author, …)
examples/             # Self-contained workspace.yml examples
                      # (claude-code-smoke, pr-review-github,
                      # jira-bugfix-labeled, …)
tools/
  agent-playground/   # Web client (SvelteKit) — dev tool and the
                      # production UI bundled in Friday Studio
  evals/              # Agent eval harness CLI
  friday-launcher/    # System tray launcher + daemon supervisor (Go)
  pty-server/         # WebSocket → PTY shell bridge (Go)
  webhook-tunnel/     # Cloudflare tunnel → daemon webhook forwarder (Go)
```

Config: `friday.yml` (platform-wide — see
[`docs/COMPREHENSIVE_FRIDAY_EXAMPLE.yml`](docs/COMPREHENSIVE_FRIDAY_EXAMPLE.yml))
· `workspace.yml` (per-workspace) · [`CLAUDE.md`](CLAUDE.md) (dev guidelines +
hard rules)

## AI Workflow

Claude Code skills support a structured planning-to-execution pipeline:

1. **Design** — `/brainstorming` refines a rough idea into a design doc via
   Socratic questioning. Outputs to `docs/plans/`.

2. **Iterate** — `/improving-plans` critiques the design, surfaces gaps, and
   outputs an improved version. Keep iterating until the questions become
   trivial.

3. **Tasks** — `/creating-tasks` converts the validated design into tracked
   work items with dependency graphs.

4. **Execute** — `/implementing-tasks` spawns parallel agents. Each claims a
   task, implements, commits, moves on.

5. **Polish** — `/polishing` runs a self-review team (lint, slop, tests,
   design) before PR.

6. **Ship** — `/opening-pr` creates a PR with summary and test plan.

Post-ship: `/reviewing-code` for reviewing others' PRs. `/remembering-learnings`
mines agent commit footers into CLAUDE.md.

## Learn more

- [`CLAUDE.md`](CLAUDE.md) — hard rules, code philosophy, gotchas
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components and data flow
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to send patches (CLA required)
- [`SECURITY.md`](SECURITY.md) — vulnerability disclosure

## License

Friday is **source-available** under the [Business Source License 1.1](LICENSE).
You can read, modify, and self-host the code; production use that competes with
Tempest Labs' offering requires a commercial license. The license converts to
Apache-2.0 on **2027-04-29**.

Third-party components retain their original licenses — see
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) and [`NOTICE`](NOTICE).
