# Local Agent Development

This directory contains custom agents for local development. The daemon auto-builds these agents on startup—no Docker required.

## Current agents (as of 2026-04-14)

11 user agents are checked into this directory, all FAST-built or
hand-bootstrapped during the autopilot loop crank.

| Agent                       | Version | Type        | Wired into                          | Purpose                                                                       |
| --------------------------- | ------- | ----------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| `autopilot-planner`         | 1.3.0   | router+http | `mild_almond` autopilot-tick        | Picks next backlog task with skip-recent cooldown, inline-dispatches          |
| `autopilot-dispatcher`      | 2.0.0   | http        | (built but unused)                  | Fire-and-poll dispatcher. Waiting on FSM 2nd-agent bug fix                    |
| `orphan-agent-auditor`      | 1.3.0   | http        | `mild_almond` audit-orphans         | Walks /api/agents + /api/workspaces, library_agents exclusion, alias resolve  |
| `reflector`                 | 1.2.0   | http+llm    | `grilled_xylem` reflect-on-last-run | Skips meta jobs, reads error fields, single focused LLM judgment              |
| `skill-publisher`           | 1.1.0   | http        | `grilled_xylem` apply-reflection    | Walks recent sessions when no session_id, gates on confidence ≥ 0.9, upload   |
| `skill-author`              | 1.0.0   | llm         | `mild_almond` cross-session-reflect | Takes high-confidence reflection, produces full SKILL.md via single LLM call  |
| `multi-session-reflector`   | 1.0.0   | http+llm    | `mild_almond` cross-session-reflect | Aggregates outcomes across N sessions, single LLM judgment for trends         |
| `task-router`               | 1.0.0   | router      | `grilled_xylem` + `ripe_jam`        | Quick-fix vs full-fsm routing. Skips architect for trivial single-file briefs |
| `session-summarizer`        | 1.0.0   | library     | (called by other agents)            | Pure structural extraction. No FSM consumer by design                         |
| `reflection-aggregator`     | 1.0.0   | library     | (called by other agents)            | Aggregates N reflection results. No FSM consumer by design                    |
| `workspace-creator`         | 1.0.0   | http        | (no consumer yet)                   | Creates ephemeral workspaces. Forward-looking primitive                       |

Each agent has unit tests next to its `agent.py`. Tests re-implement the
production helpers locally (no `friday_agent_sdk` install needed) and
include drift-checks against the live source. Run with
`python3 agents/<id>/test_*.py`.

| Test file                                                       | Assertions |
| --------------------------------------------------------------- | ---------- |
| `task-router/test_routing.py`                                   | 10         |
| `session-summarizer/test_helpers.py`                            | 17         |
| `reflection-aggregator/test_aggregation.py`                     | 14         |
| `autopilot-planner/test_iso_math.py`                            | 10         |
| `orphan-agent-auditor/test_library_exclusion.py`                | 12         |
| `reflector/test_skip_meta.py`                                   | 10         |
| `skill-author/test_gate_and_validation.py`                      | 14         |
| `multi-session-reflector/test_aggregate.py`                     | 17         |

**Adding a new agent**: the canonical authoring workflow uses FAST
itself — fire `author-agent` on the `frozen_nutella` workspace with an
`agent_id` + `agent_brief`. The architect → coder → reviewer pipeline
produces a new `agents/<id>/agent.py` that auto-builds on next daemon
restart. **Include a CONSUMER CONTRACT in the brief** (name the
workspace + job that will reference the new agent) or it will land as
an orphan (caught by `orphan-agent-auditor`).

## Quick Start

**1. Place agent source directories here**

Each subdirectory containing an `agent.py` becomes one agent:

```
agents/
├── text-analyser/
│   └── agent.py          ← @agent(id="text-analyser", ...)
├── my-custom-agent/
│   └── agent.py
└── README.md             ← this file
```

**2. Start the daemon with `AGENT_SOURCE_DIR` set**

```bash
AGENT_SOURCE_DIR=./agents deno task dev:playground
```

Or for daemon-only:

```bash
AGENT_SOURCE_DIR=./agents deno task atlas:dev daemon start
```

**3. Verify in logs**

```
Building 2 agent(s) from ./agents (parallel)
Built agent text-analyser@1.0.0 from source
Built agent my-custom-agent@0.1.0 from source
Agent registry initialized
```

**4. Test via playground**

Open http://localhost:5200 → Agents → Bundled. Your agents appear alongside built-in agents.

## Prerequisites

The build toolchain must be on your PATH:

```bash
# Python → WASM compiler
pip install componentize-py

# WASM → JavaScript transpiler (requires JSPI async support)
npm install -g @bytecodealliance/jco

# Verify
componentize-py --version
jco --version
```

## Rebuilding After Changes

The daemon builds once at startup. To rebuild:

1. Edit your `agent.py`
2. Restart the daemon (Ctrl-C, then restart with `AGENT_SOURCE_DIR=./agents`)

If a build fails, the error appears in daemon logs and that agent is skipped—others continue loading.

## How It Works

On startup, the daemon:

1. Scans `AGENT_SOURCE_DIR` for subdirectories
2. Copies each to a temp location (builds are destructive)
3. Runs `componentize-py` → `agent.wasm`
4. Runs `jco transpile` (with JSPI flags) → `agent-js/`
5. Writes to `~/.atlas/agents/{id}@{version}/`
6. Registry picks up built agents from `~/.atlas/agents/`

The playground discovers agents from the same registry location—no additional configuration needed.

## Troubleshooting

**"friday-agent-sdk not found, skipping source builds"**

The SDK lives at `packages/sdk-python/`. The daemon walks up from `AGENT_SOURCE_DIR` to find it. Ensure:

- You're running from the repository root
- `packages/sdk-python/wit/agent.wit` exists
- `AGENT_SOURCE_DIR` is a relative path (`./agents`) or absolute path within the repo

**Build failures**

Check daemon logs for phase information:

- `prereqs` — `componentize-py` or `jco` not on PATH
- `compile` — Python syntax error or invalid SDK import
- `transpile` — jco flags mismatch (rare)
- `validate` — Missing required `@agent()` decorator fields

**Agent not appearing in playground**

Verify the build succeeded and check the registry:

```bash
curl http://localhost:8080/api/agents | jq '.[] | select(.source == "user")'
```


