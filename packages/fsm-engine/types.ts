/**
 * Core type definitions for the FSM Engine
 */

import type { ToolCall, ToolResult } from "@atlas/agent-sdk";

// Re-export ToolCall and ToolResult for FSM event consumers
export type { ToolCall, ToolResult };

import type { DocumentScope } from "../document-store/node.ts";

// Re-export DocumentScope for convenience
export type { DocumentScope };

export interface JSONSchema {
  type?: "object" | "array" | "string" | "number" | "boolean" | "null";
  properties?: Record<string, unknown>; // Recursive, but typed as unknown for Zod compatibility
  items?: unknown; // Recursive, but typed as unknown for Zod compatibility
  required?: string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | unknown; // Recursive, but typed as unknown for Zod compatibility
  description?: string;
}

export interface FSMDefinition {
  id: string;
  initial: string;
  states: Record<string, StateDefinition>;
  functions?: Record<string, FunctionDefinition>;
  tools?: Record<string, ToolFunctionDefinition>;
  documentTypes?: Record<string, JSONSchema>;
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
  guards?: string[];
  actions?: Action[];
}

export type Action = LLMAction | CodeAction | EmitAction | AgentAction;

export interface LLMAction {
  type: "llm";
  provider: string;
  model: string;
  prompt: string;
  tools?: string[];
  outputTo?: string;
  /** Explicit document type name for schema lookup. Takes precedence over outputTo document's type. */
  outputType?: string;
}

export interface CodeAction {
  type: "code";
  function: string;
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
  /** Task instructions for the agent. Takes precedence over agent config prompt. */
  prompt?: string;
}

export interface FunctionDefinition {
  type: "guard" | "action";
  code: string;
}

export interface ToolFunctionDefinition {
  description: string;
  inputSchema: JSONSchema;
  code: string;
}

export interface Context {
  documents: Document[];
  state: string;
  emit?: (signal: Signal) => Promise<void>;
  updateDoc?: (id: string, data: Record<string, unknown>) => void;
  createDoc?: (doc: Document) => void;
  deleteDoc?: (id: string) => void;
}

export type GuardFunction = (context: Context, event: Signal) => boolean;

export type ActionFunction = (context: Context, event: Signal) => void | Promise<void>;

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

export type FSMEvent =
  | FSMStateTransitionEvent
  | FSMActionExecutionEvent
  | FSMToolCallEvent
  | FSMToolResultEvent;

/**
 * Signal with additional context for execution tracking and event streaming
 */
export interface SignalWithContext extends Signal {
  _context?: {
    sessionId: string;
    workspaceId: string;
    onEvent?: (event: FSMEvent) => void;
    abortSignal?: AbortSignal;
  };
}

export interface EmittedEvent {
  event: string;
  data?: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  data?: { toolCalls?: ToolCall[]; toolResults?: ToolResult[]; [key: string]: unknown };
  calledTool?: { name: string; args: unknown };
}

/**
 * Trace data from an LLM action, capturing what is needed for hallucination detection.
 * Uses AI SDK's native ToolCall/ToolResult types via @atlas/agent-sdk.
 */
export interface LLMActionTrace {
  /** The LLMs final output content */
  content: string;
  /** Tool calls made during execution - uses AI SDK's native format */
  toolCalls?: ToolCall[];
  /** Tool results returned - uses AI SDK's native format */
  toolResults?: ToolResult[];
  /** Model identifier used for the call */
  model: string;
  /** Full prompt including any injected document context */
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
    model: string;
    prompt: string;
    tools?: Record<string, import("ai").Tool>;
    toolChoice?: "auto" | "required" | "none";
    /** Tool names that should trigger early stop when called successfully */
    stopOnToolCall?: string[];
  }): Promise<LLMResponse>;
}
