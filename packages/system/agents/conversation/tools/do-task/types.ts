/**
 * Task execution types for do_task.
 */

import type { MCPServerResult } from "../../../fsm-workspace-creator/enrichers/mcp-servers.ts";

/** A single step in an enhanced task plan. */
export interface EnhancedTaskStep {
  agentId?: string;
  description: string;
  executionType: "agent" | "llm";
  capabilities: string[];
  friendlyDescription?: string;
}

/** Full task plan with aggregated capabilities and MCP server configs. */
export interface EnhancedTaskPlan {
  steps: EnhancedTaskStep[];
  capabilities: string[];
  mcpServers: MCPServerResult[];
}

/**
 * Progress events emitted during task execution.
 * Discriminated union - make impossible states impossible.
 */
export type TaskProgressEvent =
  | { type: "planning" }
  | { type: "preparing"; stepCount: number }
  | { type: "step-start"; stepIndex: number; totalSteps: number; description: string }
  | { type: "step-complete"; stepIndex: number; success: boolean };

/**
 * Datetime context from client session
 */
export interface DatetimeContext {
  timezone: string;
  timestamp: string;
  localDate: string;
  localTime: string;
  timezoneOffset: string;
}

/**
 * Execution context with progress callback and cancellation.
 * Passed to FSM executor.
 */
export interface TaskExecutionContext {
  sessionId: string;
  workspaceId: string;
  streamId: string;
  userId?: string;
  daemonUrl?: string;
  datetime?: DatetimeContext;
  onProgress?: (event: TaskProgressEvent) => void;
  abortSignal?: AbortSignal;
}
