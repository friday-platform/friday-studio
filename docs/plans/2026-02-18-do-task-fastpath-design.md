# do_task Fastpath for Single-Agent Jobs

## Problem Statement

Users frequently use `do_task` for simple, single-agent jobs -- "search the web
for X", "check my calendar", "summarize this". These tasks go through the full
workspace planning pipeline: plan generation, DAG construction, schema
generation, data mappings, and context enrichment -- 5-7 LLM calls (mostly
Sonnet) before any actual work starts. For a task that just needs one agent, this
is unnecessary overhead that adds latency and cost.

## Solution

Add a fastpath gate after the first two planning steps (`generatePlan` +
`classifyAgents`). When the result is a single agent -- bundled or LLM-backed --
with no ambiguous classifications, skip the multi-step pipeline wiring (DAG,
schemas, mappings, context enrichment) and dispatch directly via a trivial FSM.

The fastpath reuses the existing `executeTaskViaFSMDirect` executor, preserving
observability hooks, context building, session isolation, and future Session
History v2 compatibility. The savings come entirely from eliminating the planning
LLM calls that wire multi-step pipelines.

**Total LLM calls on fastpath: 1** (plan step). Down from 5-7.

## Success Criteria

1. **Single-agent tasks take the fastpath** -- `deno task atlas prompt "check my
   calendar"` produces a log line `do-task fastpath: single-agent dispatch`.
   Only 1 LLM call (the plan step); `generateDAGSteps` should NOT appear in logs.
2. **Multi-agent tasks use the full pipeline** -- `deno task atlas prompt
   "research X then email Y"` produces a log line `do-task fastpath: ineligible`.
3. **Results are collected correctly** -- Unit test: executor given a fastpath FSM
   + DocumentContract + DAGStep returns a successful `DoTaskResult` with content
   (not `"No result found for step"`).
4. **Progress events fire for both agent types** -- LLM agent FSM triggers
   `step-start` / `step-complete` via `stateToStepIndex` lookup. Bundled agent
   progress fires via `agentExecutor` callback (unchanged).
5. **Credential resolution works on fastpath** -- Agent with
   `configRequirements` gets credentials resolved; unresolved credentials bail
   with clarification response.
6. **Full pipeline fallback with precomputed results** -- `buildBlueprint({
   precomputed })` produces identical output to calling without precomputed,
   minus the plan+classify steps.
7. **Timing data is captured on both paths** -- `do_task completed` log line
   includes `durationMs`, `planningMs`, `executionMs`, and `fastpath` fields.
   Task artifact payload includes `timing` object.
8. **Eval suite passes** -- `deno task evals run --filter do-task/fastpath`
   produces `routing/correct: 1.0` for all cases.

## User Stories

1. As a user sending a simple research query, I want results faster, so that
   do_task feels responsive for one-off jobs
2. As a user asking Friday to check my calendar, I want the system to recognize
   this is a single-agent job and skip unnecessary planning, so that I get my
   answer without waiting for DAG/schema/mapping generation
3. As a user sending a multi-step task ("research X then email Y"), I want the
   full planning pipeline to still run, so that complex workflows are wired
   correctly
4. As a user whose task needs OAuth credentials (e.g. Linear, Google Calendar),
   I want credential resolution to still work on the fastpath, so that
   authenticated integrations aren't broken
5. As a user, I want session history to capture fastpath executions the same way
   it captures full-pipeline executions, so that my task history is complete
6. As a developer, I want the fastpath to use the same classification logic as
   the full pipeline, so that agent selection is consistent and predictable
7. As a developer, I want the fastpath decision to be invisible to the executor,
   so that observability and context building aren't reimplemented

## Implementation Decisions

### Fastpath Gate

The gate runs after `generatePlan()` + `classifyAgents()` -- the first two steps
of `buildBlueprint()`. Plan extracts agent needs (1 Sonnet call), classify
matches them deterministically against the bundled agent registry and MCP server
registry (no LLM).

Extract the gate as a named, exported function for testability:

```typescript
export function isFastpathEligible(
  plan: Phase1Result,
  classifyResult: { clarifications: AgentClarification[]; configRequirements: ConfigRequirement[] },
): boolean {
  if (plan.agents.length !== 1) return false;
  const agent = plan.agents[0];
  if (agent.bundledId == null && (!agent.mcpServers || agent.mcpServers.length === 0)) return false;
  if (classifyResult.clarifications.length > 0) return false;
  return true;
}
```

Three signals: single agent, successfully classified (bundled or MCP-backed), no
ambiguity. Any multi-agent plan, unresolved needs, or ambiguous classification
falls through to the full pipeline.

### Architecture: Fastpath Lives in do-task/index.ts

The fastpath decision lives in `do-task/index.ts`, not inside `buildBlueprint()`.
`buildBlueprint()`'s contract is "give me a prompt, I give you a blueprint ready
for FSM compilation." Making it return "skip the FSM and dispatch directly" would
violate its purpose and leak dispatch concerns into the planner. The
`workspace-planner` agent also consumes `buildBlueprint()` for workspace
generation -- adding a fastpath there risks unintended side effects on that path.

`do-task/index.ts` calls `generatePlan()` and `classifyAgents()` directly (both
already exported). If the gate passes, it takes the fastpath. If not, it calls
`buildBlueprint()` with pre-computed plan+classify results to avoid re-running
the Sonnet call.

### Error Handling for Direct Calls

The fastpath calls `generatePlan()` and `classifyAgents()` directly -- outside
`buildBlueprint()`'s `runStep()` wrapper. The catch handler must handle both
`PipelineError` (from `buildBlueprint` on the fallback path) and raw errors
(from direct calls):

```typescript
try {
  const plan = await generatePlan(intent, { mode: "task", abortSignal });
  const classifyResult = await classifyAgents(plan.agents);

  if (isFastpathEligible(plan, classifyResult)) {
    // ... fastpath ...
  } else {
    // ... full pipeline with precomputed ...
  }
} catch (err) {
  if (err instanceof Error && err.name === "AbortError") throw err;
  if (err instanceof PipelineError) {
    logger.error("Pipeline failed", { phase: err.phase, error: err.cause.message });
    return { success: false, error: `Planning failed at "${err.phase}": ${err.cause.message}` };
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error("do_task failed", { error: message });
  return { success: false, error: `Task failed: ${message}` };
}
```

`storeTaskArtifact` calls (both paths) are wrapped in try/catch -- a storage
failure after successful execution logs a warning but doesn't retroactively fail
the task.

### Pre-computed Results for Full Pipeline Fallback

Extend `BuildBlueprintOpts` with an optional `precomputed` field:

```typescript
type BuildBlueprintOpts = {
  mode: PlanMode;
  logger: Logger;
  abortSignal?: AbortSignal;
  precomputed?: {
    plan: Phase1Result;
    classified: ClassifyResult;
  };
};
```

When `precomputed` is present, `buildBlueprint()` skips `generatePlan()` and
`classifyAgents()` and uses the provided results. Three-line change at the top
of the function. The rest of the pipeline (DAG, schemas, mappings, context
enrichment) runs unchanged.

### Credential Resolution on the Fastpath

Credential resolution (`resolveCredentials` + `checkEnvironmentReadiness`) runs
on the fastpath. Many MCP-backed servers require OAuth tokens. Both steps are
no-LLM deterministic lookups -- zero added cost. If credentials are unresolved,
the fastpath bails with the same clarification response the full pipeline uses.

### Prompt Construction

The trivial FSM uses the **original user intent** (the `prompt` string passed to
`do_task`) as the action prompt. Not `plan.agents[0].description` (describes
what the agent *is*, not what it should *do*) and not `plan.workspace.purpose`
(summarized/rewritten, loses fidelity). For a single-agent task the user's
original intent is the most faithful instruction.

### Shared Compiler Utilities

Export from `build-fsm.ts` (currently module-local) for reuse by the fastpath:

- `DEFAULT_LLM_PROVIDER` (`"anthropic"`)
- `DEFAULT_LLM_MODEL` (`"claude-sonnet-4-6"`)
- `stateName(stepId: string): string` -- returns `step_${normalize(stepId)}`
- `normalize(id: string): string` -- replaces `-` with `_`

Add `export` to the existing definitions in `build-fsm.ts`. Re-export from
`workspace-builder/mod.ts`. No new files. State naming is the highest-risk
convention to duplicate -- a mismatch silently drops LLM agent progress events
with no runtime error. Sharing by import eliminates this class of bug.

### Trivial FSM Construction

Build a 3-state FSM directly instead of running the compiler. The FSM state name
uses the shared `stateName()` function to match the compiler's naming convention.
This is required because the executor's `stateToStepIndex` map uses this pattern
to map FSM state transitions to step indices for progress events.

Both action types set `outputTo: "result"` -- without it, the FSM engine skips
writing results to `engine.documents`, and the executor reports
`{ success: false, error: "No result found for step" }`.

**Bundled agent:**

```typescript
import { stateName, DEFAULT_LLM_PROVIDER, DEFAULT_LLM_MODEL } from "@atlas/workspace-builder";

const stateId = stateName(fastpathDAGStep.id);

{
  id: `task-fastpath-${crypto.randomUUID().slice(0, 8)}`,
  initial: "idle",
  states: {
    idle: {
      on: { "adhoc-trigger": { target: stateId } },
    },
    [stateId]: {
      entry: [
        { type: "agent", agentId: bundledId, prompt: intent, outputTo: "result" },
        { type: "emit", event: "ADVANCE" },
      ],
      on: { ADVANCE: { target: "completed" } },
    },
    completed: { type: "final" },
  },
}
```

**LLM agent with MCP tools:**

```typescript
const stateId = stateName(fastpathDAGStep.id);

{
  id: `task-fastpath-${crypto.randomUUID().slice(0, 8)}`,
  initial: "idle",
  states: {
    idle: {
      on: { "adhoc-trigger": { target: stateId } },
    },
    [stateId]: {
      entry: [
        {
          type: "llm",
          provider: DEFAULT_LLM_PROVIDER,
          model: DEFAULT_LLM_MODEL,
          prompt: intent,
          tools: mcpServerIds,
          outputTo: "result",
        },
        { type: "emit", event: "ADVANCE" },
      ],
      on: { ADVANCE: { target: "completed" } },
    },
    completed: { type: "final" },
  },
}
```

When `documentTypes` is missing from the FSM definition, the engine bypasses
schema validation entirely (backwards-compatibility path). The conversation
agent relays results to the user. Structured output schemas only matter for
multi-step data wiring.

### Minimal Data Structure Construction

The executor requires `EnhancedTaskStep[]` for progress reporting. The actual
type:

```typescript
type EnhancedTaskStep = {
  agentId?: string;
  description: string;
  executionType: "agent" | "llm";
  needs: string[];
  friendlyDescription?: string;
};
```

Note: `executionType` uses `"agent"` (not `"bundled"`) -- the existing
`blueprintToTaskPlan` maps the compiler's `"bundled"` to `"agent"` for the
executor. The fastpath does the same mapping inline:

```typescript
const agent = plan.agents[0];

const fastpathStep: EnhancedTaskStep = {
  agentId: agent.bundledId ?? agent.name,
  description: intent,
  executionType: agent.bundledId ? "agent" : "llm",
  needs: agent.needs,
  friendlyDescription: agent.description,
};
```

The executor also uses `dagSteps` for state name to step index mapping (drives
progress events). Construct a minimal `DAGStep`:

```typescript
const fastpathDAGStep: DAGStep = {
  id: `${agent.name}-step`,
  agentId: agent.bundledId ?? agent.name,
  description: intent,
  depends_on: [],
};
```

### Result Collection via DocumentContract

The executor collects results through a two-tier lookup:

1. **Primary:** `stepDocumentId.get(dagStep.id)` -> `engine.results[docId]`
2. **Fallback:** `engine.documents.find(d => d.id === docId || d.id === "${agentId}_result")`

With `documentContracts: []`, both lookups fail silently. Pass a minimal
`DocumentContract` to enable the primary lookup path:

```typescript
const fastpathContract: DocumentContract = {
  producerStepId: fastpathDAGStep.id,
  documentId: "result",
  documentType: "result",
  schema: { type: "object" } as ValidatedJSONSchema,
};
```

The `documentType` and `schema` fields are required by the type but not consumed
by result collection -- they're only used for FSM-level schema validation, which
is bypassed when `documentTypes` is absent.

```typescript
executeTaskViaFSMDirect(fsm, [fastpathStep], {
  ...context,
  dagSteps: [fastpathDAGStep],
  documentContracts: [fastpathContract],
});
```

MCP server configs are built from the classified agent's `mcpServers` array +
credential bindings. `buildMCPServerConfigs` expects post-classification
`Agent[]` with `mcpServers` set -- compatible as-is after `classifyAgents()`
mutates the plan agents.

### Executor Reuse

The trivial FSM feeds into the existing `executeTaskViaFSMDirect()`. This
preserves:

- **Context building:** datetime injection, artifact expansion, document
  serialization
- **Session isolation:** `${parentSessionId}-task-${8chars}` scoping
- **Observability hooks:** `onEvent` with state transitions, action execution
  events -- same integration point for Session History v2
- **MCP tool setup:** `GlobalMCPServerPool` + `GlobalMCPToolProvider`
- **Progress events:** `step-start` / `step-complete` emitted to UI stream

The executor doesn't know or care whether it's running a trivial fastpath FSM
or a compiled multi-step FSM.

### Friendly Descriptions

Skip `generateFriendlyDescriptions()` (1 Haiku call) on the fastpath. The plan
step already provides `plan.agents[0].description` -- used directly as
`friendlyDescription` on the `EnhancedTaskStep`.

### Observability and Timing

do_task currently has zero timing infrastructure. The fastpath adds structured
timing to both code paths so we can measure the speedup. Follows codebase
convention: `Date.now()` diff -> `durationMs` field.

**Completion log (both paths):**

```typescript
const startMs = Date.now();
// ... generatePlan, classifyAgents, gate check ...
const planMs = Date.now();
// ... fastpath or full pipeline execution ...
const execMs = Date.now();

logger.info("do_task completed", {
  durationMs: execMs - startMs,
  planningMs: planMs - startMs,
  executionMs: execMs - planMs,
  fastpath: tookFastpath,
  agentName: agent.name,
  executionType: step.executionType,
  success,
});
```

**Routing decision logs:**

```typescript
// Fastpath taken:
logger.info("do-task fastpath: single-agent dispatch", {
  agentName: agent.name,
  executionType: agent.bundledId ? "bundled" : "llm",
  bundledId: agent.bundledId,
  mcpServers: agent.mcpServers?.map((s) => s.serverId),
});

// Fastpath skipped:
logger.info("do-task fastpath: ineligible, using full pipeline", {
  agentCount: plan.agents.length,
  hasClarifications: classifyResult.clarifications.length > 0,
});
```

**Task artifact timing:**

```typescript
storeTaskArtifact({
  intent, plan, results, success,
  timing: {
    planningMs: planMs - startMs,
    executionMs: execMs - planMs,
    totalMs: execMs - startMs,
    fastpath: tookFastpath,
  },
});
```

No API surface change (`DoTaskResult` unchanged).

### Full Flow

```
do-task execute(intent)
  |
  +- startMs = Date.now()
  +- emitProgress("planning")
  |
  +- try {
  |   +- generatePlan(intent, { mode: "task", abortSignal }) <- 1 Sonnet call
  |   +- classifyAgents(plan.agents)                          <- deterministic
  |   +- planMs = Date.now()
  |   |
  |   +- GATE: isFastpathEligible(plan, classifyResult)
  |   |   |
  |   |   YES (fastpath):
  |   |   +- logger.info("do-task fastpath: single-agent dispatch", ...)
  |   |   +- resolveCredentials(configRequirements)       <- deterministic
  |   |   +- checkEnvironmentReadiness(configRequirements) <- deterministic
  |   |   +- bail if unresolved credentials
  |   |   +- build trivial 3-state FSM (prompt = intent)
  |   |   |   +- state name: stateName(dagStep.id) <- shared utility
  |   |   |   +- bundled: { type: "agent", agentId, outputTo: "result" }
  |   |   |   +- llm:     { type: "llm", model, tools, outputTo: "result" }
  |   |   +- build single EnhancedTaskStep (executionType: "agent"|"llm")
  |   |   +- build single DAGStep for progress mapping
  |   |   +- build single DocumentContract for result collection
  |   |   +- buildMCPServerConfigs([agent], bindings)
  |   |   +- create MCP pool + provider
  |   |   +- emitProgress("preparing", stepCount: 1)
  |   |   +- executeTaskViaFSMDirect(fsm, [step], {
  |   |   |     ...ctx, dagSteps: [dagStep],
  |   |   |     documentContracts: [contract]
  |   |   |   })                                           <- same executor
  |   |   +- extract artifacts, sanitize output
  |   |   +- execMs = Date.now()
  |   |   +- log completion with timing, store artifact
  |   |   +- return DoTaskResult
  |   |
  |   |   NO (full pipeline):
  |   |   +- logger.info("do-task fastpath: ineligible", ...)
  |   |   +- buildBlueprint(intent, { precomputed: { plan, classified } })
  |   |   |   +- skips plan+classify, continues: DAG -> schemas -> mappings
  |   |   +- friendly descriptions, FSM compilation
  |   |   +- executeTaskViaFSMDirect(fsm, steps, ctx)     <- same executor
  |   |   +- execMs = Date.now()
  |   |   +- log completion with timing, store artifact
  |   |   +- return DoTaskResult
  |   |
  |   } catch (err) {
  |     +- AbortError -> rethrow
  |     +- PipelineError -> extract phase, return error DoTaskResult
  |     +- raw Error -> return error DoTaskResult with message
  |   }
```

### Modules Modified

- `packages/system/agents/conversation/tools/do-task/index.ts` -- fastpath gate,
  trivial FSM construction, minimal step/config building, credential resolution,
  branching logic, observability logging, broadened error handling
- `packages/workspace-builder/planner/build-blueprint.ts` -- accept optional
  `precomputed` plan+classify results
- `packages/workspace-builder/mod.ts` -- export `generatePlan`, `classifyAgents`,
  `resolveCredentials`, `checkEnvironmentReadiness`, `stateName`, `normalize`,
  `DEFAULT_LLM_PROVIDER`, `DEFAULT_LLM_MODEL`, and their associated types
  (`Phase1Result`, `ClassifyResult`, `ConfigRequirement`)
- `packages/workspace-builder/compiler/build-fsm.ts` -- add `export` to
  `DEFAULT_LLM_PROVIDER`, `DEFAULT_LLM_MODEL`, `stateName()`, `normalize()`
- `tools/evals/agents/do-task/do-task-fastpath.eval.ts` (new) -- CLI-based eval
  cases for fastpath routing correctness and timing measurement

### What Doesn't Change

- `generatePlan()` -- same function, same prompt, same model
- `classifyAgents()` -- same deterministic classification logic
- `resolveCredentials()` / `checkEnvironmentReadiness()` -- same credential flow
- `executeTaskViaFSMDirect()` -- same executor, no modifications
- `extractArtifactsFromOutput()` / `sanitizeAgentOutput()` -- same post-processing
- `buildBlueprint()` return type -- `BlueprintResult` shape unchanged
- `workspace-planner` agent -- completely untouched

## Testing Decisions

Tests verify external behavior: does the fastpath produce equivalent results to
the full pipeline for single-agent tasks, and does it correctly fall through for
multi-agent tasks?

- **Gate logic unit tests:** Test `isFastpathEligible()` with: single bundled
  agent (true), single LLM agent with MCP servers (true), multi-agent plans
  (false), plans with clarifications (false), no classification match (false),
  single agent with neither bundledId nor mcpServers (false). Pure function on
  data.
- **Trivial FSM construction tests:** Verify correct structure for bundled vs
  LLM agent types. Verify `outputTo: "result"` on both. Verify execution state
  name matches `stateName(dagStep.id)`.
- **Minimal step construction tests:** Verify `EnhancedTaskStep` has correct
  `executionType` (`"agent"` for bundled, `"llm"` for MCP-backed), correct
  `agentId`, and `friendlyDescription` from agent description.
- **DAGStep construction tests:** Verify correct `id`, `agentId`, empty
  `depends_on`.
- **DocumentContract construction tests:** Verify `producerStepId` maps to
  `fastpathDAGStep.id` and `documentId` to `"result"`.
- **Result collection integration test:** Verify executor finds result via
  primary `stepDocumentId` lookup path (not fallback scan).
- **`buildBlueprint` precomputed tests:** Verify `precomputed` results skip
  plan+classify and produce identical output.
- **Error handling tests:** Raw errors from `generatePlan` return error
  DoTaskResult; PipelineError preserves phase info; AbortError rethrown.
- **Wiring composition assertions:** The fastpath-eligible wiring test asserts
  the FSM shape (`id` matches `/^task-fastpath-/`, 3 states), `documentContracts`
  (length 1, `documentId: "result"`), and `dagSteps` (length 1) passed to the
  executor -- verifying the five independent builders compose correctly.
- **Abort signal test:** Pre-aborted `AbortSignal` returns
  `{ success: false, error: "Task cancelled" }` without calling `generatePlan`
  or the executor. The `finally` block (dispose) is covered by the existing
  "dispose on throw" test.
- **Integration test:** End-to-end `do_task` with mocked `generatePlan`
  returning a single-agent plan. Follow prior art in
  `extract-artifacts.test.ts`.

## Eval: Fastpath Routing and Timing

CLI-based eval suite validates routing correctness and measures timing. Uses
the existing eval framework (`tools/evals/`) with the daemon running.

**File:** `tools/evals/agents/do-task/do-task-fastpath.eval.ts`

**Cases:**
- Single-agent (expect fastpath): calendar check, web search, Linear lookup
- Multi-agent (expect full pipeline): research-then-email, calendar-to-Linear

**Scores:**

| Score | What it tells you |
|-------|-------------------|
| `routing/correct` | Did the gate route to the right path? Binary. |
| `timing/total-ms` | Wall-clock do_task duration. |
| `timing/planning-ms` | Time in generatePlan + classifyAgents. Should be similar across paths. |
| `timing/execution-ms` | Time from gate to result. Fastpath should be lower. |

**Baseline regression:**

```bash
deno task evals run --filter do-task/fastpath
deno task evals baseline save
# Later:
deno task evals run --filter do-task/fastpath
deno task evals diff --baseline
```

## Out of Scope

- **Conversation agent routing changes** -- The conversation agent's decision to
  call `do_task` vs answer directly is unchanged.
- **Session History v2 integration** -- The fastpath preserves the same `onEvent`
  hooks, so when session history is wired in, both paths benefit equally.
- **Bypassing `generatePlan()`** -- The plan step (1 Sonnet call) is the minimum
  cost for consistent agent selection. Future optimization if warranted.
- **Output schema generation for fastpath** -- Single-agent results are relayed
  as raw text. Structured output schemas only matter for multi-step data wiring.
- **Multi-agent fastpath** -- Only single-agent plans qualify.
- **Workspace simulator integration** -- The simulator runs in `mode: "workspace"`
  and would need substantial adaptation for `mode: "task"`. Unit tests cover the
  implementation risk.

## Further Notes

- `classifyAgents()` mutates the input `Agent[]` in place (writes `bundledId`
  and `mcpServers` directly on objects). The same mutated agents are passed to
  `buildBlueprint` via `precomputed` on the fallback path.
- The `precomputed` extension to `BuildBlueprintOpts` is a general-purpose
  optimization -- any caller that has already run plan+classify can skip
  re-running them.
- The fastpath FSM omits `functions` (no cleanup/guard code actions) and
  `documentTypes` (no output schemas). The FSM engine handles missing optional
  fields gracefully -- `documentTypes: undefined` bypasses schema validation
  entirely.
- `buildMCPServerConfigs` expects post-classification `Agent[]` with
  `mcpServers` set. Compatible as-is. Only LLM agents have `mcpServers`;
  bundled agents use `bundledId` and get MCP configs from the bundled agent
  registry at runtime.

## Design Evolution

This design went through 6 iterations with 5 review rounds. Key decisions
made across iterations:

1. **v1 -> v2:** Clarified prompt source (use original user intent, not agent
   description or workspace purpose). Added explicit `EnhancedTaskStep` and
   `buildMCPServerConfigs` construction. Added structured observability logging
   for routing decisions.

2. **v2 -> v3:** Fixed `EnhancedTaskStep` type to match actual shape
   (`executionType: "agent"|"llm"`, not `"bundled"`; dropped phantom fields).
   Added `outputTo: "result"` on FSM actions -- without it, result collection
   silently fails. Extracted `DEFAULT_LLM_PROVIDER`/`DEFAULT_LLM_MODEL` to
   shared constants.

3. **v3 -> v4:** Discovered `documentContracts: []` silently drops results even
   with `outputTo` set -- added minimal `DocumentContract` for the primary
   lookup path. Fixed FSM state naming to match compiler convention
   (`step_${normalize(id)}`), which is required for LLM progress events.
   Expanded barrel exports for credential functions.

4. **v4 -> v5:** Broadened error handling catch to handle raw errors from direct
   `generatePlan`/`classifyAgents` calls (not wrapped in `PipelineError`).
   Added `abortSignal` passthrough. Extracted `stateName()`/`normalize()`
   alongside model constants to eliminate convention duplication.

5. **v5 -> v6:** Cut speculative workspace simulator section (~25% of plan).
   Eliminated new `constants.ts` file -- just export from `build-fsm.ts`.
   Added verifiable success criteria section. Added timing instrumentation for
   both paths. Added eval suite for routing correctness and timing measurement.
