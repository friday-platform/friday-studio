/**
 * Core type definitions for the FSM Engine
 */

import type { AgentResult, AtlasUIMessageChunk, ToolCall, ToolResult } from "@atlas/agent-sdk";

// Re-export ToolCall and ToolResult for FSM event consumers
export type { ToolCall, ToolResult };

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
  /**
   * Step-level skill allowlist. Narrows which skills this LLM action can
   * `load_skill`. See `LLMActionSchema.skills` in schema.ts for full semantics
   * (undefined ⇒ inherit, [] ⇒ opt-out, populated ⇒ whitelist).
   */
  skills?: string[];
  /**
   * Short human-readable summary of what this action does. See
   * `LLMActionSchema.summary` in schema.ts.
   */
  summary?: string;
  /**
   * Advisory marker preserved for back-compat with workspaces authored
   * when the validation classifier consumed it. Currently a no-op.
   */
  run_code?: { readOnly: boolean };
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
  /** Per-step task instructions. Concatenated after the workspace agent's config prompt. */
  prompt?: string;
  /**
   * Step-level skill allowlist. See `AgentActionSchema.skills` in schema.ts.
   */
  skills?: string[];
  /**
   * Short human-readable summary of what this action does. See
   * `LLMActionSchema.summary` in schema.ts.
   */
  summary?: string;
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
  /**
   * Structured input from the triggering signal or a preceding prepare result.
   * - `task` / `config` are the canonical fields populated by every signal.
   * - `body` / `headers` are populated only by webhook-triggered signals (the
   *   tunnel forwards them byte-for-byte from the upstream HTTP request so an
   *   agent can verify HMAC against the exact bytes the upstream signed).
   *   `body` is base64-encoded; the agent decodes back to bytes for HMAC.
   *   `headers` keys are lowercased.
   */
  input?: {
    task?: string;
    config?: Record<string, unknown>;
    body?: string;
    headers?: Record<string, string>;
  };
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
  /**
   * Base64-encoded original webhook request body. Set only when the signal
   * was triggered by an inbound HTTP webhook routed through Friday's
   * webhook-tunnel. Workspace agents read this (decoded to bytes) to verify
   * HMAC signatures against the exact bytes the upstream signed. Absent for
   * cron / chat / system / FSM-emitted signals.
   */
  body?: string;
  /**
   * Original webhook request headers (lowercased keys, single value per key).
   * Set only for webhook-triggered signals. Used by workspace agents to read
   * signature headers (`x-hub-signature-256`, etc.) and event-type headers.
   */
  headers?: Record<string, string>;
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
      // Optional: success-path actions populate this with the structured
      // `complete` args (or LLM text fallback). Failure-path early-captures
      // (mid-action throws like "did not call complete") set toolCalls
      // without an output, since the action never reached the point where
      // an output is contracted.
      output?: unknown;
      /**
       * Per-call LLM token usage. Optional; non-LLM (agent) paths leave this
       * absent. See
       * `@atlas/core/session-events` `StepUsageSchema` for the on-the-wire
       * shape.
       */
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        model?: string;
      };
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
    /**
     * Delegation depth at this signal's frame.
     * `0` (or unset) means the FSM is running at the user-facing top level.
     * Each `delegate` tool invocation increments this on the child's
     * synthetic signal context, so depth-cap enforcement can read a single
     * counter regardless of how the child is invoked.
     */
    delegationDepth?: number;
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

export interface LLMProvider {
  call(params: {
    /** Synthetic agent ID for the LLM action (e.g., "fsm:job-name:output-doc") */
    agentId: string;
    /** Registry provider key (e.g., "anthropic") from workspace YAML */
    provider?: string;
    model: string;
    /**
     * Static instruction surface — the byte-stable portion of the prompt
     * that should sit at the cacheable prefix position. The adapter places
     * this in a system message with a 1h ephemeral cache_control marker
     * for Anthropic; for other providers it rides as a plain system
     * message and the provider's automatic prefix cache decides what to
     * cache. Pair with `messages` (or `prompt` for back-compat) for the
     * volatile turn-local content that must NOT poison the cached prefix.
     */
    system?: string;
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
