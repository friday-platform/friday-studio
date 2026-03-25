/**
 * Maps FSM action execution events to session stream events (v2).
 *
 * Pure functions: given an FSM event + optional side-channel data,
 * produce StepStartEvent or StepCompleteEvent for the session stream.
 * Only agent actions produce step events — non-agent types are filtered.
 *
 * @module
 */

import type { FSMActionExecutionEvent, FSMStateSkippedEvent } from "@atlas/fsm-engine";
import type {
  StepCompleteEvent,
  StepSkippedEvent,
  StepStartEvent,
  ToolCallSummary,
} from "./session-events.ts";
import { SessionActionTypeSchema } from "./session-events.ts";

// ---------------------------------------------------------------------------
// AgentResultData — side-channel projection
// ---------------------------------------------------------------------------

/**
 * Simplified projection of agent execution results stored in the side-channel
 * map. The workspace-runtime populates this after each agent executor completes.
 */
export interface AgentResultData {
  toolCalls: ToolCallSummary[];
  reasoning?: string;
  output: unknown;
}

// ---------------------------------------------------------------------------
// isAgentAction
// ---------------------------------------------------------------------------

/** Action types that represent meaningful work steps in the session history. */
const STEP_ACTION_TYPES = new Set(["agent", "llm"]);

/**
 * Returns true when the FSM action execution event represents a work step
 * that should appear in session history. Both "agent" (delegated to
 * AgentOrchestrator) and "llm" (inline FSM LLM calls) produce step events.
 * Infrastructure types (code, emit) do not.
 */
export function isAgentAction(event: FSMActionExecutionEvent): boolean {
  return STEP_ACTION_TYPES.has(event.data.actionType);
}

// ---------------------------------------------------------------------------
// mapActionToStepStart
// ---------------------------------------------------------------------------

/**
 * Maps a started FSM agent action execution to a `step:start` session event.
 *
 * @param event - FSM action execution event with status "started"
 * @param stepNumber - Monotonically increasing step counter for the session
 */
export function mapActionToStepStart(
  event: FSMActionExecutionEvent,
  stepNumber: number,
): StepStartEvent {
  const snapshot = event.data.inputSnapshot;
  return {
    type: "step:start",
    sessionId: event.data.sessionId,
    stepNumber,
    agentName: event.data.actionId ?? "unknown",
    stateId: event.data.state,
    actionType: SessionActionTypeSchema.parse(event.data.actionType),
    task: snapshot?.task ?? "",
    input: snapshot?.config,
    timestamp: new Date(event.data.timestamp).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// mapActionToStepComplete
// ---------------------------------------------------------------------------

/**
 * Maps a completed/failed FSM agent action execution to a `step:complete`
 * session event. Pulls tool calls, reasoning, and output from the side-channel
 * agent result when available.
 *
 * @param event - FSM action execution event with status "completed" or "failed"
 * @param agentResult - Side-channel data from the agent executor, or undefined on miss
 * @param stepNumber - Matching step number from the corresponding step:start
 */
export function mapActionToStepComplete(
  event: FSMActionExecutionEvent,
  agentResult: AgentResultData | undefined,
  stepNumber: number,
): StepCompleteEvent {
  return {
    type: "step:complete",
    sessionId: event.data.sessionId,
    stepNumber,
    status: event.data.status === "failed" ? "failed" : "completed",
    durationMs: event.data.durationMs ?? 0,
    toolCalls: agentResult?.toolCalls ?? [],
    reasoning: agentResult?.reasoning,
    output: agentResult?.output,
    error: event.data.error,
    timestamp: new Date(event.data.timestamp).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// mapStateSkippedToStepSkipped
// ---------------------------------------------------------------------------

/**
 * Maps a skipped FSM state event to a `step:skipped` session event.
 *
 * @param event - FSM state skipped event emitted when `skipStates` causes a state to be bypassed
 */
export function mapStateSkippedToStepSkipped(event: FSMStateSkippedEvent): StepSkippedEvent {
  return {
    type: "step:skipped",
    sessionId: event.data.sessionId,
    stateId: event.data.stateId,
    timestamp: new Date(event.data.timestamp).toISOString(),
  };
}
