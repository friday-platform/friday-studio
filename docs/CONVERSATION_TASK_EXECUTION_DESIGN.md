# Conversation-Driven Task Execution Design

> **Status**: Draft (v4) **Created**: 2025-12-13 **Updated**: 2025-12-14
> **Branch**: `fsm-integration-final`
>
> **⚠️ MVP IMPLEMENTED (2025-12-15)**: See `CONVERSATION_TASK_EXECUTION_MVP.md` for simplified
> implementation actually built. Testing hypothesis with minimal features before proceeding
> with full design.

## Changelog

**2025-12-14 (v4)**: Implementation review - fixed discontinuities and added
missing details.

- **Fixed planTask return type**: do_task handler now handles PlanResult
  discriminated union properly.
- **Fixed loadActiveTask**: Now filters by `type: "active-task"` to avoid
  collision with agent-produced artifacts.
- **Added clearActiveTask**: Was referenced but undefined.
- **Added helper definitions**: `extractStepIndex`, `extractArtifactRefs`,
  `toJobPlan`, `summarizePlan`, `summarizeTask`.
- **Fixed orchestrator lifecycle**: Create per-task, shutdown after (not
  shared).
- **Added client import**: Shows `@atlas/client/v2` pattern.
- **Enhanced StepResult.artifactRefs**: Now includes full ref (id, type,
  summary).
- **Added document contract**: Defines step_{N}_result convention.
- **Planning-time MCP validation**: Uses workspace-planner clarification
  pattern.

**2025-12-14 (v3)**: YAGNI pass - cut complexity, added clarifications.

- **Cut FSM stability**: Removed `previousFsmCode` mechanism. Cache keys handle
  unchanged step detection; FSM code variance doesn't affect behavior.
- **Simplified ExecutionResult**: Collapsed `cancelled`/`timedOut` booleans into
  discriminated `error.type` field.
- **Removed intent cap**: Keep all intents (they're small strings).
- **Added clarifications**: Planner failure mode, FSM compilation (Deno worker),
  streaming contract (AtlasUIMessageChunk), MCP requirements (workspace-planner
  pattern).

**2025-12-14 (v2)**: Artifact versioning (uses existing ArtifactStorage infra).

**2025-12-14 (v1)**: Multi-model review feedback (Opus, Gemini, Codex).

- Sequential-only MVP, improved cache key (agentId + description hash), boolean
  retry, explicit task clearing, timeout support, allowlist tool filtering,
  InMemoryDocumentStore reuse, getAgentCatalog(), status field, MCP cleanup.

## Problem Statement

The conversation agent
(`packages/system/agents/conversation/conversation.agent.ts`) currently has two
ways to execute user tasks:

1. **Direct agent invocation** - Connects to agent server via MCP, discovers
   ~40+ agents as tools, invokes them directly
2. **Workspace automation** - Plans workspaces, generates FSMs, registers with
   daemon, triggers via signals

This creates ambiguity. The agent often chooses direct invocation because it's
faster, but this:

- Overwhelms the LLM with 40+ tool definitions (token cost)
- Produces inconsistent execution patterns
- Doesn't scale as agent count grows
- Misses the predictability benefits of FSM-based execution

## Proposed Solution

Remove direct agent invocation. Give the conversation agent ONE way to execute
tasks: **FSM-based execution via a `do_task` tool**.

For "what's on my calendar today":

- **Before**: Conversation agent calls `google-calendar` agent directly
- **After**: Conversation agent calls `do_task`, which plans an FSM, executes
  it, returns results

Trade-off: 2 extra LLM calls (planning + FSM generation) for predictability and
scalability.

## Core Mental Model

### The Active Task

Each conversation has at most one "active task" - the current automation being
built/executed:

```typescript
interface ActiveTask {
  id: string;
  intents: string[]; // ["check calendar", "email me results"]
  plan: TaskExecutionPlan; // Simplified WorkspacePlan (single job)
  fsmCode: string; // Generated TypeScript FSM
  status: "idle" | "running" | "failed" | "completed";
  lastExecution?: ExecutionResult;
}

/**
 * Simplified WorkspacePlan for task execution.
 * Matches the shape expected by generateFSMCode() from fsm-generation-core.ts
 * Single implicit job, no signals (immediate execution).
 */
interface TaskExecutionPlan {
  /** Agents involved in this task - matches WorkspacePlan.agents shape */
  agents: Array<{
    id: string;
    name: string;
    description: string;
    needs: string[]; // MCP requirements
    configuration?: Record<string, unknown>;
  }>;
  /** Single job steps - matches WorkspacePlan.jobs[0].steps shape */
  steps: Array<{
    agentId: string;
    description: string;
  }>;
  /** Execution pattern - sequential only for MVP (caching/retry logic depends on it) */
  behavior: "sequential";
}

/** Artifact reference with summary for display */
interface ArtifactRef {
  id: string;
  type: string;
  summary: string;
}

interface ExecutionResult {
  timestamp: string;
  success: boolean;
  stepResults: StepResult[];
  /** All artifacts produced during execution */
  artifactRefs: ArtifactRef[];
  /** Index of last successfully completed step (-1 if none) */
  lastSuccessfulStepIndex: number;
  /** Present on failure - discriminated by type */
  error?: {
    type: "timeout" | "cancelled" | "agent_error" | "planning_failed";
    message: string;
  };
}

interface StepResult {
  stepIndex: number;
  agentId: string;
  /** Stable cache key: agentId + normalized description hash */
  cacheKey: string;
  /** Agent output (JSON-serializable) */
  output: unknown;
  /** Artifacts created by this step */
  artifactRefs?: ArtifactRef[];
  /** Previous execution timestamp if result was reused from cache */
  cachedFrom?: string;
}
```

**Why align with WorkspacePlan?** The existing `generateFSMCode()` in
`fsm-generation-core.ts` already accepts `WorkspacePlan.jobs[0]` + agents. By
matching that shape, we reuse the battle-tested FSM generation without a new
abstraction layer.

Stored as artifact (type: `active-task`) linked to conversation via `chatId`.

### User Interaction Patterns

| User says                           | What happens                                               |
| ----------------------------------- | ---------------------------------------------------------- |
| "check my calendar"                 | Create task, plan FSM, execute immediately, return results |
| "also email me the results"         | Append intent, replan FSM (chains calendar→email), execute |
| "actually just slack instead"       | Replace email with slack in plan, execute                  |
| "set this up as a daily automation" | Convert task → persistent workspace (future)               |
| "start over"                        | Clear active task                                          |

Key insight: **Intents array is source of truth**. FSM is regenerated from
accumulated intents on each modification.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                   Conversation Agent                         │
│  Tools:                                                      │
│   - atlas_workspace_* (CRUD)     - atlas_library_* (CRUD)    │
│   - atlas_session_* (describe)   - atlas_artifact_* (CRUD)   │
│   - atlas_signal_trigger         - system_version            │
│   - do_task (NEW)                                            │
└──────────────────────────────────────────────────────────────┘
                              │ do_task(intent)
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                    Task Orchestrator                         │
│  ┌────────────┐  ┌─────────────┐  ┌───────────────────────┐  │
│  │Task Store  │  │Task Planner │  │FSM Generator          │  │
│  │(artifact)  │  │(LLM)        │  │(LLM)                  │  │
│  └────────────┘  └─────────────┘  └───────────────────────┘  │
│                          ▼                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                   Task Executor                        │  │
│  │  FSMEngine + MemoryDocStore + AgentExecutor callback   │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                              │ executeAgent()
                              ▼
            ┌─────────────────────────────────────┐
            │ Existing Agent Execution Layer       │
            │ (AgentExecutionManager, MCP, stream) │
            └─────────────────────────────────────┘
```

## Execution Flow

### New Task

```
User: "what's on my calendar"
          │
   ┌──────┴──────┐
   │ Load task   │ → null (new)
   └──────┬──────┘
          │
   ┌──────┴──────┐
   │ Plan        │ → { agents: [google-calendar], steps: [...] }
   │ (1 LLM)     │
   └──────┬──────┘
          │
   ┌──────┴──────┐
   │ Gen FSM     │ → TypeScript using FSMBuilder
   │ (1 LLM)     │   idle → fetch → completed
   └──────┬──────┘
          │
   ┌──────┴──────┐
   │ Execute     │ → FSMEngine runs
   │             │   → agentAction('google-calendar')
   │             │   → streams progress to conversation
   └──────┬──────┘
          │
   ┌──────┴──────┐
   │ Store task  │ → artifact with intents + plan + result
   └─────────────┘
```

### Task Modification

```
User: "also email me the results"
          │
   ┌──────┴──────┐
   │ Load task   │ → existing (has calendar intent + results)
   └──────┬──────┘
          │
   ┌──────┴──────────────────┐
   │ Plan (with context)     │
   │ - previous intents      │
   │ - last execution result │
   │ → { agents: [cal, email], steps: [fetch, send] }
   └──────┬──────────────────┘
          │
   ┌──────┴──────┐
   │ Gen FSM     │ → idle → fetch_cal → send_email → completed
   └──────┬──────┘
          │
   ┌──────┴──────┐
   │ Store task  │ → new artifact revision
   └──────┬──────┘
          │
          ▼
       Execute (cached calendar result, only email step runs)
```

## Technical Components

### 1. `do_task` Tool

```typescript
// packages/mcp-server/src/tools/task/do-task.ts

import { client, parseResult } from "@atlas/client/v2";
import {
  findUnmatchedNeeds,
  mapNeedToMCPServers,
  matchBundledAgents,
} from "@atlas/core/mcp-registry/deterministic-matching";
import {
  createNoMatchClarification,
  formatClarificationReport,
} from "@atlas/core/mcp-registry/clarification";

/** Pattern to detect clear/reset intents */
const CLEAR_INTENT_PATTERN = /^(clear|reset|start over|forget|cancel task)/i;

registerTool("do_task", {
  description: "Execute a task, modify current task, or clear task state. " +
    "Use for anything requiring agents: data fetching, " +
    "multi-step workflows, external integrations. " +
    "Use 'clear'/'start over' intent to reset.",
  inputSchema: {
    intent: z.string().describe("What user wants to accomplish"),
    retry: z
      .boolean()
      .optional()
      .describe("Retry the last failed task from the failure point"),
  },
  handler: async ({ intent, retry }, ctx) => {
    // 1. Load existing task for this conversation
    const task = await loadActiveTask(ctx.streamId);

    // Handle clear intent explicitly (don't try to plan "start over")
    if (CLEAR_INTENT_PATTERN.test(intent)) {
      await clearActiveTask(ctx.streamId);
      return {
        cleared: true,
        message: "Task cleared. What would you like to do?",
      };
    }

    // Handle retry: reuse existing plan, resume from failure point
    if (retry && task?.lastExecution && !task.lastExecution.success) {
      const retryFromStep = task.lastExecution.lastSuccessfulStepIndex + 1;
      const result = await executeTaskFSM(task.fsmCode, {
        ...ctx,
        resumeFromStep: retryFromStep,
        cachedResults: task.lastExecution.stepResults.slice(0, retryFromStep),
      });
      await storeActiveTask(ctx.streamId, {
        ...task,
        status: result.success ? "completed" : "failed",
        lastExecution: result,
      });
      return {
        taskId: task.id,
        planSummary: `Retried from step ${retryFromStep}`,
        execution: result,
      };
    }

    const intents = [...(task?.intents ?? []), intent];

    // 2. Plan (LLM selects agents, orders steps)
    // Returns discriminated union: { success: true, plan } | { success: false, reason }
    const planResult = await planTask({
      intents,
      agentCatalog: await getAgentCatalog(),
      previousPlan: task?.plan,
      lastResult: task?.lastExecution,
    });

    // Handle planning failure (LLM couldn't find suitable agents)
    if (!planResult.success) {
      return {
        success: false,
        error: { type: "planning_failed", message: planResult.reason },
      };
    }

    const plan = planResult.plan;

    // 3. Validate MCP requirements at planning time (workspace-planner pattern)
    const clarifications = validateAgentRequirements(plan.agents);
    if (clarifications.length > 0) {
      return {
        success: false,
        error: {
          type: "planning_failed",
          message: formatClarificationReport(clarifications),
        },
      };
    }

    // 4. Check for cacheable steps from previous execution
    const cachedResults = task?.lastExecution
      ? matchCacheableSteps(plan.steps, task.lastExecution.stepResults)
      : [];

    // 5. Generate FSM code (reuses fsm-generation-core.ts)
    // Converts TaskExecutionPlan to WorkspacePlan.jobs[0] shape
    const fsmCode = await generateFSMCode(
      toJobPlan(plan),
      await classifyAgents(plan.agents),
      {
        id: "task-trigger",
        name: "Task Trigger",
        description: "Immediate execution",
      },
      ctx.abortSignal,
    );

    // 6. Update status before execution
    const taskId = task?.id ?? generateId();
    await storeActiveTask(ctx.streamId, {
      id: taskId,
      intents,
      plan,
      fsmCode,
      status: "running",
    });

    // 7. Execute immediately via AgentOrchestrator
    const result = await executeTaskFSM(fsmCode, {
      sessionId: ctx.sessionId,
      streamId: ctx.streamId,
      userId: ctx.userId,
      workspaceId: "task:" + ctx.streamId, // Synthetic workspace for MCP routing
      onStreamEvent: ctx.stream?.emit,
      abortSignal: ctx.abortSignal,
      cachedResults, // Inject cached step results
    });

    // 8. Store final result
    await storeActiveTask(ctx.streamId, {
      id: taskId,
      intents,
      plan,
      fsmCode,
      status: result.success ? "completed" : "failed",
      lastExecution: result,
    });

    return {
      taskId,
      planSummary: summarizePlan(plan),
      execution: result,
    };
  },
});

/**
 * Validate agent MCP requirements at planning time.
 * Same pattern as workspace-planner.agent.ts lines 298-358.
 */
function validateAgentRequirements(
  agents: TaskExecutionPlan["agents"],
): ClarificationItem[] {
  const clarifications: ClarificationItem[] = [];

  for (const agent of agents) {
    const bundledMatches = matchBundledAgents(agent.needs);

    if (bundledMatches.length === 1) {
      continue; // Single bundled match - good
    }

    // Try MCP servers for unmatched needs
    const mcpMatchesByNeed = new Map<string, MCPServerMatch[]>();
    for (const need of agent.needs) {
      mcpMatchesByNeed.set(need, mapNeedToMCPServers(need));
    }

    const unmatchedNeeds = findUnmatchedNeeds(
      agent.needs,
      bundledMatches,
      mcpMatchesByNeed,
    );

    for (const need of unmatchedNeeds) {
      clarifications.push(createNoMatchClarification(agent.name, need));
    }
  }

  return clarifications;
}
```

### 2. Task Executor (FSM via AgentOrchestrator)

```typescript
// packages/core/src/task-execution/executor.ts

import { AgentOrchestrator } from "../orchestrator/agent-orchestrator.ts";
import {
  type Context,
  createEngine,
  type FSMDefinition,
} from "@atlas/fsm-engine";
import { InMemoryDocumentStore } from "@atlas/document-store";
import { logger } from "@atlas/logger";

/** Default task timeout: 5 minutes */
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;

interface TaskContext {
  sessionId: string;
  streamId: string;
  userId?: string;
  workspaceId: string;
  onStreamEvent?: (event: AtlasUIMessageChunk) => void;
  abortSignal?: AbortSignal;
  /** Cached results from previous execution to skip unchanged steps */
  cachedResults?: StepResult[];
  /** Resume execution from this step index */
  resumeFromStep?: number;
  /** Maximum execution time in ms. Default: 5 minutes. */
  timeoutMs?: number;
  /** MCP server pool for agent connections */
  mcpServerPool?: GlobalMCPServerPool;
  /** Daemon URL for agent server */
  daemonUrl?: string;
}

/**
 * Document contract: FSM steps write results to `step_{N}_result` documents.
 * This convention allows caching and inter-step data flow.
 *
 * Document IDs:
 * - `step_0_result`: Output from step 0
 * - `step_1_result`: Output from step 1 (can read step_0_result)
 * - etc.
 *
 * The FSM codegen prompt (agent-helpers.ts) generates code that follows
 * this convention via the outputTo parameter in agentAction().
 */

async function executeTaskFSM(
  fsmCode: string,
  ctx: TaskContext,
): Promise<ExecutionResult> {
  // Compile FSM from generated TypeScript
  const fsmDef = await compileFSMCode(fsmCode);

  // Set up timeout + user abort signal composition
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
  const combinedSignal = ctx.abortSignal
    ? AbortSignal.any([ctx.abortSignal, timeoutController.signal])
    : timeoutController.signal;

  // Memory-based document store (ephemeral, lives for task duration)
  // Scope: synthetic workspace ID ensures isolation
  const docStore = new InMemoryDocumentStore();
  const scope = { workspaceId: ctx.workspaceId };

  // Pre-populate cached results as documents (step_{N}_result convention)
  if (ctx.cachedResults) {
    for (const cached of ctx.cachedResults) {
      await docStore.write(
        scope,
        fsmDef.id,
        `step_${cached.stepIndex}_result`,
        {
          type: "cached-result",
          data: { output: cached.output, cachedFrom: cached.cachedFrom },
        },
      );
    }
  }

  // Create NEW orchestrator per task execution (not shared)
  // Shutdown after task completes to clean up MCP sessions
  const orchestrator = new AgentOrchestrator(
    {
      agentsServerUrl: `${ctx.daemonUrl || "http://localhost:8080"}/agents`,
      mcpServerPool: ctx.mcpServerPool,
      daemonUrl: ctx.daemonUrl,
      requestTimeoutMs: timeoutMs,
    },
    logger.child({ component: "TaskOrchestrator", taskId: ctx.streamId }),
  );

  // Collect artifacts created during execution
  const collectedArtifactRefs: ArtifactRef[] = [];

  const agentExecutor = async (
    agentId: string,
    fsmContext: Context,
    signal: SignalWithContext,
  ) => {
    // Extract step index from state name (e.g., "step_0" -> 0)
    const stepIndex = extractStepIndex(fsmContext.state);

    // Check if this step has cached result
    const cached = ctx.cachedResults?.find((r) => r.stepIndex === stepIndex);
    if (cached && stepIndex < (ctx.resumeFromStep ?? Infinity)) {
      return {
        agentId,
        task: "",
        input: undefined,
        output: cached.output,
        duration: 0,
        timestamp: cached.cachedFrom,
      };
    }

    // Execute via AgentOrchestrator (same as WorkspaceRuntime.executeAgent)
    const result = await orchestrator.executeAgent(
      agentId,
      buildAgentPrompt(agentId, fsmContext, signal),
      {
        sessionId: ctx.sessionId,
        workspaceId: ctx.workspaceId,
        streamId: ctx.streamId,
        userId: ctx.userId,
        onStreamEvent: ctx.onStreamEvent,
        abortSignal: combinedSignal,
        additionalContext: { documents: fsmContext.documents },
      },
    );

    // Collect any artifacts from agent result
    if (result.artifacts) {
      collectedArtifactRefs.push(...result.artifacts);
    }

    return result;
  };

  // Create engine with document store and agent executor
  const engine = createEngine(fsmDef, {
    documentStore: docStore,
    scope,
    agentExecutor,
  });

  await engine.initialize();

  // Track step results as FSM progresses
  const stepResults: StepResult[] = [...(ctx.cachedResults || [])];
  let lastSuccessfulStepIndex = ctx.cachedResults?.length
    ? ctx.cachedResults.length - 1
    : -1;

  try {
    // Start FSM execution with trigger signal
    // FSM codegen generates idle state that transitions on "task-trigger"
    await engine.signal(
      { type: "task-trigger" },
      {
        sessionId: ctx.sessionId,
        workspaceId: ctx.workspaceId,
        onEvent: ctx.onStreamEvent,
      },
    );

    // FSM runs to completion synchronously via signal cascades
    // Final state should be "completed" if successful

    return {
      timestamp: new Date().toISOString(),
      success: engine.state === "completed",
      stepResults,
      artifactRefs: collectedArtifactRefs,
      lastSuccessfulStepIndex,
    };
  } catch (error) {
    const wasCancelled = ctx.abortSignal?.aborted ?? false;
    const wasTimedOut = timeoutController.signal.aborted && !wasCancelled;

    return {
      timestamp: new Date().toISOString(),
      success: false,
      stepResults,
      artifactRefs: collectedArtifactRefs,
      lastSuccessfulStepIndex,
      error: {
        type: wasTimedOut
          ? "timeout"
          : wasCancelled
          ? "cancelled"
          : "agent_error",
        message: wasTimedOut
          ? `Task timed out after ${timeoutMs}ms`
          : wasCancelled
          ? "Task cancelled"
          : error instanceof Error
          ? error.message
          : String(error),
      },
    };
  } finally {
    clearTimeout(timeoutId);
    // Cleanup orchestrator MCP sessions (per-task, not shared)
    await orchestrator.shutdown();
  }
}

/**
 * Extract step index from FSM state name.
 * Convention: step states are named "step_0", "step_1", etc.
 */
function extractStepIndex(state: string): number {
  const match = state.match(/^step_(\d+)$/);
  return match ? parseInt(match[1], 10) : -1;
}
```

### 3. Task Planner Prompt

```typescript
// packages/core/src/task-execution/planner.ts

/**
 * Outputs TaskExecutionPlan - aligns with WorkspacePlan.agents + jobs[0].steps
 */
const PLANNING_PROMPT = `
You select agents and order steps to accomplish user tasks.

Available agents (with MCP requirements):
\${agents.map(a => \`- \${a.id}: \${a.description} [needs: \${a.needs.join(', ') || 'none'}]\`).join('\\n')}

Previous intents (if any):
\${task.intents.slice(0,-1).map((i,n) => \`\${n+1}. "\${i}"\`).join('\\n') || 'None'}

Last execution result:
\${task.lastExecution ? JSON.stringify(task.lastExecution.stepResults.map(r => ({
  step: r.stepIndex,
  agent: r.agentId,
  cached: !!r.cachedFrom
}))) : 'None'}

New intent: "\${currentIntent}"

Output JSON matching TaskExecutionPlan:
{
  "agents": [
    { "id": "google-calendar", "name": "Calendar", "description": "...", "needs": ["google-oauth"] }
  ],
  "steps": [
    { "agentId": "google-calendar", "description": "Fetch today's calendar events" },
    { "agentId": "email-sender", "description": "Email the calendar summary to user" }
  ],
  "behavior": "sequential"
}

Rules:
- Include full agent definitions with id, name, description, needs
- steps.description must be specific enough to cache-match (include key parameters)
- If new intent extends previous, preserve unchanged steps for caching
- If new intent contradicts, replace entirely
- Prefer agents whose MCP needs are already satisfied
- If no agents can satisfy requirements, explain what's missing instead of picking unusable agents
`;
```

### 4. Agent Catalog

```typescript
// packages/core/src/task-execution/catalog.ts

import { AgentRegistry } from "@atlas/core/agent-registry";

interface CatalogAgent {
  id: string;
  name: string;
  description: string;
  needs: string[]; // MCP requirements like "google-oauth", "github-pat"
}

/**
 * Get available agents for task planning.
 * Returns all agents with their MCP requirements so planner can make
 * informed decisions about what's available vs what needs configuration.
 */
export async function getAgentCatalog(): Promise<CatalogAgent[]> {
  const registry = await AgentRegistry.getInstance();
  const agents = await registry.listAgents();

  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    needs: agent.mcpRequirements ?? [],
  }));
}
```

## Changes to Conversation Agent

### Remove (lines ~200-450 in conversation.agent.ts)

```typescript
// DELETE: Agent server MCP connection
const { agentServer, agentServerTransport } = await getAgentServerClient(
  session.streamId,
  logger,
);

// DELETE: Agent tool discovery
const { tools: agentTools } = await agentServer.listTools();

// DELETE: Agent tool registration loop
for (const agent of agentTools) {
  if (agent.name === "conversation") continue;
  agents[agent.name] = tool({ ... });
}

// DELETE: Streaming notification handler
agentServer.setNotificationHandler(StreamContentNotificationSchema, ...);

// DELETE: Active MCP requests tracking
const activeMCPRequests = new Map<string, string>();

// DELETE: agents from tool combination
const allTools = { ...tools, ...conversationTools, ...agents };
//                                              ^^^^^^^ REMOVE
```

### Add

```typescript
/**
 * Explicit allowlist of tools for conversation agent.
 * Prefer allowlist over blocklist for security (fail-closed).
 * New tools are excluded until explicitly added here.
 */
const CONVERSATION_TOOLS = new Set([
  // Workspace management
  "atlas_workspace_list",
  "atlas_workspace_create",
  "atlas_workspace_describe",
  "atlas_workspace_update",
  "atlas_workspace_delete",
  // Session inspection
  "atlas_session_list",
  "atlas_session_describe",
  // Job inspection
  "atlas_job_list",
  "atlas_job_describe",
  // Signal triggering
  "atlas_signal_trigger",
  // Library management
  "atlas_library_list",
  "atlas_library_install",
  // Artifact management
  "atlas_artifact_list",
  "atlas_artifact_read",
  "atlas_artifact_create",
  // System
  "system_version",
]);

const managementTools = Object.fromEntries(
  Object.entries(tools).filter(([name]) => CONVERSATION_TOOLS.has(name)),
);

// New tool set
const allTools = {
  ...managementTools,
  ...conversationTools, // take_note, read_atlas_resource, display_artifact
  do_task, // NEW - unified task execution
};
```

## File Structure

### New Files

```
packages/core/src/task-execution/
├── index.ts              # Public exports
├── types.ts              # ActiveTask, TaskExecutionPlan, ExecutionResult, StepResult, ArtifactRef
├── planner.ts            # LLM-based task planning, returns PlanResult union
├── executor.ts           # FSM execution via AgentOrchestrator
├── compile.ts            # compileFSMCode() - Deno worker isolation
├── compile.worker.ts     # Worker that executes FSM code (sandboxed)
├── catalog.ts            # getAgentCatalog() - wraps AgentRegistry
├── cache.ts              # computeCacheKey(), matchCacheableSteps()
├── store.ts              # loadActiveTask, storeActiveTask, clearActiveTask
├── helpers.ts            # toJobPlan, summarizePlan, summarizeTask, extractStepIndex
└── validation.ts         # validateAgentRequirements (MCP requirements check)

packages/mcp-server/src/tools/task/
├── index.ts
└── do-task.ts            # The do_task MCP tool
```

### Modified Files

```
packages/system/agents/conversation/conversation.agent.ts
  - Remove agent server connection (~lines 203-220)
  - Remove agent tool registration (~lines 365-448)
  - Remove notification handlers (~lines 326-362)
  - Add tool filtering
  - Add do_task to tool set

packages/mcp-server/src/tools/index.ts
  - Import and register do_task tool
```

### Reusable Code

```
packages/system/agents/fsm-workspace-creator/
├── fsm-generation-core.ts    # FSM codegen prompts - REUSE
├── agent-helpers.ts          # agentAction, prepare, emit - REUSE
└── agent-classifier.ts       # Bundled vs LLM agent detection - REUSE

packages/document-store/
└── in-memory-document-store.ts  # InMemoryDocumentStore - REUSE (already exists)

src/core/workspace-runtime.ts
  - FSMEngine patterns - REFERENCE for executor.ts
```

## Key Code References

| Concept                  | File                                                                  | Lines   | Notes                                      |
| ------------------------ | --------------------------------------------------------------------- | ------- | ------------------------------------------ |
| Current agent invocation | `packages/system/agents/conversation/conversation.agent.ts`           | 203-450 | Agent server connection, tool registration |
| MCP tool registration    | `packages/mcp-server/src/tools/index.ts`                              | 52-105  | All tools registered here                  |
| Signal trigger tool      | `packages/mcp-server/src/tools/signals/trigger.ts`                    | full    | Pattern for new do_task tool               |
| FSM code generation      | `packages/system/agents/fsm-workspace-creator/fsm-generation-core.ts` | full    | LLM-based FSM TypeScript gen               |
| Workspace runtime        | `src/core/workspace-runtime.ts`                                       | full    | FSMEngine usage, agent execution           |
| Agent execution          | `packages/core/src/agent-server/agent-execution-manager.ts`           | full    | How agents run                             |
| Workspace planner        | `packages/system/agents/workspace-planner/workspace-planner.agent.ts` | full    | Two-phase LLM planning pattern             |
| Bundled agent example    | `packages/bundled-agents/src/google/calendar.ts`                      | full    | Agent with MCP requirements                |

## Token Budget

| Operation       | Est. Input | Est. Output | Model      |
| --------------- | ---------- | ----------- | ---------- |
| Task planning   | ~2-3k      | ~500        | Sonnet 4.5 |
| FSM generation  | ~3-4k      | ~1k         | Sonnet 4.5 |
| Agent execution | varies     | varies      | Per agent  |

**Total overhead per task**: ~4-5k tokens vs ~500 for direct agent call.

**Optimization opportunity**: Use Haiku for planning if quality holds.

## Design Decisions (Resolved)

### 1. Result Caching ✓

**Decision**: Cache unchanged step results based on agentId + normalized
description hash.

**Mechanism**:

```typescript
/**
 * Compute stable cache key from agent + normalized description.
 * Normalization reduces LLM phrasing variance ("Fetch events" vs "Get events").
 */
function computeCacheKey(step: TaskStep): string {
  const normalized = step.description.toLowerCase().replace(/\s+/g, " ").trim();
  return `${step.agentId}:${hashString(normalized)}`;
}

function matchCacheableSteps(
  newSteps: TaskStep[],
  previousResults: StepResult[],
): StepResult[] {
  const cacheable: StepResult[] = [];
  for (let i = 0; i < newSteps.length && i < previousResults.length; i++) {
    const newKey = computeCacheKey(newSteps[i]);
    if (newKey === previousResults[i].cacheKey) {
      cacheable.push({
        ...previousResults[i],
        cachedFrom: previousResults[i].timestamp,
      });
    } else {
      break; // Stop at first mismatch (sequential execution)
    }
  }
  return cacheable;
}
```

**Why agentId in cache key?** Two agents might have similar descriptions ("send
email" via Gmail vs Slack). Including agentId prevents false cache hits.

**Why normalize?** LLM might generate "Fetch today's events" one run and "Get
today's calendar events" the next. Normalization (lowercase, collapse
whitespace) increases cache hit rate without semantic analysis.

**Complexity analysis**:

- +1 field per StepResult (`cacheKey`)
- +2 helper functions (`computeCacheKey`, `matchCacheableSteps`)
- +~10 lines in executor to check cache before agent call
- Pre-populate documents in InMemoryDocumentStore for cached results

**Total**: ~60 lines additional code. Acceptable tradeoff for avoiding redundant
agent calls on task modification.

**Staleness mitigation**: Cache only within same conversation session. If user
says "refresh" or significant time passes, clear cache flag.

### 2. Partial Failure ✓

**Decision**: Track `lastSuccessfulStepIndex`, allow retry from that point via
boolean flag.

**User experience**:

```
User: "check my calendar and email me"
→ Step 0 (calendar): ✓
→ Step 1 (email): ✗ "Gmail auth expired"

Conversation shows: "I got your calendar (3 events today), but email failed.
Would you like me to retry just the email step?"

User: "yes retry"
→ do_task({ intent: "retry", retry: true })
→ Step 1 (email): ✓ (uses cached calendar data)
```

**Implementation**: The `do_task` tool accepts `retry: boolean` parameter. When
true and last execution failed, executor computes resume point from
`lastSuccessfulStepIndex + 1`, loads cached results for steps 0..N-1 into
InMemoryDocumentStore, then executes from step N onwards.

**Why boolean instead of step index?** The LLM shouldn't need to track step
indices. The executor already knows `lastSuccessfulStepIndex` from the stored
execution result. Boolean retry is simpler and can't be wrong.

**Complexity**: ~20 additional lines. ExecutionResult already tracks
`lastSuccessfulStepIndex`.

### 3. Agent MCP Initialization ✓

**Decision**: Create new `AgentOrchestrator` per task, shutdown after
completion.

Unlike workspace-runtime (which shares one orchestrator across all jobs), task
execution creates a fresh orchestrator for each `do_task` invocation:

```typescript
// Create NEW orchestrator per task (not shared)
const orchestrator = new AgentOrchestrator(
  {
    agentsServerUrl: `${ctx.daemonUrl || "http://localhost:8080"}/agents`,
    mcpServerPool: ctx.mcpServerPool,
    daemonUrl: ctx.daemonUrl,
    requestTimeoutMs: timeoutMs,
  },
  logger.child({ component: "TaskOrchestrator", taskId: ctx.streamId }),
);

try {
  // ... execute task ...
} finally {
  // Always cleanup MCP sessions
  await orchestrator.shutdown();
}
```

**Why per-task instead of shared?**

- Task execution is ephemeral (single conversation turn)
- No benefit to caching MCP connections across turns
- Clean shutdown prevents connection leaks
- Simpler lifecycle (no "getOrCreate" complexity)

The orchestrator still handles lazy MCP initialization internally—agents only
connect when actually executed. Shutdown ensures cleanup.

### 4. Artifact Versioning ✓

**Decision**: Use existing `ArtifactStorage.update()` which creates new
revisions automatically. No custom versioning needed.

**Mechanism**:

```typescript
// packages/core/src/task-execution/store.ts

import { client, parseResult } from "@atlas/client/v2";
import type { ActiveTask, TaskExecutionPlan } from "./types.ts";

/** Stored task includes artifact metadata */
interface StoredActiveTask extends ActiveTask {
  artifactId: string;
}

/**
 * Load active task for a conversation.
 * Filters by type "active-task" to avoid collision with agent-produced artifacts.
 */
async function loadActiveTask(
  streamId: string,
): Promise<StoredActiveTask | null> {
  const response = await parseResult(
    client.artifactsStorage.index.$get({
      query: { chatId: streamId, limit: "100" },
    }),
  );

  if (!response.ok) {
    return null;
  }

  // Filter by type and get most recent (list returns newest first)
  const activeTaskArtifact = response.data.artifacts.find(
    (a) => a.type === "active-task",
  );

  if (!activeTaskArtifact) {
    return null;
  }

  // Fetch full artifact data
  const fullResponse = await parseResult(
    client.artifactsStorage[":id"].$get({
      param: { id: activeTaskArtifact.id },
    }),
  );

  if (!fullResponse.ok || fullResponse.data.artifact.type !== "active-task") {
    return null;
  }

  return {
    ...fullResponse.data.artifact.data.data as ActiveTask,
    artifactId: activeTaskArtifact.id,
  };
}

/**
 * Store or update active task artifact.
 */
async function storeActiveTask(
  streamId: string,
  task: ActiveTask,
): Promise<void> {
  const existing = await loadActiveTask(streamId);

  if (existing) {
    // Creates new revision (ArtifactStorage handles versioning)
    await parseResult(
      client.artifactsStorage[":id"].$put({
        param: { id: existing.artifactId },
        json: {
          type: "active-task",
          data: { type: "active-task", version: 1, data: task },
          summary: summarizeTask(task),
        },
      }),
    );
  } else {
    await parseResult(
      client.artifactsStorage.index.$post({
        json: {
          data: { type: "active-task", version: 1, data: task },
          summary: summarizeTask(task),
          chatId: streamId,
        },
      }),
    );
  }
}

/**
 * Clear active task for a conversation (soft delete).
 */
async function clearActiveTask(streamId: string): Promise<void> {
  const existing = await loadActiveTask(streamId);
  if (existing) {
    await parseResult(
      client.artifactsStorage[":id"].$delete({
        param: { id: existing.artifactId },
      }),
    );
  }
}

/**
 * Convert TaskExecutionPlan to WorkspacePlan.jobs[0] shape for FSM generation.
 * Matches the signature expected by generateFSMCode() from fsm-generation-core.ts.
 */
function toJobPlan(plan: TaskExecutionPlan): WorkspaceJobPlan {
  return {
    id: "task-job",
    name: "Task Execution",
    triggerSignalId: "task-trigger",
    steps: plan.steps,
    behavior: plan.behavior,
  };
}

/**
 * Generate human-readable summary of plan for tool response.
 */
function summarizePlan(plan: TaskExecutionPlan): string {
  const agentNames = plan.agents.map((a) => a.name).join(" → ");
  return `${plan.steps.length} step(s): ${agentNames}`;
}

/**
 * Generate summary for artifact storage.
 */
function summarizeTask(task: ActiveTask): string {
  const status = task.status;
  const intentCount = task.intents.length;
  const lastIntent = task.intents[task.intents.length - 1] || "";
  const preview = lastIntent.length > 50
    ? lastIntent.slice(0, 47) + "..."
    : lastIntent;
  return `[${status}] ${intentCount} intent(s): "${preview}"`;
}
```

**Benefits**: Audit trail, diff revisions, rollback (future). All handled by
existing artifact infra.

**Lookup**: `loadActiveTask(streamId)` queries artifacts by chatId and filters
by `type: "active-task"` to avoid collision with agent-produced artifacts.

### 5. Planner Failure Mode ✓

When planner can't satisfy requirements, return structured failure:

```typescript
// planTask() returns discriminated union
type PlanResult =
  | { success: true; plan: TaskExecutionPlan }
  | { success: false; reason: string }; // LLM explains what's missing

// do_task handler
const planResult = await planTask({ intents, agentCatalog, ... });
if (!planResult.success) {
  return {
    success: false,
    error: { type: "planning_failed", message: planResult.reason },
  };
}
```

Planner prompt instructs LLM: "If no agents can satisfy requirements, explain
what's missing instead of picking unusable agents."

### 6. FSM Compilation ✓

Execute LLM-generated FSM code via isolated Deno worker (same pattern as
`packages/workspace-builder/mcp-tools/codegen.ts`):

```typescript
const worker = new Worker(workerUrl, {
  type: "module",
  deno: { permissions: "none" }, // Complete isolation
});
```

Worker receives FSM code string, compiles to FSMDefinition, returns result.
Timeout + error handling per codegen.ts pattern.

### 7. Streaming ✓

Progress streams via `AtlasUIMessageChunk` (defined in `@atlas/agent-sdk`):

```typescript
// Executor passes through to agent execution
orchestrator.executeAgent(agentId, prompt, {
  onStreamEvent: ctx.onStreamEvent, // (chunk: AtlasUIMessageChunk) => void
  ...
});
```

Events include: `agent-start`, `agent-finish`, `agent-error`, `tool-progress`.
UI renders these as conversation progresses.

### 8. MCP Requirements ✓

**Decision**: Validate at planning time, fail fast with clarification message.

Same pattern as workspace-planner.agent.ts (lines 298-368):

1. After `planTask()` returns, call `validateAgentRequirements(plan.agents)`
2. For each agent, check `matchBundledAgents(agent.needs)`
3. For unmatched needs, try `mapNeedToMCPServers(need)`
4. Collect `ClarificationItem[]` for any unmatched needs
5. If clarifications exist, return
   `{ success: false, error: { type: "planning_failed", message } }`

```typescript
// In do_task handler, after successful planTask():
const clarifications = validateAgentRequirements(plan.agents);
if (clarifications.length > 0) {
  return {
    success: false,
    error: {
      type: "planning_failed",
      message: formatClarificationReport(clarifications),
    },
  };
}
```

**Auth handwaving**: For MVP, assume MCP servers that require auth (OAuth, API
keys) are pre-configured in the user's environment. Future: integrate with
credential management UI.

### 9. Session Scoping ✓

Session = chatId (called `streamId` in some places). One active task per chatId.
Cache scoped to same chatId - new conversation = fresh task state.

## Open Questions (Post-MVP)

1. **Task visibility** - Does user need explicit tool to inspect task plan?
   Likely sufficient via tool-progress events for MVP.

2. **Cross-session continuity** - Active task persists (artifact storage), but
   how to surface on return? Consider auto-loading on conversation resume.

3. **Haiku for planning** - Test in eval before switching. May need structured
   output mode.

## Future Scope

- **persist_automation** - Converting task → workspace with signals. Separate
  design doc when prioritized.

## Implementation Order

1. **Phase 1: Core infrastructure**
   - Create `packages/core/src/task-execution/` module
   - Implement types.ts (ActiveTask, TaskExecutionPlan, ExecutionResult,
     StepResult, ArtifactRef, PlanResult)
   - Implement store.ts using `@atlas/client/v2`:
     - `loadActiveTask(streamId)` with type filter
     - `storeActiveTask(streamId, task)`
     - `clearActiveTask(streamId)`
   - Implement helpers.ts:
     - `toJobPlan(plan)` - convert to WorkspacePlan.jobs[0] shape
     - `summarizePlan(plan)` - human-readable summary
     - `summarizeTask(task)` - artifact summary
     - `extractStepIndex(state)` - parse "step_N" → N
   - Implement catalog.ts: `getAgentCatalog()` wrapping AgentRegistry

2. **Phase 2: FSM generation + compilation**
   - Implement compile.ts + compile.worker.ts (Deno worker, zero permissions)
   - Reuse fsm-generation-core.ts `generateFSMCode()` directly
   - Document contract: FSM uses "task-trigger" signal, "step_N" states,
     "step_N_result" documents
   - Test: single-step task generates valid FSM

3. **Phase 3: Planner + validation**
   - Implement planner.ts returning `PlanResult` discriminated union
   - Implement validation.ts: `validateAgentRequirements(agents)` using
     `matchBundledAgents`, `mapNeedToMCPServers`, `findUnmatchedNeeds`
   - Implement cache.ts: `computeCacheKey()`, `matchCacheableSteps()`
   - Test: planner returns failure when agents can't satisfy requirements

4. **Phase 4: Executor + do_task tool**
   - Implement executor.ts with per-task AgentOrchestrator
   - Create `packages/mcp-server/src/tools/task/do-task.ts`
   - Wire PlanResult handling in do_task handler
   - Add explicit allowlist tool filtering to conversation agent
   - Remove direct agent invocation code
   - Test: "check my calendar" works end-to-end
   - Test: "start over" clears task state

5. **Phase 5: Caching + retry + polish**
   - Implement step caching with agentId + normalized description keys
   - Add boolean `retry` parameter handling
   - Test: "also email me" reuses cached calendar data
   - Test: retry after partial failure works
   - Streaming progress events (AtlasUIMessageChunk via onStreamEvent)
   - Error handling refinement

## Related Documents

- `docs/ARCHITECTURE.md` - Overall Atlas architecture
- `packages/system/agents/fsm-workspace-creator/` - Existing FSM generation
  (reference impl)
- `packages/system/agents/workspace-planner/` - Existing planning patterns
- `packages/core/src/orchestrator/agent-orchestrator.ts` - Agent execution layer
