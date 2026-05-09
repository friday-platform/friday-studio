import type { RequestHandler } from "@sveltejs/kit";
import { DAEMON_BASE_URL } from "$lib/daemon-url";

/**
 * Proxy all HTTP methods to the local daemon.
 * Strips the `/api/daemon` prefix and forwards the rest of the path.
 * SSE responses (`text/event-stream`) are passed through without buffering.
 */
function proxyAbortableBody(
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

const handler: RequestHandler = async ({ params, request }) => {
  const path = params.path ?? "";
  const target = new URL(`/${path}`, DAEMON_BASE_URL);
  target.search = new URL(request.url).search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");

  const upstreamController = new AbortController();
  const abortUpstream = () => upstreamController.abort();
  request.signal.addEventListener("abort", abortUpstream, { once: true });

  // Buffer the request body for methods that carry one. Streaming with
  // `duplex: "half"` races the response: when the daemon short-circuits
  // (e.g. 401 from requireUser before consuming the body) the in-flight
  // body sender can error with `TypeError: fetch failed`, swallowing the
  // upstream's real status code. Buffering eliminates the race so the
  // browser sees the actual status and the user gets a useful message.
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
      JSON.stringify({ error: `daemon proxy fetch failed: ${message}` }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  // Strip headers that don't survive the proxy / HTTP/2 boundary:
  //  - content-encoding: fetch() already decompressed; forwarding makes
  //    the browser try to decompress again.
  //  - content-length: chunked re-encoding by the dev server breaks the
  //    invariant; let the framework recompute (or omit and stream).
  //  - HTTP/1.1 connection-specific headers: HTTP/2 forbids them
  //    (Node throws ERR_HTTP2_INVALID_CONNECTION_HEADERS at writeHead).
  //    The daemon serves h1.1 to us; the browser talks h2 to vite, so
  //    the SvelteKit response writer hits Http2ServerResponse and rejects
  //    `transfer-encoding: chunked`. Same applies to SSE responses.
  const responseHeaders = new Headers(res.headers);
  for (const h of [
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "upgrade",
    "proxy-connection",
    "te",
    "trailer",
  ]) {
    responseHeaders.delete(h);
  }

  // SSE: proxy with explicit cancellation. Returning `res.body` directly
  // leaves the upstream daemon fetch alive when the browser closes the
  // EventSource/fetch, which leaks daemon subscriptions and dev-server fds.
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

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
