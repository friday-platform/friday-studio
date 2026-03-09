/**
 * Shared SSE (Server-Sent Events) parser utilities.
 *
 * Handles byte stream buffering, double-newline boundary splitting, and field
 * extraction (`event:`, `data:`). Supports all WHATWG spec line endings
 * (CRLF, LF, CR). Schema-agnostic — consumers apply their own Zod parse on
 * the yielded messages.
 *
 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html
 * @module
 */

/** A single parsed SSE message with optional event name and data payload. */
export interface SSEMessage {
  event?: string;
  data: string;
}

/**
 * Normalizes CRLF and CR line endings to LF per the WHATWG SSE spec.
 *
 * Order matters: CRLF must be replaced before bare CR to avoid double
 * conversion (`\r\n` -> `\n\n`).
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Parses an SSE byte stream into raw {@link SSEMessage} objects.
 *
 * Handles:
 * - Byte buffering with `TextDecoder` streaming mode
 * - Line ending normalization (CRLF, LF, CR per WHATWG spec)
 * - Double-newline boundary detection for message separation
 * - Multi-line `data:` field concatenation
 * - `event:` field extraction
 * - Skipping comments (`:` prefix) and empty messages
 *
 * @param body - A `ReadableStream<Uint8Array>` from a fetch response
 * @yields Parsed SSE messages (only those with a non-empty `data` field)
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += normalizeLineEndings(decoder.decode(value, { stream: true }));

      // Process complete SSE messages (separated by double newline)
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

/**
 * Parses a single raw SSE message block into an {@link SSEMessage}.
 *
 * Extracts `event:` and `data:` fields from the raw text between `\n\n`
 * boundaries. Multi-line `data:` fields are concatenated with newlines.
 * Comments (lines starting with `:`) and other fields (`id:`, `retry:`)
 * are ignored.
 *
 * @param raw - The raw SSE message text (content between `\n\n` boundaries)
 * @returns Parsed message, or `null` if the block contains no `data:` field
 */
export function parseSSEMessage(raw: string): SSEMessage | null {
  let data = "";
  let event = "";

  for (const line of normalizeLineEndings(raw).split("\n")) {
    if (line.startsWith("data:")) {
      // Concatenate multi-line data fields
      data += (data ? "\n" : "") + line.slice(5).trim();
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    }
    // Ignore comments (: prefix) and other fields (id:, retry:)
  }

  if (!data) return null;

  return event ? { event, data } : { data };
}
