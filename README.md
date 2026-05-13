# Friday Studio

[![CI](https://github.com/friday-platform/friday-studio/actions/workflows/test.yml/badge.svg)](https://github.com/friday-platform/friday-studio/actions)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/uczJyp5FMH)

Friday turns natural-language asks into repeatable AI-powered workflows.
You describe what you want in chat — *"every morning, triage my inbox,
draft replies, file real asks as Linear tickets"* — and the result is a
`workspace.yml` you can read, version, share, and run on schedule. Run it
once, or run it forever.

**Why both a chat and a YAML?** Prompts decay. Run the same prompt tomorrow
and the output drifts; bump the model and your old contracts shift with
it. Friday keeps both halves of the loop: **conversation** is how you
build, **configuration** is how you ship — agents, MCP tools, signals
(HTTP, cron, Slack, email, webhook), and the jobs that wire them together.
Read the file. Version it. Hand it to a teammate and it runs the same on
their machine.

Two surfaces, one runtime:

- **Chat in the playground.** Friday picks up your installed skills, MCP
  servers, memory, and OAuth credentials, and actually drives your tools
  instead of describing what it would do.
- **Run autonomously.** Capture the pattern in a `workspace.yml`, bind it
  to a signal, and the daemon runs it observably and locally on schedule.

It's for developers and operators who want agents in production —
reviewing PRs at 3am, draining their inbox before standup, watching
competitor pricing, summarizing a Fathom call into a Linear ticket —
without wiring queues, secret stores, schedulers, MCP plumbing, and
provider clients from scratch every time.

> **Prefer the packaged version?** **[hellofriday.ai](https://hellofriday.ai)**
> ships the same daemon and playground as a one-click installer for macOS
> with the launcher, dependencies, and tray UI bundled. The
> rest of this README is for working in-tree.

## Architecture

| | What it is | When you use it |
| --- | --- | --- |
| **`atlasd` (daemon)** | Headless runtime — HTTP API on `:8080`, workspace lifecycle, signal router, session state, JetStream message bus. | Production. CI. Anything you'd `systemd`-ify. |
| **Agent Playground** | SvelteKit web UI on `:5200` — chat with Friday, author and run agents, inspect every session step-by-step, manage skills/MCP servers/schedules/memory/credentials, browse the workspace marketplace. | Day-to-day. The playground is what you actually look at. |

The desktop installer ships both behind a tray icon. In-tree, `deno task
dev:playground` runs both side by side with hot reload.

## Quickstart

### Prerequisites

The daemon orchestrates several runtimes — Friday agents can be authored
in TypeScript *or* Python, can drive a real browser, and fan out work over
a message bus. Install the four below yourself, then `scripts/setup-dev-env.sh`
handles the rest.

**You install these (we won't touch your version managers):**

| Tool | Min | Why |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | `24+` | Playground runs under Vite via `npx`; `@atlas/ui` builds with `svelte-package`. Manage via fnm/volta/nvm — auto-installing system Node clobbers project pins. |
| [git](https://git-scm.com/) | any recent | — |

**`setup-dev-env.sh` handles these — installs if missing or below min, otherwise keeps yours:**

| Tool | Min | Why |
| --- | --- | --- |
| [Deno](https://deno.com/) | `2.7.0` | Runs the daemon, CLI, link service, and every TS/Svelte package. |
| [Go](https://go.dev/) | `1.26.0` | Builds the Go services in `tools/`. macOS auto-install via Homebrew; Linux fails with the install URL (no sudo without consent). |
| [uv](https://docs.astral.sh/uv/) | `0.11.0` | Provisions the managed Python that `type: "user"` agents spawn under. |
| [`nats-server`](https://nats.io/) | `2.12.0` | Internal message bus the daemon spawns for agent ↔ daemon RPC. Pinned to `v2.12.8` for fresh installs. |
| [`agent-browser`](https://www.npmjs.com/package/agent-browser) | latest | CLI the bundled `web` agent shells out to for headless browsing. Pulls a Chromium build (~150MB) on first run. |
| Python 3.12 + `friday-agent-sdk` | pinned | Pre-warmed into uv's cache so the first user-agent spawn isn't a cold start. |

Docker (optional) skips all of the above — `docker compose up` runs the
whole stack in containers.

You don't need a separate database for local development — the daemon
persists state through its embedded JetStream bus. Postgres is only needed
for production deployments of the `link` credential service.

### 1. Clone and install

```bash
git clone https://github.com/friday-platform/friday-studio
cd friday-studio
bash scripts/setup-dev-env.sh    # bootstraps deno+go+uv+nats+agent-browser, runs deno install, pre-warms Python
```

`setup-dev-env.sh` checks each tool's version against the minimums above
and **keeps your existing toolchain** wherever it satisfies them — auto-
install only kicks in for missing or stale tools. It also runs `deno
install`, writes the daemon envfile, and pre-warms the uv cache. Re-run
it whenever the pinned `friday-agent-sdk` version bumps in
`tools/friday-launcher/paths.go`.

If the script ends with a `⚠ Skipped:` block, follow the per-tool hint and
re-run. Common case: `agent-browser` install fails on a system Node — switch
to a user-scoped Node manager (fnm/volta/nvm) and re-run to enable
web/browser agents.

### 2. Configure environment

```bash
cp .env.example .env
# open .env and set ANTHROPIC_API_KEY (or another provider key)
```

The example file documents every variable the daemon reads — provider keys,
proxies, OAuth/GitHub App credentials, integration tokens. The minimum to
run a real agent is one LLM provider key.

### 3. Run the playground (recommended)

One command, four processes — daemon, link, playground, and webhook tunnel —
all with hot reload:

```bash
deno task dev:playground
```

Open <http://localhost:5200> and the sidebar gives you everything: bundled
agents under **Agents**, MCP server browser, skills, schedules, memory,
workspace inspector, settings.

### 4. (Or) just the daemon

If you only need the API:

```bash
deno task atlas daemon start --detached
# atlas auto-loads the daemon .env, so this works on both plain-HTTP and
# TLS-enabled installs (scheme/port follow FRIDAYD_URL).
deno task atlas daemon status
deno task atlas daemon stop
```

> **TLS opt-in (dev).** Run `bash scripts/setup-tls.sh` once to generate
> certs and write `FRIDAYD_URL=https://…` plus `FRIDAY_TLS_CA` into
> `~/.atlas/.env`. Installed Studio gets the same vars written into
> `${FRIDAY_HOME:-~/.friday/local}/.env` automatically by the launcher.
> Every subcommand and skill example below switches scheme automatically.

## Examples

### Just chat with it

Open the playground at <http://localhost:5200>. Type:

> *Find every unread email from my team that's waiting on a reply, summarize what each is asking, and draft responses.*

Friday uses your `google-gmail` MCP server to search the inbox, an LLM agent
to triage, and Gmail's `create_draft` tool to leave the replies in your
drafts folder — picking tools from what's installed. Same surface as a chat
product, except the actions actually run. No tools wired up? Add them under
**MCP** / **Skills** / **Settings** and ask again — the conversation
continues.

The CLI is the same surface, headless:

```bash
deno task atlas prompt "summarize the last 10 PRs in friday-platform/friday-studio"
deno task atlas chat <chatId> --human    # readable transcript
```

### Promote a chat into a workspace

When a one-off chat is worth re-running on its own, capture the agents and
tools you used in a `workspace.yml` and bind it to a signal.

**HTTP — review every PR I open:**

```bash
git clone https://github.com/friday-platform/friday-studio-examples
deno task atlas workspace add ./friday-studio-examples/github-pr-reviewer

# Source the daemon .env once so $FRIDAYD_URL / $FRIDAY_TLS_CA are set on
# TLS-enabled installs. The chain tries the installed-Studio location first,
# then the dev location written by `scripts/setup-tls.sh`. Skip this on
# plain-HTTP installs.
set -a
. "${FRIDAY_HOME:-$HOME/.friday/local}/.env" 2>/dev/null \
  || . "$HOME/.atlas/.env" 2>/dev/null || true
set +a
curl -X POST ${FRIDAY_TLS_CA:+--cacert "$FRIDAY_TLS_CA"} \
  "${FRIDAYD_URL:-http://localhost:8080}/review-pr" \
  -d '{"pr_url": "https://github.com/your-org/your-repo/pull/42"}'
```

The workspace declares an HTTP signal at `/review-pr`, an LLM agent with
the `gh` MCP server, and a system prompt scoped to your team's review
checklist. Wire it to GitHub via `webhook-tunnel` for a public URL.

**Cron — drain my inbox before 9am:**

```yaml
# workspace.yml
workspace: { name: inbox-zero }
signals:
  - { id: morning, type: cron, schedule: "0 8 * * 1-5" }
agents:
  - id: triage
    type: llm
    model: claude-sonnet-4-6
    mcp: [gmail, linear]
    prompt: |
      Read unread Gmail. Real asks → file as a Linear ticket tagged `inbox`.
      Newsletters → archive. Reply to anything from <my-team>.
jobs:
  - { on: morning, run: triage }
```

`deno task atlas workspace add ./inbox-zero` and the cron is live. Each
morning's run lands in **Platform → inbox-zero → Sessions**.

**Web — watch competitor pricing:** the bundled `web` agent shells out to
the `agent-browser` CLI, so any agent (chat or workspace) can drive a real
Chromium. Install once with `npm i -g agent-browser && agent-browser install`,
then bind it to an hourly cron and have it post to Slack on price changes.

### Skip the YAML — write Python

For mechanical work where an LLM is overkill, an agent declared
`type: "user"` is a Python file the daemon spawns under uv. The agent
calls LLM, HTTP, and MCP capabilities through `friday-agent-sdk` —
authoring guide, full API, and ten runnable examples live in
[`friday-platform/agent-sdk`](https://github.com/friday-platform/agent-sdk).

> **Rule of thumb:** use `type: "user"` only when each call's decision is
> mechanical (regex / schema / fixed routing). For LLM-judgment work, use
> `type: "llm"` with MCP tools.

Browse [`friday-studio-examples`](https://github.com/friday-platform/friday-studio-examples)
for `github-digest`, `competitive-monitor`, `daily-operating-memo`,
`jira-bugfix-bitbucket`, and others.

## Agent Playground

`deno task dev:playground` opens the playground at <http://localhost:5200>.
It's the same Svelte app the desktop installer ships — production UI, not
a debug widget.

**What's in there:**

- **Agents** — bundled agents (claude-code, gh, jira, hubspot, web, csv,
  knowledge, image-generation, …) with one-click execute and live SSE
  streaming. Build a custom one-shot agent (provider, model, system prompt,
  MCP tools) from the same screen.
- **Workspaces / Inspector** — load a `workspace.yml`, see the parsed
  signals/agents/jobs graph, run the full pipeline (prompt → blueprint →
  FSM compile → execute), and replay every step from disk.
- **Platform → \<workspace\>** — sessions per workspace, FSM state,
  per-step transcripts, tool calls, costs.
- **MCP** — every MCP server registered with the daemon, with tool schemas
  and a "test call" panel.
- **Skills** — author and edit the markdown skills agents load on demand.
- **Memory** — narrative memory each workspace has accumulated.
- **Schedules** — every cron-bound job, last/next fire, manual trigger.
- **Discover** — workspace marketplace (browse and install community
  workspaces).
- **Settings** — model chains, OAuth, provider keys, environment.

**CLI mode** (workspace generation, no UI):

```bash
deno task sim "build a daily competitor-pricing digest"          # full pipeline
deno task sim "..." --stop-at=plan       # blueprint only
deno task sim "..." --stop-at=fsm        # blueprint + FSM compile
deno task sim "..." --real               # execute with real MCP agents
```

Artifacts land in `runs/workspaces/<timestamp>-<slug>/` — replay them in the
playground's **Workspaces / History** tab.

## Common commands

```bash
# Daemon lifecycle
deno task atlas daemon start --detached   # background
deno task atlas:dev daemon start          # auto-restart on file change
deno task atlas daemon status             # health
deno task atlas daemon stop

# Talk to it
deno task atlas prompt "your prompt"      # one-shot prompt → bundled chat workspace
deno task atlas chat                      # list recent chats
deno task atlas chat <chatId> --human     # readable transcript

# Develop
deno task typecheck                       # deno check + svelte-check
deno task lint                            # deno lint + biome check --write
deno task fmt                             # biome format --write
deno task test <file>                     # vitest single file
```

## Docker

Want it all in containers?

```bash
docker compose up
```

Brings up the daemon, playground, link credential service, PTY server, and
webhook tunnel. Ports default to `1xxxx` to avoid host collisions — see
[`docker-compose.yml`](docker-compose.yml).

## Project structure

```
apps/
  atlasd/             # Daemon — HTTP API, workspace lifecycle, signal router
  atlas-cli/          # CLI entry point — `deno task atlas`
  link/               # Credential / OAuth service
  ledger/             # Resource & activity storage service
  studio-installer/   # Tauri desktop app — tray, daemon supervisor,
                      # autostart. The hellofriday.ai download.
packages/             # @atlas/* libraries — core, agent-sdk, config,
                      # fsm-engine, llm, logger, mcp, memory, skills,
                      # storage, workspace, signals, jetstream, …
tools/
  agent-playground/   # Web client (SvelteKit) — production UI
  evals/              # Agent eval harness
  friday-launcher/    # System tray launcher + daemon supervisor (Go)
  pty-server/         # WebSocket → PTY shell bridge (Go)
  webhook-tunnel/     # Cloudflare tunnel → daemon webhook forwarder (Go)
```

Config: `friday.yml` (platform-wide) · `workspace.yml` (per-workspace) ·
[`CONTRIBUTING.md`](CONTRIBUTING.md) (dev guidelines + code style).

## Learn more

- **[hellofriday.ai](https://hellofriday.ai)** — desktop installer (macOS, Windows)
- **[docs.hellofriday.ai](https://docs.hellofriday.ai)** — full documentation
- **[`friday-studio-examples`](https://github.com/friday-platform/friday-studio-examples)** —
  ready-to-import workspaces
- **[`friday-platform/agent-sdk`](https://github.com/friday-platform/agent-sdk)** —
  Python SDK for `type: "user"` agents
- [AI Drift: the hidden cost of building with AI](https://blog.hellofriday.ai/ai-drift-the-hidden-cost-of-building-with-ai-e2b51415b3b0)
  — why prompt-only automations stop holding up
- [Building a personal fitness tracker in one conversation](https://blog.hellofriday.ai/building-a-personal-fitness-tracker-in-one-conversation-1ae2696a89f7)
  — chat → workspace, end to end
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — patches, code style, hard rules (CLA required)
- [`SECURITY.md`](SECURITY.md) — vulnerability disclosure
- [Discord](https://discord.gg/uczJyp5FMH) — questions, show-and-tell

## License

Friday is **source-available** under the [Business Source License 1.1](LICENSE).
You can read, modify, and self-host the code under the
[Additional Use Grant](LICENSE), which permits free production use for
personal use, organizations under 5 people, and businesses with under $1M
ARR. Production use outside those bounds, or that competes with Tempest
Labs' offering, requires a commercial license. Each released version
converts automatically to **Apache-2.0 one year after that version is first
distributed** (current version's Change Date: **2027-04-30**; later
versions get their own date).

For commercial-license inquiries: legal@tempest.team.

Third-party components retain their original licenses — see
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) and [`NOTICE`](NOTICE)
(includes MPL-2.0 §3.2 source-availability notice and license elections for
dual/tri-licensed deps).
