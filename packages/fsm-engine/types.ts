/**
 * Core type definitions for the FSM Engine
 */

import type { AgentResult, AtlasUIMessageChunk, ToolCall, ToolResult } from "@atlas/agent-sdk";

// Re-export ToolCall and ToolResult for FSM event consumers
export type { ToolCall, ToolResult };

import type { ValidationVerdict } from "@atlas/hallucination/verdict";
import type { ModelMessage, Tool } from "ai";
import type { DocumentScope } from "../document-store/mod.ts";

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

export type Action = LLMAction | EmitAction | AgentAction | NotificationAction;

export interface LLMAction {
  type: "llm";
  provider: string;
  model: string;
  prompt: string;
  tools?: string[];
  outputTo?: string;
  /** Explicit document type name for schema lookup. Takes precedence over outputTo document's type. */
  outputType?: string;
  /** Document id(s) whose `data` becomes the LLM's task input. See AgentAction.inputFrom. */
  inputFrom?: string | string[];
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
   * Document id(s) whose `data` becomes the agent's task input. String form
   * chains a single prior step's `outputTo`; array form concatenates
   * multiple prior outputs labeled by id (`<id>: <data>` joined by blank
   * lines). The engine fails loud if any id is missing at action
   * execution time.
   */
  inputFrom?: string | string[];
}

export interface NotificationAction {
  type: "notification";
  message: string;
  /**
   * Optional allowlist of communicator kinds (e.g. "slack", "telegram").
   * When omitted, the message is broadcast to every configured communicator
   * with a `default_destination`. When provided, only the listed kinds receive
   * the message.
   */
  communicators?: string[];
}

/**
 * Structural contract the FSM engine uses to fan a notification out to chat
 * platforms. Implementations live outside fsm-engine (e.g. atlasd wraps
 * ChatSdkNotifier + broadcastDestinations) — the engine just calls broadcast.
 *
 * Per-platform delivery failures must be swallowed inside the implementation;
 * the engine treats a thrown error as a hard FSM failure.
 */
export interface FSMBroadcastNotifier {
  broadcast(args: { message: string; communicators?: string[] }): Promise<void>;
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

/**
 * Lifecycle event for a single LLM-output validation attempt.
 *
 * Each attempt emits exactly one `running` event before the judge call and
 * exactly one terminal event (`passed` or `failed`) after. `terminal` is
 * present only on `failed` events: `false` for the first failure (a retry
 * follows), `true` for the second failure (the action throws).
 *
 * actionId MUST match the actionId from the parent FSMActionExecutionEvent
 * to allow UI correlation.
 */
export interface FSMValidationAttemptEvent {
  type: "data-fsm-validation-attempt";
  data: {
    sessionId: string;
    workspaceId: string;
    jobName: string;
    actionId?: string;
    state: string;
    attempt: number;
    status: "running" | "passed" | "failed";
    /** Present on `failed` events; `true` only on terminal failure. */
    terminal?: boolean;
    /** Present on `passed` and `failed` terminal events; absent on `running`. */
    verdict?: ValidationVerdict;
    timestamp: number;
  };
}

export type FSMEvent =
  | FSMStateTransitionEvent
  | FSMActionExecutionEvent
  | FSMToolCallEvent
  | FSMToolResultEvent
  | FSMStateSkippedEvent
  | FSMValidationAttemptEvent;

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
  /** Model reasoning text (e.g., extended-thinking output), if the model produced any. */
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  model: string;
  prompt: string;
}

/**
 * Result of validating LLM output.
 * Named distinctly to avoid collision with ValidationResult in validator.ts.
 *
 * The verdict's `status` field drives retry policy: `pass` and `uncertain`
 * proceed identically to downstream steps; `fail` triggers a single retry, and
 * a second `fail` throws with the verdict attached on the error.
 */
export interface LLMOutputValidationResult {
  verdict: ValidationVerdict;
}

/**
 * Function type for validating LLM action output.
 * Returns a promise because real validators call LLMs for analysis.
 *
 * `abortSignal` lets callers cancel an in-flight judge call when a job is
 * aborted mid-validation, so doomed validations do not waste tokens.
 */
export type OutputValidator = (
  trace: LLMActionTrace,
  abortSignal?: AbortSignal,
) => Promise<LLMOutputValidationResult>;

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
