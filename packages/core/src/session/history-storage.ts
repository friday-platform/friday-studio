import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
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

// Combined session structure (metadata + events)
const StoredSessionSchema = z.object({
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
  events: z.array(z.unknown()),
});

type StoredSession = Omit<z.infer<typeof StoredSessionSchema>, "events"> & {
  events: SessionHistoryEvent[];
};

export type SessionHistoryMetadata = Omit<StoredSession, "events">;

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

function getSessionFile(sessionId: string): string {
  return join(getSessionDir(), `${sessionId}.json`);
}

async function ensureSessionDir(): Promise<void> {
  await mkdir(getSessionDir(), { recursive: true });
}

async function readAndValidateSession(filePath: string): Promise<StoredSession> {
  const content = await readFile(filePath, "utf-8");
  const json = JSON.parse(content);
  const parsedSession = StoredSessionSchema.parse(json);
  const events = parsedSession.events.map((e) => SessionHistoryEventSchema.parse(e));
  return { ...parsedSession, events };
}

/**
 * Reads session data through an already-opened and locked file handle.
 * This ensures the read happens within the lock's protection.
 */
async function readSessionFromHandle(file: Deno.FsFile): Promise<StoredSession> {
  const fileStat = await file.stat();
  const buf = new Uint8Array(fileStat.size);
  await file.seek(0, Deno.SeekMode.Start);
  await file.read(buf);
  const content = new TextDecoder().decode(buf);
  const json = JSON.parse(content);
  const parsedSession = StoredSessionSchema.parse(json);
  const events = parsedSession.events.map((e) => SessionHistoryEventSchema.parse(e));
  return { ...parsedSession, events };
}

/**
 * Writes session data through an already-opened and locked file handle.
 * Truncates and rewrites the entire file.
 */
async function writeSessionToHandle(file: Deno.FsFile, session: StoredSession): Promise<void> {
  const encoded = new TextEncoder().encode(JSON.stringify(session, null, 2));
  await file.truncate(0);
  await file.seek(0, Deno.SeekMode.Start);
  await file.write(encoded);
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
): Promise<Result<StoredSession, string>> {
  try {
    await ensureSessionDir();
    const sessionFile = getSessionFile(input.sessionId);

    try {
      const existing = await readAndValidateSession(sessionFile);
      logger.debug("Session already exists, returning existing", {
        sessionId: input.sessionId,
        eventCount: existing.events.length,
      });
      return success(existing);
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

    const session: StoredSession = {
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
      events: [],
    };

    await writeFile(sessionFile, JSON.stringify(session, null, 2), "utf-8");
    logger.debug("Created new session", { sessionId: input.sessionId });

    return success(session);
  } catch (error) {
    return fail(stringifyError(error));
  }
}

export async function appendSessionEvent(
  input: AppendSessionEventInput,
): Promise<Result<SessionHistoryEvent, string>> {
  try {
    await ensureSessionDir();
    const sessionFile = getSessionFile(input.sessionId);

    using file = await Deno.open(sessionFile, { read: true, write: true });
    await file.lock(true);

    const session = await readSessionFromHandle(file);

    const timestamp = input.emittedAt || new Date().toISOString();
    const eventId = crypto.randomUUID();
    const event: SessionHistoryEvent = SessionHistoryEventSchema.parse({
      ...input.event,
      eventId,
      emittedAt: timestamp,
      sessionId: input.sessionId,
      emittedBy: input.emittedBy,
    });

    session.events.push(event);
    session.updatedAt = timestamp;

    await writeSessionToHandle(file, session);

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
    const sessionFile = getSessionFile(sessionId);

    using file = await Deno.open(sessionFile, { read: true, write: true });
    await file.lock(true);

    const session = await readSessionFromHandle(file);

    session.status = status;
    session.updatedAt = finishedAt;
    if (details?.durationMs !== undefined) session.durationMs = details.durationMs;
    if (details?.failureReason !== undefined) session.failureReason = details.failureReason;
    if (details?.summary !== undefined) session.summary = details.summary;
    if (details?.output !== undefined) session.output = details.output;

    await writeSessionToHandle(file, session);

    const { events: _, ...metadata } = session;
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
    const sessionFile = getSessionFile(sessionId);

    using file = await Deno.open(sessionFile, { read: true, write: true });
    await file.lock(true);

    const session = await readSessionFromHandle(file);

    session.title = title;
    // Note: Not modifying updatedAt - title is cosmetic metadata, not content change

    await writeSessionToHandle(file, session);

    const { events: _, ...metadata } = session;
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
    const session = await readAndValidateSession(getSessionFile(sessionId));
    const { events: _, ...metadata } = session;
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
        const session = await readAndValidateSession(path);
        if (options.excludeWorkspaceIds?.includes(session.workspaceId)) continue;
        if (!options.workspaceId || session.workspaceId === options.workspaceId) {
          sessions.push({
            sessionId: session.sessionId,
            workspaceId: session.workspaceId,
            status: session.status,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            summary: session.summary,
            title: session.title,
            parentStreamId: session.parentStreamId,
            parentTitle: session.parentTitle,
            sessionType: session.sessionType,
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
    const session = await readAndValidateSession(getSessionFile(sessionId));
    const { events, ...metadata } = session;
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

export const SessionHistoryStorage = {
  createSessionRecord,
  appendSessionEvent,
  markSessionComplete,
  updateSessionTitle,
  getSessionMetadata,
  listSessions,
  loadSessionTimeline,
};
