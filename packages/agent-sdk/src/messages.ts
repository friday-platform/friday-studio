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
import { normalizeToUIMessages } from "./normalize-to-ui-messages.ts";
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
  "tool-timing": z.object({ toolCallId: z.string(), durationMs: z.number() }),
  "outline-update": z.object({
    id: z.string(),
    title: z.string(),
    timestamp: z.number(),
    icon: z.string().optional(),
    content: z.string().optional(),
    artifactId: z.string().optional(),
    artifactLabel: z.string().optional(),
  }),
  "credential-linked": z.object({ provider: z.string(), displayName: z.string() }),
  "integration-disconnected": z.object({
    integrations: z.array(
      z.object({
        serverId: z.string(),
        provider: z.string().optional(),
        kind: z.enum([
          "credential_not_found",
          "credential_expired",
          "credential_refresh_failed",
          "no_default_credential",
        ]),
        message: z.string(),
      }),
    ),
  }),
  intent: z.object({ content: z.string() }),
  "artifact-attached": z.object({
    artifactIds: z.array(z.string()),
    filenames: z.array(z.string()),
    mimeTypes: z.array(z.string()).optional(),
  }),
  /** Forwarded tool call from an inner (sub-agent) execution */
  "inner-tool-call": z.object({
    toolName: z.string(),
    status: z.enum(["started", "completed", "failed"]),
    input: z.string().optional(),
    result: z.string().optional(),
  }),
  /**
   * Envelope-wrapped chunk from a delegate sub-agent's stream. `chunk` is
   * either a namespaced AI SDK `UIMessageChunk` or a synthetic
   * `{ type: "delegate-end", pendingToolCallIds: string[] }` terminator —
   * left as `unknown` to avoid duplicating the entire `UIMessageChunk` tagged
   * union here.
   */
  "delegate-chunk": z.object({ delegateToolCallId: z.string(), chunk: z.unknown() }),
  /**
   * Envelope-wrapped chunk from a nested child tool call's stream. `chunk` is
   * a namespaced AI SDK `UIMessageChunk` — left as `unknown` to avoid
   * duplicating the entire `UIMessageChunk` tagged union here.
   */
  "nested-chunk": z.object({ parentToolCallId: z.string(), chunk: z.unknown() }),
  /** Final ledger of tools used during a delegate sub-agent run. */
  "delegate-ledger": z.object({
    delegateToolCallId: z.string(),
    toolsUsed: z.array(
      z.object({
        toolCallId: z.string(),
        name: z.string(),
        input: z.unknown(),
        outcome: z.enum(["success", "error"]),
        summary: z.string().optional(),
        stepIndex: z.number(),
        durationMs: z.number(),
      }),
    ),
  }),
  "action-summary": z.object({ summary: z.string() }),
  // Adapter write events — leapfrog #3 (observable mutations)
  "memory-write": z.object({
    workspaceId: z.string(),
    store: z.string(),
    entryId: z.string(),
    kind: z.literal("narrative"),
    at: z.string(),
  }),
  "memory-rollback": z.object({
    workspaceId: z.string(),
    store: z.string(),
    toVersion: z.string(),
    at: z.string(),
  }),
  "scratchpad-write": z.object({
    sessionKey: z.string(),
    chunkId: z.string(),
    kind: z.string(),
    at: z.string(),
  }),
  "skill-write": z.object({
    workspaceId: z.string(),
    name: z.string(),
    version: z.string(),
    at: z.string(),
  }),
  "skill-rollback": z.object({
    workspaceId: z.string(),
    name: z.string(),
    toVersion: z.string(),
    at: z.string(),
  }),
  // Emitted by the load-time linter when a skill is loaded with quality issues.
  // Non-fatal — the skill still loads, but consumers (e.g. the Context tab)
  // can surface warnings inline.
  "skill-lint-warning": z.object({
    skillId: z.string(),
    namespace: z.string(),
    name: z.string(),
    warnings: z.array(
      z.object({
        rule: z.string(),
        message: z.string(),
        severity: z.enum(["info", "warn", "error"]).default("warn"),
      }),
    ),
  }),
};

// ── Standalone event schemas with type discriminant (leapfrog #3) ───────────

export const MemoryWriteEventSchema = z.object({
  type: z.literal("memory-write"),
  workspaceId: z.string(),
  store: z.string(),
  entryId: z.string(),
  kind: z.literal("narrative"),
  at: z.string(),
});

export const MemoryRollbackEventSchema = z.object({
  type: z.literal("memory-rollback"),
  workspaceId: z.string(),
  store: z.string(),
  toVersion: z.string(),
  at: z.string(),
});

export const ScratchpadWriteEventSchema = z.object({
  type: z.literal("scratchpad-write"),
  sessionKey: z.string(),
  chunkId: z.string(),
  kind: z.string(),
  at: z.string(),
});

export const SkillWriteEventSchema = z.object({
  type: z.literal("skill-write"),
  workspaceId: z.string(),
  name: z.string(),
  version: z.string(),
  at: z.string(),
});

export const SkillRollbackEventSchema = z.object({
  type: z.literal("skill-rollback"),
  workspaceId: z.string(),
  name: z.string(),
  toVersion: z.string(),
  at: z.string(),
});

export const AtlasDataEventSchema = z.discriminatedUnion("type", [
  MemoryWriteEventSchema,
  MemoryRollbackEventSchema,
  ScratchpadWriteEventSchema,
  SkillWriteEventSchema,
  SkillRollbackEventSchema,
]);

export type AtlasDataEvent = z.infer<typeof AtlasDataEventSchema>;

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
  "tool-timing": z.infer<(typeof AtlasDataEventSchemas)["tool-timing"]>;
  "outline-update": z.infer<(typeof AtlasDataEventSchemas)["outline-update"]>;
  "fsm-state-transition": z.infer<(typeof AtlasDataEventSchemas)["fsm-state-transition"]>;
  "fsm-action-execution": z.infer<(typeof AtlasDataEventSchemas)["fsm-action-execution"]>;
  "credential-linked": z.infer<(typeof AtlasDataEventSchemas)["credential-linked"]>;
  "integration-disconnected": z.infer<(typeof AtlasDataEventSchemas)["integration-disconnected"]>;
  intent: z.infer<(typeof AtlasDataEventSchemas)["intent"]>;
  "artifact-attached": z.infer<(typeof AtlasDataEventSchemas)["artifact-attached"]>;
  "inner-tool-call": z.infer<(typeof AtlasDataEventSchemas)["inner-tool-call"]>;
  "delegate-chunk": z.infer<(typeof AtlasDataEventSchemas)["delegate-chunk"]>;
  "delegate-ledger": z.infer<(typeof AtlasDataEventSchemas)["delegate-ledger"]>;
  "nested-chunk": z.infer<(typeof AtlasDataEventSchemas)["nested-chunk"]>;
  "action-summary": z.infer<(typeof AtlasDataEventSchemas)["action-summary"]>;
  "memory-write": z.infer<(typeof AtlasDataEventSchemas)["memory-write"]>;
  "memory-rollback": z.infer<(typeof AtlasDataEventSchemas)["memory-rollback"]>;
  "scratchpad-write": z.infer<(typeof AtlasDataEventSchemas)["scratchpad-write"]>;
  "skill-write": z.infer<(typeof AtlasDataEventSchemas)["skill-write"]>;
  "skill-rollback": z.infer<(typeof AtlasDataEventSchemas)["skill-rollback"]>;
  "skill-lint-warning": z.infer<(typeof AtlasDataEventSchemas)["skill-lint-warning"]>;
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

  // Normalize each element — plain strings become user UIMessages, single
  // objects get wrapped in arrays, arrays are passed through. This makes
  // callers like `validateAtlasUIMessages([message])` tolerate plain strings
  // sent by curl / external clients without crashing validateUIMessages.
  const normalized = messages.flatMap((m) => normalizeToUIMessages(m));
  if (normalized.length === 0) {
    return [];
  }

  // AI SDK v6 rejects messages with empty parts arrays. Filter them out
  // rather than failing — tool-call-only responses can produce assistant
  // messages with parts: [] before text content arrives.
  const hasEmptyParts = z.object({ parts: z.array(z.unknown()).max(0) });
  const nonEmpty = normalized.filter((m) => !hasEmptyParts.safeParse(m).success);
  if (nonEmpty.length === 0) {
    return [];
  }

  // Normalize: auto-assign id to messages missing one (defense-in-depth for
  // clients that omit UIMessage.id — the AI SDK requires it).
  const withIds = nonEmpty.map((m) => {
    if (typeof m !== "object" || m === null) return m;
    if ("id" in m && typeof m.id === "string" && m.id.length > 0) return m;
    return { ...m, id: crypto.randomUUID() };
  });

  const validated = await validateUIMessages<AtlasUIMessage>({
    messages: withIds,
    metadataSchema: MessageMetadataSchema.optional(),
    dataSchemas: AtlasDataEventSchemas,
  });

  // The AI SDK validates metadata but discards the parsed result, so unknown
  // keys (e.g. `part` carrying the full Anthropic request body) survive
  // validation and persist across turns via mergeObjects. Strip them here.
  return validated.map((m) => {
    if (m.metadata == null) return m;
    const parsed = MessageMetadataSchema.safeParse(m.metadata);
    return parsed.success ? { ...m, metadata: parsed.data } : m;
  });
}

export const MessageMetadataSchema = z.object({
  agentId: z.string().optional(),
  // FSM job name that produced the message. Powers the Context tab's
  // "Active agent + job" display. Outermost wins — nested sub-agent calls
  // surface via tool-progress events instead.
  jobName: z.string().optional(),
  sessionId: z.string().optional(),
  timestamp: z.iso.datetime().optional(),
  startTimestamp: z.iso.datetime().optional(),
  endTimestamp: z.iso.datetime().optional(),
  // Which model produced this message. Recorded so subsequent turns can
  // decide whether to replay model-specific parts (e.g. `reasoning`) back
  // to the LLM — safe only when the current model matches what emitted
  // them, otherwise providers may reject the payload.
  provider: z.string().optional(),
  modelId: z.string().optional(),
});

export type MessageMetadata = z.infer<typeof MessageMetadataSchema>;

export type AtlasUIMessage = UIMessage<MessageMetadata, AtlasDataEvents>;
export type AtlasUIMessageChunk = UIMessageChunk<MessageMetadata, AtlasDataEvents>;
export type AtlasUIMessagePart = UIMessagePart<AtlasDataEvents, InferUITools<AtlasTools>>;
