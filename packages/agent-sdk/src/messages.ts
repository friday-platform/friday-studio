/**
 * Atlas Message Types and Validation
 *
 * Consolidated data event types and message validation for Atlas UI messages.
 */

import {
  type InferUITools,
  type UIMessage,
  type UIMessageChunk,
  type UIMessagePart,
  validateUIMessages,
} from "ai";
import { z } from "zod";
import type { AtlasTools } from "./types.ts";

/**
 * Zod schemas for Atlas data events.
 * Used for runtime validation of data parts in UI messages.
 */
export const AtlasDataEventSchemas = {
  "session-start": z.object({ sessionId: z.string() }),
  "session-finish": z.object({
    sessionId: z.string(),
    workspaceId: z.string(),
    status: z.string().optional(),
    duration: z.number().optional(),
    source: z.string().optional(),
  }),
  "session-cancel": z.object({
    sessionId: z.string(),
    workspaceId: z.string(),
    reason: z.string().optional(),
  }),
  "agent-start": z.object({ agentId: z.string(), task: z.string() }),
  "agent-finish": z.object({ agentId: z.string(), duration: z.number() }),
  "agent-error": z.object({ agentId: z.string(), duration: z.number(), error: z.string() }),
  // FSM events: key without "data-" prefix since DataUIMessageChunk adds "data-" prefix
  // Result: type "fsm-state-transition" → DataUIMessageChunk type "data-fsm-state-transition"
  "fsm-state-transition": z.object({
    sessionId: z.string(),
    workspaceId: z.string(),
    jobName: z.string(),
    fromState: z.string(),
    toState: z.string(),
    triggeringSignal: z.string(),
    timestamp: z.number(),
  }),
  "fsm-action-execution": z.object({
    sessionId: z.string(),
    workspaceId: z.string(),
    jobName: z.string(),
    actionType: z.string(),
    actionId: z.string().optional(),
    state: z.string(),
    status: z.enum(["started", "completed", "failed"]),
    durationMs: z.number().optional(),
    error: z.string().optional(),
    timestamp: z.number(),
    inputSnapshot: z
      .object({
        task: z.string().optional(),
        requestDocId: z.string().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  }),
  "agent-timeout": z.object({
    agentId: z.string(),
    task: z.string(),
    duration: z.number(),
    error: z.string(),
  }),
  error: z.object({ error: z.string(), errorCause: z.unknown() }),
  "user-message": z.object({ content: z.string() }),
  "tool-progress": z.object({
    toolName: z.string(),
    content: z.string(),
    stepIndex: z.number().optional(),
    totalSteps: z.number().optional(),
  }),
  "outline-update": z.object({
    id: z.string(),
    title: z.string(),
    timestamp: z.number(),
    icon: z.string().optional(),
    content: z.string().optional(),
    artifactId: z.string().optional(),
    artifactLabel: z.string().optional(),
  }),
  "credential-linked": z.object({
    provider: z.string(), // e.g., 'google-calendar'
    displayName: z.string(), // e.g., 'Google Calendar'
  }),
  intent: z.object({
    content: z.string(), // e.g., 'Connecting to Notion', 'Creating plan'
  }),
  "artifact-attached": z.object({
    artifactIds: z.array(z.string()), // UUIDs of attached artifacts
    filenames: z.array(z.string()), // Original filenames for display
    mimeTypes: z.array(z.string()).optional(), // MIME types of attached artifacts
  }),
  /** Forwarded tool call from an inner (sub-agent) execution */
  "inner-tool-call": z.object({
    toolName: z.string(), // e.g., "search_pages"
    status: z.enum(["started", "completed", "failed"]),
    input: z.string().optional(), // Tool input/args as JSON string
    result: z.string().optional(), // Tool output as JSON string
  }),
  "action-summary": z.object({ summary: z.string() }),
};

/**
 * Atlas data events - consolidated session and user message events.
 * Used to type UI messages streamed between agents and clients.
 */
export type AtlasDataEvents = {
  "session-start": z.infer<(typeof AtlasDataEventSchemas)["session-start"]>;
  "session-finish": z.infer<(typeof AtlasDataEventSchemas)["session-finish"]>;
  "session-cancel": z.infer<(typeof AtlasDataEventSchemas)["session-cancel"]>;
  "agent-start": z.infer<(typeof AtlasDataEventSchemas)["agent-start"]>;
  "agent-finish": z.infer<(typeof AtlasDataEventSchemas)["agent-finish"]>;
  "agent-error": z.infer<(typeof AtlasDataEventSchemas)["agent-error"]>;
  "agent-timeout": z.infer<(typeof AtlasDataEventSchemas)["agent-timeout"]>;
  error: z.infer<(typeof AtlasDataEventSchemas)["error"]>;
  "user-message": z.infer<(typeof AtlasDataEventSchemas)["user-message"]>;
  "tool-progress": z.infer<(typeof AtlasDataEventSchemas)["tool-progress"]>;
  "outline-update": z.infer<(typeof AtlasDataEventSchemas)["outline-update"]>;
  // FSM events: keys match schema keys (without data- prefix)
  // DataUIMessageChunk adds "data-" prefix → final type is "data-fsm-state-transition"
  "fsm-state-transition": z.infer<(typeof AtlasDataEventSchemas)["fsm-state-transition"]>;
  "fsm-action-execution": z.infer<(typeof AtlasDataEventSchemas)["fsm-action-execution"]>;
  "credential-linked": z.infer<(typeof AtlasDataEventSchemas)["credential-linked"]>;
  intent: z.infer<(typeof AtlasDataEventSchemas)["intent"]>;
  "artifact-attached": z.infer<(typeof AtlasDataEventSchemas)["artifact-attached"]>;
  "inner-tool-call": z.infer<(typeof AtlasDataEventSchemas)["inner-tool-call"]>;
  "action-summary": z.infer<(typeof AtlasDataEventSchemas)["action-summary"]>;
};

/**
 * Validates Atlas UI messages.
 * Checks message structure, metadata, and data parts.
 */
export async function validateAtlasUIMessages(messages: unknown[]): Promise<AtlasUIMessage[]> {
  /**
   * Return early if there are no messages.
   * validateUIMessages now fails if the messages array is empty.
   * @see https://github.com/vercel/ai/commit/818b144eafffaa89329e9aa5d76f40fe9b1b7bd1
   */
  if (messages.length === 0) {
    return [];
  }

  // AI SDK v6 rejects messages with empty parts arrays. Filter them out
  // rather than failing — tool-call-only responses can produce assistant
  // messages with parts: [] before text content arrives.
  const hasEmptyParts = z.object({ parts: z.array(z.unknown()).max(0) });
  const nonEmpty = messages.filter((m) => !hasEmptyParts.safeParse(m).success);
  if (nonEmpty.length === 0) {
    return [];
  }
  return await validateUIMessages({
    messages: nonEmpty,
    metadataSchema: MessageMetadataSchema.optional(),
    dataSchemas: AtlasDataEventSchemas,
  });
}

export const MessageMetadataSchema = z.object({
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  timestamp: z.iso.datetime().optional(),
  startTimestamp: z.iso.datetime().optional(),
  endTimestamp: z.iso.datetime().optional(),
});

export type MessageMetadata = z.infer<typeof MessageMetadataSchema>;

export type AtlasUIMessage = UIMessage<MessageMetadata, AtlasDataEvents>;
export type AtlasUIMessageChunk = UIMessageChunk<MessageMetadata, AtlasDataEvents>;
export type AtlasUIMessagePart = UIMessagePart<AtlasDataEvents, InferUITools<AtlasTools>>;
