import type { RequestHandler } from "@sveltejs/kit";

/** Hop-by-hop / connection-specific headers that don't survive the
 * proxy or HTTP/2 boundary:
 *  - content-encoding: fetch() already decompressed; forwarding makes
 *    the browser double-decompress.
 *  - content-length: chunked re-encoding may invalidate it.
 *  - RFC 7230 connection-specific headers: when the playground serves
 *    TLS the dev server negotiates h2 with the browser; h2 forbids
 *    `transfer-encoding`, `connection`, etc. The upstream daemon /
 *    tunnel is h1.1, so its responses carry these — drop them.
 */
export const HOP_BY_HOP_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "proxy-connection",
  "te",
  "trailer",
] as const;

/** Wrap an upstream body stream so the consumer's `AbortSignal` cancels
 * the upstream fetch instead of leaving subscriptions and file
 * descriptors open. Used for SSE responses where the body is long-lived
 * and we can't rely on response completion to trigger cleanup. */
export function proxyAbortableBody(
  body: ReadableStream<Uint8Array>,
  requestSignal: AbortSignal,
  abortUpstream: () => void,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;

  const cancelUpstream = () => {
    if (cancelled) return;
    cancelled = true;
    abortUpstream();
    void reader?.cancel().catch(() => {
      // The upstream may already be gone.
    });
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      reader = body.getReader();
      requestSignal.addEventListener("abort", cancelUpstream, { once: true });
      if (requestSignal.aborted) cancelUpstream();

      void (async () => {
        try {
          while (!cancelled) {
            const { done, value } = await reader!.read();
            if (done) break;
            controller.enqueue(value);
          }
          if (!cancelled) controller.close();
        } catch (err) {
          if (!cancelled) controller.error(err);
        } finally {
          requestSignal.removeEventListener("abort", cancelUpstream);
          try {
            reader?.releaseLock();
          } catch {
            // Reader may already be released after cancellation.
          }
          abortUpstream();
        }
      })();
    },
    cancel() {
      cancelUpstream();
    },
  });
}

export interface BuildProxyOptions {
  /** Absolute URL of the upstream service (daemon or tunnel). */
  upstream: string;
  /** Short label used in 502 error bodies — "daemon" or "tunnel". */
  label: string;
}

/** Build a SvelteKit `RequestHandler` that reverse-proxies the path
 * parameter (`params.path`, set by the catch-all `[...path]/+server.ts`
 * route) to the upstream service. Used by both `/api/daemon/*` and
 * `/api/tunnel/*` so they stay behaviorally identical. */
export function buildProxyHandler({ upstream, label }: BuildProxyOptions): RequestHandler {
  return async ({ params, request }) => {
    const path = params.path ?? "";
    const target = new URL(`/${path}`, upstream);
    target.search = new URL(request.url).search;

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");

    const upstreamController = new AbortController();
    const abortUpstream = () => upstreamController.abort();
    request.signal.addEventListener("abort", abortUpstream, { once: true });

    // Buffer the request body for methods that carry one. Streaming with
    // `duplex: "half"` races the response: when the upstream short-
    // circuits (e.g. 401 before consuming the body) the in-flight body
    // sender can error with `TypeError: fetch failed`, swallowing the
    // upstream's real status code.
    let body: BodyInit | null = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = new Uint8Array(await request.arrayBuffer());
    }

    let res: Response;
    try {
      res = await fetch(target, {
        method: request.method,
        headers,
        body,
        signal: upstreamController.signal,
      });
    } catch (err) {
      request.signal.removeEventListener("abort", abortUpstream);
      const message = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: `${label} proxy fetch failed: ${message}` }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }

    const responseHeaders = new Headers(res.headers);
    for (const h of HOP_BY_HOP_HEADERS) responseHeaders.delete(h);

    if (res.headers.get("content-type")?.includes("text/event-stream")) {
      if (!res.body) {
        request.signal.removeEventListener("abort", abortUpstream);
        return new Response(null, { status: res.status, headers: responseHeaders });
      }
      request.signal.removeEventListener("abort", abortUpstream);
      const stream = proxyAbortableBody(res.body, request.signal, abortUpstream);
      return new Response(stream, { status: res.status, headers: responseHeaders });
    }

    request.signal.removeEventListener("abort", abortUpstream);
    return new Response(res.body, { status: res.status, headers: responseHeaders });
  };
}
