/**
 * SSE (Server-Sent Events) utilities for ACP streaming
 * Based on acp-sdk implementation with Deno compatibility
 */

import { EventSourceParserStream } from "eventsource-parser/stream";
import { SSEError } from "./sse-errors.ts";

type FetchLike = typeof fetch;

interface EventSourceParams {
  url: URL | string;
  fetch?: FetchLike;
  options?: RequestInit;
}

export interface EventSourceMessage {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

/**
 * Creates an EventSource-like interface for Server-Sent Events
 * Compatible with the ACP protocol streaming endpoints
 */
export async function createEventSource({
  url,
  fetch = globalThis.fetch,
  options,
}: EventSourceParams) {
  const response = await fetch(url, getFetchOptions(options));

  return {
    response,
    async *consume(): AsyncIterableIterator<EventSourceMessage> {
      if (response.status === 204) {
        throw new SSEError("Server sent HTTP 204, not connecting", response);
      }

      if (!response.ok) {
        throw new SSEError(
          `Non-200 status code (${response.status})`,
          response,
        );
      }

      if (
        !response.headers.get("content-type")?.startsWith("text/event-stream")
      ) {
        throw new SSEError(
          'Invalid content type, expected "text/event-stream"',
          response,
        );
      }

      if (!response.body) {
        throw new SSEError("Missing response body", response);
      }

      const stream = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream({ onError: "terminate" }));

      try {
        for await (const message of stream) {
          yield message;
        }
      } catch (err) {
        throw new SSEError((err as Error).message, response, { cause: err });
      }
    },
  };
}

export type EventSource = Awaited<ReturnType<typeof createEventSource>>;

function getFetchOptions(options?: RequestInit): RequestInit {
  return {
    ...options,
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      ...options?.headers,
    },
    cache: "no-store",
  };
}

/**
 * Utility function to parse SSE data as JSON with error handling
 */
export function parseSSEData<T>(data: string): T {
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new Error(
      `Failed to parse SSE data as JSON: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }
}

/**
 * Creates an AbortController with timeout for SSE connections
 */
export function createSSEAbortController(timeoutMs?: number): AbortController {
  const controller = new AbortController();

  if (timeoutMs && timeoutMs > 0) {
    setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new Error(`SSE connection timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  }

  return controller;
}

/**
 * Utility to handle SSE connection with automatic retry logic
 */
export async function* createRetryableSSEStream(
  params: EventSourceParams,
  options: {
    maxRetries?: number;
    retryDelayMs?: number;
    timeoutMs?: number;
  } = {},
): AsyncIterableIterator<EventSourceMessage> {
  const { maxRetries = 3, retryDelayMs = 1000, timeoutMs } = options;
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    try {
      const controller = createSSEAbortController(timeoutMs);
      const eventSource = await createEventSource({
        ...params,
        options: {
          ...params.options,
          signal: controller.signal,
        },
      });

      for await (const message of eventSource.consume()) {
        yield message;
        retryCount = 0; // Reset retry count on successful message
      }

      // If we reach here, the stream ended normally
      break;
    } catch (error) {
      retryCount++;

      if (retryCount > maxRetries) {
        throw error;
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * retryCount));
    }
  }
}
