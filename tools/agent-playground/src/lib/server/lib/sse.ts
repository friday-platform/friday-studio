/**
 * Framework-agnostic SSE response helper for streaming agent execution events.
 *
 * Uses Web Standards `ReadableStream` + `Response` — no Hono or SvelteKit dependency.
 *
 * @module
 */

import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";

/** Log entry emitted during agent execution. */
export interface LogEntry {
  level: string;
  message: string;
  [key: string]: unknown;
}

/** Trace entry for observability spans. */
export interface TraceEntry {
  spanId: string;
  name: string;
  durationMs: number;
  [key: string]: unknown;
}

/** Stats payload sent with the `done` event. */
export interface DoneStats {
  durationMs: number;
  totalTokens?: number;
  stepCount?: number;
}

/** Typed emitter provided to the executor function. */
export interface SSEEmitter {
  send(event: string, data: unknown): void;
  progress(chunk: AtlasUIMessageChunk): void;
  log(entry: LogEntry): void;
  trace(entry: TraceEntry): void;
  result(payload: unknown): void;
  done(stats: DoneStats): void;
}

/**
 * Creates a streaming SSE `Response` from an async executor function.
 *
 * @param executor - Async function that receives a typed emitter and AbortSignal.
 *   The stream closes when the executor resolves or rejects.
 * @returns A `Response` with `text/event-stream` content type and streaming body.
 */
export function createSSEStream(
  executor: (emitter: SSEEmitter, signal: AbortSignal) => Promise<void>,
): Response {
  const abortController = new AbortController();
  const encoder = new TextEncoder();

  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      /** Encode and enqueue a single SSE frame. Silently drops if stream is closed. */
      function enqueue(event: string, data: unknown): void {
        if (closed) return;
        const json = JSON.stringify(data);
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${json}\n\n`));
      }

      const emitter: SSEEmitter = {
        send: enqueue,
        progress: (chunk) => enqueue("progress", chunk),
        log: (entry) => enqueue("log", entry),
        trace: (entry) => enqueue("trace", entry),
        result: (payload) => enqueue("result", payload),
        done: (stats) => enqueue("done", stats),
      };

      try {
        await executor(emitter, abortController.signal);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        enqueue("error", { error: message });
      } finally {
        closed = true;
        controller.close();
      }
    },
    cancel() {
      closed = true;
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
