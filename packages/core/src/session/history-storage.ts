import type { AgentResult, ArtifactRef, ToolCall, ToolResult } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { join } from "@std/path";
import { mkdir } from "node:fs/promises";
import type { LanguageModelUsage, ReasoningOutput } from "ai";
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

export interface AgentSnapshot {
  agentId: string;
  task: string;
  inputData: { structured: unknown; raw?: string };
  promptSummary?: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  outputText?: string;
  structuredOutput?: unknown;
  artifacts?: ArtifactRef[];
  usage?: LanguageModelUsage;
  response?: ReasoningOutput | string;
  messages?: unknown[];
  result: AgentResult;
}

const AgentSnapshotSchema: z.ZodType<AgentSnapshot> = z.object({
  agentId: z.string(),
  task: z.string(),
  inputData: z.object({ structured: z.unknown(), raw: z.string().optional() }),
  promptSummary: z.string().optional(),
  reasoning: z.string().optional(),
  toolCalls: z.custom<ToolCall[]>((value) => Array.isArray(value)).optional(),
  toolResults: z.custom<ToolResult[]>((value) => Array.isArray(value)).optional(),
  outputText: z.string().optional(),
  structuredOutput: z.unknown().optional(),
  artifacts: z
    .array(z.object({ id: z.string(), type: z.string(), summary: z.string() }))
    .optional(),
  usage: z.custom<LanguageModelUsage>(() => true).optional(),
  response: z.custom<ReasoningOutput | string>(() => true).optional(),
  messages: z.array(z.unknown()).optional(),
  result: z.custom<AgentResult>(),
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
  | "plan-created"
  | "plan-updated"
  | "phase-start"
  | "phase-complete"
  | "agent-start"
  | "agent-output"
  | "agent-error"
  | "agent-tool-call"
  | "agent-tool-result"
  | "agent-retry"
  | "supervisor-action"
  | "validation-result"
  | "memory-update"
  | "session-finish";

type SessionStartEvent = SessionHistoryEventBase<
  "session-start",
  { status: ReasoningResultStatusType; message?: string }
>;

type PlanCreatedEvent = SessionHistoryEventBase<
  "plan-created",
  { plan: unknown; reasoning?: string; strategy?: string }
>;

type PlanUpdatedEvent = SessionHistoryEventBase<
  "plan-updated",
  { plan: unknown; reasoning?: string; strategy?: string }
>;

type PhaseStartEvent = SessionHistoryEventBase<
  "phase-start",
  {
    phaseId: string;
    name: string;
    executionStrategy: "sequential" | "parallel";
    agents: string[];
    reasoning?: string;
  }
>;

type PhaseCompleteEvent = SessionHistoryEventBase<
  "phase-complete",
  { phaseId: string; status: ReasoningResultStatusType; durationMs?: number; issues?: string[] }
>;

type AgentStartEvent = SessionHistoryEventBase<
  "agent-start",
  { agentId: string; executionId: string; promptSummary?: string; input: unknown }
>;

type AgentOutputEvent = SessionHistoryEventBase<
  "agent-output",
  { agentId: string; executionId: string; snapshot: AgentSnapshot }
>;

type AgentErrorEvent = SessionHistoryEventBase<
  "agent-error",
  { agentId: string; executionId: string; error: string; retryable?: boolean }
>;

type AgentToolCallEvent = SessionHistoryEventBase<
  "agent-tool-call",
  { agentId: string; executionId: string; toolCall: ToolCall }
>;

type AgentToolResultEvent = SessionHistoryEventBase<
  "agent-tool-result",
  { agentId: string; executionId: string; toolResult: ToolResult }
>;

type AgentRetryEvent = SessionHistoryEventBase<
  "agent-retry",
  { agentId: string; executionId: string; attempt: number; reason?: string }
>;

type SupervisorActionEvent = SessionHistoryEventBase<
  "supervisor-action",
  { action: string; details?: Record<string, unknown> }
>;

type ValidationResultEvent = SessionHistoryEventBase<
  "validation-result",
  {
    agentId: string;
    executionId: string;
    score: number;
    verdict: "pass" | "fail" | "retry";
    analysis?: Record<string, unknown>;
  }
>;

type MemoryUpdateEvent = SessionHistoryEventBase<
  "memory-update",
  { memoryType: string; entries: unknown[]; summary?: string }
>;

type SessionFinishEvent = SessionHistoryEventBase<
  "session-finish",
  {
    status: ReasoningResultStatusType;
    durationMs: number;
    failureReason?: string;
    summary?: string;
  }
>;

export type SessionHistoryEvent =
  | SessionStartEvent
  | PlanCreatedEvent
  | PlanUpdatedEvent
  | PhaseStartEvent
  | PhaseCompleteEvent
  | AgentStartEvent
  | AgentOutputEvent
  | AgentErrorEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentRetryEvent
  | SupervisorActionEvent
  | ValidationResultEvent
  | MemoryUpdateEvent
  | SessionFinishEvent;

const SessionHistoryEventSchema: z.ZodType<SessionHistoryEvent> = z.discriminatedUnion("type", [
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("session-start"),
    data: z.object({ status: ReasoningStatusSchema, message: z.string().optional() }),
  }),
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("plan-created"),
    data: z.object({
      plan: z.unknown(),
      reasoning: z.string().optional(),
      strategy: z.string().optional(),
    }),
  }),
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("plan-updated"),
    data: z.object({
      plan: z.unknown(),
      reasoning: z.string().optional(),
      strategy: z.string().optional(),
    }),
  }),
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("phase-start"),
    data: z.object({
      phaseId: z.string(),
      name: z.string(),
      executionStrategy: z.union([z.literal("sequential"), z.literal("parallel")]),
      agents: z.array(z.string()),
      reasoning: z.string().optional(),
    }),
  }),
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("phase-complete"),
    data: z.object({
      phaseId: z.string(),
      status: ReasoningStatusSchema,
      durationMs: z.number().optional(),
      issues: z.array(z.string()).optional(),
    }),
  }),
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("agent-start"),
    data: z.object({
      agentId: z.string(),
      executionId: z.string(),
      promptSummary: z.string().optional(),
      input: z.unknown(),
    }),
  }),
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("agent-output"),
    data: z.object({ agentId: z.string(), executionId: z.string(), snapshot: AgentSnapshotSchema }),
  }),
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("agent-error"),
    data: z.object({
      agentId: z.string(),
      executionId: z.string(),
      error: z.string(),
      retryable: z.boolean().optional(),
    }),
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
    type: z.literal("agent-retry"),
    data: z.object({
      agentId: z.string(),
      executionId: z.string(),
      attempt: z.number(),
      reason: z.string().optional(),
    }),
  }),
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("supervisor-action"),
    data: z.object({ action: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
  }),
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("validation-result"),
    data: z.object({
      agentId: z.string(),
      executionId: z.string(),
      score: z.number(),
      verdict: z.union([z.literal("pass"), z.literal("fail"), z.literal("retry")]),
      analysis: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("memory-update"),
    data: z.object({
      memoryType: z.string(),
      entries: z.array(z.unknown()),
      summary: z.string().optional(),
    }),
  }),
  SessionHistoryEventBaseSchema.extend({
    type: z.literal("session-finish"),
    data: z.object({
      status: ReasoningStatusSchema,
      durationMs: z.number(),
      failureReason: z.string().optional(),
      summary: z.string().optional(),
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
}

export interface AppendSessionEventInput {
  sessionId: string;
  emittedBy: string;
  event: Omit<SessionHistoryEvent, "eventId" | "emittedAt" | "sessionId" | "emittedBy">;
}

export interface ListSessionsOptions {
  workspaceId?: string;
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
  const content = await Deno.readTextFile(filePath);
  const json = JSON.parse(content);
  const parsedSession = StoredSessionSchema.parse(json);
  const events = parsedSession.events.map((e) => SessionHistoryEventSchema.parse(e));
  return { ...parsedSession, events };
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
      if (!(error instanceof Deno.errors.NotFound)) {
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
      events: [],
    };

    await Deno.writeTextFile(sessionFile, JSON.stringify(session, null, 2));
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

    const session = await readAndValidateSession(sessionFile);

    const timestamp = new Date().toISOString();
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

    await Deno.writeTextFile(sessionFile, JSON.stringify(session, null, 2));

    return success(event);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
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
  details?: { durationMs?: number; failureReason?: string; summary?: string },
): Promise<Result<SessionHistoryMetadata, string>> {
  try {
    await ensureSessionDir();
    const sessionFile = getSessionFile(sessionId);

    using file = await Deno.open(sessionFile, { read: true, write: true });
    await file.lock(true);

    const session = await readAndValidateSession(sessionFile);

    session.status = status;
    session.updatedAt = finishedAt;
    if (details?.durationMs !== undefined) session.durationMs = details.durationMs;
    if (details?.failureReason !== undefined) session.failureReason = details.failureReason;
    if (details?.summary !== undefined) session.summary = details.summary;

    await Deno.writeTextFile(sessionFile, JSON.stringify(session, null, 2));

    const { events: _, ...metadata } = session;
    return success(metadata);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
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
    if (error instanceof Deno.errors.NotFound) {
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

    for await (const entry of Deno.readDir(sessionDir)) {
      if (entry.isFile && entry.name.endsWith(".json")) {
        const filePath = join(sessionDir, entry.name);
        try {
          const stat = await Deno.stat(filePath);
          if (stat.mtime) {
            fileInfos.push({ path: filePath, mtime: stat.mtime.getTime() });
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
        if (!options.workspaceId || session.workspaceId === options.workspaceId) {
          sessions.push({
            sessionId: session.sessionId,
            workspaceId: session.workspaceId,
            status: session.status,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            summary: session.summary,
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
    if (error instanceof Deno.errors.NotFound) {
      return success(null);
    }
    if (error instanceof z.ZodError) {
      return fail(`Invalid session data format: ${error.message}`);
    }
    return fail(stringifyError(error));
  }
}

// ---------------------------------------------------------------------------
// Normalization adapters
// ---------------------------------------------------------------------------

export function toAgentSnapshot(
  result: AgentResult & {
    outputText?: string;
    structuredOutput?: unknown;
    promptSummary?: string;
    usage?: LanguageModelUsage;
    response?: ReasoningOutput | string;
    messages?: unknown[];
  },
): AgentSnapshot {
  const snapshot: AgentSnapshot = {
    agentId: result.agentId,
    task: result.task,
    inputData: {
      structured: result.input,
      raw: typeof result.input === "string" ? result.input : undefined,
    },
    promptSummary: result.promptSummary,
    reasoning: result.reasoning,
    toolCalls: result.toolCalls,
    toolResults: result.toolResults,
    outputText:
      result.outputText ?? (typeof result.output === "string" ? result.output : undefined),
    structuredOutput:
      result.structuredOutput ?? (typeof result.output === "string" ? undefined : result.output),
    artifacts: result.artifactRefs,
    usage: result.usage,
    response: result.response,
    messages: result.messages,
    result,
  };

  return AgentSnapshotSchema.parse(snapshot);
}

export function toToolCallEvent(
  agentId: string,
  executionId: string,
  toolCall: ToolCall,
  context?: SessionHistoryEventContext,
): AppendSessionEventInput["event"] {
  return { type: "agent-tool-call", context, data: { agentId, executionId, toolCall } };
}

export function toToolResultEvent(
  agentId: string,
  executionId: string,
  toolResult: ToolResult,
  context?: SessionHistoryEventContext,
): AppendSessionEventInput["event"] {
  return { type: "agent-tool-result", context, data: { agentId, executionId, toolResult } };
}

export const SessionHistoryStorage = {
  createSessionRecord,
  appendSessionEvent,
  markSessionComplete,
  getSessionMetadata,
  listSessions,
  loadSessionTimeline,
  toAgentSnapshot,
  toToolCallEvent,
  toToolResultEvent,
};
