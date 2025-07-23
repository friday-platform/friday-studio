/**
 * Core types for the reasoning machine
 */

import { Tool, ToolCallUnion } from "ai";

/**
 * Base reasoning context that all reasoning contexts must extend.
 * Ensures all reasoning contexts have common identity fields.
 */
export interface BaseReasoningContext {
  // Identity fields - every reasoning context needs these
  sessionId: string;
  workspaceId: string;
  tools: Record<string, Tool>;

  // Allow additional fields for flexibility
  [key: string]: unknown;
}

// User context for session-based reasoning
export interface SessionReasoningContext extends BaseReasoningContext {
  signal: {
    id: string;
    [key: string]: unknown;
  };
  payload: Record<string, unknown>;
  availableAgents: Array<{
    id: string;
    name: string;
    purpose: string;
    type: "system" | "llm" | "remote";
    config: Record<string, unknown>;
  }>;
  maxIterations: number;
  timeLimit: number;
}

export interface ReasoningAction {
  type: "agent_call" | "tool_call" | "complete";
  agentId?: string;
  toolName?: string;
  parameters: Record<string, unknown>;
  reasoning: string;
  toolCallId?: string;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

export interface ReasoningStep {
  iteration: number;
  thinking: ReasoningThinking;
  action: ReasoningAction | null;
  observation: string;
  result?: unknown;
  confidence: number;
  timestamp: number;
  llmUsage?: LLMUsage;
  isComplete: boolean;
}

export interface ReasoningThinking {
  text: string;
  toolCalls: ToolCallUnion<Record<string, Tool>>[];
}

export interface ReasoningCompletion {
  isComplete: boolean;
  thinking: ReasoningThinking;
  confidence: number;
  usage?: LLMUsage;
}

export interface ReasoningContext<TUserContext extends BaseReasoningContext> {
  // User-provided context
  userContext: TUserContext;

  // Standard reasoning state
  currentStep: ReasoningStep | null;
  steps: ReasoningStep[];
  workingMemory: Map<string, unknown>;
  maxIterations: number;
  currentIteration: number;
}

export interface ReasoningCallbacks<
  TUserContext extends BaseReasoningContext,
> {
  // Required: Generate thinking based on current state
  think: (
    context: ReasoningContext<TUserContext>,
  ) => Promise<ReasoningCompletion>;

  // Required: Parse action from thinking
  parseAction: (thinking: ReasoningThinking) => ReasoningAction | null;

  // Required: Execute the parsed action
  executeAction: (
    action: ReasoningAction,
    context: ReasoningContext<TUserContext>,
  ) => Promise<ReasoningExecutionResult>;

  // Optional: Evaluate if the goal is achieved
  evaluate?: (
    context: ReasoningContext<TUserContext>,
  ) => Promise<{ isComplete: boolean; usage?: LLMUsage }>;

  // Optional: Check if goal is achieved
  isComplete?: (context: ReasoningContext<TUserContext>) => boolean;

  // Optional: Format observations
  formatObservation?: (result: unknown) => string;

  // Optional: Stream reasoning updates
  onThinkingStart?: (context: TUserContext) => void;
  onThinkingUpdate?: (partialThinking: ReasoningThinking) => void;
  onActionDetermined?: (action: ReasoningAction) => void;
  onExecutionStart?: (action: ReasoningAction) => void;
  onObservation?: (observation: string) => void;
}

export interface ExecutionDetails {
  agentId?: string;
  toolName?: string;
  parameters: unknown;
  result: unknown;
  duration: number;
}

export interface ReasoningResult {
  status: "completed" | "failed" | "partial";
  reasoning: {
    steps: ReasoningStep[];
    totalIterations: number;
    finalThinking: string;
    confidence: number;
  };
  execution: {
    agentsExecuted: ExecutionDetails[];
    toolsExecuted: ExecutionDetails[];
    totalDuration: number;
  };
  jobResults: {
    goal: string;
    achieved: boolean;
    output: unknown;
    artifacts: Record<string, unknown>;
  };
  metrics: {
    agentCalls: number;
    toolCalls: number;
  };
}

export interface ReasoningExecutionResult {
  result: unknown;
  observation: string;
  usage?: LLMUsage;
}
