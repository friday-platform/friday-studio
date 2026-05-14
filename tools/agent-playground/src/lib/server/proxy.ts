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
  /** Short label used in 502 error bodies and X-Forwarded-Prefix —
   * "daemon" or "tunnel". */
  label: string;
}

/** Core reverse-proxy execution: forwards `request` to `target`, sets
 * X-Forwarded-* + `redirect: "manual"`, strips hop-by-hop headers, and
 * preserves SSE / abort semantics. Shared by `buildProxyHandler`
 * (SvelteKit dev hook) and `static-server.ts:buildProxy` (the compiled
 * playground binary) so both paths can't drift again on header / redirect
 * semantics — see `static-server.ts:buildProxy` for the binary wrapper.
 *
 * Defense-in-depth: this is an unauthenticated pass-through. Any caller
 * who reaches the playground origin can inject X-Forwarded-Host. Trust
 * is enforced individually by each downstream consumer, e.g.:
 *   - `apps/atlasd/routes/link.ts` — dev-only middleware
 *   - `apps/atlasd/routes/me/index.ts:10-12` — session-cookie auth on
 *     reads, but persists the resolved URL to user records, so the host
 *     becomes sticky
 * Keep this function dumb — new daemon endpoints consuming these headers
 * must enforce trust on their own boundary, not here.
 */
export async function executeProxyFetch(
  target: URL,
  request: Request,
  label: string,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");

  // Tell the upstream where the browser actually lives. Required for
  // services like Link that synthesize external callback URLs from
  // X-Forwarded-* — otherwise they emit URLs pointing at the upstream's
  // own s2s listener (cert not browser-trusted → ERR_CERT_AUTHORITY_INVALID
  // when the OAuth provider redirects the browser back).
  const incoming = new URL(request.url);
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));
  headers.set("x-forwarded-prefix", `/api/${label}`);

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
      // Forward 3xx as-is. Node's fetch defaults to redirect: "follow",
      // which silently walks Location headers on the SSR side — fatal
      // for OAuth, where the browser must navigate to accounts.google.com
      // itself, not receive Google's HTML rendered under localhost:5200.
      redirect: "manual",
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
}

/** Build a SvelteKit `RequestHandler` that reverse-proxies the
 * `/api/${label}/*` path to the upstream service. Used by both
 * `/api/daemon/*` and `/api/tunnel/*` so they stay behaviorally identical.
 *
 * The post-prefix path is taken from the raw `request.url` pathname rather
 * than SvelteKit's `params.path`, because SvelteKit decodes captured rest
 * params — which corrupts identifiers that contain percent-encoded slashes
 * (e.g. GitHub chat IDs like `github:owner/repo:issue:N`). Mirrors
 * `buildHonoProxy` below. */
export function buildProxyHandler({ upstream, label }: BuildProxyOptions): RequestHandler {
  const prefix = `/api/${label}`;
  return ({ request }) => {
    const incoming = new URL(request.url);
    const path = incoming.pathname.replace(new RegExp(`^${prefix}`), "");
    const target = new URL(path + incoming.search, upstream);
    return executeProxyFetch(target, request, label);
  };
}

/** Build a Hono handler that reverse-proxies requests matching `prefix` to
 * the upstream service. Used by the compiled `playground` binary
 * (`static-server.ts`) where the SvelteKit dev server is unavailable and
 * Hono mounts the `/api/{daemon,tunnel}/*` routes directly. Lives here
 * (next to `buildProxyHandler` + `executeProxyFetch`) so both runtimes
 * share the same OAuth-critical semantics and can be exercised by a
 * single Node-compatible test suite. */
export function buildHonoProxy(prefix: string, upstream: string, label: string) {
  return (c: { req: { url: string; raw: Request } }) => {
    const url = new URL(c.req.url);
    const path = url.pathname.replace(new RegExp(`^${prefix}`), "");
    const target = new URL(path + url.search, upstream);
    return executeProxyFetch(target, c.req.raw, label);
  };
}
