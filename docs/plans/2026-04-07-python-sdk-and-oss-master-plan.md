# Python Agent SDK & Open-Source Distribution — Master Plan

**Date:** 2026-04-07
**Status:** Source of Record
**Consolidates:** python-agent-sdk-design.v3, polyglot-agents-spike-results,
polyglot-code-agents-design, async-bridging-spike-results,
claude-code-python-agent-design.v4, open-source-agent-sdk-design.v2,
wasm-agent-host-capabilities-design.v3

---

## Problem

Friday needed to support user-authored agents in languages beyond TypeScript.
Python is the dominant language in AI/ML, but:

1. No SDK existed for writing agents in Python
2. WASM sandboxing blocks native extensions (pydantic-core, httpx, ssl)
3. Agents couldn't call LLMs or make HTTP requests from inside the sandbox
4. The SDK was trapped in a private monorepo, blocking community contributions

---

## Spike Results That Shaped the Design

### WASM Compilation Pipeline (2026-04-02)

**Validated:** Python → componentize-py → .wasm → jco transpile → ES module
importable by Deno.

**Key findings:**
- Component Model chosen over Extism (Extism SDK broken on Deno 2, proprietary
  ABI, v2 RC stuck 1+ year)
- Cold start ~11ms, warm calls ~0.027ms
- 18 MiB artifact size (CPython runtime, amortized across all Python agents)
- WIT exports proven, imports (host functions) not yet tested

**Rejected:** Extism PDK, containers (slow startup, GB images), subprocesses
(no sandboxing), JSON-RPC protocol approach.

### JSPI Async Bridging (2026-04-02)

**Question:** Can synchronous Python `call_tool()` inside WASM bridge to async
JavaScript host functions?

**Answer:** Yes. Three jco flags required:
- `--async-mode jspi`
- `--async-imports "friday:agent/capabilities#call-tool"` (and each async import)
- `--async-exports "friday:agent/agent#execute"`

WIT stays synchronous. jco handles async at the transpilation layer. ~15ms JSPI
overhead (negligible vs real tool calls at 100ms+). Deno V8 has native
`WebAssembly.promising` — no flags needed.

---

## SDK Design

### Authoring Experience

One decorator, one function, zero WIT ceremony:

```python
from friday_agent_sdk import agent, ok, err

@agent(
    id="my-agent",
    version="1.0.0",
    description="Does things",
    llm={"provider": "anthropic", "model": "claude-sonnet-4"},
    environment={"required": [{"name": "API_KEY", "description": "Auth"}]},
    mcp={"server": {"transport": {"type": "stdio", "command": "mcp-server"}}},
)
def execute(prompt: str, ctx: AgentContext):
    result = ctx.llm.generate("Analyze this", model="claude-haiku-4-5")
    response = ctx.http.fetch("https://api.example.com/data")
    tools = ctx.tools.list()
    ctx.stream.progress("Working on it...")
    return ok({"analysis": result.text})
```

### Public API Surface

```python
from friday_agent_sdk import (
    # Core
    agent,                          # Decorator
    ok, err,                        # Result constructors
    AgentContext,                    # Execution context

    # Result types
    OkResult, ErrResult, AgentResult,
    AgentExtras, ArtifactRef, OutlineRef,

    # Response types
    LlmResponse, HttpResponse,

    # Exceptions
    ToolCallError, LlmError, HttpError,

    # Utilities
    StreamEmitter, parse_input,
)
```

### Internal Architecture (~800 lines total)

| Module | Lines | Purpose |
|--------|-------|---------|
| `_types.py` | 261 | AgentContext, Tools, Llm, Http, StreamEmitter, exceptions |
| `_parse.py` | 137 | JSON extraction from enriched prompts |
| `_bridge.py` | 124 | WIT boundary shim (componentize-py entry point) |
| `_context.py` | 70 | Context builder from JSON |
| `_result.py` | 61 | ok()/err() result types with extras |
| `_registry.py` | 53 | One-agent-per-module singleton registry |
| `_decorator.py` | 46 | @agent decorator, pure metadata collection |
| `_serialize.py` | 15 | Dataclass → dict serialization |

**Zero runtime dependencies.** Pure Python stdlib only. Dataclasses instead of
Pydantic (pydantic-core's Rust extension can't compile in WASM).

### Key Design Decisions

1. **Thin WIT contract** — Complex data crosses as JSON strings, not WIT
   records. Schema changes happen in JSON, not WIT. Only `agent-result` variant
   and `tool-definition` record use WIT types.

2. **Validation outside the sandbox** — Pydantic doesn't work in WASM. The
   daemon validates metadata with Zod schemas at build intake time.
   Schema extraction from dataclasses happens at build time (native Python).

3. **Bridge pattern** — SDK generates a WIT implementation class at module load
   time from decorator registration. User writes a function, SDK handles WASM
   export wiring.

4. **Tagged union results** — `ok()` and `err()` return distinct types.
   Impossible to return success with error data or vice versa.

5. **Casing convention** — Decorator kwargs use snake_case (Pythonic). Dict
   values in `environment` and `mcp` use camelCase (matching host Zod schemas).
   Bridge handles snake_case → camelCase conversion.

---

## WIT Contract (friday:agent@0.1.0)

### Exports (Agent Implements)

```wit
export get-metadata: func() -> string;
export execute: func(prompt: string, context: string) -> agent-result;
```

### Imports (Host Provides)

```wit
call-tool: func(name: string, args: string) -> result<string, string>;
list-tools: func() -> list<tool-definition>;
llm-generate: func(request: string) -> result<string, string>;
http-fetch: func(request: string) -> result<string, string>;
log: func(level: log-level, message: string);
stream-emit: func(event-type: string, data: string);
```

All complex data uses `func(string) -> result<string, string>` pattern. JSON
contracts define the schema. WIT stays stable while capabilities evolve.

---

## Host Capabilities

### Why

Three blockers prevented common agent patterns:
- `pydantic-core` — Rust C extension, can't compile in WASM
- `httpcore/httpx` — imports `ssl` unconditionally, blocked in WASM
- TLS/SSL — requires OpenSSL, a native library

No platform (Modal, Temporal, Spin, Extism, etc.) has solved arbitrary Python
deps in WASM. Host-provided capabilities are the answer.

### ctx.llm — LLM Generation

Routes through host's `@atlas/llm` registry. Agent never sees API keys.

```python
# Simple generation
result = ctx.llm.generate("Summarize this document")

# With model override
result = ctx.llm.generate("Quick check", model="claude-haiku-4-5")

# Structured output
result = ctx.llm.generate_object("Extract fields", output_schema={...})

# Provider options passthrough
result = ctx.llm.generate("Analyze", provider_options={"claude-code": {...}})
```

**Model resolution cascade:**
1. Fully qualified per-call (`"anthropic:claude-haiku-4-5"`) → use directly
2. Bare per-call + decorator provider → resolve
3. Fully qualified per-call overrides decorator → use per-call
4. No per-call + decorator defaults → use decorator
5. Nothing → error

**Response:** `LlmResponse(text, object, model, usage, finish_reason)`

### ctx.http — Outbound HTTP

Routes through host's `fetch()`. TLS handled by host.

```python
response = ctx.http.fetch("https://api.example.com/data",
    method="POST",
    headers={"Authorization": f"Bearer {ctx.env['API_KEY']}"},
    body='{"query": "test"}',
    timeout_ms=30000,
)
data = response.json()  # Convenience helper
```

**Security:** 5MB response body limit (matches platform webfetch). Structured
info-level logging for audit trail. URL allowlists designed but deferred.

### Host-Side Implementation

Both capabilities follow the same pattern:
1. Safe JSON parse (`parseAgentJson()` — clear errors, not cryptic SyntaxError)
2. Zod schema validation
3. Execute operation
4. Return JSON response

Error propagation chain:
Host `ComponentError` → jco wraps as `{tag: "err", val: reason}` →
componentize-py surfaces as Python exception → SDK catches and raises typed
error (`LlmError`/`HttpError`) with `e.value` unwrapping.

---

## Claude Code Agent Port (Shipped)

The production validation of the full SDK — porting the TypeScript claude-code
bundled agent to Python. Fully implemented with multi-phase effort
classification, fallback model selection, structured output (with code fence
parsing), artifact refs, and workspace skills. Delegates sandbox/timeout
management to the host rather than handling it in-agent (architectural
simplification vs the TS version, not a gap).

### Key Insight: Claude Code as LLM Provider

Register `ai-sdk-provider-claude-code` as a community provider in `@atlas/llm`.
Agent calls `ctx.llm.generate(model="claude-code:sonnet", provider_options={...})`.

### Responsibility Split

| Agent Controls (Python) | Host Controls (Platform) |
|--------------------------|--------------------------|
| Model selection | Permission mode |
| Effort classification | Disallowed tools |
| Prompt construction | Sandbox lifecycle |
| Fallback selection | Progress forwarding |
| Structured output | Stall detection (120s) |

### Dual Streaming

- **Agent-side:** `ctx.stream.progress()` between JSPI calls (sync, not
  suspended)
- **Host-side:** `streamText()` + `smallLLM()` generates progress messages
  while WASM is suspended during `ctx.llm.generate()`

### Result Extras

```python
return ok(
    data={"summary": analysis},
    extras=AgentExtras(
        artifact_refs=[ArtifactRef(id="...", title="...", type="...")],
        outline_refs=[OutlineRef(id="...", title="...")],
        reasoning="...",
    ),
)
```

Bridge serializes with snake_case → camelCase conversion.

---

## Open-Source Distribution

### Repository Structure

Extracted to `/Users/ericskram/code/tempest/agent-sdk` as a Vite+ (pnpm
workspace) monorepo:

```
agent-sdk/
├── packages/
│   ├── wit/              # WIT contract (the spec)
│   │   └── agent.wit
│   ├── conformance/      # Cross-language validation suite
│   │   ├── schemas/      # 7 JSON Schema files
│   │   ├── stubs/        # Deterministic mock host
│   │   └── tests/        # 5 contract area test files
│   └── python/           # Reference SDK implementation
│       ├── friday_agent_sdk/
│       ├── examples/     # 10 example agents (pre-compiled)
│       └── tests/
├── package.json
└── pnpm-workspace.yaml
```

### What's Extracted vs What Stays

| Extracted (OSS) | Stays in Atlas |
|-----------------|----------------|
| WIT contract | Build tooling (`atlas agent build`) |
| Python SDK (~800 LOC) | WASM runtime/executor |
| Conformance tests | Agent discovery/registry |
| JSON Schema fixtures | MCP server management |
| 10 example agents | Platform integration |
| | TypeScript agent SDK |

### Conformance Test Suite

Five contract areas, language-agnostic (tests compiled WASM, not source):

1. **Metadata** — `getMetadata()` returns correct JSON shape
2. **Execution** — `execute()` returns valid ok/err results
3. **Context Round-Trip** — Correct deserialization of context JSON
4. **Tool Capabilities** — `callTool`, `listTools`, `log`, `streamEmit` wiring
5. **LLM + HTTP Capabilities** — `llmGenerate`, `httpFetch` wiring

JSON Schemas owned independently in the OSS repo (no automated drift detection
with atlas Zod schemas — manual sync accepted as trade-off).

### Adding New Language SDKs

1. Create `packages/<language>/`
2. Re-implement example agents
3. Compile to WASM
4. Run conformance tests — passing = compatible with Friday

---

## What Was Built vs What Was Deferred

### Built

| Feature | Location |
|---------|----------|
| Python SDK (~800 LOC, zero deps) | Both repos |
| WIT contract (friday:agent@0.1.0) | Both repos |
| @agent decorator with full metadata | SDK |
| ctx.tools (callTool, listTools) | SDK + Host |
| ctx.llm (generate, generate_object) | SDK + Host |
| ctx.http (fetch) | SDK + Host |
| ctx.stream (progress, intent) | SDK + Host |
| ok()/err() tagged union results | SDK |
| AgentExtras (artifacts, outlines, reasoning) | SDK |
| parse_input() JSON extraction | SDK |
| JSPI async bridging | Build pipeline |
| Zod validation at build intake | Host |
| 5MB HTTP response limit | Host |
| Safe JSON parsing (parseAgentJson) | Host |
| Model resolution cascade | Host |
| Conformance test suite (5 areas) | OSS repo |
| 7 JSON Schema contract files | OSS repo |
| Claude Code agent (full port from TS) | OSS repo |
| 10 example agents (echo → claude-code) | Both repos |
| Comprehensive README (355 lines) | SDK |

### Deferred

| Feature | Notes |
|---------|-------|
| Streaming LLM responses | Requires WASI 0.3 (late 2026) |
| Multi-turn tool-use in LLM calls | Schema forward-compatible, impl deferred |
| URL allowlists for HTTP | Agent metadata `allowed_hosts` designed |
| Token/cost budgets | Per-agent limits, usage tracking |
| Container runtime (Path B) | For agents needing native deps |
| TypeScript WASM SDK | Python only for now |
| PyPI publication | Until SDK is stable |
| Automated schema drift detection | Manual sync between repos |
| `import anthropic` / `import openai` | Blocked by pydantic-core in WASM |
| GPU access | Out of scope |
| Module signing | Out of scope |

---

## Key Trade-offs

1. **Host capabilities over native imports** — Can't `import anthropic` but can
   `ctx.llm.generate()`. Agents get the same functionality without dependency
   hell. Trade-off: host controls the provider registry.

2. **Dataclasses over Pydantic** — Less ergonomic but WASM-safe. Build-time
   schema extraction compensates. Trade-off: no runtime validation inside agent.

3. **JSON over WIT records** — Evolve schemas without WIT version bumps.
   Trade-off: no compile-time boundary checking, validation must be explicit.

4. **Independent schema ownership** — OSS JSON Schemas not auto-synced with
   atlas Zod schemas. Trade-off: manual drift management, but no complex
   cross-repo tooling.

5. **Conformance tests as the contract** — Passing conformance = compatible.
   No need to understand Friday internals. Trade-off: tests must be
   comprehensive enough to catch real issues.

6. **Zero runtime deps** — Pure stdlib Python. Trade-off: less ergonomic
   serialization, manual type construction. But: zero WASM compatibility risk.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────┐
│  Developer                                  │
│  writes agent.py with @agent decorator      │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  Build Pipeline (atlas agent build)         │
│  componentize-py → .wasm → jco → ES module │
│  + Zod validation + metadata.json sidecar   │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  Agent Registry (UserAdapter)               │
│  Discovers agent-js/ + metadata.json        │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  CodeAgentExecutor                          │
│  Imports ES module, binds host functions,   │
│  calls execute() via JSPI                   │
├─────────────────────────────────────────────┤
│  Host Functions (globalThis.__friday...)    │
│  callTool │ listTools │ llmGenerate │       │
│  httpFetch │ log │ streamEmit               │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  WASM Sandbox (Python agent)                │
│  SDK bridge translates WIT ↔ Python         │
│  @agent handler receives AgentContext       │
│  Returns ok(data) or err(message)           │
└─────────────────────────────────────────────┘
```

---

## Source Documents

These documents are superseded by this master plan:

- `2026-04-02-python-agent-sdk-design.v3.md` — SDK authoring experience
- `2026-04-02-polyglot-agents-spike-results.md` — WASM compilation validation
- `2026-04-02-polyglot-code-agents-design.md` — Full polyglot vision
- `2026-04-02-async-bridging-spike-results.md` — JSPI async proof
- `2026-04-05-claude-code-python-agent-design.v4.md` — Claude Code port design
- `2026-04-03-open-source-agent-sdk-design.v2.md` — OSS extraction plan
- `2026-04-03-wasm-agent-host-capabilities-design.v3.md` — LLM + HTTP host capabilities
