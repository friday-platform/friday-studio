/**
 * SSE consumer for session event streaming through the daemon proxy.
 *
 * Adapted from `apps/web-client/src/lib/utils/session-event-stream.ts` for
 * the playground's `/api/daemon/` proxy. Connects to the session SSE endpoint
 * and yields parsed session events for use with TanStack `streamedQuery`.
 *
 * @module
 */

import {
  EphemeralChunkSchema,
  SessionStreamEventSchema,
  SessionViewSchema,
  type EphemeralChunk,
  type SessionStreamEvent,
  type SessionView,
} from "@atlas/core/session/session-events";

/** Base delay for exponential backoff in milliseconds. */
const BASE_DELAY_MS = 1000;

/** Maximum number of reconnection attempts before throwing. */
const MAX_RETRIES = 3;

/**
 * Async generator that consumes the daemon session SSE endpoint (via proxy)
 * and yields parsed `SessionStreamEvent` or `EphemeralChunk` objects.
 *
 * @param sessionId - The session ID to stream events for
 * @yields Parsed session events (durable) or ephemeral chunks
 */
export async function* sessionEventStream(
  sessionId: string,
): AsyncGenerator<SessionStreamEvent | EphemeralChunk> {
  const streamUrl = `/api/daemon/api/sessions/${encodeURIComponent(sessionId)}/stream`;
  const jsonUrl = `/api/daemon/api/sessions/${encodeURIComponent(sessionId)}`;

  let retries = 0;

  while (retries <= MAX_RETRIES) {
    let controller: AbortController | undefined;

    try {
      controller = new AbortController();
      const response = await fetch(streamUrl, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });

      if (response.status === 404 || response.status === 410) {
        yield* fetchJsonFallback(jsonUrl);
        return;
      }

      if (!response.ok) {
        throw new Error(`SSE request failed: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("SSE response has no body");
      }

      retries = 0;
      yield* parseTypedSSEStream(response.body);
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      if (error instanceof Error && isNonRetryableError(error)) {
        throw error;
      }

      retries++;
      if (retries > MAX_RETRIES) {
        throw new Error(
          `SSE connection lost after ${MAX_RETRIES} retries: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }

      await sleep(BASE_DELAY_MS * Math.pow(2, retries - 1));
    } finally {
      controller?.abort();
    }
  }
}

/**
 * Fetches the session JSON endpoint and returns the full SessionView.
 * Use for already-finished sessions to avoid an unnecessary SSE round-trip.
 */
export async function fetchSessionView(sessionId: string): Promise<SessionView> {
  const jsonUrl = `/api/daemon/api/sessions/${encodeURIComponent(sessionId)}`;
  const response = await fetch(jsonUrl);

  if (response.status === 410) {
    throw new Error("Session uses an outdated format and cannot be displayed");
  }

  if (!response.ok) {
    throw new Error(`Session JSON request failed: ${response.status} ${response.statusText}`);
  }

  const json: unknown = await response.json();
  return SessionViewSchema.parse(json);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** SSE message with optional event name. */
interface SSEMessage {
  event?: string;
  data: string;
}

async function* parseTypedSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SessionStreamEvent | EphemeralChunk> {
  for await (const message of parseSSEStream(body)) {
    const json: unknown = JSON.parse(message.data);

    if (message.event === "ephemeral") {
      yield EphemeralChunkSchema.parse(json);
    } else {
      yield SessionStreamEventSchema.parse(json);
    }
  }
}

async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const message = parseSSEMessage(raw);
        if (message) {
          yield message;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSSEMessage(raw: string): SSEMessage | null {
  let data = "";
  let event = "";

  for (const line of raw.split("\n")) {
    if (line.startsWith("data:")) {
      data += (data ? "\n" : "") + line.slice(5).trim();
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    }
  }

  if (!data) return null;
  return event ? { event, data } : { data };
}

async function* fetchJsonFallback(
  jsonUrl: string,
): AsyncGenerator<SessionStreamEvent | EphemeralChunk> {
  const response = await fetch(jsonUrl);

  if (response.status === 410) {
    throw new Error("Session uses an outdated format and cannot be displayed");
  }

  if (!response.ok) {
    throw new Error(`Session JSON request failed: ${response.status} ${response.statusText}`);
  }

  const json: unknown = await response.json();
  const view = SessionViewSchema.parse(json);

  const plannedSteps = view.agentBlocks.map((b) => ({
    agentName: b.agentName,
    stateId: b.stateId,
    task: b.task,
    actionType: b.actionType,
  }));

  const sessionStart: SessionStreamEvent = {
    type: "session:start",
    sessionId: view.sessionId,
    workspaceId: view.workspaceId,
    jobName: view.jobName,
    task: view.task,
    plannedSteps: plannedSteps.length > 0 ? plannedSteps : undefined,
    timestamp: view.startedAt,
  };
  yield sessionStart;

  for (const block of view.agentBlocks) {
    if (block.stepNumber == null) continue;

    const stepStart: SessionStreamEvent = {
      type: "step:start",
      sessionId: view.sessionId,
      stepNumber: block.stepNumber,
      agentName: block.agentName,
      stateId: block.stateId,
      actionType: block.actionType,
      task: block.task,
      input: block.input,
      timestamp: view.startedAt,
    };
    yield stepStart;

    const stepComplete: SessionStreamEvent = {
      type: "step:complete",
      sessionId: view.sessionId,
      stepNumber: block.stepNumber,
      status: block.status === "failed" ? "failed" : "completed",
      durationMs: block.durationMs ?? 0,
      toolCalls: block.toolCalls,
      reasoning: block.reasoning,
      output: block.output,
      error: block.error,
      timestamp: view.startedAt,
    };
    yield stepComplete;
  }

  const sessionComplete: SessionStreamEvent = {
    type: "session:complete",
    sessionId: view.sessionId,
    status: view.status,
    durationMs: view.durationMs ?? 0,
    error: view.error,
    timestamp: view.completedAt ?? view.startedAt,
  };
  yield sessionComplete;

  if (view.aiSummary) {
    const sessionSummary: SessionStreamEvent = {
      type: "session:summary",
      timestamp: view.completedAt ?? view.startedAt,
      summary: view.aiSummary.summary,
      keyDetails: view.aiSummary.keyDetails,
    };
    yield sessionSummary;
  }
}

const NON_RETRYABLE_PATTERNS = ["outdated format", "Session JSON request failed"] as const;

function isNonRetryableError(error: Error): boolean {
  return NON_RETRYABLE_PATTERNS.some((pattern) => error.message.includes(pattern));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
