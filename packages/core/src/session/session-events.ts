/**
 * Session History v2 — Event schemas and view types.
 *
 * Defines the contract between client, server, and storage for session
 * streaming. Durable events are persisted; ephemeral chunks are streamed
 * to SSE subscribers but never stored.
 *
 * @module
 */

import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { ValidationVerdictSchema } from "@atlas/hallucination/verdict";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const SessionStatusSchema = z.enum([
  "active",
  "completed",
  "failed",
  "skipped",
  "cancelled",
  // Set on daemon startup for sessions whose events.jsonl exists but
  // metadata.json doesn't — i.e. they were mid-flight when the previous
  // daemon process died. Distinguishes "killed by restart" from "user
  // cancelled" or "platform failed".
  "interrupted",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionActionTypeSchema = z.enum(["agent", "llm"]);
export type SessionActionType = z.infer<typeof SessionActionTypeSchema>;

// ---------------------------------------------------------------------------
// ToolCallSummary
// ---------------------------------------------------------------------------

export const ToolCallSummarySchema = z.object({
  toolName: z.string(),
  args: z.unknown(),
  result: z.unknown().optional(),
  durationMs: z.number().optional(),
});
export type ToolCallSummary = z.infer<typeof ToolCallSummarySchema>;

// ---------------------------------------------------------------------------
// Durable session stream events
// ---------------------------------------------------------------------------

export const SessionStartEventSchema = z.object({
  type: z.literal("session:start"),
  sessionId: z.string(),
  workspaceId: z.string(),
  jobName: z.string(),
  task: z.string(),
  plannedSteps: z
    .array(
      z.object({
        agentName: z.string(),
        stateId: z.string().optional(),
        task: z.string(),
        actionType: SessionActionTypeSchema,
      }),
    )
    .optional(),
  timestamp: z.string(),
});
export type SessionStartEvent = z.infer<typeof SessionStartEventSchema>;

export const StepStartEventSchema = z.object({
  type: z.literal("step:start"),
  sessionId: z.string(),
  stepNumber: z.number(),
  agentName: z.string(),
  /** FSM state identifier — stable key for joining to job agent definitions */
  stateId: z.string().optional(),
  actionType: SessionActionTypeSchema,
  task: z.string(),
  /** Input context from prepare function (accumulated results from prior steps) */
  input: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string(),
});
export type StepStartEvent = z.infer<typeof StepStartEventSchema>;

export const StepCompleteEventSchema = z.object({
  type: z.literal("step:complete"),
  sessionId: z.string(),
  stepNumber: z.number(),
  status: z.enum(["completed", "failed"]),
  durationMs: z.number(),
  toolCalls: z.array(ToolCallSummarySchema),
  reasoning: z.string().optional(),
  output: z.unknown(),
  artifactRefs: z.array(z.unknown()).optional(),
  error: z.string().optional(),
  timestamp: z.string(),
});
export type StepCompleteEvent = z.infer<typeof StepCompleteEventSchema>;

export const StepSkippedEventSchema = z.object({
  type: z.literal("step:skipped"),
  sessionId: z.string(),
  stateId: z.string(),
  timestamp: z.string(),
});
export type StepSkippedEvent = z.infer<typeof StepSkippedEventSchema>;

export const SessionCompleteEventSchema = z.object({
  type: z.literal("session:complete"),
  sessionId: z.string(),
  status: SessionStatusSchema,
  durationMs: z.number(),
  error: z.string().optional(),
  timestamp: z.string(),
});
export type SessionCompleteEvent = z.infer<typeof SessionCompleteEventSchema>;

/**
 * One LLM-output validation attempt's lifecycle event for the session stream.
 *
 * Mirrors `FSMValidationAttemptEvent` from @atlas/fsm-engine: each attempt emits
 * one `running` event before the judge call and one terminal event (`passed` or
 * `failed`) after. `terminal` is present only on `failed` events — `false` for
 * the first failure (a retry follows), `true` for the second failure (the action
 * throws). `verdict` is present on terminal events; absent on `running`.
 *
 * `actionId` mirrors the parent action event's identifier so clients can render
 * pills inline with that action's tool calls — no new identifier is introduced.
 */
export const StepValidationEventSchema = z.object({
  type: z.literal("step:validation"),
  sessionId: z.string(),
  actionId: z.string(),
  attempt: z.number().int().positive(),
  status: z.enum(["running", "passed", "failed"]),
  terminal: z.boolean().optional(),
  verdict: ValidationVerdictSchema.optional(),
  timestamp: z.string(),
});
export type StepValidationEvent = z.infer<typeof StepValidationEventSchema>;

export const SessionSummaryEventSchema = z.object({
  type: z.literal("session:summary"),
  timestamp: z.string(),
  summary: z.string(),
  keyDetails: z.array(
    z.object({ label: z.string(), value: z.string(), url: z.string().optional() }),
  ),
});
export type SessionSummaryEvent = z.infer<typeof SessionSummaryEventSchema>;

export const SessionStreamEventSchema = z.discriminatedUnion("type", [
  SessionStartEventSchema,
  StepStartEventSchema,
  StepCompleteEventSchema,
  StepSkippedEventSchema,
  StepValidationEventSchema,
  SessionCompleteEventSchema,
  SessionSummaryEventSchema,
]);
export type SessionStreamEvent = z.infer<typeof SessionStreamEventSchema>;

// ---------------------------------------------------------------------------
// Ephemeral (not persisted)
// ---------------------------------------------------------------------------

export const EphemeralChunkSchema = z.object({
  // Optional: bundled-agent chunks carry the FSM step they belong to so the
  // reducer can attach UI deltas to the right block. User-agent SDKs publish
  // without it (the agent subprocess doesn't know its FSM step) — the reducer
  // falls back to the currently-running block.
  stepNumber: z.number().optional(),
  chunk: z.custom<AtlasUIMessageChunk>((val) => val != null && typeof val === "object"),
});
export type EphemeralChunk = z.infer<typeof EphemeralChunkSchema>;

// ---------------------------------------------------------------------------
// AI Summary (structured output from generateObject)
// ---------------------------------------------------------------------------

export const SessionAISummarySchema = z.object({
  summary: z
    .string()
    .describe("1-2 sentence summary of what happened, grounded in the job's intent"),
  keyDetails: z
    .array(
      z.object({
        label: z.string().describe("Short label: 'Notion Page', 'Tickets Found'"),
        value: z.string().describe("The detail value"),
        url: z.string().optional().describe("Clickable URL if the detail is linkable"),
      }),
    )
    .describe(
      "Actionable deliverables the user needs to access. Only include items the user would click or copy — links, counts, names. Omit raw IDs, job status, and anything already visible in the session metadata. Empty for failures.",
    ),
});
export type SessionAISummary = z.infer<typeof SessionAISummarySchema>;

// ---------------------------------------------------------------------------
// Reducer output / JSON endpoint response
// ---------------------------------------------------------------------------

export const AgentBlockSchema = z.object({
  stepNumber: z.number().optional(),
  agentName: z.string(),
  /** FSM state identifier — stable key for joining to job agent definitions */
  stateId: z.string().optional(),
  actionType: SessionActionTypeSchema,
  task: z.string(),
  /** Input context from prepare function (accumulated results from prior steps) */
  input: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
  /** Timestamp when step:start fired — enables waterfall timeline positioning */
  startedAt: z.string().optional(),
  durationMs: z.number().optional(),
  toolCalls: z.array(ToolCallSummarySchema),
  reasoning: z.string().optional(),
  output: z.unknown(),
  artifactRefs: z.array(z.unknown()).optional(),
  error: z.string().optional(),
  ephemeral: z.array(z.custom<AtlasUIMessageChunk>(() => true)).optional(),
});
export type AgentBlock = z.infer<typeof AgentBlockSchema>;

export const SessionViewSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  jobName: z.string(),
  task: z.string(),
  status: SessionStatusSchema,
  startedAt: z.string(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  agentBlocks: z.array(AgentBlockSchema),
  /** Per-agent structured results keyed by agentName (from complete tool args) */
  results: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  /** AI-generated summary produced at session finalization */
  aiSummary: SessionAISummarySchema.optional(),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

// ---------------------------------------------------------------------------
// List endpoint summary
// ---------------------------------------------------------------------------

export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  jobName: z.string(),
  task: z.string(),
  status: SessionStatusSchema,
  startedAt: z.string(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  stepCount: z.number(),
  agentNames: z.array(z.string()),
  error: z.string().optional(),
  /** AI-generated summary produced at session finalization */
  aiSummary: SessionAISummarySchema.optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
