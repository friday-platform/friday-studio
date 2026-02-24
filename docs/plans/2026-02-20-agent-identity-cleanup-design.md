# Agent Identity Cleanup

Shipped 2026-02-20 on `eric/fix-planning-context`. Follow-up to PR #2109.

The workspace-builder pipeline had a discontinuity where `stampExecutionTypes()`
replaced `step.agentId` (planner ID) with the bundled registry key. Every
downstream consumer keyed lookups on `agentId` against agents indexed by planner
ID — causing silent lookup failures for bundled agents in schemas, mappings, and
context enrichment.

## What Changed

### Schema (`packages/schemas/src/workspace.ts`)

Added required `executionRef: string` field to `ClassifiedDAGStepSchema`. Always
populated by stamp — bundled agents get the registry key, LLM agents get their
own planner ID.

### Stamp (`packages/workspace-builder/planner/stamp-execution-types.ts`)

Stopped mutating `step.agentId`. Bundled agents now get
`{ ...step, executionRef: agent.bundledId, executionType: "bundled" }` — planner
ID preserved. LLM agents get `executionRef: step.agentId`.

### FSM Compiler (`packages/workspace-builder/compiler/build-fsm.ts`)

`agentAction()` uses `step.executionRef` for the execution target. Warning
diagnostics still use `step.agentId` (planner ID reads better in logs).

### Schemas (`packages/workspace-builder/planner/schemas.ts`)

Removed the PR #2109 dual-index workaround (secondary map from `bundledId` →
agent). Function signature changed from `DAGStep[]` to `ClassifiedDAGStep[]`.
Registry lookup via `step.executionRef`, agent lookup via direct
`agentMap.get(step.agentId)`.

### Mappings (`packages/workspace-builder/planner/mappings.ts`)

`resolveConsumerInputSchema()` uses `step.executionRef` for
`bundledAgentsRegistry` lookup. `buildMappingPrompt()` agent lookup was fixed
structurally — no code change needed since `step.agentId` is now the planner ID.

### Files Fixed Structurally (No Code Changes)

- **`enrich-pipeline-context.ts`** — `requirementsByAgent` groups by
  `step.agentId`, looked up by `agent.id`. Both are planner IDs now. Match.
- **`tools.ts`** — `findAgentIdForStep()` returns `step.agentId` for error
  messages. Planner ID is correct.

### Fixtures

All 11 fixture files updated with `executionRef` on every step.
`csv-analysis-plan.json` and `fan-in-plan.json` use divergent planner IDs
(e.g., `agentId: "csv-data-analyst"` with `executionRef: "data-analyst"`) to
exercise the identity split in tests.

## Key Decisions

**`executionRef` is required, not optional.** Stamp always populates it. This
eliminates scattered `?? step.agentId` fallback patterns — consumers use the
field that matches their intent without conditionals.

**Two-field identity model.** `agentId` = planner-assigned ID for definition
lookups. `executionRef` = execution target for runtime and registry access.
Consumers pick the one they need.

**`generateOutputSchemas` signature changed to `ClassifiedDAGStep[]`.** Required
because the code accesses `step.executionRef`, which only exists on
`ClassifiedDAGStep`. Call site (`build-blueprint.ts`) already passes
`ClassifiedJobWithDAG` steps — no caller change needed.

**Divergent fixture IDs required for meaningful testing.** Most fixtures had
`agent.id` equal to the bundled key — the identity split was a no-op. Two
fixtures were updated with realistic LLM-style planner IDs so tests actually
catch regressions.

## Out of Scope

- **`@std/text/to-kebab-case` in `fsm-workspace-creator.agent.ts`** has the
  same special-char bug as the original `toKebabCase`. Handles workspace
  directory names, not agent IDs — lower priority.
- **`@atlas/fsm-engine`** `AgentAction.agentId` unchanged. Receives the same
  bundled ID value, sourced from `executionRef` during compilation.
- **`classify-agents.ts`**, **`build-workspace.ts`**, **`plan.ts`** — untouched.

## Test Coverage

- **`stamp-execution-types.test.ts`** (new) — 4 cases: bundled agent (agentId
  preserved, executionRef = bundledId), LLM agent with MCP tools, unmatched
  agent fallthrough, multi-job independence.
- **`schemas.test.ts`** — Replaced dual-index test with direct lookup
  verification. All step test data uses `ClassifiedDAGStep` shape.
- **`mappings.test.ts`** — Registry lookup via `executionRef` with divergent
  planner ID. Bug #3 verification (consumer agent description in mapping
  prompt).
- **`enrich-pipeline-context.test.ts`** — Bug #2 verification (bundled agent
  with divergent planner ID receives downstream context enrichment).
- **`build-blueprint.test.ts`** — Updated mock data and assertions for
  preserved planner IDs.
- **`build-fsm.test.ts`** — All step test data includes `executionRef`.
  Compiler tests verify correct execution target in FSM actions.
