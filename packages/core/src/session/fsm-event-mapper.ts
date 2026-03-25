/**
 * Maps FSMEvent (from @atlas/fsm-engine) to SessionHistoryEvent payload format.
 *
 * This module converts runtime FSM events to the session history schema format
 * for persistence. Extracted from workspace-runtime for reuse by do_task.
 */

import type { FSMEvent, ToolCall, ToolResult } from "@atlas/fsm-engine";
import { z } from "zod";
import type { SessionHistoryEvent } from "./history-storage.ts";

/**
 * The "content" portion of a SessionHistoryEvent - type, context, and data.
 *
 * SessionHistoryEvent has envelope fields (eventId, sessionId, emittedAt, emittedBy)
 * that are auto-generated when persisting. This type represents just the payload
 * that mapFsmEventToSessionEvent produces, before the envelope is added.
 */
export type SessionHistoryEventPayload = Omit<
  SessionHistoryEvent,
  "eventId" | "emittedAt" | "sessionId" | "emittedBy"
>;

// Zod schema for FSM action type validation - ensures actionType matches session history schema
const FSMActionTypeSchema = z.enum(["agent", "llm", "code", "emit"]);

/**
 * Build executionId for tool events from actionId and state.
 * Matches the executionId format used in fsm-action events for correlation.
 */
function buildToolExecutionId(
  jobName: string,
  actionId: string | undefined,
  state: string,
  timestamp: number,
): string {
  return actionId ? `${jobName}:${actionId}:${state}` : `${jobName}:${state}:${timestamp}`;
}

/**
 * Map FSMEvent to session history event payload.
 * Converts runtime FSM events to the session history schema format.
 *
 * @param fsmEvent - The FSM event from @atlas/fsm-engine
 * @returns A SessionHistoryEventPayload ready for persistence (missing envelope fields)
 */
export function mapFsmEventToSessionEvent(fsmEvent: FSMEvent): SessionHistoryEventPayload {
  switch (fsmEvent.type) {
    case "data-fsm-tool-call": {
      const executionId = buildToolExecutionId(
        fsmEvent.data.jobName,
        fsmEvent.data.actionId,
        fsmEvent.data.state,
        fsmEvent.data.timestamp,
      );
      return {
        type: "agent-tool-call",
        context: {
          executionId,
          agentId: fsmEvent.data.actionId,
          metadata: { fsmEventType: "tool-call" },
        },
        data: {
          agentId: fsmEvent.data.actionId ?? fsmEvent.data.jobName,
          executionId,
          toolCall: fsmEvent.data.toolCall as ToolCall,
        },
      };
    }

    case "data-fsm-tool-result": {
      const executionId = buildToolExecutionId(
        fsmEvent.data.jobName,
        fsmEvent.data.actionId,
        fsmEvent.data.state,
        fsmEvent.data.timestamp,
      );
      return {
        type: "agent-tool-result",
        context: {
          executionId,
          agentId: fsmEvent.data.actionId,
          metadata: { fsmEventType: "tool-result" },
        },
        data: {
          agentId: fsmEvent.data.actionId ?? fsmEvent.data.jobName,
          executionId,
          toolResult: fsmEvent.data.toolResult as ToolResult,
        },
      };
    }

    case "data-fsm-action-execution": {
      const executionId = fsmEvent.data.actionId
        ? `${fsmEvent.data.jobName}:${fsmEvent.data.actionId}:${fsmEvent.data.state}`
        : `${fsmEvent.data.jobName}:${fsmEvent.data.state}:${fsmEvent.data.timestamp}`;

      // Parse actionType with Zod schema - validates it matches session history schema
      const actionTypeResult = FSMActionTypeSchema.safeParse(fsmEvent.data.actionType);
      const actionType = actionTypeResult.success ? actionTypeResult.data : "agent"; // fallback for unknown types

      return {
        type: "fsm-action",
        context: { executionId, metadata: { fsmEventType: "action" } },
        data: {
          jobName: fsmEvent.data.jobName,
          state: fsmEvent.data.state,
          actionType,
          actionId: fsmEvent.data.actionId,
          status: fsmEvent.data.status,
          durationMs: fsmEvent.data.durationMs,
          error: fsmEvent.data.error,
          inputSnapshot: fsmEvent.data.inputSnapshot,
        },
      };
    }

    case "data-fsm-state-transition":
      // State transitions are no longer persisted to session history
      // Return a minimal fsm-action event as a no-op placeholder
      return {
        type: "fsm-action",
        context: { metadata: { fsmEventType: "transition-ignored" } },
        data: {
          jobName: fsmEvent.data.jobName,
          state: fsmEvent.data.toState,
          actionType: "emit" as const,
          status: "completed" as const,
        },
      };

    case "data-fsm-state-skipped":
      // Skipped states mapped to session events via step:skipped (separate path)
      return {
        type: "fsm-action",
        context: { metadata: { fsmEventType: "state-skipped-ignored" } },
        data: {
          jobName: fsmEvent.data.jobName,
          state: fsmEvent.data.stateId,
          actionType: "emit" as const,
          status: "completed" as const,
        },
      };
  }
}
