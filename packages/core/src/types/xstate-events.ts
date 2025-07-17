/**
 * XState Event Type Definitions
 *
 * Provides typed events for all XState machines in the actor hierarchy,
 * replacing generic 'any' types with discriminated unions.
 */

import type { ActorRefMap, AgentResult, SessionInfo, SessionResult } from "./actors.ts";
import type { ExecutionPlan } from "./agent-execution.ts";

// ==============================================================================
// WORKSPACE SUPERVISOR EVENTS
// ==============================================================================

/**
 * Events for WorkspaceSupervisor XState machine
 */
export type WorkspaceSupervisorEvent =
  | { type: "SIGNAL_RECEIVED"; signal: unknown; payload: Record<string, unknown> }
  | { type: "SESSION_STARTED"; sessionId: string; actorRef: ActorRefMap["session"] }
  | { type: "SESSION_COMPLETED"; sessionId: string; result: SessionResult }
  | { type: "SESSION_FAILED"; sessionId: string; error: Error }
  | { type: "GET_SESSION"; sessionId: string }
  | { type: "LIST_SESSIONS" }
  | { type: "SHUTDOWN" }
  | { type: "ERROR"; error: Error };

// ==============================================================================
// SESSION SUPERVISOR EVENTS
// ==============================================================================

/**
 * Events for SessionSupervisor XState machine
 */
export type SessionSupervisorEvent =
  | { type: "START_EXECUTION"; plan?: ExecutionPlan }
  | { type: "PLAN_CREATED"; plan: ExecutionPlan }
  | { type: "AGENT_STARTED"; agentId: string; actorRef: ActorRefMap["agent"] }
  | { type: "AGENT_COMPLETED"; agentId: string; result: AgentResult }
  | { type: "AGENT_FAILED"; agentId: string; error: Error }
  | { type: "ABORT"; reason?: string }
  | { type: "TIMEOUT" }
  | { type: "ERROR"; error: Error };

// ==============================================================================
// AGENT EXECUTION EVENTS
// ==============================================================================

/**
 * Events for AgentExecution XState machine (if using XState)
 * Note: Current implementation uses plain class, but this is provided
 * for future XState migration
 */
export type AgentExecutionEvent =
  | { type: "EXECUTE"; taskId: string; payload: unknown }
  | { type: "TOOL_CALL"; toolName: string; params: unknown }
  | { type: "TOOL_RESULT"; toolName: string; result: unknown }
  | { type: "COMPLETION"; result: unknown }
  | { type: "ERROR"; error: Error }
  | { type: "TIMEOUT" }
  | { type: "ABORT" };

// ==============================================================================
// WORKSPACE RUNTIME EVENTS
// ==============================================================================

/**
 * Events for WorkspaceRuntime XState machine
 * Already defined in workspace-runtime-machine.ts but included here for reference
 */
export type WorkspaceRuntimeEvent =
  | { type: "INITIALIZE" }
  | {
    type: "PROCESS_SIGNAL";
    signal: unknown;
    payload: Record<string, unknown>;
    sessionId?: string;
    traceHeaders?: Record<string, string>;
  }
  | { type: "SESSION_CREATED"; sessionId: string }
  | { type: "SESSION_COMPLETED"; sessionId: string; result?: Record<string, unknown> }
  | { type: "SESSION_FAILED"; sessionId: string; error: string }
  | { type: "SHUTDOWN" }
  | { type: "ERROR"; error: Error }
  | { type: "STORE_SESSION_RESULT"; sessionId: string; result: unknown };

// ==============================================================================
// EVENT TYPE GUARDS
// ==============================================================================

/**
 * Type guard for error events
 */
export function isErrorEvent(event: unknown): event is { type: "ERROR"; error: Error } {
  return typeof event === "object" &&
    event !== null &&
    "type" in event &&
    event.type === "ERROR" &&
    "error" in event;
}

/**
 * Type guard for shutdown events
 */
export function isShutdownEvent(event: unknown): event is { type: "SHUTDOWN" } {
  return typeof event === "object" &&
    event !== null &&
    "type" in event &&
    event.type === "SHUTDOWN";
}

/**
 * Type guard for abort events
 */
export function isAbortEvent(event: unknown): event is { type: "ABORT"; reason?: string } {
  return typeof event === "object" &&
    event !== null &&
    "type" in event &&
    event.type === "ABORT";
}
