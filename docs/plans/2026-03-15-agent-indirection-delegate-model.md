# Agent Indirection: Delegate Model

Shipped on `feature/agent-indirection-delegate-model`. Workspace agents are now
named references that the runtime resolves — FSM definitions speak
workspace-agent language ("who does this"), and the runtime maps that to
concrete executors.

## Context

FSM entry actions previously referenced runtime agent types directly
(`agentId: claude-code`) instead of workspace agent keys (`agentId: repo-cloner`).
This caused three problems: pipeline diagrams showed generic runtime types
instead of named agents, workspace agent configs (prompts, env, descriptions)
were orphaned and never read at runtime, and the workspace builder generated
parallel config layers that didn't talk to each other.

## What Changed

### New resolution functions (`packages/config/`)

Two pure functions alongside the existing derivation family (`deriveTopology`,
`deriveAgentJobUsage`, etc.):

**`expand-agent-actions.ts`** — Load-time transformation.
`expandAgentActions(fsmDefinition, workspaceAgents)` walks all `type: agent`
entry actions and looks up the workspace agent by `agentId`. LLM agents are
converted to `type: llm` actions with provider/model/tools from config and
combined prompt (config prompt + `\n\n` + action prompt). Atlas/system/unknown
agents pass through unchanged. Returns a new FSM definition (no mutation).

**`resolve-runtime-agent.ts`** — Execution-time mapping.
`resolveRuntimeAgentId(agentConfig, agentId)` extracts the runtime ID from
atlas/system agents (`agentConfig.agent` field), passes through LLM and unknown
agents unchanged. Called when the orchestrator needs a concrete runtime ID.

Both are exported from `packages/config/mod.ts`.

### Workspace builder (`packages/workspace-builder/`)

**`planner/stamp-execution-types.ts`** — Bundled agents now set
`executionRef = step.agentId` (workspace agent key) instead of
`executionRef = agent.bundledId` (runtime type). Runtime resolution handles the
mapping later.

**`compiler/build-fsm.ts`** — Unified: all agent types produce
`agentAction(step.agentId, ...)`. The compiler no longer emits `llmAction()` —
LLM expansion happens at load time via `expandAgentActions`.

### Runtime wiring

**`packages/workspace/src/runtime.ts`** — `expandAgentActions` called during FSM
load (before engine creation) for both inline and file-based FSM definitions.
`resolveRuntimeAgentId` called in the agent executor before orchestrator
dispatch.

**`packages/system/agents/conversation/tools/do-task/ephemeral-executor.ts`** —
Same pattern: `expandAgentActions` before engine init (only when
`context.workspaceAgents` is provided), `resolveRuntimeAgentId` in agent
executor. Keeps both execution paths consistent.

### Workspace format (after)

```yaml
# Bundled agent — named reference to a runtime
agents:
  repo-cloner:
    type: atlas
    agent: claude-code
    description: Clones repos and gathers PR metadata
    prompt: "Delegated to bundled agent" # required by schema; follow-up to make optional

# LLM agent — config defines the model, prompt defines the role
agents:
  summarizer:
    type: llm
    description: Summarizes documents into concise briefs
    config:
      prompt: "You are a document summarizer..." # role/system prompt
      provider: anthropic
      model: claude-sonnet-4-6
      tools: [notion-mcp]

# FSM actions — uniform regardless of agent type
jobs:
  pr-code-review:
    fsm:
      states:
        step_clone_repo:
          entry:
            - type: agent
              agentId: repo-cloner # workspace agent key, not runtime type
              prompt: "Clone the repo..." # task-specific
              outputTo: clone-output
```

## Key Decisions

**Two-phase resolution (load-time expansion + runtime resolution) instead of
unifying action types.** The FSM engine has fundamentally different execution
paths for `type: agent` (delegates to agentExecutor callback) and `type: llm`
(handles tool assembly, validation, retry internally). Unifying them would
require moving LLM execution logic into the workspace runtime — large blast
radius, no user benefit. Expanding at load time keeps the FSM engine unchanged.

**Delegate model, not extend or override.** Bundled agents are self-contained —
they carry env requirements in agent metadata and resolve credentials from Link
automatically. Making workspace agents override bundled agent config adds
complexity without value. Delegate (named reference + task prompt) is the
minimum viable indirection. The `resolveRuntimeAgentId` fallback path makes it
safe to add extend semantics later.

**Resolution functions live in `packages/config/`.** Both consumers — workspace
runtime and ephemeral executor — already depend on `@atlas/config`. Placing them
alongside `deriveTopology` and `deriveAgentJobUsage` keeps the dependency graph
clean.

**Compiler no longer emits `llmAction()`.** All agents produce
`agentAction(step.agentId)`. The expansion layer converts LLM agents at load
time. This gives workspace authors a uniform FSM format regardless of agent
implementation.

## Error Handling

`expandAgentActions` is a pure passthrough for unrecognized agent IDs — no
errors, just returns the action unchanged. This is the backward-compat path.

`resolveRuntimeAgentId` returns `agentId` unchanged when config is undefined
(legacy workspaces) or when the agent type is LLM (expansion should have already
handled it). No exceptions thrown.

## Out of Scope

- **`AtlasAgentConfigSchema.prompt` → optional**: Bundled agents use a
  placeholder prompt. Making it optional requires auditing downstream code that
  assumes `atlasAgent.prompt` is always a string.
- **Env var cleanup**: Bundled workspace agents still declare env blocks for UI
  display. Deriving integrations panel data from bundled agent metadata is a
  follow-up.
- **Prompt combining for bundled agents**: `buildFinalAgentPrompt` uses OR logic
  (action > config). Changing to AND (combine both) is deferred.
- **Color threading**: Visual linkage between agent cards and pipeline steps via
  accent colors. Separate design work.
- **Agent-job cross-reference**: `deriveAgentJobUsage` automatically fixes
  itself when FSM references workspace agent keys — no code changes needed.

## Test Coverage

**Unit tests** for both pure functions in `packages/config/src/`:
- `expand-agent-actions.test.ts` — LLM expansion with prompt combining, prompt
  fallback, atlas/system/unknown passthrough, mixed entry arrays, property
  preservation (`outputTo`, `outputType`), immutability
- `resolve-runtime-agent.test.ts` — Atlas/system extraction, LLM passthrough,
  undefined config backward compat

**Integration tests** (`delegate-model-integration.test.ts`) against real
workspace config shapes:
- Legacy backward compat: `agentId: claude-code` passthrough, inline
  `type: llm` passthrough
- Delegate model: Atlas agents resolved to runtime IDs, LLM agents expanded
  with combined prompts

**Updated builder tests**: `stamp-execution-types.test.ts` asserts
`executionRef = step.agentId`, `build-fsm.test.ts` asserts all agents produce
`agentAction()`.
