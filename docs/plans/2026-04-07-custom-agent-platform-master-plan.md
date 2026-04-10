# Custom Agent Platform — Master Plan

**Date:** 2026-04-07
**Status:** Source of Record
**Consolidates:** user-defined-agents-design.v3, code-agents-implementation.v3,
code-agent-input-parsing.v3, structured-input-for-code-agents,
agent-reload-iteration-design, agent-sdk-developer-workflow-design

---

## Problem

Friday's agent ecosystem was closed. Agents were trapped inside workspace YAML
files with no shared catalog, no cross-workspace reuse, and no way for users to
bring their own code. The internal architecture made this worse: two parallel
registries, two execution paths, and MCP abstraction overhead for bundled agents.

Users needed the ability to:

1. Bring code agents with custom logic and arbitrary dependencies (WASM-based)
2. Iterate quickly without painful build/upload cycles

---

## Architecture Decisions

### Unified Agent Registry

**Before:** Two parallel registries — planner's `bundledAgentsRegistry` (string
map) and runtime's `AgentRegistry` (class-based). Changes had to be coordinated
across both.

**After:** Single `AgentRegistry` with `AgentAdapter` interface. Both planner
and runtime consume the same registry. Adapters handle source-specific loading:

- `BundledAgentAdapter` — built-in TS agents
- `UserAdapter` — user-defined WASM code agents
- Future: `CortexAdapter` for cloud-stored agents

### Agent Identity & Namespacing

- `agent.id` — stable kebab-case identifier (used for planner identity, never
  `agent.name`)
- `user:` prefix — prevents collision with bundled agents
- `source: "user"` — user-defined agents share this source type
- `{id}@{version}/` directories for WASM agents with `metadata.json` sidecar

### Storage

- Root: `getAtlasHome()/agents/`
- WASM agents: `{id}@{version}/` directories with `metadata.json` sidecar
- Storage adapter pattern with swappable backends (local filesystem now,
  Postgres later)
- No aggressive caching — read-from-disk every call for simplicity and
  hot-reload support
- Version resolution: latest semver wins, old versions kept as rollback
  artifacts

### Execution Path

User agents bypass the MCP agent server and call through a dedicated executor:

- **WASM code agents** → `CodeAgentExecutor` → WASM component import → JSPI
  async bridging

This avoids the MCP overhead that bundled agents pay and gives cleaner error
propagation.

### Workspace Integration

User agents are referenced in `workspace.yml` as `type: "user"`:

```yaml
agents:
  - id: my-agent
    type: user
```

The planner discovers them through the unified registry and delegates via the
same FSM action system used for bundled agents.

---

## Input Handling

### The Problem

Code agents receive an "enriched prompt" — a markdown string containing the
task, temporal facts, signal data, and accumulated context. LLM agents read
this naturally. Deterministic code agents can't parse markdown to extract
structured data.

### V1: parse_input() (Shipped)

Pure Python utility in the SDK. Three-tier extraction:

1. Code-fenced JSON blocks
2. Balanced-brace scan
3. Full prompt fallback

Optional dataclass schema for typed extraction. Unknown keys filtered
automatically so enrichment context doesn't crash dataclass construction.

```python
from friday_agent_sdk import parse_input

config = parse_input(prompt, MyConfig)  # Returns typed dataclass
```

---

## Developer Workflow

### Build Pipeline (Shipped)

`atlas agent build` wraps the compilation pipeline:

1. `componentize-py` — Python → agent.wasm
2. `jco transpile` — agent.wasm → ES module (agent-js/)
3. Zod validation gate — metadata validated against
   `CreateAgentConfigValidationSchema`
4. `metadata.json` sidecar — enables cheap discovery without WASM instantiation

The daemon is the single build path. CLI calls daemon API (not `buildAgent()`
directly). Docker container includes SDK at `/opt/friday-agent-sdk`.

### Iteration (Partially Shipped)

**What shipped:**
- Explicit build via `POST /api/agents` (multipart upload) or CLI
- `POST /api/agents/reload` — triggers registry rescan after build

**What was designed but parked:**
- Volume mount approach: mount `./agents/` into container at `/app/user-agents`
- Build on startup: auto-scan on daemon start
- File watch: hot-reload with automatic rebuilds

The reload endpoint covers ~90% of the iteration pain. Edit → `curl reload` →
test is the current loop.

### SDK Role

The Python SDK (`friday-agent-sdk`) is a **compile-time dependency only**. It
gets compiled into the WASM binary by componentize-py. Zero runtime dependency
on the SDK package.

Two "agent-sdk" packages exist:
- Python `friday-agent-sdk` — separate repo, compile-time, WASM agents
- TypeScript `@atlas/agent-sdk` — monorepo, runtime, bundled agents

---

## What Was Built vs What Was Deferred

### Built

| Feature | Status |
|---------|--------|
| Unified AgentRegistry with adapters | ✅ Shipped |
| WASM code agent execution | ✅ Shipped |
| `user:` namespace prefix | ✅ Shipped |
| `type: "user"` workspace config | ✅ Shipped |
| Build pipeline (componentize-py → jco) | ✅ Shipped |
| metadata.json sidecar for discovery | ✅ Shipped |
| Zod validation gate at build time | ✅ Shipped |
| `parse_input()` for JSON extraction | ✅ Shipped |
| Reload endpoint for registry rescan | ✅ Shipped |
| Defense-in-depth error handling | ✅ Shipped |
| 10 example agents | ✅ Shipped |

### Deferred

| Feature | Status | Notes |
|---------|--------|-------|
| PostgresAgentStorageAdapter | Designed | Cloud storage backend |
| Agent versioning behavior | Placeholder | Version field exists, semantics TBD |
| Volume mount iteration | Parked | Reload endpoint sufficient for now |
| File watch / hot-reload | Parked | Lowest priority DX improvement |
| Agent sharing / access control | Not designed | |
| CLI agent management commands | Not designed | API-first approach |
| TypeScript WASM agents | Not designed | Python only for now |
| PyPI publication | Deferred | Until SDK is stable |

---

## Key Trade-offs

1. **WASM over containers** — Millisecond cold starts, sandboxed execution,
   typed contracts. Trade-off: can't use native Python deps (pydantic, numpy).
   Host capabilities (`ctx.llm`, `ctx.http`) bridge the most critical gaps.

2. **JSON strings over WIT records** — Schema changes don't require WIT version
   bumps. Trade-off: no compile-time type checking at the boundary.

3. **Daemon as build service** — Developers don't need componentize-py or jco
   installed locally. Trade-off: Docker required, no offline builds.

4. **No caching** — Read-from-disk every time. Trade-off: slightly slower
   discovery, but trivial with local filesystem and enables instant reload.

5. **Single agent per module** — Simplifies registry, build, and execution.
   Trade-off: can't bundle multiple agents in one WASM binary.

---

## Source Documents

These documents are superseded by this master plan:

- `2026-03-26-user-defined-agents-design.v3.md` — Registry consolidation, YAML agents
- `2026-04-02-code-agents-implementation.v3.md` — WASM code agent production readiness
- `2026-04-04-code-agent-input-parsing.v3.md` — parse_input() utility
- `2026-04-04-structured-input-for-code-agents.md` — ctx.input platform-level solution
- `2026-04-07-agent-reload-iteration-design.md` — Iteration workflow improvements
- `2026-04-07-agent-sdk-developer-workflow-design.md` — End-to-end developer workflow
