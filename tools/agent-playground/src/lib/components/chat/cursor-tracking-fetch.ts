/**
 * `fetch` wrapper that threads SSE event ids through the AI SDK's
 * `DefaultChatTransport` so cursored stream resume works reliably.
 *
 * Two hooks:
 *
 *   1. Outgoing: when the caller signals a resume request (via
 *      {@link CursorTrackingFetchOptions.isResumeRequest}) and a cursor is
 *      currently tracked, attach `Last-Event-ID: <cursor>` so the server
 *      skips events the client has already rendered.
 *
 *   2. Incoming: pipe the response body through a `TransformStream` that
 *      scans for SSE `id: <n>` lines and updates the cursor to the highest
 *      id seen. Bytes pass through unchanged so the AI SDK parser sees the
 *      same payload — its `parseJsonEventStream` only consumes `data:`
 *      lines and ignores `id:`, which is why the cursor must be tracked
 *      out-of-band.
 *
 * Cursor-commit timing matters: an SSE event is `id: N\ndata: {…}\n\n` and
 * the empty line is the dispatch boundary. The cursor must only commit
 * `setCursor(N)` AFTER the empty line passes through — otherwise a
 * connection drop between `id: N\n` and `data:`/terminator leaves the AI
 * SDK without event N (still buffering in eventsource-parser) but the
 * cursor already advanced. Resume then skips event N on the server side
 * and the SDK throws "tool-input-delta for missing tool call with ID …" →
 * error → resume → loop. Tracking a `pendingId` and promoting it on the
 * empty-line terminator fixes this race.
 */

/** Statuses the fetch spec defines as null-body — see whatwg/fetch §2.2.6. */
const NULL_BODY_STATUS: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

export interface CursorTrackingFetchOptions {
  /** Read the current cursor; `undefined` means "no cursor yet". */
  getCursor(): number | undefined;
  /** Commit a higher cursor; only invoked when strictly greater than current. */
  setCursor(value: number): void;
  /** True when the request should carry `Last-Event-ID` (e.g. resume endpoint). */
  isResumeRequest(input: Request | URL | string): boolean;
  /** Override `globalThis.fetch` — primarily for tests. */
  fetchImpl?: typeof fetch;
}

export type TrackingFetch = (
  input: Request | URL | string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Build a `fetch` wrapper bound to an external cursor cell. The cursor
 * lives outside this module (typically a Svelte `$state` in the chat
 * component) so the wrapper can be used without owning reactive state.
 */
export function createCursorTrackingFetch(options: CursorTrackingFetchOptions): TrackingFetch {
  const { getCursor, setCursor, isResumeRequest, fetchImpl = fetch } = options;

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

    // Pass-through for non-success and bodyless responses. The null-body
    // status check matters because constructing `new Response(stream,
    // {status: 204})` throws "Response with null body status cannot have
    // body" — and the resume endpoint returns 204 when the chat has
    // already finished, which we'd otherwise wrap on rehydrate.
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

/**
 * `TransformStream` that scans an SSE byte stream for `id:` lines and
 * commits the highest seen id to the cursor on each event terminator.
 * Exported for unit tests; production code should use
 * {@link createCursorTrackingFetch}.
 */
export function createCursorTracker(
  options: CursorTrackerOptions,
): TransformStream<Uint8Array, Uint8Array> {
  const { getCursor, setCursor } = options;
  const decoder = new TextDecoder();
  let textBuf = "";
  let pendingId: number | undefined;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Forward the raw bytes immediately — downstream consumers (the AI
      // SDK parser) must see exactly what the server sent. The cursor
      // bookkeeping is a side-effect of the same scan.
      controller.enqueue(chunk);

      textBuf += decoder.decode(chunk, { stream: true });
      // SSE per WHATWG accepts LF, CR, or CRLF as line terminators. Splitting
      // on LF and stripping a trailing CR covers all three without an extra
      // regex pass.
      let nl = textBuf.indexOf("\n");
      while (nl !== -1) {
        let line = textBuf.slice(0, nl);
        textBuf = textBuf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          // SSE event terminator: pendingId's full event has now been
          // forwarded downstream. Safe to commit the cursor.
          if (pendingId !== undefined) {
            const current = getCursor();
            if (current === undefined || pendingId > current) {
              setCursor(pendingId);
            }
            pendingId = undefined;
          }
        } else if (line.startsWith("id:")) {
          // SSE id field: 'id: <value>' (whitespace after colon optional
          // per spec). Non-negative integer only — the server emits
          // indices into its events buffer.
          const raw = line.slice(3).trim();
          const id = Number.parseInt(raw, 10);
          if (Number.isFinite(id) && id >= 0) {
            pendingId = id;
          }
        }
        nl = textBuf.indexOf("\n");
      }
    },
  });
}
