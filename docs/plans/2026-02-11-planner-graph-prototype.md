# Planner Graph Prototype

Branch: `eric/planner-graph-prototype`. Work started 2026-02-05.

Replaces LLM code generation for FSM wiring with a multi-phase planner pipeline
and deterministic compiler. The LLM's role shifts from "generate arbitrary
TypeScript" to "select fields from known schemas and decompose tasks with
dependencies" — both constrained and naturally suited to language models. Same
plan always produces same FSM.

## What Changed

### `packages/workspace-builder/` — Pipeline Package

Single home for the full workspace creation pipeline. Contains the planner
(LLM-based), compiler (pure function), and assembler (pure function). The
existing FSMBuilder fluent API (`builder.ts`, `helpers.ts`) stays — the compiler
uses it internally.

```
packages/workspace-builder/
├── mod.ts                          # Public API: buildBlueprint(), buildFSMFromPlan(), buildWorkspaceYaml()
├── types.ts                        # WorkspaceBlueprint, JobWithDAG, DAGStep, DocumentContract, etc.
├── builder.ts                      # FSMBuilder fluent API (internal)
├── helpers.ts                      # agentAction, codeAction, emitAction, llmAction
├── planner/
│   ├── build-blueprint.ts          # Top-level orchestrator: prompt → WorkspaceBlueprint
│   ├── plan.ts                     # Phase 1: prompt → signals + agents (mode-aware)
│   ├── dag.ts                      # Phase 2: → DAG steps per job
│   ├── schemas.ts                  # Phase 3a: → output schemas per step
│   ├── mappings.ts                 # Phase 3b: → prepare mappings (tool-use validation)
│   ├── mapping-accumulator.ts      # Accumulator for validated mapping operations
│   ├── tools.ts                    # AI SDK tool definitions for mapping generation
│   ├── validation-executor.ts      # Long-lived worker pool for transform validation
│   ├── validation.worker.ts        # Isolated sandbox for JS expression execution
│   ├── classify-agents.ts          # Bundled registry / MCP matching
│   ├── enrich-signals.ts           # Concrete signal configs (cron, HTTP, etc.)
│   ├── enrich-pipeline-context.ts  # Downstream requirements → behavioral descriptions
│   ├── resolve-credentials.ts      # Link credential resolution → bindings
│   └── preflight.ts                # Environment readiness checks
├── compiler/
│   ├── build-fsm.ts                # JobWithDAG → FSMDefinition (pure, deterministic)
│   └── validate-field-path.ts      # JSON Schema path validation (properties + items only)
├── assembler/
│   └── build-workspace.ts          # Plan + FSMs → workspace.yml (pure)
└── fixtures/                       # 11 test plans covering all topologies
```

#### Pipeline Phases

**`buildBlueprint(prompt, opts)` orchestrates all phases internally:**

1. **Plan** — LLM generates workspace identity, signals, agents from prompt.
   Mode-aware: `"workspace"` includes signals, `"task"` excludes them (same
   output type, empty `signals` array in task mode).
2. **Classify** — Match agents to bundled registry or MCP servers
   (deterministic).
3. **Credentials** — Resolve Link credentials → bindings.
4. **Preflight** — Validate environment readiness.
5. **Signals** — Enrich signal configs (workspace mode only, LLM).
6. **DAG** — Generate job steps with `depends_on` edges (LLM). Topological sort
   validates no cycles. In task mode, signal IDs fall back to `["adhoc-trigger"]`
   since the signals array is empty.
7. **Context** — Annotate agent descriptions with downstream requirements (LLM).
   Produces behavioral guidance, not field specs.
8. **Schemas** — Output schemas per step. Bundled agents: from registry (no
   LLM). LLM agents: `generateObject` per step, parallelized. Minimal and
   permissive — 1-3 top-level fields, `additionalProperties: true`.
9. **Mappings** — Prepare mappings with mandatory tool-based validation (LLM).

**Error semantics:** Throws `PipelineError` for unrecoverable failures. Returns
soft issues (clarifications, unresolved credentials) in `BlueprintResult`.

#### Tool-Based Mapping Validation (Phase 3b)

Mappings are constructed through validated tool calls, not LLM JSON output.
Every operation validates against ground truth schemas before acceptance:

- **`lookupOutputSchema(stepId)`** — Read-only discovery of upstream schemas.
  Uses `stepOutputSchemas` exclusively (no bundled registry bypass).
- **`addSourceMapping(fromDoc, fromPath, toField)`** — Validates `fromPath`
  against source schema. For bundled agent consumers, validates `toField`
  against the consumer's `inputJsonSchema`.
- **`addTransformMapping(fromDoc, fromPath, toField, transform, description)`**
  — Everything `addSourceMapping` does, plus: syntax pre-check via
  `new Function()`, execution against schema-derived mock data in an isolated
  worker, Zod type validation of the result. Transform expressions are single
  JS expressions with `value` (extracted field) and `docs` (all upstream
  documents by ID) bindings.
- **`addConstant(key, value)`** — Inject static value with optional schema
  validation.
- **`finalize()`** — Signals completion.

Invalid operations are rejected with error context, mock data snapshot, and
field suggestions. The mapping IS the accumulated validated operations.

A single `ValidationExecutor` worker is spawned at Phase 3b start, reused
across all parallel mapping tasks, and terminated on completion.

#### Compiler (`build-fsm.ts`)

Pure function. No LLM, no side effects. Walks DAG topologically and emits:

- **States**: `idle` → `step_*` → `completed`
- **Prepare functions**: Template-generated code for field extraction. Plain
  mappings use direct property access. Transforms compile to IIFEs with `value`
  binding and fail-fast undefined guards. A hoisted `docs` preamble
  (`const docs = context.results`) enables cross-document transforms.
- **Guards**: Existence guards (`context.results[id] !== undefined`), fan-in
  guards (AND of multiple existence checks), conditional guards (value matching
  with default fallback).
- **Transitions**: `ADVANCE` signal routing with guard evaluation.

Supported topologies: linear chains, fan-in (diamond), conditional branching,
multi-job plans. Returns `{ fsm, warnings }` — warnings are `no_output_contract`
and `invalid_prepare_path`.

**Limitation: agent/LLM action type.** The compiler emits `agentAction()` for
every DAG step — it doesn't know which agents are bundled (HTTP delegation) vs
LLM (managed execution with MCP tools). `DAGStep` only carries
`{ id, agentId, description, depends_on }`, no execution type. Consumers
post-process with `patchLLMActions()` to swap non-bundled agents to `llmAction`
with their MCP server tools. See Key Decisions for the tradeoff.

#### Assembler (`build-workspace.ts`)

Pure function. Plan + compiled FSMs → valid `workspace.yml`:

- Maps signals to workspace signal configs
- Collects MCP server configs from registry
- Applies credential bindings
- Builds agent configs (bundled → `type: "atlas"`, LLM → `type: "llm"`)
- Embeds compiled FSMs inline in job definitions

### `packages/schemas/` — JSON Schema as Single Source of Truth

`JSONSchemaSchema` (`packages/schemas/src/json-schema.ts`) defines exactly which
JSON Schema keywords the FSM engine supports: `type`, `properties`, `items`,
`required`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`,
`additionalProperties`, `description`. Composition keywords (`anyOf`, `oneOf`,
`allOf`, `not`) are stripped via Zod parse. `sanitizeJsonSchema()` is a thin
wrapper around `JSONSchemaSchema.parse()`. `ValidatedJSONSchema` means
"engine-compatible" — only supported keywords survive.

### `packages/bundled-agents/` — Parse at the Boundary

`deriveRegistryEntry()` wraps `z.toJSONSchema()` output with
`sanitizeJsonSchema()` for both `inputJsonSchema` and `outputJsonSchema`.
Schemas are engine-safe from the moment they enter the registry.

### `packages/fsm-engine/` — Engine Changes

**Deleted hand-rolled JSON Schema → Zod converter.** `json-schema-to-zod.ts`
(166 lines) replaced by Zod v4's native `z.fromJSONSchema()`. The `JSONSchema`
interface gained a `[key: string]: unknown` index signature for assignability to
`z.fromJSONSchema()`'s parameter type without casts.

**Prepare results as return values.** Prepare functions return
`{ task?, config? }` instead of calling `context.createDoc()`. The engine
captures code action return values via `parsePrepareResult()` (Zod-parsed at
the boundary) and threads them to subsequent agent actions as `context.input`.
Local variable scoping in `executeActions` makes cross-state leakage impossible
by construction.

**Results accumulator.** `context.results` replaces the document bag for
prototype-compiled workspaces. Agent outputs merge into
`Record<string, Record<string, unknown>>` keyed by `outputTo`. Replace
semantics (not merge). Results clear when FSM returns to initial state —
eliminates generated cleanup functions.

**Dual-write backward compatibility.** Agent outputs write to both
`pendingResults` and `pendingDocuments`. Legacy workspaces read
`context.documents`; prototype-compiled workspaces read `context.results`. Both
participate in the same transactional isolation pattern.

**Schema validation at merge.** When `outputType` is declared on an action, the
engine validates agent output against the document type schema before merging.
Fails with a clear error naming the agent and contract violation.

**Input-only prompts.** Agent and LLM prompts show only the curated `Input:`
section from prepare functions. No ambient document dump. Artifact ref expansion
is retained in LLM prompt building.

### `do-task/` — Task Mode Integration

Post-processes compiled FSMs via `patchLLMActions()` to convert non-bundled
agents from `agentAction` to `llmAction` with MCP server tool IDs, hardcoded
`anthropic` provider and `claude-sonnet-4-5` model. Applied between
`buildFSMFromPlan()` and engine creation.

`ephemeral-executor.ts` fixes: result collection uses `engine.results` with
contract-based `documentId` lookup (not `${agentId}_result`). State-to-step
mapping uses actual DAG step IDs (not numeric indices). Trigger signal hardcoded
to `"adhoc-trigger"` (not derived from FSM definition ID via regex).

### `proto/` — Development Shell

Proto stays as a CLI/playground/harness layer over `workspace-builder`:

```
proto/
├── cli.ts               # Full pipeline from prompt, compile from fixture, re-run
├── tracer.ts            # PipelineTracer: structured execution trace → trace.json
├── playground.ts        # Web UI (port 3456), SSE streaming, interactive inspection
├── harness/
│   ├── run-fsm.ts       # Execute FSM via real FSMEngine
│   ├── mock-executor.ts # Schema-derived stubs + fixture replay
│   ├── real-executor.ts # HTTP calls to running daemon
│   ├── capture-executor.ts  # Save agent outputs as fixtures
│   ├── direct-executor.ts   # Direct agent invocation
│   └── generate-stub.ts    # JSON Schema → deterministic mock data
├── fixtures/            # Test plans (mirrors workspace-builder/fixtures/)
└── runs/                # Saved pipeline runs (gitignored)
```

**CLI** supports: full pipeline from prompt, compile from fixture
(`--plan=file.json`), re-run from saved run (`--run=dir/`), stop at phase
(`--stop-at=plan|fsm|run`), verbose mode, saved run listing.

**Harness** executes compiled FSMs with pluggable agent executors. Produces
`ExecutionReport` with state transitions, result snapshots, action traces
(including input received by each agent), and assertions (reached completed,
all expected results exist, no prepare failures).

**Tracer** wraps pipeline phases with timing, inputs, outputs, and error cause
chains. `run()` for fatal phases (re-throws), `tryRun()` for non-fatal (returns
undefined). Writes `trace.json` incrementally to the run directory. Prints
condensed failure summary to stdout.

**Playground** renders pipeline output as interactive web panels: workspace
overview, phase artifacts, compiled FSM states, execution trace timing
waterfall.

### Type System (`workspace-builder/types.ts`)

`PlanWithContracts` was renamed to `WorkspaceBlueprint`. Key types:

- **`WorkspaceBlueprint`** — Top-level: workspace identity, signals, agents,
  jobs.
- **`JobWithDAG`** — Job with steps, document contracts, prepare mappings,
  conditionals.
- **`DAGStep`** — `{ id, agentId, description, depends_on: string[] }`.
  Empty `depends_on` = root step.
- **`DocumentContract`** — What a step produces: `{ producerStepId, documentId,
  documentType, schema: JSONSchema }`.
- **`PrepareMapping`** — How a step gets its input: sources (with optional
  `transform` and `description`), constants.
- **`Conditional`** — Branch on field value: `{ stepId, field, branches[] }`.

**Artifact versioning:**
- v1: `{ type: "workspace-plan", version: 1, data: WorkspacePlan }` (flat steps)
- v2: `{ type: "workspace-plan", version: 2, data: WorkspaceBlueprint }` (DAG +
  contracts + mappings)

## Key Decisions

**Deterministic compilation over LLM code generation.** The old
`fsm-workspace-creator` had an LLM generate 500+ lines of FSM wiring code with
a 3-attempt retry loop. The LLM hallucinated document fields, generated
incorrect naming, and missed function definitions. The compiler is a pure
function — same plan, same FSM — eliminating this entire class of bugs.

**Tool-based validation over prompt-based instructions.** The LLM _can_ ignore
prompt instructions. It cannot ignore tool validation: `addSourceMapping` and
`addTransformMapping` validate against ground truth schemas before accepting.
Invalid operations never enter the accumulator. This inverts the typical LLM
tool pattern (optional capabilities) into a constrained construction pattern
(tools as the only way to build the output).

**Prepare functions as pure transforms.** Returning `{ task, config }` instead
of calling `context.createDoc()` eliminates request documents entirely. No
document type registration needed, no cleanup required. The
`patchRequestDocTypes` hack was deleted.

**Results accumulator over document bag.** `context.results` provides keyed
access, progressive accumulation, automatic cleanup on return to initial state,
and schema validation at merge. The document bag remains for backward
compatibility via dual-write.

**Minimal, permissive schemas for LLM agents.** Over-specified schemas (6+
required fields, 3+ levels of nesting) made contracts fragile and prepare
mappings surgical. LLM agent schemas now have 1-3 top-level fields,
`additionalProperties: true`, and minimal required fields. Bundled agents keep
their registry schemas unchanged.

**`buildBlueprint()` as single orchestrator.** Encapsulates ~13 steps and
~250 lines of orchestration. Consumers become thin shells: workspace-planner
calls it and saves the artifact; do-task calls it and compiles/executes
ephemerally. Manages `ValidationExecutor` lifecycle internally.

**Jobs as the execution primitive.** The job — not the workspace, not the
signal — is the unit of execution. Signals are scheduling (`"when"`).
Workspaces are persistence (`"save this"`). Jobs are execution (`"what"`).
This enables: do-task = plan + compile + execute now; workspace creation =
plan + signals + compile + assemble + persist.

**Mode-parameterized planning.** `plan.ts` accepts `"workspace" | "task"`.
Workspace mode includes signal planning; task mode excludes it. Same output
type, same downstream pipeline. For task mode, callers inject a synthetic
`triggerSignalId: "adhoc-trigger"`.

**JSON Schema as single parse boundary.** `JSONSchemaSchema` in `@atlas/schemas`
is the one definition of supported keywords. Bundled agent schemas are sanitized
at registry build time via `sanitizeJsonSchema()`. Downstream code trusts
`ValidatedJSONSchema` without re-parsing. The hand-rolled `json-schema-to-zod`
converter was deleted in favor of Zod v4's native `z.fromJSONSchema()`.
Composition keywords (`anyOf`/`oneOf`/`allOf`) are stripped rather than
unwrapped — simpler and the downstream code handles typeless fields gracefully.

**Post-process FSM for agent/LLM dispatch (quick fix).** The compiler is pure
and receives only `JobWithDAG` — no agent metadata. It emits `agentAction()`
uniformly. `patchLLMActions()` in do-task post-processes the FSM to swap
non-bundled agents to `llmAction` with MCP tools. This is a known seam: the
compiled FSM artifact is "wrong" until patched, and the model/provider are
hardcoded. The proper fix — either extending `DAGStep` with execution type or
passing agent metadata to the compiler — is deferred until workspace mode
needs it.

## Error Handling

**Pipeline errors.** `buildBlueprint()` throws `PipelineError` (wraps cause
with step name) for unrecoverable failures — LLM errors, validation failures,
abort signals. Soft issues (ambiguous classification, unresolved credentials)
are returned in `BlueprintResult` for callers to evaluate. `PipelineError`
catches in do-task now log via `logger.error` — previously silent failures made
debugging a forensic exercise.

**Compiler warnings are fatal by default.** `no_output_contract` and
`invalid_prepare_path` warnings produce dead-on-arrival workspaces. A contract
completeness gate between schemas and mappings re-runs schemas for missing
steps once before failing.

**Transform validation errors.** Three layers: crash report (actual error
message), mock data snapshot (what the expression was executed against), and
field suggestions (available alternatives). The LLM receives these and
self-corrects within the same inference turn.

**Engine schema validation.** Agent output validated against document type
schema at merge time. Clear error: `"Agent 'data-analyst' output does not
match AnalyzeCsvResult schema: missing required field 'summary'"`.

**Pipeline trace.** `PipelineTracer` records every phase attempt with timing,
inputs, outputs, and full error cause chains. On failure, stdout prints a
condensed summary with all failed spans. `trace.json` persists for agent
diagnosis.

## Out of Scope

- **Parallel step execution in FSM engine** — The DAG identifies parallelizable
  steps, but concurrent execution is a separate engine enhancement.
- **Cross-job dependencies** — Jobs remain independent FSMs triggered by
  signals.
- **Migration of existing workspaces** — Old workspaces with LLM-generated code
  continue to work unchanged via dual-write.
- **Declarative guard DSL** — No expression language. Simple equality checks
  compile to code. Complex conditions become routing steps.
- **v2 plan card UI enhancements** — MVP renders same summary as v1. DAG
  visualization and contract inspection deferred.
- **Full do-task convergence** — Designed in the workspace-builder integration
  plan (Phase 4), not yet implemented. do-task still uses its own pipeline.
- **Production rollout** — Feature flags, gradual rollout, A/B testing are
  separate concerns.
- **Shared execution package** — Extracting ephemeral execution to
  `@atlas/fsm-runner` is premature until a second consumer materializes.
- **Proper compiler agent/LLM dispatch** — Extending `DAGStep` with execution
  type or passing agent metadata to the compiler. The post-process quick fix
  works for task mode; revisit when workspace mode needs correct FSMs by
  construction.
- **Union type preservation in schemas** — Agent schemas with unions (e.g.,
  `to: string | string[]`) lose type info after sanitization. `anyOf` is
  stripped, leaving typeless fields. Long-term: adjust agent Zod schemas to
  avoid unions the engine can't express, or add pre-sanitization unwrapping.
- **FSM engine `JSONSchema` / `ValidatedJSONSchema` unification** — Structurally
  identical but separate types across packages. Unifying requires `fsm-engine`
  depending on `@atlas/schemas`.
- **Task-mode fast path** — Single-step tasks run through 13 pipeline phases to
  produce a single-step FSM. A fast path for trivial tasks is worth exploring
  but not yet designed.
- **Proto simplification** — Trimming proto from ~2,900 LOC to ~1,500 by
  deleting dead paths (fixture compilation, run replay, tracer). Designed but
  not yet implemented.

## Test Coverage

**21 test files** across planner, compiler, and assembler. **11 fixture plans**
covering all topologies: linear, fan-in (diamond), conditional branching,
multi-job, transforms.

**Compiler tests** (`build-fsm.test.ts`) — Fixture-based snapshot testing.
Validates state generation, transition routing, guard codegen, prepare function
codegen (with and without transforms), document type registration, and
determinism (same input → same output). Tests per topology: linear (6), fan-in
(5), 3-step linear (3), conditional (7), multi-job (6), compile warnings (8).

**Planner tests** — Mock LLM calls, verify output shapes and enrichment logic.
Mapping accumulator tests validate tool operations: path validation,
transform sandbox execution, type checking, error messages. Schema generation
tests verify minimality and permissiveness constraints.

**Assembler tests** — Output passes `WorkspaceConfigSchema`. Signals, agents,
FSMs, credentials all mapped correctly.

**Engine tests** — `prepare-result.test.ts` (return value capture, Zod parsing,
empty-result filtering, scoping), `results-accumulator.test.ts` (accumulation,
clear-on-initial, transactional isolation, dual-write, schema validation).

**Harness tests** — Mock executor (stub generation, fixture loading, override
priority), execution report assertions, transform integration (end-to-end data
flow through compiled FSM).

**Tracer tests** — `run()` success/failure, `tryRun()` non-fatal semantics,
error cause chain extraction, incremental file writes.

**JSON Schema tests** — `json-schema.test.ts` (8 tests: parse behavior, strips
composition keywords, accepts supported keywords). `registry.test.ts` (30
structural tests: parameterized identity checks, per-agent schema tests for
union handling and optional fields, verifies no composition keywords survive).
`validate-field-path.test.ts` (8 tests per copy: root/nested/array paths,
invalid paths, empty schemas, typeless leaves — composition cases deleted).
