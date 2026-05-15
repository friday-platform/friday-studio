/**
 * Minimal Server-Sent Events response helper.
 *
 * Wraps the `ReadableStream` + `text/event-stream` header boilerplate so route
 * handlers can focus on what to emit. The producer receives a writer and an
 * `AbortSignal` that fires when the client disconnects.
 *
 * @module
 */

/** Writes named SSE events to an open stream. */
export interface SSEWriter {
  /** Emit a named event carrying a JSON-serialized data payload. */
  send(event: string, data: unknown): void;
  /** Close the stream. Idempotent. */
  close(): void;
}

/**
 * Build a `text/event-stream` `Response`. The stream stays open until the
 * producer resolves (or the producer calls `writer.close()`); whichever comes
 * first closes it.
 */
export function sseResponse(
  producer: (writer: SSEWriter, signal: AbortSignal) => void | Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writer: SSEWriter = {
        send(event, data) {
          if (closed) return;
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        },
        close() {
          if (closed) return;
          closed = true;
          controller.close();
        },
      };

      try {
        await producer(writer, abort.signal);
      } catch {
        // Producer failures must not leave the stream hanging — fall through
        // to close. The producer owns surfacing the error as an SSE event.
      } finally {
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
      abort.abort();
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
