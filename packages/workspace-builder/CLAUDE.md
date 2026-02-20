# @atlas/workspace-builder

Deterministic compiler: prompt → WorkspaceBlueprint (LLM) → FSM (pure) →
workspace.yml (pure).

## Commands

```bash
deno task test packages/workspace-builder/          # run tests
deno check packages/workspace-builder/mod.ts        # type check
```

## Package Rules

- Compiler and assembler are **pure functions** — no LLM calls, no I/O. Keep
  them deterministic.
- Blueprint types live in `@atlas/schemas/workspace`, not here. This package
  re-exports them via `types.ts`.
- Planner steps use Vercel AI SDK (`generateObject`, `generateText`, `tool`).
- Transform expressions are JS with `value` and `docs` bindings, validated in a
  zero-permission Deno worker sandbox.
- One `PrepareMapping` per (consumer, upstream) pair — fan-in produces multiple
  mappings per consumer step.

## Domain Vocabulary

| Term | Meaning |
|---|---|
| WorkspaceBlueprint | Complete plan artifact (signals + agents + jobs) |
| DAGStep | Execution node with `depends_on` edges |
| DocumentContract | Output promise: step ID + doc ID + JSON Schema |
| PrepareMapping | Input wiring: field paths + transforms + constants |
| Conditional | Branch on field value with `equals`/`default` |
| fan-in | Step with multiple `depends_on` entries |

## Architecture

```
planner/          Phase 1: LLM-based (plan → dag → schemas → mappings)
compiler/         Phase 2: Pure (DAG → FSM via topological sort)
assembler/        Phase 3: Pure (FSMs → workspace.yml)
builder.ts        FSMBuilder fluent API (hand-authored FSMs)
helpers.ts        Action factories (codeAction, agentAction, etc.)
types.ts          Re-exports from @atlas/schemas + local Result/BuildError types
fixtures/         Test plans (JSON)
```

## Key Patterns

- `buildBlueprint()` orchestrates the full planner pipeline with `runStep()`
  wrappers for logging and error handling.
- `buildFSMFromPlan()` uses Kahn's algorithm for topological sort. Fan-in guards
  check all upstream `context.results` entries exist.
- Prepare functions are compiled as IIFEs reading from `context.results` with
  undefined guards.
- Mapping validation uses `generateStubFromSchema()` → sandboxed worker
  execution → type checking against consumer schema.

## Gotchas

- **`classifyAgents()` mutates `Agent[]` in place** — writes `bundledId` and
  `mcpServers` on the original objects. Downstream code gets modified references
  without cloning.
- **`EnhancedTaskStep.executionType` is `"agent"` not `"bundled"`** —
  `blueprintToTaskPlan` maps compiler's `"bundled"` to `"agent"` for the
  executor. Wrong value silently breaks progress reporting.

## Testing Conventions

- Mock LLM calls with `vi.fn()` — never hit real models in unit tests.
- Use fixture JSON plans from `fixtures/` for compiler/assembler tests.
- Compiler tests verify topological ordering, guard generation, and prepare code.
- See the `testing` skill for broader test philosophy.
