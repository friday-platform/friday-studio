/**
 * Task execution types for do_task.
 */

import type { DatetimeContext } from "@atlas/llm";
import type { MCPServerResult } from "../../../fsm-workspace-creator/enrichers/mcp-servers.ts";

/** A single step in an enhanced task plan. */
export interface EnhancedTaskStep {
  agentId?: string;
  /** Execution target — bundled registry key or agentId for LLM agents. */
  executionRef: string;
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

/** Forwarded tool call from an inner agent execution */
export interface InnerToolCallEvent {
  toolName: string;
  status: "started" | "completed" | "failed";
  input?: string;
  result?: string;
}

export type { DatetimeContext };
