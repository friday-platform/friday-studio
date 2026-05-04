# Friday Studio

[![Test](https://github.com/friday-platform/friday-studio/actions/workflows/test.yml/badge.svg)](https://github.com/friday-platform/friday-studio/actions/workflows/test.yml)
[![Type check](https://github.com/friday-platform/friday-studio/actions/workflows/type-check.yml/badge.svg)](https://github.com/friday-platform/friday-studio/actions/workflows/type-check.yml)
[![Lint JS](https://github.com/friday-platform/friday-studio/actions/workflows/js-lint.yml/badge.svg)](https://github.com/friday-platform/friday-studio/actions/workflows/js-lint.yml)
[![Go CI](https://github.com/friday-platform/friday-studio/actions/workflows/go-ci.yml/badge.svg)](https://github.com/friday-platform/friday-studio/actions/workflows/go-ci.yml)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/uczJyp5FMH)

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
| [uv](https://docs.astral.sh/uv/) | `0.11+` | Provisions the managed Python that user agents run under (auto-installed by `setup-dev-env.sh` if absent) |
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

To run a real example workspace, clone the
[`friday-studio-examples`](https://github.com/friday-platform/friday-studio-examples)
repo and add one — for instance, the HTTP-triggered GitHub PR reviewer:

```bash
git clone https://github.com/friday-platform/friday-studio-examples
deno task atlas workspace add ./friday-studio-examples/github-pr-reviewer
curl -X POST http://localhost:8080/review-pr \
  -H "Content-Type: application/json" \
  -d '{"pr_url": "https://github.com/friday-platform/friday-studio/pull/118"}'
```

Browse
[`friday-studio-examples`](https://github.com/friday-platform/friday-studio-examples)
for more — `github-digest`, `inbox-zero`, `competitive-monitor`,
`daily-operating-memo`, and others — each is a self-contained
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

## Local development

Working in-tree (running the daemon out of the repo, not via the desktop
installer) needs a one-time setup so the daemon's user-agent spawn path
finds a managed Python with the SDK installed:

```bash
bash scripts/setup-dev-env.sh
```

Idempotent. Safe to re-run after every `friday-agent-sdk` version bump.

What it does:

1. Verifies `uv` is on PATH (installs from astral.sh if not).
2. Writes the env vars the daemon needs (`FRIDAY_UV_PATH`,
   `UV_PYTHON_INSTALL_DIR`, `UV_CACHE_DIR`, `FRIDAY_AGENT_SDK_VERSION`)
   into the daemon's envfile (`~/.atlas/.env` or `~/.friday/local/.env`,
   matching whichever home holds your live state).
3. Pre-warms the uv cache — Python 3.12 + the pinned `friday-agent-sdk`
   wheel — so the first user-agent spawn doesn't pay the download as
   cold-start latency.
4. Uninstalls any stale editable `friday-agent-sdk` installs from system
   Pythons that would otherwise shadow the uv-managed copy.

Restart your daemon after running it so the new env vars take effect.

The desktop installer handles the same setup automatically; this script is
for in-tree development only.

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
tools/
  agent-playground/   # Web client (SvelteKit) — dev tool and the
                      # production UI bundled in Friday Studio
  evals/              # Agent eval harness CLI
  friday-launcher/    # System tray launcher + daemon supervisor (Go)
  pty-server/         # WebSocket → PTY shell bridge (Go)
  webhook-tunnel/     # Cloudflare tunnel → daemon webhook forwarder (Go)
```

Config: `friday.yml` (platform-wide) · `workspace.yml` (per-workspace) ·
[`CONTRIBUTING.md`](CONTRIBUTING.md) (dev guidelines + code style)

## Python user agents

A workspace agent declared `type: "user"` is a Python file the daemon spawns
as a subprocess. The agent code calls capabilities (LLM, HTTP, MCP tools,
streaming) over NATS through the [`friday-agent-sdk`](https://pypi.org/project/friday-agent-sdk/)
package — no provider keys, no MCP plumbing in your code.

Minimal agent:

```python
from friday_agent_sdk import AgentContext, agent, ok

@agent(id="hello", version="1.0.0", description="Reverses input.")
def execute(prompt: str, ctx: AgentContext):
    return ok({"reversed": prompt[::-1]})

if __name__ == "__main__":
    from friday_agent_sdk import run
    run()
```

Register and run:

```bash
curl -X POST http://localhost:8080/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{"entrypoint":"/abs/path/to/agent.py"}'

curl -X POST "http://localhost:8080/api/agents/hello/run?workspaceId=user" \
  -H "Content-Type: application/json" \
  -d '{"input":"hello"}'
```

The daemon spawns `uv run --python 3.12 --with friday-agent-sdk==<pinned> agent.py`
under the hood — the version is pinned in
[`tools/friday-launcher/paths.go`](tools/friday-launcher/paths.go)
(`bundledAgentSDKVersion`) and threaded through to the daemon via the
launcher (or `setup-dev-env.sh` for in-tree work). Bumping the SDK is a
deliberate change in three pin sites: that constant, the same value in the
[`Dockerfile`](Dockerfile), and `BUNDLED_AGENT_SDK_VERSION` in
[`apps/studio-installer/src-tauri/src/commands/prewarm_agent_sdk.rs`](apps/studio-installer/src-tauri/src/commands/prewarm_agent_sdk.rs).

**Rule of thumb:** use `type: "user"` only when each call's decision is
mechanical (regex / schema / fixed routing). For any LLM-judgment work
(classifying, summarizing, choosing among options), use `type: "llm"` with
MCP tools — that's faster to author and easier to maintain.

Reference:

- **SDK:** [`friday-platform/agent-sdk`](https://github.com/friday-platform/agent-sdk)
  · authoring guide vendored at
  [`packages/system/skills/writing-friday-python-agents`](packages/system/skills/writing-friday-python-agents/SKILL.md)
- **Memory access from agents:** narrative is the only supported strategy
  today — see
  [`packages/system/skills/writing-to-memory`](packages/system/skills/writing-to-memory/SKILL.md)
- **Spawn resolution:**
  [`apps/atlasd/src/agent-spawn.ts`](apps/atlasd/src/agent-spawn.ts) —
  three-tier fallback (uv-run → `FRIDAY_AGENT_PYTHON` → bare `python3`)

## Learn more

- [docs.hellofriday.ai](https://docs.hellofriday.ai) — full documentation
- [`friday-studio-examples`](https://github.com/friday-platform/friday-studio-examples)
  — ready-to-import workspace examples
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to send patches, code style, hard
  rules (CLA required)
- [`SECURITY.md`](SECURITY.md) — vulnerability disclosure

## License

Friday is **source-available** under the [Business Source License 1.1](LICENSE).
You can read, modify, and self-host the code under the
[Additional Use Grant](LICENSE), which permits free production use for personal
use, organizations under 5 people, and businesses with under $1M ARR.
Production use outside those bounds, or that competes with Tempest Labs'
offering, requires a commercial license. Each released version converts
automatically to **Apache-2.0 one year after that version is first
distributed** (so the current version's Change Date is **2027-04-30**; later
versions get their own date).

For commercial-license inquiries: legal@tempest.team.

Third-party components retain their original licenses — see
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) and [`NOTICE`](NOTICE)
(includes MPL-2.0 §3.2 source-availability notice and license elections for
dual/tri-licensed deps).
