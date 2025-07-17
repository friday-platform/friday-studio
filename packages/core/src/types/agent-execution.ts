/**
 * Agent Execution Types
 *
 * Defines the payload and result types for agent execution,
 * replacing the missing types/messages.ts import.
 */

import { z } from "zod/v4";

// ==============================================================================
// AGENT EXECUTE PAYLOAD
// ==============================================================================

/**
 * Simplified payload schema that matches actual usage patterns
 * Uses consistent camelCase naming and groups optional fields
 */
export const AgentExecutePayloadSchema = z.object({
  agentId: z.string().describe("The ID of the agent to execute"),
  input: z.unknown().describe("Input data for the agent"),
  sessionContext: z.object({
    sessionId: z.string().describe("The session ID this execution belongs to"),
    workspaceId: z.string().describe("The workspace ID"),
    task: z.string().optional().describe("Optional task description"),
    reasoning: z.string().optional().describe("Optional reasoning from supervisor"),
  }).describe("Session context for the execution"),
});

export type AgentExecutePayload = z.infer<typeof AgentExecutePayloadSchema>;

// ==============================================================================
// AGENT EXECUTION RESULT
// ==============================================================================

/**
 * Result type for agent execution
 * Provides consistent structure for all agent types
 */
export interface AgentExecutionResult {
  output: unknown;
  duration: number;
  metadata?: {
    tokensUsed?: number;
    cost?: number;
    toolCalls?: unknown[];
    model?: string;
    provider?: string;
  };
  /** Tool calls made during execution (if agent supports tools) */
  toolCalls?: unknown[];
  /** Results from tool executions (if agent supports tools) */
  toolResults?: unknown[];
}

// ==============================================================================
// AGENT TASK DEFINITION
// ==============================================================================

/**
 * Task definition from execution plan
 * Used by SessionSupervisor when orchestrating agents
 */
export interface AgentTask {
  agentId: string;
  task: string;
  reasoning?: string;
  dependencies?: string[];
  order?: number;
  inputSource?: string;
}

// ==============================================================================
// TOOL EXECUTION RESULT
// ==============================================================================

/**
 * Result type for tool execution
 * Used by SessionSupervisor when executing tools in reasoning flow
 */
export interface ToolExecutorResult {
  success: boolean;
  result: string;
  duration: number;
}

// ==============================================================================
// AGENT INPUT TYPES
// ==============================================================================

/**
 * Combined input structure for agents that need access to both
 * the original signal payload and outputs from previous agents.
 *
 * Used when an agent's inputSource is set to "combined", allowing
 * the agent to see both:
 * - The initial data that triggered the session (original)
 * - Results from all agents that executed before it (previous)
 *
 * This enables agents to make decisions based on the full context
 * of the session's execution history.
 */
export interface CombinedAgentInput {
  /** The original payload from the signal that started this session */
  original: Record<string, unknown>;

  /** Array of outputs from previously executed agents in this session */
  previous: Array<{
    /** ID of the agent that produced this output */
    agentId: string;
    /** The output data from the agent */
    output: unknown;
  }>;
}

// ==============================================================================
// EXECUTION PLAN
// ==============================================================================

/**
 * Reasoning step information for execution plans
 * Captures the thinking process from the reasoning machine
 */
export interface ExecutionPlanReasoningStep {
  iteration: number;
  thinking: string;
  action: string;
  observation: string;
}

/**
 * Execution plan created by SessionSupervisor
 * Contains ordered tasks for agents
 */
export interface ExecutionPlan {
  planId: string;
  sessionId: string;
  tasks: AgentTask[];
  reasoning?: string;
  createdAt: number;
  reasoningSteps?: ExecutionPlanReasoningStep[];
}
