import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import type { ToolCall, ToolResult } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import { fail, isErrnoException, type Result, stringifyError, success } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { join } from "@std/path";

import { z } from "zod";
import type { IWorkspaceSignal } from "../../../../src/types/core.ts";
import {
  ReasoningResultStatus,
  type ReasoningResultStatusType,
} from "../constants/supervisor-status.ts";
import { withExclusiveLock } from "../utils/file-lock.ts";

const logger = createLogger({ component: "session-history-storage" });

const ReasoningStatusSchema = z.union([
  z.literal(ReasoningResultStatus.COMPLETED),
  z.literal(ReasoningResultStatus.FAILED),
  z.literal(ReasoningResultStatus.PARTIAL),
  z.literal(ReasoningResultStatus.CANCELLED),
]);

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

const SessionHistorySignalProviderSchema = z.object({ id: z.string(), name: z.string() });
const SessionHistorySignalSchema = z.object({
  id: z.string(),
  provider: SessionHistorySignalProviderSchema,
  workspaceId: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type SessionHistorySignal = z.infer<typeof SessionHistorySignalSchema>;

export interface SessionHistoryEventContext {
  phaseId?: string;
  agentId?: string;
  executionId?: string;
  relatedEventId?: string;
  metadata?: Record<string, unknown>;
}

const SessionHistoryEventContextSchema = z.object({
  phaseId: z.string().optional(),
  agentId: z.string().optional(),
  executionId: z.string().optional(),
  relatedEventId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export interface SessionHistoryEventBase<TType extends SessionHistoryEventType, TData> {
  eventId: string;
  sessionId: string;
  emittedAt: string;
  emittedBy: string;
  type: TType;
  context?: SessionHistoryEventContext;
  data: TData;
}

const SessionHistoryEventBaseSchema = z.object({
  eventId: z.string(),
  sessionId: z.string(),
  emittedAt: z.string(),
  emittedBy: z.string(),
  context: SessionHistoryEventContextSchema.optional(),
});

export type SessionHistoryEventType =
  | "session-start"
  | "agent-tool-call"
  | "agent-tool-result"
  | "session-finish"
  | "fsm-action";

type SessionStartEvent = SessionHistoryEventBase<
  "session-start",
  { status: ReasoningResultStatusType; message?: string }
>;

type AgentToolCallEvent = SessionHistoryEventBase<
  "agent-tool-call",
  { agentId: string; executionId: string; toolCall: ToolCall }
>;

type AgentToolResultEvent = SessionHistoryEventBase<
  "agent-tool-result",
  { agentId: string; executionId: string; toolResult: ToolResult }
>;

type SessionFinishEvent = SessionHistoryEventBase<
  "session-finish",
  {
    status: ReasoningResultStatusType;
    durationMs: number;
    failureReason?: string;
    summary?: string;
    output?: unknown;
  }
>;

export type FSMActionEvent = SessionHistoryEventBase<
  "fsm-action",
  {
    jobName: string;
    state: string;
    actionType: "agent" | "llm" | "code" | "emit";
    actionId?: string;
    status: "started" | "completed" | "failed";
    durationMs?: number;
    error?: string;
    inputSnapshot?: { task?: string; requestDocId?: string; config?: Record<string, unknown> };
  }
>;

export type SessionHistoryEvent =
  | SessionStartEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | SessionFinishEvent
  | FSMActionEvent;

const SessionHistoryEventSchema: z.ZodType<SessionHistoryEvent> = z.discriminatedUnion("type", [
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("session-start"),
    data: z.object({ status: ReasoningStatusSchema, message: z.string().optional() }),
  }),
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("agent-tool-call"),
    data: z.object({
      agentId: z.string(),
      executionId: z.string(),
      toolCall: z.custom<ToolCall>(() => true),
    }),
  }),
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("agent-tool-result"),
    data: z.object({
      agentId: z.string(),
      executionId: z.string(),
      toolResult: z.custom<ToolResult>(() => true),
    }),
  }),
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("session-finish"),
    data: z.object({
      status: ReasoningStatusSchema,
      durationMs: z.number(),
      failureReason: z.string().optional(),
      summary: z.string().optional(),
      output: z.unknown().optional(),
    }),
  }),
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("fsm-action"),
    data: z.object({
      jobName: z.string(),
      state: z.string(),
      actionType: z.union([
        z.literal("agent"),
        z.literal("llm"),
        z.literal("code"),
        z.literal("emit"),
      ]),
      actionId: z.string().optional(),
      status: z.union([z.literal("started"), z.literal("completed"), z.literal("failed")]),
      durationMs: z.number().optional(),
      error: z.string().optional(),
      inputSnapshot: z
        .object({
          task: z.string().optional(),
          requestDocId: z.string().optional(),
          config: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    }),
  }),
]);

// Metadata-only schema (new format: no events field)
const StoredMetadataSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: ReasoningStatusSchema,
  signal: SessionHistorySignalSchema,
  signalPayload: z.unknown().optional(),
  jobSpecificationId: z.string().optional(),
  availableAgents: z.array(z.string()),
  streamId: z.string().optional(),
  artifactIds: z.array(z.string()).optional(),
  durationMs: z.number().optional(),
  failureReason: z.string().optional(),
  summary: z.string().optional(),
  title: z.string().optional(),
  parentStreamId: z.string().optional(),
  parentTitle: z.string().optional(),
  sessionType: z.enum(["conversation", "task"]).optional(),
  output: z.unknown().optional(),
  /** Job description from workspace config - human-readable explanation of what the job does */
  jobDescription: z.string().optional(),
});

// Legacy format schema (metadata + embedded events)
const LegacyStoredSessionSchema = StoredMetadataSchema.extend({ events: z.array(z.unknown()) });

export type SessionHistoryMetadata = z.infer<typeof StoredMetadataSchema>;

export interface SessionHistoryListItem {
  sessionId: string;
  workspaceId: string;
  status: ReasoningResultStatusType;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  title?: string;
  parentStreamId?: string;
  parentTitle?: string;
  sessionType?: "conversation" | "task";
}

export interface SessionHistoryTimeline {
  metadata: SessionHistoryMetadata;
  events: SessionHistoryEvent[];
}

export interface CreateSessionMetadataInput {
  sessionId: string;
  workspaceId: string;
  status: ReasoningResultStatusType;
  signal: SessionHistorySignal | IWorkspaceSignal;
  signalPayload?: unknown;
  jobSpecificationId?: string;
  availableAgents: string[];
  streamId?: string;
  artifactIds?: string[];
  summary?: string;
  /** Human-readable title for the session */
  title?: string;
  parentStreamId?: string;
  parentTitle?: string;
  sessionType?: "conversation" | "task";
  /** Job description from workspace config - human-readable explanation of what the job does */
  jobDescription?: string;
}

export interface AppendSessionEventInput {
  sessionId: string;
  emittedBy: string;
  event: Omit<SessionHistoryEvent, "eventId" | "emittedAt" | "sessionId" | "emittedBy">;
  /** Optional timestamp to use instead of now. Useful for preserving original event timestamps when batching. */
  emittedAt?: string;
}

export interface ListSessionsOptions {
  workspaceId?: string;
  excludeWorkspaceIds?: string[];
}

export interface ListSessionsResult {
  sessions: SessionHistoryListItem[];
}

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

function getSessionDir(): string {
  return join(getAtlasHome(), "sessions");
}

function getMetadataFile(sessionId: string): string {
  return join(getSessionDir(), `${sessionId}.json`);
}

function getEventsFile(sessionId: string): string {
  return join(getSessionDir(), `${sessionId}.jsonl`);
}

async function ensureSessionDir(): Promise<void> {
  await mkdir(getSessionDir(), { recursive: true });
}

/**
 * Read and validate session metadata from the .json file.
 * Handles both new format (metadata only) and legacy format (metadata + events).
 */
async function readMetadata(filePath: string): Promise<SessionHistoryMetadata> {
  const content = await readFile(filePath, "utf-8");
  // Use passthrough() so legacy files with extra `events` field are not silently stripped
  const raw = StoredMetadataSchema.passthrough().parse(JSON.parse(content));
  // Strip the legacy `events` key if present — callers read events from JSONL
  const { events: _, ...metadata } = raw;
  return StoredMetadataSchema.parse(metadata);
}

/**
 * Read events from JSONL file if it exists, otherwise from legacy JSON file.
 */
async function readEvents(sessionId: string): Promise<SessionHistoryEvent[]> {
  const eventsFile = getEventsFile(sessionId);

  // Try JSONL file first (new format)
  try {
    const content = await readFile(eventsFile, "utf-8");
    if (!content.trim()) return [];

    const events: SessionHistoryEvent[] = [];
    for (const line of content.trimEnd().split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(SessionHistoryEventSchema.parse(JSON.parse(line)));
      } catch {
        logger.warn("Skipping malformed event line in session JSONL", { sessionId });
      }
    }
    return events;
  } catch (error) {
    if (!(isErrnoException(error) && error.code === "ENOENT")) {
      throw error;
    }
  }

  // Fall back to legacy format (events embedded in .json)
  const metadataFile = getMetadataFile(sessionId);
  try {
    const content = await readFile(metadataFile, "utf-8");
    const parsed = LegacyStoredSessionSchema.safeParse(JSON.parse(content));
    if (parsed.success && Array.isArray(parsed.data.events)) {
      return parsed.data.events.map((e) => SessionHistoryEventSchema.parse(e));
    }
  } catch (error) {
    if (!(isErrnoException(error) && error.code === "ENOENT")) {
      throw error;
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function extractSignalData(signal: SessionHistorySignal | IWorkspaceSignal): SessionHistorySignal {
  // Extract only serializable fields, let Zod validate
  const data = {
    id: signal.id,
    provider: signal.provider,
    workspaceId: "workspaceId" in signal ? signal.workspaceId : undefined,
    metadata:
      "metadata" in signal && signal.metadata && typeof signal.metadata === "object"
        ? signal.metadata
        : undefined,
  };

  return SessionHistorySignalSchema.parse(data);
}

// ---------------------------------------------------------------------------
// Storage write operations
// ---------------------------------------------------------------------------

export async function createSessionRecord(
  input: CreateSessionMetadataInput,
): Promise<Result<{ events: SessionHistoryEvent[] } & SessionHistoryMetadata, string>> {
  try {
    await ensureSessionDir();
    const metadataFile = getMetadataFile(input.sessionId);

    try {
      const existing = await readMetadata(metadataFile);
      const events = await readEvents(input.sessionId);
      logger.debug("Session already exists, returning existing", {
        sessionId: input.sessionId,
        eventCount: events.length,
      });
      return success({ ...existing, events });
    } catch (error) {
      if (!(isErrnoException(error) && error.code === "ENOENT")) {
        logger.warn("Error reading existing session, creating new", {
          sessionId: input.sessionId,
          error: stringifyError(error),
        });
      }
    }

    const now = new Date().toISOString();
    const signal = extractSignalData(input.signal);

    const metadata: SessionHistoryMetadata = {
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      createdAt: now,
      updatedAt: now,
      status: input.status,
      signal,
      signalPayload: input.signalPayload,
      jobSpecificationId: input.jobSpecificationId,
      availableAgents: input.availableAgents,
      streamId: input.streamId,
      artifactIds: input.artifactIds,
      summary: input.summary,
      title: input.title,
      parentStreamId: input.parentStreamId,
      parentTitle: input.parentTitle,
      sessionType: input.sessionType,
      jobDescription: input.jobDescription,
    };

    await writeFile(metadataFile, JSON.stringify(metadata, null, 2), "utf-8");
    logger.debug("Created new session", { sessionId: input.sessionId });

    return success({ ...metadata, events: [] });
  } catch (error) {
    return fail(stringifyError(error));
  }
}

export async function appendSessionEvent(
  input: AppendSessionEventInput,
): Promise<Result<SessionHistoryEvent, string>> {
  try {
    await ensureSessionDir();
    const metadataFile = getMetadataFile(input.sessionId);
    const eventsFile = getEventsFile(input.sessionId);

    const timestamp = input.emittedAt || new Date().toISOString();
    const eventId = crypto.randomUUID();
    const event: SessionHistoryEvent = SessionHistoryEventSchema.parse({
      ...input.event,
      eventId,
      emittedAt: timestamp,
      sessionId: input.sessionId,
      emittedBy: input.emittedBy,
    });

    // Migrate legacy embedded events to JSONL on first append if needed
    await withExclusiveLock(metadataFile, async () => {
      await migrateLegacyEventsIfNeeded(input.sessionId);

      // Append event as a single JSONL line
      await appendFile(eventsFile, JSON.stringify(event) + "\n", "utf-8");

      // Update metadata timestamp
      const metadata = await readMetadata(metadataFile);
      metadata.updatedAt = timestamp;
      await writeFile(metadataFile, JSON.stringify(metadata, null, 2), "utf-8");
    });

    return success(event);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return fail("Session not found");
    }
    if (error instanceof z.ZodError) {
      return fail(`Invalid session data format: ${error.message}`);
    }
    return fail(stringifyError(error));
  }
}

export async function markSessionComplete(
  sessionId: string,
  status: ReasoningResultStatusType,
  finishedAt: string,
  details?: { durationMs?: number; failureReason?: string; summary?: string; output?: unknown },
): Promise<Result<SessionHistoryMetadata, string>> {
  try {
    await ensureSessionDir();
    const metadataFile = getMetadataFile(sessionId);

    const metadata = await withExclusiveLock(metadataFile, async () => {
      const meta = await readMetadata(metadataFile);

      meta.status = status;
      meta.updatedAt = finishedAt;
      if (details?.durationMs !== undefined) meta.durationMs = details.durationMs;
      if (details?.failureReason !== undefined) meta.failureReason = details.failureReason;
      if (details?.summary !== undefined) meta.summary = details.summary;
      if (details?.output !== undefined) meta.output = details.output;

      await writeFile(metadataFile, JSON.stringify(meta, null, 2), "utf-8");
      return meta;
    });

    return success(metadata);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return fail("Session not found");
    }
    if (error instanceof z.ZodError) {
      return fail(`Invalid session data format: ${error.message}`);
    }
    return fail(stringifyError(error));
  }
}

/**
 * Updates the title of an existing session.
 * Title is cosmetic metadata - does NOT modify updatedAt.
 */
export async function updateSessionTitle(
  sessionId: string,
  title: string,
): Promise<Result<SessionHistoryMetadata, string>> {
  try {
    await ensureSessionDir();
    const metadataFile = getMetadataFile(sessionId);

    const metadata = await withExclusiveLock(metadataFile, async () => {
      const meta = await readMetadata(metadataFile);

      meta.title = title;
      // Note: Not modifying updatedAt - title is cosmetic metadata, not content change

      await writeFile(metadataFile, JSON.stringify(meta, null, 2), "utf-8");
      return meta;
    });

    return success(metadata);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return fail("Session not found");
    }
    if (error instanceof z.ZodError) {
      return fail(`Invalid session data format: ${error.message}`);
    }
    return fail(stringifyError(error));
  }
}

// ---------------------------------------------------------------------------
// Read/query utilities
// ---------------------------------------------------------------------------

export async function getSessionMetadata(
  sessionId: string,
): Promise<Result<SessionHistoryMetadata | null, string>> {
  try {
    const metadata = await readMetadata(getMetadataFile(sessionId));
    return success(metadata);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return success(null);
    }
    if (error instanceof z.ZodError) {
      return fail(`Invalid session data format: ${error.message}`);
    }
    return fail(stringifyError(error));
  }
}

export async function listSessions(
  options: ListSessionsOptions,
): Promise<Result<ListSessionsResult, string>> {
  try {
    await ensureSessionDir();
    const sessionDir = getSessionDir();

    const fileInfos: Array<{ path: string; mtime: number }> = [];

    const sessionEntries = await readdir(sessionDir, { withFileTypes: true });
    for (const entry of sessionEntries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const filePath = join(sessionDir, entry.name);
        try {
          const fileStat = await stat(filePath);
          if (fileStat.mtime) {
            fileInfos.push({ path: filePath, mtime: fileStat.mtime.getTime() });
          }
        } catch (error) {
          logger.warn("Failed to stat session file, skipping", {
            file: entry.name,
            error: stringifyError(error),
          });
        }
      }
    }

    fileInfos.sort((a, b) => b.mtime - a.mtime);

    const sessions: SessionHistoryListItem[] = [];
    for (const { path } of fileInfos) {
      try {
        const metadata = await readMetadata(path);
        if (options.excludeWorkspaceIds?.includes(metadata.workspaceId)) continue;
        if (!options.workspaceId || metadata.workspaceId === options.workspaceId) {
          sessions.push({
            sessionId: metadata.sessionId,
            workspaceId: metadata.workspaceId,
            status: metadata.status,
            createdAt: metadata.createdAt,
            updatedAt: metadata.updatedAt,
            summary: metadata.summary,
            title: metadata.title,
            parentStreamId: metadata.parentStreamId,
            parentTitle: metadata.parentTitle,
            sessionType: metadata.sessionType,
          });
        }
      } catch (error) {
        logger.warn("Failed to read session file, skipping", {
          path,
          error: stringifyError(error),
        });
      }
    }

    return success({ sessions });
  } catch (error) {
    return fail(stringifyError(error));
  }
}

export async function loadSessionTimeline(
  sessionId: string,
): Promise<Result<SessionHistoryTimeline | null, string>> {
  try {
    const metadata = await readMetadata(getMetadataFile(sessionId));
    const events = await readEvents(sessionId);
    return success({ metadata, events });
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return success(null);
    }
    if (error instanceof z.ZodError) {
      return fail(`Invalid session data format: ${error.message}`);
    }
    return fail(stringifyError(error));
  }
}

// ---------------------------------------------------------------------------
// Migration helper
// ---------------------------------------------------------------------------

/**
 * If a legacy session file has embedded events and no .jsonl file exists,
 * migrate the events to JSONL and rewrite the metadata file without events.
 */
async function migrateLegacyEventsIfNeeded(sessionId: string): Promise<void> {
  const eventsFile = getEventsFile(sessionId);
  const metadataFile = getMetadataFile(sessionId);

  // If JSONL file already exists, no migration needed
  try {
    await stat(eventsFile);
    return;
  } catch (error) {
    if (!(isErrnoException(error) && error.code === "ENOENT")) {
      throw error;
    }
  }

  // Read legacy file to check for embedded events
  const content = await readFile(metadataFile, "utf-8");
  const parsed = LegacyStoredSessionSchema.safeParse(JSON.parse(content));

  if (!parsed.success || parsed.data.events.length === 0) {
    // No events to migrate or not legacy format - just create empty JSONL
    await writeFile(eventsFile, "", "utf-8");
    // Rewrite metadata without events field if it was legacy format
    if (parsed.success) {
      const { events: _, ...metaOnly } = parsed.data;
      await writeFile(metadataFile, JSON.stringify(metaOnly, null, 2), "utf-8");
    }
    return;
  }

  // Migrate events to JSONL
  const legacyEvents = parsed.data.events;
  const lines = legacyEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(eventsFile, lines, "utf-8");

  // Rewrite metadata without events
  const { events: _, ...metaOnly } = parsed.data;
  await writeFile(metadataFile, JSON.stringify(metaOnly, null, 2), "utf-8");

  logger.debug("Migrated legacy session events to JSONL", {
    sessionId,
    eventCount: legacyEvents.length,
  });
}

export const SessionHistoryStorage = {
  createSessionRecord,
  appendSessionEvent,
  markSessionComplete,
  updateSessionTitle,
  getSessionMetadata,
  listSessions,
  loadSessionTimeline,
};
