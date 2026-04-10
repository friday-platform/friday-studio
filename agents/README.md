# Local Agent Development

This directory contains custom agents for local development. The daemon auto-builds these agents on startup—no Docker required.

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


