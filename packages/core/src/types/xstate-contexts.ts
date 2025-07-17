/**
 * XState Context Type Definitions
 *
 * Provides typed context interfaces for XState machines with
 * state-specific context shapes for type narrowing.
 */

import type {
  ActorRefMap,
  AgentExecutionConfig,
  SessionInfo,
  SessionSupervisorConfig,
  WorkspaceSupervisorConfig,
} from "./actors.ts";
import type { AgentExecutionResult, AgentTask, ExecutionPlan } from "./agent-execution.ts";
import type { WorkspaceAgentConfig } from "@atlas/config";

// Type alias for clarity
type AgentConfig = WorkspaceAgentConfig;

// ==============================================================================
// WORKSPACE SUPERVISOR CONTEXTS
// ==============================================================================

/**
 * Base context for WorkspaceSupervisor in idle state
 */
export interface WorkspaceSupervisorIdleContext {
  config: WorkspaceSupervisorConfig;
  activeSessions: Map<string, {
    info: SessionInfo;
    actorRef: ActorRefMap["session"];
  }>;
  lastSignalTime?: number;
  stats: {
    totalSignalsProcessed: number;
    totalSessionsCreated: number;
  };
}

/**
 * Context when processing a signal
 */
export interface WorkspaceSupervisorProcessingContext extends WorkspaceSupervisorIdleContext {
  currentSignal: unknown;
  currentPayload: Record<string, unknown>;
  processingStartTime: number;
}

/**
 * Context when in error state
 */
export interface WorkspaceSupervisorErrorContext extends WorkspaceSupervisorIdleContext {
  lastError: Error;
  errorCount: number;
  errorTime: number;
}

/**
 * Union type for all WorkspaceSupervisor contexts
 */
export type WorkspaceSupervisorContext =
  | WorkspaceSupervisorIdleContext
  | WorkspaceSupervisorProcessingContext
  | WorkspaceSupervisorErrorContext;

// ==============================================================================
// SESSION SUPERVISOR CONTEXTS
// ==============================================================================

/**
 * Base context for SessionSupervisor in idle state
 */
export interface SessionSupervisorIdleContext {
  config: SessionSupervisorConfig;
  sessionId: string;
  workspaceId: string;
  startTime: number;
}

/**
 * Context when planning execution
 */
export interface SessionSupervisorPlanningContext extends SessionSupervisorIdleContext {
  planningStartTime: number;
  signal?: unknown;
}

/**
 * Context when executing agents
 */
export interface SessionSupervisorExecutingContext extends SessionSupervisorIdleContext {
  executionPlan: ExecutionPlan;
  activeAgents: Map<string, {
    task: AgentTask;
    config: AgentConfig;
    actorRef: ActorRefMap["agent"];
    startTime: number;
  }>;
  completedAgents: Map<string, {
    task: AgentTask;
    result: AgentExecutionResult;
    duration: number;
  }>;
  executionStartTime: number;
}

/**
 * Context when completed
 */
export interface SessionSupervisorCompletedContext extends SessionSupervisorIdleContext {
  executionPlan: ExecutionPlan;
  results: Record<string, AgentExecutionResult>;
  endTime: number;
  duration: number;
}

/**
 * Context when in error state
 */
export interface SessionSupervisorErrorContext extends SessionSupervisorIdleContext {
  error: Error;
  failedAgentId?: string;
  executionPlan?: ExecutionPlan;
  partialResults?: Record<string, AgentExecutionResult>;
}

/**
 * Union type for all SessionSupervisor contexts
 */
export type SessionSupervisorContext =
  | SessionSupervisorIdleContext
  | SessionSupervisorPlanningContext
  | SessionSupervisorExecutingContext
  | SessionSupervisorCompletedContext
  | SessionSupervisorErrorContext;

// ==============================================================================
// AGENT EXECUTION CONTEXTS
// ==============================================================================

/**
 * Base context for AgentExecution in idle state
 */
export interface AgentExecutionIdleContext {
  config: AgentExecutionConfig;
  agentId: string;
  capabilities: string[];
}

/**
 * Context when executing
 */
export interface AgentExecutionExecutingContext extends AgentExecutionIdleContext {
  taskId: string;
  input: unknown;
  sessionContext: {
    sessionId: string;
    workspaceId: string;
    task?: string;
    reasoning?: string;
  };
  startTime: number;
  toolCalls?: Array<{
    toolName: string;
    params: unknown;
    result?: unknown;
  }>;
}

/**
 * Context when completed
 */
export interface AgentExecutionCompletedContext extends AgentExecutionIdleContext {
  result: AgentExecutionResult;
  duration: number;
}

/**
 * Context when in error state
 */
export interface AgentExecutionErrorContext extends AgentExecutionIdleContext {
  error: Error;
  taskId?: string;
  partialResult?: unknown;
}

/**
 * Union type for all AgentExecution contexts
 */
export type AgentExecutionContext =
  | AgentExecutionIdleContext
  | AgentExecutionExecutingContext
  | AgentExecutionCompletedContext
  | AgentExecutionErrorContext;

// ==============================================================================
// CONTEXT TYPE GUARDS
// ==============================================================================

/**
 * Type guard for WorkspaceSupervisor processing context
 */
export function isProcessingContext(
  context: WorkspaceSupervisorContext,
): context is WorkspaceSupervisorProcessingContext {
  return "currentSignal" in context && "processingStartTime" in context;
}

/**
 * Type guard for SessionSupervisor executing context
 */
export function isExecutingContext(
  context: SessionSupervisorContext,
): context is SessionSupervisorExecutingContext {
  return "executionPlan" in context && "activeAgents" in context;
}

/**
 * Type guard for error contexts
 */
export function isErrorContext(
  context: WorkspaceSupervisorContext | SessionSupervisorContext | AgentExecutionContext,
): context is
  | WorkspaceSupervisorErrorContext
  | SessionSupervisorErrorContext
  | AgentExecutionErrorContext {
  return "error" in context || "lastError" in context;
}
