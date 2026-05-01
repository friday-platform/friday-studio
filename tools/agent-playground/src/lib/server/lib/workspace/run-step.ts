/**
 * Single-step execution for the workspace inspector.
 *
 * Extracts the agent action from a specific FSM state and executes it
 * in isolation — no FSM engine, no state transitions, just the agent
 * call with provided input. Used for step re-runs with edited input.
 *
 * @module
 */

import type {
  AgentAction,
  AgentResult,
  Context,
  SignalWithContext,
} from "@atlas/fsm-engine";
import type { CompiledFSMDefinition, WorkspaceBlueprint } from "@atlas/workspace-builder";
import { createDirectMCPExecutor } from "./direct-executor.ts";
import { createMockAgentExecutor } from "./mock-executor.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for executing a single step. */
export interface RunStepOptions {
  /** The FSM definition containing the target state. */
  fsm: CompiledFSMDefinition;
  /** The workspace plan (for schema lookup and agent resolution). */
  plan: WorkspaceBlueprint;
  /** The FSM state ID to execute (e.g. "step_clone_repo"). */
  stateId: string;
  /** Input data to pass to the agent (possibly user-edited). */
  input: Record<string, unknown>;
  /** Use real agents instead of mocks. */
  real?: boolean;
  /** Called on action execution events. */
  onAction?: (action: {
    state: string;
    actionType: string;
    actionId?: string;
    input?: { task?: string; config?: Record<string, unknown> };
    status: "started" | "completed" | "failed";
    error?: string;
  }) => void;
}

/** Result of a single step execution. */
export interface StepResult {
  success: boolean;
  output: unknown;
  durationMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Execute a single FSM step's agent action in isolation.
 *
 * Looks up the agent action in the specified state's entry actions,
 * then invokes either the mock or real executor with the given input.
 *
 * @param opts - Step execution options
 * @returns Step result with output data
 */
export async function runStep(opts: RunStepOptions): Promise<StepResult> {
  const startTime = Date.now();

  // Find the agent action in the state's entry actions
  const state = opts.fsm.states[opts.stateId];
  if (!state) {
    return {
      success: false,
      output: null,
      durationMs: Date.now() - startTime,
      error: `State "${opts.stateId}" not found in FSM`,
    };
  }

  const entryActions = Array.isArray(state.entry) ? state.entry : [];
  const agentAction = entryActions.find(
    (a): a is AgentAction =>
      typeof a === "object" && a !== null && "type" in a && (a.type === "agent" || a.type === "llm"),
  );

  if (!agentAction) {
    return {
      success: false,
      output: null,
      durationMs: Date.now() - startTime,
      error: `No agent action found in state "${opts.stateId}"`,
    };
  }

  opts.onAction?.({
    state: opts.stateId,
    actionType: agentAction.type,
    actionId: agentAction.agentId,
    input: { task: agentAction.prompt, config: opts.input as Record<string, unknown> },
    status: "started",
  });

  let realExecutorHandle:
    | { executor: (a: AgentAction, c: Context, s: SignalWithContext) => Promise<AgentResult>; shutdown: () => Promise<void> }
    | undefined;

  try {
    const executor = opts.real
      ? (() => {
          realExecutorHandle = createDirectMCPExecutor({ plan: opts.plan });
          return realExecutorHandle.executor;
        })()
      : createMockAgentExecutor({ plan: opts.plan });

    const fsmContext: Context = {
      state: opts.stateId,
      results: {},
      documents: [],
      input: opts.input as { task?: string; config?: Record<string, unknown> },
    };
    const signal: SignalWithContext = {
      type: "step-rerun",
      data: opts.input,
      _context: {
        sessionId: `rerun-${startTime}`,
        workspaceId: "harness-workspace",
      },
    };

    const result = await executor(agentAction, fsmContext, signal);

    opts.onAction?.({
      state: opts.stateId,
      actionType: agentAction.type,
      actionId: agentAction.agentId,
      status: result.ok ? "completed" : "failed",
      error: result.ok ? undefined : (result as { error?: { reason?: string } }).error?.reason,
    });

    return {
      success: result.ok === true,
      output: result.ok ? result.data : null,
      durationMs: Date.now() - startTime,
      error: result.ok ? undefined : (result as { error?: { reason?: string } }).error?.reason,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.onAction?.({
      state: opts.stateId,
      actionType: agentAction.type,
      actionId: agentAction.agentId,
      status: "failed",
      error: message,
    });
    return {
      success: false,
      output: null,
      durationMs: Date.now() - startTime,
      error: message,
    };
  } finally {
    await realExecutorHandle?.shutdown();
  }
}
