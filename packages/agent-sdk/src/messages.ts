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
  "session-start": z.object({
    sessionId: z.string(),
    signalId: z.string(),
    workspaceId: z.string(),
  }),
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
  "agent-timeout": z.object({
    agentId: z.string(),
    task: z.string(),
    duration: z.number(),
    error: z.string(),
  }),
  error: z.object({ error: z.string(), errorCause: z.unknown() }),
  "user-message": z.object({ content: z.string() }),
  "tool-progress": z.object({ toolName: z.string(), content: z.string() }),
  "outline-update": z.object({
    id: z.string(),
    title: z.string(),
    timestamp: z.number(),
    icon: z.string().optional(),
    content: z.string().optional(),
    artifactId: z.string().optional(),
    artifactLabel: z.string().optional(),
  }),
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
  return await validateUIMessages({
    messages,
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
