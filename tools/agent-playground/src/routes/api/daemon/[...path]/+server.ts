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

const handler: RequestHandler = async ({ request }) => {
  // Use the raw pathname from request.url instead of `params.path` because
  // SvelteKit decodes captured params (rest segments included), which turns
  // `%2F` into a literal `/` and corrupts identifiers that contain slashes —
  // e.g. github chat IDs like `github:owner/repo:issue:N`. The daemon's
  // Hono routes accept percent-encoded path params correctly, so we forward
  // the path verbatim.
  const incoming = new URL(request.url);
  const daemonPath = incoming.pathname.replace(/^\/api\/daemon/, "");
  const target = new URL(daemonPath + incoming.search, DAEMON_BASE_URL);

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
    return new Response(JSON.stringify({ error: `daemon proxy fetch failed: ${message}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  // SSE: proxy with explicit cancellation. Returning `res.body` directly
  // leaves the upstream daemon fetch alive when the browser closes the
  // EventSource/fetch, which leaks daemon subscriptions and dev-server fds.
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    if (!res.body) {
      request.signal.removeEventListener("abort", abortUpstream);
      return new Response(null, { status: res.status, headers: res.headers });
    }
    request.signal.removeEventListener("abort", abortUpstream);
    const stream = proxyAbortableBody(res.body, request.signal, abortUpstream);
    return new Response(stream, { status: res.status, headers: res.headers });
  }

  request.signal.removeEventListener("abort", abortUpstream);

  // Strip content-encoding — fetch() already decompresses the body,
  // so forwarding the header causes the browser to double-decompress.
  const responseHeaders = new Headers(res.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");

  return new Response(res.body, { status: res.status, headers: responseHeaders });
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
