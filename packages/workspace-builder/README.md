# @atlas/workspace-builder

Deterministic compiler that turns natural language prompts into executable Atlas
workspaces. Three phases, one boundary: LLMs plan, pure functions compile.

## How It Works

```
prompt ──► Planner (LLM) ──► WorkspaceBlueprint ──► Compiler (pure) ──► FSM ──► Assembler (pure) ──► workspace.yml
```

**Phase 1 — Planner.** LLM decomposes a prompt into signals (triggers), agents
(capabilities), and DAG-structured jobs. Each step gets an output schema
(contract) and prepare mappings (data wiring between steps). Tool-use validation
catches mapping errors at plan time, not runtime.

**Phase 2 — Compiler.** Pure function. Topological sort linearizes the DAG into
FSM states. Same input → same output, always. No LLM touches wiring logic.

**Phase 3 — Assembler.** Pure function. Merges FSM definitions with signal
configs and agent declarations into a valid `workspace.yml`.

## Key Concepts

- **WorkspaceBlueprint** — The complete plan: signals, agents, jobs with DAG
  topology
- **DAGStep** — Execution node with `depends_on` edges. Supports fan-in
  (multiple upstream dependencies)
- **DocumentContract** — What a step promises to produce (step ID + document ID
  + JSON Schema)
- **PrepareMapping** — How a step gets input: field paths from upstream docs,
  optional transforms, constants
- **Conditional** — Branch execution on a field value

## Usage

```typescript
import {
  buildBlueprint,
  buildFSMFromPlan,
  buildWorkspaceYaml,
} from "@atlas/workspace-builder";

// Phase 1: Prompt → Blueprint
const { blueprint, clarifications, credentials } = await buildBlueprint(
  "Monitor GitHub PRs and post summaries to Slack",
  { mode: "workspace" },
);

// Phase 2: Blueprint → FSMs (one per job)
const fsms = blueprint.jobs.map((job) => buildFSMFromPlan(job));

// Phase 3: FSMs → workspace.yml
const yaml = buildWorkspaceYaml(blueprint, fsms, credentials.bindings);
```

## FSMBuilder

Fluent API for hand-authoring FSM definitions without the planner pipeline:

```typescript
import { FSMBuilder, agentAction, codeAction } from "@atlas/workspace-builder";

const result = FSMBuilder.create("my-workflow")
  .addState("fetch")
    .onEntry(agentAction("github-fetcher"))
    .transition("ADVANCE", "process")
  .addState("process")
    .onEntry(codeAction("transform"))
    .transition("ADVANCE", "done")
  .addState("done", { final: true })
  .setInitial("fetch")
  .build();
```

## Testing

```bash
deno task test packages/workspace-builder/       # all tests
deno task test packages/workspace-builder/compiler/  # compiler only
```

Fixtures in `fixtures/` cover linear chains, fan-in patterns, conditional
branching, and array mappings.
