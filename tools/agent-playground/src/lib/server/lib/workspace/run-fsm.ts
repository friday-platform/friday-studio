/**
 * FSM execution harness core.
 *
 * Runs a compiled FSM through the real FSMEngine with a mock agent
 * executor. Captures state transitions, action traces, and document
 * snapshots into a structured ExecutionReport.
 *
 * @module
 */

import { InMemoryDocumentStore } from "@atlas/document-store";
import {
  AtlasLLMProviderAdapter,
  FSMEngine,
  type AgentExecutor,
  type FSMDefinition,
  type FSMEvent,
} from "@atlas/fsm-engine";
import type { WorkspaceBlueprint } from "@atlas/workspace-builder";
import { createInlineCodeExecutor } from "./inline-code-executor.ts";
import { createMockAgentExecutor, createMockLLMProvider } from "./mock-executor.ts";

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface ExecutionReport {
  success: boolean;
  finalState: string;
  stateTransitions: Array<{ from: string; to: string; signal: string; timestamp: number }>;
  resultSnapshots: Record<string, Record<string, Record<string, unknown>>>;
  actionTrace: Array<{
    state: string;
    actionType: string;
    actionId?: string;
    input?: { task?: string; config?: Record<string, unknown> };
    status: "started" | "completed" | "failed";
    error?: string;
  }>;
  assertions: Array<{ check: string; passed: boolean; detail?: string }>;
  error?: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RunFSMOptions {
  fsm: FSMDefinition;
  plan: WorkspaceBlueprint;
  triggerSignal: string;
  signalPayload?: Record<string, unknown>;
  agentOverrides?: Record<string, unknown>;
  /** Custom agent executor. Defaults to mock executor when not provided. */
  agentExecutor?: AgentExecutor;
  /** Called on each state transition for live streaming. */
  onTransition?: (transition: {
    from: string;
    to: string;
    signal: string;
    timestamp: number;
    resultSnapshot: Record<string, Record<string, unknown>>;
  }) => void;
  /** Called on each action execution for live streaming. */
  onAction?: (action: {
    state: string;
    actionType: string;
    actionId?: string;
    input?: { task?: string; config?: Record<string, unknown> };
    status: "started" | "completed" | "failed";
    error?: string;
  }) => void;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Runs a compiled FSM through FSMEngine.
 *
 * Uses mock agents by default, or a custom executor when provided.
 *
 * @param opts - FSM definition, plan metadata, and execution options
 * @returns Structured execution report with traces, snapshots, and assertions
 */
export async function runFSM(opts: RunFSMOptions): Promise<ExecutionReport> {
  const startTime = Date.now();
  const stateTransitions: ExecutionReport["stateTransitions"] = [];
  const resultSnapshots: Record<string, Record<string, Record<string, unknown>>> = {};
  const actionTrace: ExecutionReport["actionTrace"] = [];

  const store = new InMemoryDocumentStore();
  const scope = { workspaceId: "harness-workspace", sessionId: `harness-${startTime}` };

  const isMockMode = !opts.agentExecutor;

  const agentExecutor =
    opts.agentExecutor ??
    createMockAgentExecutor({ plan: opts.plan, agentOverrides: opts.agentOverrides });

  const llmProvider = isMockMode
    ? createMockLLMProvider({ plan: opts.plan, agentOverrides: opts.agentOverrides })
    : (() => {
        // FSM actions have model baked in from compilation — override to use Groq
        const adapter = new AtlasLLMProviderAdapter("openai/gpt-oss-120b", "groq");
        return {
          call: (params: Parameters<typeof adapter.call>[0]) =>
            adapter.call({ ...params, model: "" }),
        };
      })();

  const engine = new FSMEngine(opts.fsm, {
    documentStore: store,
    scope,
    agentExecutor,
    llmProvider,
    codeExecutor: createInlineCodeExecutor(),
  });

  // Event collector for tracing
  function collectEvents(event: FSMEvent) {
    switch (event.type) {
      case "data-fsm-state-transition": {
        const transition = {
          from: event.data.fromState,
          to: event.data.toState,
          signal: event.data.triggeringSignal,
          timestamp: event.data.timestamp,
        };
        stateTransitions.push(transition);
        // Snapshot results accumulator at this transition
        const snapshot = structuredClone(engine.results);
        resultSnapshots[event.data.toState] = snapshot;
        opts.onTransition?.({ ...transition, resultSnapshot: snapshot });
        break;
      }

      case "data-fsm-action-execution": {
        const { task, config } = event.data.inputSnapshot ?? {};
        const input = task || config ? { task, config } : undefined;
        const entry = {
          state: event.data.state,
          actionType: event.data.actionType,
          actionId: event.data.actionId,
          input,
          status: event.data.status as "started" | "completed" | "failed",
          error: event.data.error,
        };
        actionTrace.push(entry);
        opts.onAction?.(entry);
        break;
      }
    }
  }

  try {
    await engine.initialize();

    await engine.signal(
      { type: opts.triggerSignal, data: opts.signalPayload ?? {} },
      { sessionId: scope.sessionId, workspaceId: scope.workspaceId, onEvent: collectEvents },
    );
  } catch (err) {
    return {
      success: false,
      finalState: engine.state,
      stateTransitions,
      resultSnapshots,
      actionTrace,
      assertions: [],
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }

  // Run post-execution assertions
  const assertions = runAssertions(engine, opts, stateTransitions);

  const success = engine.state === "completed" && assertions.every((a) => a.passed);

  return {
    success,
    finalState: engine.state,
    stateTransitions,
    resultSnapshots,
    actionTrace,
    assertions,
    durationMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Post-execution assertions
// ---------------------------------------------------------------------------

function runAssertions(
  engine: FSMEngine,
  opts: RunFSMOptions,
  stateTransitions: ExecutionReport["stateTransitions"],
): ExecutionReport["assertions"] {
  const assertions: ExecutionReport["assertions"] = [];

  // 1. Reached completed state
  assertions.push({
    check: "reached_completed",
    passed: engine.state === "completed",
    detail:
      engine.state === "completed"
        ? undefined
        : `Final state is "${engine.state}", expected "completed"`,
  });

  // 2. Assert results exist for steps that were actually visited.
  //    State names follow the pattern "step_<snake_case_id>" so we derive
  //    visited step IDs from the transition trace to handle conditional branches.
  const job = opts.plan.jobs.find((j) => j.id === opts.fsm.id);
  if (job) {
    const visitedStates = new Set<string>();
    for (const t of stateTransitions) {
      visitedStates.add(t.from);
      visitedStates.add(t.to);
    }

    // Convert step ID to the state name the compiler generates
    const toStateName = (stepId: string) => `step_${stepId.replace(/-/g, "_")}`;

    const results = engine.results;

    for (const contract of job.documentContracts) {
      const stepState = toStateName(contract.producerStepId);
      if (!visitedStates.has(stepState)) continue;

      const exists = results[contract.documentId] !== undefined;
      assertions.push({
        check: `result_exists:${contract.documentId}`,
        passed: exists,
        detail: exists
          ? undefined
          : `Result "${contract.documentId}" not found (expected from step "${contract.producerStepId}")`,
      });
    }
  }

  return assertions;
}
