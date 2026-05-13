/**
 * `fetch` wrapper that threads SSE event ids through `DefaultChatTransport`.
 *
 * Outgoing: attaches `Last-Event-ID: <cursor>` on resume requests.
 * Incoming: scans the body for `id:` lines and commits the cursor on the
 * SSE empty-line terminator.
 *
 * Commit-on-terminator (not commit-on-id): a drop between `id: N\n` and
 * the data line would advance the cursor past an event the AI SDK's
 * parser hasn't yet seen. The next resume would then skip event N and
 * trip "tool-input-delta for missing tool call with ID …" → error →
 * resume → loop.
 */

/** whatwg/fetch §2.2.6 — `new Response(stream, { status })` throws for these. */
const NULL_BODY_STATUS: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

/** Server marker on a 410 resume response: buffer overflowed, no replay possible. */
const REPLAY_DISABLED_HEADER = "X-Stream-Replay-Disabled";

export interface CursorTrackingFetchOptions {
  getCursor(): number | undefined;
  setCursor(value: number): void;
  isResumeRequest(input: Request | URL | string): boolean;
  /**
   * Fired when the server signals the SSE buffer can't be replayed
   * (`410 Gone` + `X-Stream-Replay-Disabled: true`). Lets the caller
   * short-circuit auto-resume so it doesn't burn its retry budget on
   * a status that won't change.
   */
  onUnrecoverable?(): void;
  fetchImpl?: typeof fetch;
}

export type TrackingFetch = (
  input: Request | URL | string,
  init?: RequestInit,
) => Promise<Response>;

export function createCursorTrackingFetch(options: CursorTrackingFetchOptions): TrackingFetch {
  const { getCursor, setCursor, isResumeRequest, onUnrecoverable, fetchImpl = fetch } = options;

  return async (input, init) => {
    let mergedInit = init;
    if (isResumeRequest(input)) {
      const cursor = getCursor();
      if (cursor !== undefined) {
        const headers = new Headers(init?.headers);
        headers.set("Last-Event-ID", String(cursor));
        mergedInit = { ...init, headers };
      }
    }

    const response = await fetchImpl(input as RequestInfo, mergedInit);

    if (
      response.status === 410 &&
      response.headers.get(REPLAY_DISABLED_HEADER) === "true"
    ) {
      onUnrecoverable?.();
    }

    // Resume endpoint returns 204 on finished chats — wrapping that throws.
    if (!response.ok || !response.body || NULL_BODY_STATUS.has(response.status)) {
      return response;
    }

    return new Response(
      response.body.pipeThrough(createCursorTracker({ getCursor, setCursor })),
      response,
    );
  };
}

interface CursorTrackerOptions {
  getCursor(): number | undefined;
  setCursor(value: number): void;
}

/** Exported for unit tests. Production code should use {@link createCursorTrackingFetch}. */
export function createCursorTracker(
  options: CursorTrackerOptions,
): TransformStream<Uint8Array, Uint8Array> {
  const { getCursor, setCursor } = options;
  const decoder = new TextDecoder();
  let textBuf = "";
  let pendingId: number | undefined;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);

      textBuf += decoder.decode(chunk, { stream: true });
      // WHATWG SSE accepts LF/CR/CRLF — split on LF, strip trailing CR.
      let nl = textBuf.indexOf("\n");
      while (nl !== -1) {
        let line = textBuf.slice(0, nl);
        textBuf = textBuf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (pendingId !== undefined) {
            const current = getCursor();
            if (current === undefined || pendingId > current) {
              setCursor(pendingId);
            }
            pendingId = undefined;
          }
        } else if (line.startsWith("id:")) {
          const id = Number.parseInt(line.slice(3).trim(), 10);
          if (Number.isFinite(id) && id >= 0) {
            pendingId = id;
          }
        }
        nl = textBuf.indexOf("\n");
      }
    },
  });
}
