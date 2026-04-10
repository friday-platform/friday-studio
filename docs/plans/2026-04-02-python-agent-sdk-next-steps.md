# Python Agent SDK — Next Steps

**Date:** 2026-04-02
**Picks up after:** Python Agent SDK PoC (v3 design)
**Context:** [Polyglot Code Agents Design](./2026-04-02-polyglot-code-agents-design.md)

At this point the SDK PoC is done: a Python agent authored with `@agent`, compiled
to WASM, executing through the playground. The decorator, bridge, WIT contract,
and tagged union results all work end-to-end. But the agent is a black box — no
host capabilities, no CLI tooling, no registry.

These are the moves that take it from PoC to usable, in dependency order.

---

## 1. Host Function Bridge

**The biggest remaining unknown.** The spike proved WIT exports (agent → host).
This step proves WIT imports (host → agent): `call-tool`, `list-tools`, `log`,
`stream-emit`.

**What to figure out:**
- How jco-transpiled modules accept host function bindings at instantiation
  (`--instantiation` flag, `preview2-shim` config, or manual import wiring)
- Whether host functions can be async (MCP tool calls are async on the host side,
  but WASM execution is synchronous)
- How the transpiled ES module surfaces the import stubs for the host to fill

**Deliverable:** A Python agent that calls `ctx.tools.call("echo", {"msg": "hi"})`
and gets a response from a mock host function. Proves the round-trip. The
playground wires mock implementations for all four capabilities.

**Risk:** If jco's import wiring is awkward, the internal bridge changes but
`ctx.tools.call()` stays the same from the user's perspective.

---

## 2. `atlas agent build` CLI

Wraps the manual `componentize-py` → `jco transpile` pipeline into a single
command.

**What it does:**
- Detects entry point (`app.py` by convention, overridable)
- Imports user module in native Python to trigger `@agent` decorator
- Extracts JSON Schema from dataclass schemas (build-time library)
- Generates bridge import wiring
- Runs `componentize-py` → `jco transpile`
- **Validates metadata:** instantiates the transpiled module, calls
  `getMetadata()`, and runs the output through `AgentMetadataSchema.parse()`.
  Build fails with actionable error if the metadata doesn't satisfy the host
  contract (e.g. missing required `expertise` field). This is the compile-time
  enforcement — the Python SDK emits an opaque JSON string via WIT, so the
  build step is the earliest point where the real TypeScript schema can validate
  it. The integration test (`wasm-pipeline.test.ts`) covers this in the PoC.
- Outputs transpiled ES module ready for import

**What it enables:**
- Schema extraction actually works (currently handwaved in PoC — schemas are
  pre-computed at build time, but there's no build step running)
- Single command instead of 3 manual steps
- Foundation for `atlas agent run` (local test execution)

**Depends on:** Nothing from step 1 — can be built in parallel.

---

## 3. Registry Integration (CodeAgentAdapter)

Wire WASM agents into the unified `AgentRegistry` so they're discoverable
alongside bundled and YAML agents.

**What to build:**
- `CodeAgentAdapter` implementing `AgentAdapter` interface
- `LocalCodeAgentAdapter` — reads `.wasm` artifacts from `~/.friday/agents/`
- Loads WASM module, calls `get-metadata()`, returns `AgentSourceData`
- New `AgentSourceType`: `"code"` alongside `"system" | "bundled" | "sdk"`
- LRU cache for loaded modules (same pattern as `AgentLoader`)

**What it enables:**
- WASM agents appear in `listAgents()` and planner classification
- Workspace config references them: `type: code, agent: my-agent@1.0.0`
- No more hardcoded `user-agents.ts` in the playground

**Depends on:** Step 2 (need `atlas agent build` to produce artifacts in the
conventional location).

---

## 4. CodeAgentExecutor

The execution path for code agents in the workspace runtime, parallel to the
bundled agent path and the YAML agent path.

**What to build:**
- `CodeAgentExecutor` that loads transpiled module, binds real host functions,
  calls `execute()`, parses result
- Host function binding: `list-tools` → workspace MCP tool registry,
  `call-tool` → MCP tool invocation, `stream-emit` → StreamEmitter bridge,
  `log` → Logger bridge
- Timeout enforcement (configurable per-agent, default 180s)
- Dispatch fork in workspace runtime: `source === "code"` → `CodeAgentExecutor`

**What it enables:**
- WASM agents participate in FSM workflows for real
- Real MCP tool access, real streaming, real logging
- Agents can actually do useful work (call Slack, read GitHub, etc.)

**Depends on:** Steps 1 + 3 (host functions must work, agents must be in
registry).

---

## 5. DX Polish

Lower priority — the agent works without these, but the authoring experience
improves significantly.

### TypedDict IDE Types
- Generate TypedDict definitions from Zod schemas via `datamodel-code-generator`
- Ship as part of `friday-agent-sdk` so IDE autocomplete works for `@agent` kwargs
- Catches ~70% of errors before running anything

### Pydantic Build-Time Validation
- `friday_agent_validation` sub-package with Pydantic models from Zod schemas
- Runs during `atlas agent build` before `componentize-py`
- Catches ~99% of errors with actionable messages
- Depends on step 2 (build CLI)

### PyPI Publishing
- Publish `friday-agent-sdk` so users can `pip install` instead of working from
  source
- Publish `friday-agent-validation` separately (has Pydantic dep)

---

## Dependency Graph

```
         ┌──────────────┐
         │  SDK PoC (✓)  │
         └──────┬───────┘
                │
        ┌───────┴────────┐
        ▼                ▼
  ┌───────────┐   ┌────────────┐
  │ 1. Host   │   │ 2. Build   │
  │ Functions │   │    CLI     │
  └─────┬─────┘   └──────┬─────┘
        │                │
        │         ┌──────▼──────┐
        │         │ 3. Registry │
        │         │  Adapter    │
        │         └──────┬──────┘
        │                │
        └────────┬───────┘
                 ▼
          ┌─────────────┐
          │ 4. Executor │
          └──────┬──────┘
                 │
                 ▼
          ┌─────────────┐
          │ 5. DX Polish│
          └─────────────┘
```

Steps 1 and 2 can run in parallel. Everything else is sequential.
