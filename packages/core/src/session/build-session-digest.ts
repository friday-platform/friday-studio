/**
 * Transforms raw session timeline events into an agent-friendly digest format.
 *
 * This is designed for machine consumption - gives agents the actual I/O content,
 * not summaries. Agents can parse JSON - they need data to reason about.
 */

import type {
  FSMActionEvent,
  SessionHistoryEvent,
  SessionHistoryTimeline,
} from "./history-storage.ts";

// ---------------------------------------------------------------------------
// Output Types
// ---------------------------------------------------------------------------

/** Tool call paired with its result */
export interface DigestToolCall {
  /** Unique identifier for this tool call */
  toolCallId: string;
  /** Tool name (e.g., "web_search", "read_file") */
  tool: string;
  /** Tool arguments */
  args: unknown;
  /** Tool result (output or error) */
  result?: unknown;
  /** Error message if tool call failed */
  error?: string;
}

/** A step in the session execution */
export interface DigestStep {
  /** Step number (1-indexed) */
  step: number;
  /** FSM state name (e.g., "step_0") */
  state: string;
  /** Agent or action that executed this step */
  agent: string;
  /** Execution status */
  status: "completed" | "failed" | "in-progress";
  /** Duration in milliseconds */
  durationMs?: number;
  /** Task description from request document */
  task?: string;
  /** Tool calls made during this step */
  toolCalls: DigestToolCall[];
  /** Error message if step failed */
  error?: string;
  /** When the step started (ISO timestamp) */
  startedAt?: string;
  /** When the step completed (ISO timestamp) */
  completedAt?: string;
}

/** Error summary for quick debugging */
export interface DigestError {
  /** Step number where error occurred (0 for session-level) */
  step: number;
  /** Error message */
  error: string;
}

/** Input section of the digest */
export interface DigestInput {
  /** Task description (from signalPayload.intent or summary) */
  task?: string;
  /** Full signal payload for context */
  signalPayload?: unknown;
}

/** Artifact info extracted from tool results for UI display */
export interface DigestArtifact {
  /** Artifact ID */
  id: string;
  /** Artifact title */
  title?: string;
  /** Artifact type (e.g., "document", "code") */
  type?: string;
}

/**
 * Digest of a session's execution for agent/LLM consumption.
 *
 * This is the output format for `atlas session inspect <id>` and the
 * session history API. Designed to give agents everything they need
 * to understand what happened in a session: input, output, steps,
 * tool calls, and errors.
 *
 * @remarks
 * This is distinct from {@link SessionSummary} (src/types/core.ts) which
 * tracks execution counts for supervisor coordination. SessionDigest focuses
 * on actual I/O content; SessionSummary focuses on orchestration state.
 *
 * Use SessionDigest when: an agent needs to analyze/debug a session
 * Use SessionSummary when: the supervisor needs to coordinate execution
 */
export interface SessionDigest {
  /** Session ID */
  id: string;
  /** Final session status */
  status: string;
  /** Session type (task or conversation) */
  type?: "task" | "conversation";
  /** Total duration in milliseconds */
  durationMs?: number;
  /** When the session was created (ISO timestamp) */
  createdAt: string;
  /** Workspace ID */
  workspaceId: string;
  /** Session title */
  title?: string;
  /** Session summary */
  summary?: string;
  /** Parent stream ID (for task sessions spawned from conversations) */
  parentStreamId?: string;
  /** Parent title (denormalized from parent chat) */
  parentTitle?: string;

  /** Session input */
  input: DigestInput;
  /** Session output (from session-finish event, full size) */
  output?: unknown;
  /** Execution steps */
  steps: DigestStep[];
  /** Collected errors for quick debugging */
  errors: DigestError[];

  // UI-friendly extracted fields (computed from output)
  /** LLM's final text response extracted from output */
  outputContent?: string;
  /** Artifacts created during session (extracted from tool results) */
  artifacts: DigestArtifact[];
  /** Primary error message for failed sessions */
  primaryError?: string;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Build a map of executionId+toolCallId -> tool result.
 * Tool results are matched to calls by toolCallId within the same executionId.
 */
function buildToolResultMap(events: SessionHistoryEvent[]): Map<string, unknown> {
  const results = new Map<string, unknown>();

  for (const event of events) {
    if (event.type === "agent-tool-result") {
      const { executionId, toolResult } = event.data;
      const key = `${executionId}:${toolResult.toolCallId}`;
      results.set(key, toolResult.output);
    }
  }

  return results;
}

/**
 * Build a map of executionId -> tool calls with results.
 * Groups tool calls by execution and pairs them with results.
 */
function buildToolCallsByExecution(events: SessionHistoryEvent[]): Map<string, DigestToolCall[]> {
  const toolResultMap = buildToolResultMap(events);
  const byExecution = new Map<string, DigestToolCall[]>();

  for (const event of events) {
    if (event.type === "agent-tool-call") {
      const { executionId, toolCall } = event.data;
      const resultKey = `${executionId}:${toolCall.toolCallId}`;
      const result = toolResultMap.get(resultKey);

      let execTools = byExecution.get(executionId);
      if (!execTools) {
        execTools = [];
        byExecution.set(executionId, execTools);
      }
      execTools.push({
        toolCallId: toolCall.toolCallId,
        tool: toolCall.toolName,
        args: toolCall.input,
        result,
      });
    }
  }

  return byExecution;
}

/**
 * Extract task/intent from signal payload.
 * Handles different signal formats.
 */
function extractTaskFromSignalPayload(signalPayload: unknown): string | undefined {
  if (!signalPayload || typeof signalPayload !== "object") return undefined;

  const payload = signalPayload as Record<string, unknown>;

  // Task sessions: intent field
  if (typeof payload.intent === "string") {
    return payload.intent;
  }

  // FSM sessions: might have task in body
  if (payload.body && typeof payload.body === "object") {
    const body = payload.body as Record<string, unknown>;
    if (typeof body.task === "string") return body.task;
    if (typeof body.intent === "string") return body.intent;
  }

  return undefined;
}

/**
 * Group fsm-action events by state, returning the most recent execution per state.
 * Filters to agent/llm action types only.
 */
function groupActionsByState(events: SessionHistoryEvent[]): Map<string, FSMActionEvent[]> {
  // Filter to agent/llm actions only
  const workActions = events.filter(
    (e): e is FSMActionEvent =>
      e.type === "fsm-action" && (e.data.actionType === "agent" || e.data.actionType === "llm"),
  );

  // Group by state
  const byState = new Map<string, FSMActionEvent[]>();
  for (const event of workActions) {
    const state = event.data.state;
    const stateActions = byState.get(state);
    if (stateActions) {
      stateActions.push(event);
    } else {
      byState.set(state, [event]);
    }
  }

  // For each state, group by executionId and keep only the most recent execution
  const result = new Map<string, FSMActionEvent[]>();

  for (const [state, stateEvents] of byState) {
    const byExecution = new Map<string, FSMActionEvent[]>();
    for (const event of stateEvents) {
      const execId = event.context?.executionId || event.eventId;
      const execEvents = byExecution.get(execId);
      if (execEvents) {
        execEvents.push(event);
      } else {
        byExecution.set(execId, [event]);
      }
    }

    // Pick the most recent execution (latest start time)
    const executions = Array.from(byExecution.values());
    const latest = executions.sort((a, b) => {
      const aTime = a[0]?.emittedAt || "";
      const bTime = b[0]?.emittedAt || "";
      return bTime.localeCompare(aTime);
    })[0];

    if (latest) {
      result.set(state, latest);
    }
  }

  return result;
}

/**
 * Build steps array from fsm-action events.
 */
function buildSteps(
  events: SessionHistoryEvent[],
  toolCallsByExecution: Map<string, DigestToolCall[]>,
): DigestStep[] {
  const actionsByState = groupActionsByState(events);
  const steps: DigestStep[] = [];

  for (const [state, stateEvents] of actionsByState) {
    // Extract step number from state name (step_0 -> 1, step_1 -> 2, etc.)
    const stepMatch = state.match(/^step_(\d+)$/);
    if (!stepMatch) continue; // Skip non-step states (idle, completed, etc.)

    const stepNumber = Number(stepMatch[1]) + 1;

    const started = stateEvents.find((e) => e.data.status === "started");
    const completed = stateEvents.find(
      (e) => e.data.status === "completed" || e.data.status === "failed",
    );

    if (!started) continue; // Need at least a started event

    // Determine status
    let status: DigestStep["status"] = "in-progress";
    if (completed) {
      status = completed.data.status === "completed" ? "completed" : "failed";
    }

    // Get input snapshot (prefer started, fall back to completed)
    const snapshot = started.data.inputSnapshot || completed?.data.inputSnapshot;

    // Get tool calls for this execution
    const executionId = started.context?.executionId;
    const toolCalls = executionId ? toolCallsByExecution.get(executionId) || [] : [];

    steps.push({
      step: stepNumber,
      state,
      agent: started.data.actionId || started.data.jobName,
      status,
      durationMs: completed?.data.durationMs,
      task: snapshot?.task,
      toolCalls,
      error: completed?.data.error,
      startedAt: started.emittedAt,
      completedAt: completed?.emittedAt,
    });
  }

  // Sort by step number
  return steps.sort((a, b) => a.step - b.step);
}

/**
 * Collect errors from steps and session-finish event.
 */
function collectErrors(
  steps: DigestStep[],
  sessionFinishEvent: SessionHistoryEvent | undefined,
): DigestError[] {
  const errors: DigestError[] = [];

  // Errors from failed steps
  for (const step of steps) {
    if (step.error) {
      errors.push({ step: step.step, error: step.error });
    }
  }

  // Session-level failure reason
  if (sessionFinishEvent?.type === "session-finish" && sessionFinishEvent.data.failureReason) {
    errors.push({ step: 0, error: sessionFinishEvent.data.failureReason });
  }

  return errors;
}

/** Type guard for objects with specific properties */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Safely get a nested property from an unknown value */
function getNestedProp(obj: unknown, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Extract the LLM's final text response from the session output.
 * Output structure: output[].output.content (string from LLM)
 */
export function extractOutputContent(output: unknown): string | undefined {
  if (!Array.isArray(output) || output.length === 0) return undefined;

  // Get the last step's output (usually the final response)
  const lastStep = output[output.length - 1];
  const content = getNestedProp(lastStep, "output", "content");
  return typeof content === "string" ? content : undefined;
}

/**
 * Extract artifact IDs from artifacts_create tool results.
 * Parses toolResults for artifacts_create calls and extracts IDs from the response JSON.
 */
export function extractArtifacts(output: unknown): DigestArtifact[] {
  if (!Array.isArray(output)) return [];

  const artifacts: DigestArtifact[] = [];

  for (const step of output) {
    const toolResults = getNestedProp(step, "output", "toolResults");
    if (!Array.isArray(toolResults)) continue;

    for (const result of toolResults) {
      if (!isRecord(result) || result.toolName !== "artifacts_create") continue;

      // Extract artifact info from the response
      const content = getNestedProp(result, "output", "content");
      if (!Array.isArray(content)) continue;

      for (const item of content) {
        if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;

        try {
          const parsed: unknown = JSON.parse(item.text);
          if (isRecord(parsed) && typeof parsed.id === "string") {
            artifacts.push({
              id: parsed.id,
              title: typeof parsed.title === "string" ? parsed.title : undefined,
              type: typeof parsed.type === "string" ? parsed.type : undefined,
            });
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
  }

  return artifacts;
}

/**
 * Extract the primary error message for failed sessions.
 * Prefer step-level error over session-level (more specific).
 */
export function extractPrimaryError(errors: DigestError[], status: string): string | undefined {
  if (status !== "failed" || errors.length === 0) return undefined;
  const stepError = errors.find((e) => e.step > 0);
  const sessionError = errors.find((e) => e.step === 0);
  return stepError?.error ?? sessionError?.error;
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Transforms a session timeline into an agent-friendly digest format.
 *
 * The digest includes:
 * - Input: task from signalPayload.intent or summary, full signalPayload
 * - Output: from session-finish event (full size, no truncation)
 * - Steps: fsm-action events filtered to agent/llm, grouped by state
 * - Tool calls: paired agent-tool-call with agent-tool-result by executionId + toolCallId
 * - Errors: from failed steps and session-finish failureReason
 *
 * @param timeline - Session timeline with metadata and events
 * @returns SessionDigest ready for JSON serialization
 */
export function buildSessionDigest(timeline: SessionHistoryTimeline): SessionDigest {
  const { metadata, events } = timeline;

  // Find session-finish event for output and failure reason
  const sessionFinishEvent = events.find(
    (e): e is Extract<SessionHistoryEvent, { type: "session-finish" }> =>
      e.type === "session-finish",
  );

  // Build tool calls indexed by executionId
  const toolCallsByExecution = buildToolCallsByExecution(events);

  // Build steps from fsm-action events
  const steps = buildSteps(events, toolCallsByExecution);

  // Collect errors
  const errors = collectErrors(steps, sessionFinishEvent);

  // Extract task from signal payload, job description, or fall back to summary
  // Priority: signalPayload.intent (user request) > jobDescription (workflow definition) > summary
  const signalPayload = metadata.signalPayload;
  const task =
    extractTaskFromSignalPayload(signalPayload) || metadata.jobDescription || metadata.summary;

  const output = sessionFinishEvent?.data.output ?? metadata.output;

  // Extract UI-friendly fields from output
  const outputContent = extractOutputContent(output);
  const artifacts = extractArtifacts(output);
  const primaryError = extractPrimaryError(errors, metadata.status);

  return {
    id: metadata.sessionId,
    status: metadata.status,
    type: metadata.sessionType,
    durationMs: metadata.durationMs,
    createdAt: metadata.createdAt,
    workspaceId: metadata.workspaceId,
    title: metadata.title,
    summary: metadata.summary,
    parentStreamId: metadata.parentStreamId,
    parentTitle: metadata.parentTitle,

    input: { task, signalPayload },

    output,

    steps,
    errors,

    // UI-friendly extracted fields
    outputContent,
    artifacts,
    primaryError,
  };
}
