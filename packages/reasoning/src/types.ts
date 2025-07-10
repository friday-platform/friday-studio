/**
 * Core types for the reasoning machine
 */

export interface ReasoningAction {
  type: "agent_call" | "tool_call" | "complete";
  agentId?: string;
  toolName?: string;
  parameters: Record<string, unknown>;
  reasoning: string;
}

export interface ReasoningStep {
  iteration: number;
  thinking: string;
  action: ReasoningAction | null;
  observation: string;
  result?: any;
  confidence: number;
  timestamp: number;
}

export interface ReasoningContext<TUserContext = any> {
  // User-provided context
  userContext: TUserContext;

  // Standard reasoning state
  currentStep: ReasoningStep | null;
  steps: ReasoningStep[];
  workingMemory: Map<string, any>;
  maxIterations: number;
  currentIteration: number;
}

export interface ReasoningCallbacks<TUserContext = any> {
  // Required: Generate thinking based on current state
  think: (context: ReasoningContext<TUserContext>) => Promise<{
    thinking: string;
    confidence: number;
  }>;

  // Required: Parse action from thinking
  parseAction: (thinking: string) => ReasoningAction | null;

  // Required: Execute the parsed action
  executeAction: (action: ReasoningAction, context: ReasoningContext<TUserContext>) => Promise<{
    result: any;
    observation: string;
  }>;

  // Optional: Check if goal is achieved
  isComplete?: (context: ReasoningContext<TUserContext>) => boolean;

  // Optional: Format observations
  formatObservation?: (result: any) => string;

  // Optional: Stream reasoning updates
  onThinkingStart?: (context: TUserContext) => void;
  onThinkingUpdate?: (partialThinking: string) => void;
  onActionDetermined?: (action: ReasoningAction) => void;
  onExecutionStart?: (action: ReasoningAction) => void;
  onObservation?: (observation: string) => void;
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
    agentsExecuted: Array<{
      agentId: string;
      task: string;
      result: any;
      duration: number;
    }>;
    toolsExecuted: Array<{
      toolName: string;
      parameters: any;
      result: any;
      duration: number;
    }>;
    totalDuration: number;
  };
  jobResults: {
    goal: string;
    achieved: boolean;
    output: any;
    artifacts: Record<string, any>;
  };
  metrics: {
    llmTokens: number;
    llmCost: number;
    agentCalls: number;
    toolCalls: number;
  };
}
