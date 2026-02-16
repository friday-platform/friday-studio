# Workspace Simulator

Interactive test harness and visualizer for the
[workspace-builder](../../packages/workspace-builder/README.md) pipeline. The core
implementation (planner, compiler, assembler) lives in `packages/workspace-builder/`.

This directory is for **running, inspecting, and debugging** the pipeline — not
the pipeline itself.

## What's Here

```
tools/workspace-simulator/
├── cli.ts              # CLI runner — orchestrates pipeline, saves artifacts
├── playground.ts       # Browser visualizer server (port 3456)
├── playground.html     # Single-file UI for inspecting pipeline phases
├── harness/            # FSM execution with pluggable agent executors
│   ├── run-fsm.ts      # Execute compiled FSMs through FSMEngine
│   ├── mock-executor.ts    # Deterministic stubs from schema contracts
│   └── direct-executor.ts  # Real MCP agent execution (in-process)
└── runs/               # Timestamped execution artifacts
```

## CLI

```bash
# Full pipeline: prompt → plan → compile → execute
deno task sim "analyze CSV data and email a report"

# Stop at intermediate phase
deno task sim "prompt" --stop-at=plan    # After planning
deno task sim "prompt" --stop-at=fsm     # After compilation

# Real agent execution (spins up MCP servers in-process)
deno task sim "prompt" --real
```

Runs save to `tools/workspace-simulator/runs/<timestamp>-<slug>/` with all phase artifacts:
`phase3.json`, `fsm.json`, `workspace.yml`, `execution-report.json`,
`summary.txt`.

## Playground

```bash
deno task sim:playground
# → http://localhost:3456
```

Browser-based UI for running the pipeline and stepping through every phase.
Panels: signals/agents, DAG visualization, contracts/mappings, workspace.yml
preview, and an FSM execution debugger with state diagram, stepper controls, and
results accumulator.

Live-reloads on source changes. Select previous runs from the dropdown; URL
persists with `?run=<slug>`.

## Harness

The FSM harness executes compiled FSMs through `FSMEngine` with pluggable
executors:

- **Mock executor** — deterministic stubs derived from output schema contracts.
  Resolution: agent overrides → schema stub → `{}`.
- **Direct executor** — real MCP execution. Spins up MCP servers in-process,
  injects `complete` tool with output schema, runs agentic loop via AI SDK.

Returns an `ExecutionReport`: state transitions, result snapshots per state,
action traces, assertions (reached completed, all docs exist, no prepare
failures).

```bash
deno task test tools/workspace-simulator/harness/    # harness tests
```
