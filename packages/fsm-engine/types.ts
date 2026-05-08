/**
 * Core type definitions for the FSM Engine
 */

import type { AgentResult, AtlasUIMessageChunk, ToolCall, ToolResult } from "@atlas/agent-sdk";

// Re-export ToolCall and ToolResult for FSM event consumers
export type { ToolCall, ToolResult };

import type { ValidationVerdict } from "@atlas/hallucination/verdict";
import type { ModelMessage, Tool } from "ai";
import type { DocumentScope } from "../document-store/mod.ts";
import type { ValidateStrategy } from "./schema.ts";

// Re-export ValidateStrategy for consumers of this types module.
// Re-export DocumentScope for convenience
export type { DocumentScope, ValidateStrategy };

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
   * Per-action validation strategy. See `ValidateStrategySchema` in schema.ts
   * for full semantics. Absent or `"auto"` ⇒ runtime classifier picks `skip`
   * or `self`. The classifier never auto-resolves to `external`.
   */
  validate?: ValidateStrategy;
  /**
   * K6 (melodic-strolling-seal-pt3) — author opt-in to treat `run_code` as
   * read-only for this action. See `LLMActionSchema.run_code` in schema.ts.
   * `run_code` is excluded from the default `READ_ONLY_ALLOWLIST` because
   * it can mutate state; this knob lets a deterministic SQL `SELECT` /
   * HTTP `GET` / arithmetic transform skip self-validation. Combined with
   * `outputType:`, the action then resolves to `validate: skip`.
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
   * Per-action validation strategy — see `ValidateStrategySchema` in
   * schema.ts. Mirrors the field on LLMAction.
   */
  validate?: ValidateStrategy;
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
      /**
       * Per-call LLM token usage. Optional — pre-Phase-11 callers and
       * non-LLM (agent) paths leave this absent. See
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
      /**
       * Per-action validation outcome — present on every `type: llm` and
       * `case "agent" → type: llm` action. Three shapes mirror the resolved
       * strategy: `skip` carries `skipReason`; `self` carries the LLM's
       * `record_validation` args; `external` carries the judge-derived
       * verdict. Phase B6 of melodic-strolling-seal-pt2. See
       * `@atlas/core/session-events` `StepValidationOutputSchema` for the
       * on-the-wire shape.
       */
      validation?: {
        strategy: "skip" | "self" | "external";
        verdict?: "pass" | "advisory" | "blocking";
        issues?: Array<{
          category?: string;
          claim: string;
          reasoning?: string;
          severity?: "low" | "medium" | "high" | "info" | "warn" | "error";
          citation?: string | null;
        }>;
        skipReason?: string;
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
    /**
     * Phase 7 — delegation depth at this signal's frame.
     * `0` (or unset) means the FSM is running at the user-facing top level.
     * Each `delegate` tool invocation increments this on the child's
     * synthetic signal context, so depth-cap enforcement (Phase 8 budgets)
     * can read a single counter regardless of how the child is invoked.
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
 * One tool call's projection in the judge handoff manifest. Phase B7 of
 * melodic-strolling-seal-pt2. The runtime walks the action's
 * `traceToolResults` and builds one entry per call:
 *
 *   - `resultArtifactId` + `resultSummary` for scrubber-lifted (A2) results
 *     so the judge sees a short ref string and fetches via `artifacts_get`
 *     only for the specific claims it needs to verify.
 *   - `resultInline` otherwise — small payloads inline up to the cap.
 */
export interface JudgeToolCallEntry {
  toolName: string;
  args?: unknown;
  /** Set when the tool result was lifted to an artifact by the scrubber. */
  resultArtifactId?: string;
  /** Human-readable preview of the lifted artifact (mime / size / source). */
  resultSummary?: string;
  /** Set when the tool result was small enough to inline directly. */
  resultInline?: string;
}

/**
 * Distilled handoff the FSM engine builds for the judge agent's delegate
 * call. Refs-not-bytes: scrubber-lifted results carry only the artifact id
 * + summary, so cost scales with judgment work rather than input size.
 */
export interface JudgeHandoff {
  /** The action's input prompt — what the LLM was asked to produce. */
  actionInput: string;
  /** The action's output — the LLM's draft to be judged. */
  actionOutput: string;
  /** Per-tool-call manifest with refs for lifted artifacts and inline for small payloads. */
  toolCalls: JudgeToolCallEntry[];
}

/**
 * Function type the FSM engine calls when an action's resolved validation
 * decision is `external`. Replaces the pre-B7 `OutputValidator` hook —
 * external validation is now a delegate spawn to a system-level judge
 * agent (default `judge-agent`, overridable via `validate.agent`).
 *
 * Implementations live outside fsm-engine (workspace runtime wires this to
 * the agent orchestrator). Returns the verdict the judge emitted, or `ok:
 * false` when the delegate failed (budget exhausted, agent not found,
 * exception). The runtime synthesizes an advisory verdict on `ok: false`
 * so the action still emits.
 */
export type JudgeAgentRunner = (input: {
  /** Default `"judge-agent"`; can be overridden via `validate.agent`. */
  agentId: string;
  /** Distilled handoff the judge agent reads. */
  handoff: JudgeHandoff;
  abortSignal?: AbortSignal;
}) => Promise<{ ok: true; verdict: ValidationVerdict } | { ok: false; error: string }>;

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
