/**
 * Core type definitions for the FSM Engine
 */

import type { AgentResult, AtlasUIMessageChunk, ToolCall, ToolResult } from "@atlas/agent-sdk";

// Re-export ToolCall and ToolResult for FSM event consumers
export type { ToolCall, ToolResult };

import type { ModelMessage, Tool } from "ai";
import type { DocumentScope } from "../document-store/node.ts";

// Re-export DocumentScope for convenience
export type { DocumentScope };

export interface JSONSchema {
  [key: string]: unknown;
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JSONSchema;
  description?: string;
}

export interface FSMDefinition {
  id: string;
  initial: string;
  states: Record<string, StateDefinition>;
  documentTypes?: Record<string, JSONSchema>;
  functions?: Record<string, { type: "action" | "guard"; code: string }>;
  tools?: Record<string, { code: string }>;
}

export interface StateDefinition {
  documents?: Document[];
  entry?: Action[];
  on?: Record<string, TransitionDefinition | TransitionDefinition[]>;
  type?: "final";
}

export interface Document {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export interface TransitionDefinition {
  target: string;
  actions?: Action[];
}

export type Action = LLMAction | EmitAction | AgentAction;

export interface LLMAction {
  type: "llm";
  provider: string;
  model: string;
  prompt: string;
  tools?: string[];
  outputTo?: string;
  /** Explicit document type name for schema lookup. Takes precedence over outputTo document's type. */
  outputType?: string;
  /** Document id whose `data` becomes the LLM's task input. See AgentAction.inputFrom. */
  inputFrom?: string;
}

export interface EmitAction {
  type: "emit";
  event: string;
  data?: Record<string, unknown>;
}

export interface AgentAction {
  type: "agent";
  agentId: string;
  outputTo?: string;
  /** Explicit result type name for schema validation. */
  outputType?: string;
  /** Task instructions for the agent. Takes precedence over agent config prompt. */
  prompt?: string;
  /**
   * Document id whose `data` becomes the agent's task input. Used to chain
   * a prior step's `outputTo` into the next step without writing a
   * `prepare` action. The engine fails loud if the id is missing at
   * action execution time.
   */
  inputFrom?: string;
}

export interface Context {
  state: string;
  results: Record<string, Record<string, unknown>>;
  setResult?: (key: string, data: Record<string, unknown>) => void;
  /** Structured input from the triggering signal or a preceding prepare result */
  input?: { task?: string; config?: Record<string, unknown> };
  emit?: (signal: Signal) => Promise<void>;

  /** @deprecated Use context.results instead */
  documents: Document[];
  /** @deprecated */
  updateDoc?: (id: string, data: Record<string, unknown>) => void;
  /** @deprecated */
  createDoc?: (doc: Document) => void;
  /** @deprecated */
  deleteDoc?: (id: string) => void;
}

export interface Signal {
  type: string;
  data?: Record<string, unknown>;
}

/**
 * FSM event types for streaming state transitions and action executions
 * These match the AtlasDataEvents schema in @atlas/agent-sdk
 * Note: Uses "data-" prefix as required by Vercel AI SDK for data events
 */
export interface FSMStateTransitionEvent {
  type: "data-fsm-state-transition";
  data: {
    sessionId: string;
    workspaceId: string;
    jobName: string;
    fromState: string;
    toState: string;
    triggeringSignal: string;
    timestamp: number;
  };
}

export interface FSMActionExecutionEvent {
  type: "data-fsm-action-execution";
  data: {
    sessionId: string;
    workspaceId: string;
    jobName: string;
    actionType: string;
    actionId?: string;
    state: string;
    status: "started" | "completed" | "failed";
    durationMs?: number;
    error?: string;
    timestamp: number;
    inputSnapshot?: { task?: string; requestDocId?: string; config?: Record<string, unknown> };
    /** LLM action result data, populated on completion for session history */
    llmResult?: {
      toolCalls: Array<{ toolName: string; args: unknown }>;
      reasoning?: string;
      output: unknown;
    };
  };
}

/**
 * Tool call event emitted during LLM action execution.
 * actionId MUST match the actionId from the parent FSMActionExecutionEvent
 * to allow UI correlation.
 */
export interface FSMToolCallEvent {
  type: "data-fsm-tool-call";
  data: {
    sessionId: string;
    workspaceId: string;
    jobName: string;
    actionId?: string;
    state: string;
    toolCall: ToolCall;
    timestamp: number;
  };
}

/**
 * Tool result event emitted during LLM action execution.
 * actionId MUST match the actionId from the parent FSMActionExecutionEvent
 * to allow UI correlation.
 */
export interface FSMToolResultEvent {
  type: "data-fsm-tool-result";
  data: {
    sessionId: string;
    workspaceId: string;
    jobName: string;
    actionId?: string;
    state: string;
    toolResult: ToolResult;
    timestamp: number;
  };
}

/**
 * Emitted when a state is skipped due to `skipStates` configuration.
 * The engine chains through skipped states without executing their entry actions.
 */
export interface FSMStateSkippedEvent {
  type: "data-fsm-state-skipped";
  data: {
    sessionId: string;
    workspaceId: string;
    jobName: string;
    stateId: string;
    timestamp: number;
  };
}

export type FSMEvent =
  | FSMStateTransitionEvent
  | FSMActionExecutionEvent
  | FSMToolCallEvent
  | FSMToolResultEvent
  | FSMStateSkippedEvent;

/**
 * Signal with additional context for execution tracking and event streaming
 */
export interface SignalWithContext extends Signal {
  _context?: {
    sessionId: string;
    workspaceId: string;
    onEvent?: (event: FSMEvent) => void;
    /** Separate channel for agent UIMessageChunks (text, reasoning, tool-call, etc.) */
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void;
    abortSignal?: AbortSignal;
    /** State IDs to skip — their entry actions won't execute, engine chains through */
    skipStates?: string[];
  };
}

export interface EmittedEvent {
  event: string;
  data?: Record<string, unknown>;
}

export type FSMLLMOutput = Record<string, unknown>;

/**
 * Re-export AgentResult for FSM consumers
 */
export type { AgentResult };

/** Trace data from an LLM action for hallucination detection */
export interface LLMActionTrace {
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  model: string;
  prompt: string;
}

/**
 * Result of validating LLM output.
 * Named distinctly to avoid collision with ValidationResult in validator.ts.
 */
export interface LLMOutputValidationResult {
  /** Whether the output passed validation */
  valid: boolean;
  /** Required when valid=false - feedback for retry prompt injection */
  feedback?: string;
}

/**
 * Function type for validating LLM action output.
 * Returns a promise because real validators call LLMs for analysis.
 */
export type OutputValidator = (trace: LLMActionTrace) => Promise<LLMOutputValidationResult>;

export interface LLMProvider {
  call(params: {
    /** Synthetic agent ID for the LLM action (e.g., "fsm:job-name:output-doc") */
    agentId: string;
    /** Registry provider key (e.g., "anthropic") from workspace YAML */
    provider?: string;
    model: string;
    prompt: string;
    /** Structured messages with mixed content types (e.g., text + images). When present, used instead of prompt. */
    messages?: Array<ModelMessage>;
    tools?: Record<string, Tool>;
    toolChoice?: "auto" | "required" | "none" | { type: "tool"; toolName: string };
    /** Tool names that should trigger early stop when called successfully */
    stopOnToolCall?: string[];
    /** Provider-specific options (e.g., Anthropic thinking config) */
    providerOptions?: Record<string, unknown>;
    /** Callback for real-time streaming events (tool calls, tool results) during LLM execution */
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void;
    abortSignal?: AbortSignal;
  }): Promise<AgentResult<string, FSMLLMOutput>>;
}
