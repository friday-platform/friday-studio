/**
 * SSE consumer async generator for session event streaming.
 *
 * Connects to the session SSE endpoint and yields parsed session events.
 * Designed to plug into TanStack `streamedQuery`'s `streamFn`.
 *
 * Handles:
 * - Default SSE events parsed as `SessionStreamEvent`
 * - Named `event: ephemeral` events parsed as `EphemeralChunk`
 * - Reconnection with exponential backoff on connection drop
 * - 404 fallback to JSON endpoint
 * - 410 "outdated format" error
 * - Cleanup on generator return
 *
 * @module
 */

import {
  EphemeralChunkSchema,
  SessionStreamEventSchema,
  SessionViewSchema,
  type EphemeralChunk,
  type SessionStreamEvent,
} from "@atlas/core/session/session-events";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { parseSSEStream, type SSEMessage } from "@atlas/utils";

/** Base delay for exponential backoff in milliseconds. */
const BASE_DELAY_MS = 1000;

/** Maximum number of reconnection attempts before throwing. */
const MAX_RETRIES = 3;

/**
 * Calculates exponential backoff delay for a given attempt number.
 * @param attempt - Zero-based attempt index (0 = first retry)
 * @returns Delay in milliseconds: 1000, 2000, 4000, ...
 */
export function backoffDelay(attempt: number): number {
  return BASE_DELAY_MS * Math.pow(2, attempt);
}

/**
 * Async generator that consumes the session SSE endpoint and yields
 * parsed `SessionStreamEvent` or `EphemeralChunk` objects.
 *
 * @param sessionId - The session ID to stream events for
 * @yields Parsed session events (durable) or ephemeral chunks
 * @throws When all retry attempts are exhausted
 * @throws When server returns 410 (outdated session format)
 */
export async function* sessionEventStream(
  sessionId: string,
): AsyncGenerator<SessionStreamEvent | EphemeralChunk> {
  const baseUrl = getAtlasDaemonUrl();
  const streamUrl = `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/stream`;
  const jsonUrl = `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`;

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
        // Session not in stream registry (404) or old format (410) — fall back to JSON endpoint.
        // The JSON endpoint has v2 data even when the stream returns 410 (v1 file exists alongside v2).
        yield* fetchJsonFallback(jsonUrl);
        return;
      }

      if (!response.ok) {
        throw new Error(`SSE request failed: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("SSE response has no body");
      }

      // Reset retry counter on successful connection
      retries = 0;

      yield* parseTypedSSEStream(response.body);

      // Stream ended normally (server closed connection after session:complete)
      return;
    } catch (error) {
      // Don't retry abort errors (generator was returned/closed)
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      // Don't retry application-level errors (410, JSON fallback errors)
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

      await sleep(backoffDelay(retries - 1));
    } finally {
      controller?.abort();
    }
  }
}

/**
 * Wraps the shared SSE parser with session-specific Zod schema application.
 *
 * Routes messages by `event:` field:
 * - `ephemeral` → {@link EphemeralChunkSchema}
 * - default (no event) → {@link SessionStreamEventSchema}
 */
async function* parseTypedSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SessionStreamEvent | EphemeralChunk> {
  for await (const message of parseSSEStream(body)) {
    const typed = applySchema(message);
    if (typed) {
      yield typed;
    }
  }
}

/**
 * Applies the appropriate Zod schema to a raw SSE message based on its
 * `event` field.
 */
function applySchema(message: SSEMessage): SessionStreamEvent | EphemeralChunk | null {
  const json: unknown = JSON.parse(message.data);

  if (message.event === "ephemeral") {
    return EphemeralChunkSchema.parse(json);
  }

  return SessionStreamEventSchema.parse(json);
}

/**
 * Falls back to the JSON session endpoint when SSE returns 404.
 * Fetches the complete SessionView and yields the events that the
 * reducer would need to reconstruct it.
 */
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

  // Synthesize events from the SessionView so the reducer can reconstruct state.
  // Derive plannedSteps from the view's blocks so the reducer seeds pending
  // blocks (which session:complete will transition to skipped if unmatched).
  const plannedSteps = view.agentBlocks.map((b) => ({
    agentName: b.agentName,
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

  // Only synthesize step events for blocks that actually ran (have a stepNumber).
  // Skipped/pending blocks stay as pending from plannedSteps seeding — the
  // session:complete event transitions them to skipped.
  for (const block of view.agentBlocks) {
    if (block.stepNumber == null) continue;

    const stepStart: SessionStreamEvent = {
      type: "step:start",
      sessionId: view.sessionId,
      stepNumber: block.stepNumber,
      agentName: block.agentName,
      actionType: block.actionType,
      task: block.task,
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

/** Error messages that should not trigger reconnection. */
const NON_RETRYABLE_PATTERNS = ["outdated format", "Session JSON request failed"] as const;

/** Checks whether an error should skip the retry logic. */
function isNonRetryableError(error: Error): boolean {
  return NON_RETRYABLE_PATTERNS.some((pattern) => error.message.includes(pattern));
}

/** Promise-based sleep utility. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
