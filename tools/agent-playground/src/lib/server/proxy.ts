import type { RequestHandler } from "@sveltejs/kit";
import { Agent } from "undici";

/** Platform `RequestInit` augmented with undici's non-standard
 * `dispatcher` extension. Lets us pass our long-lived dispatcher into
 * `fetch()` without a blanket `as any` cast.
 *
 * Why we extend the *platform* `RequestInit` rather than importing
 * undici's: undici 7 narrows `body` to `string | DataView | FormData |
 * ReadableStream | URLSearchParams | Blob`, dropping the platform's
 * support for `ArrayBufferView` (and therefore `Uint8Array`). We
 * construct the proxied body via `new Uint8Array(await
 * request.arrayBuffer())` further down, so the platform's looser
 * `BodyInit` is the right base type. The structural mismatch on
 * `dispatcher` is the only thing the local extension bridges. */
interface UndiciRequestInit extends RequestInit {
  dispatcher?: Agent;
}

// Node's bundled undici ships a 300_000ms (5-min) default
// `headersTimeout` and `bodyTimeout` on the global fetch. Long-running
// daemon endpoints — chiefly `POST /api/workspaces/{id}/signals/{id}`
// for jobs like `reindex`, where the daemon awaits the cascade before
// returning headers — exceed that and the proxy fetch fails with
// `UND_ERR_HEADERS_TIMEOUT`. The catch-all then aborts the SvelteKit
// request, the daemon's `onClientAbort` handler cancels the in-flight
// session, and a 30-min reindex dies at exactly t+5min.
//
// Bound — don't disable. A `0` ceiling means a wedged daemon parks
// SvelteKit request workers indefinitely with no server-side back-
// pressure. Use a dedicated dispatcher with a 1-hour ceiling: covers
// the worst documented job (30-min reindex) with headroom, and still
// fails fast on a genuinely-stuck socket. Connection-level timeouts
// (TCP, TLS handshake) keep their defaults because those still
// indicate actual upstream sickness, not slow work.
export const PROXY_DISPATCHER_TIMEOUT_MS = 60 * 60_000;
/** Both timeout knobs the dispatcher needs (headers + body) — exported
 * as a frozen object so tests can assert that BOTH are pinned to
 * `PROXY_DISPATCHER_TIMEOUT_MS` together, not just one. Per PR #314
 * review (Vpr99): a partial-revert that did
 * `new Agent({ headersTimeout: 5000, bodyTimeout: PROXY_DISPATCHER_TIMEOUT_MS })`
 * would still pass an assertion that only checked the constant value
 * AND the dispatcher-identity check, because undici doesn't expose
 * dispatcher options for direct inspection. Test against this object
 * to lock the contract for both knobs. */
export const PROXY_DISPATCHER_OPTIONS = {
  headersTimeout: PROXY_DISPATCHER_TIMEOUT_MS,
  bodyTimeout: PROXY_DISPATCHER_TIMEOUT_MS,
} as const;
/** Exported so tests can assert identity (`toBe(longLivedDispatcher)`)
 * — `toBeInstanceOf(Agent)` would let a bare `new Agent({})` regression
 * pass while reintroducing the original 5-min default. */
export const longLivedDispatcher = new Agent(PROXY_DISPATCHER_OPTIONS);

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

  const upstreamStartedAt = Date.now();
  const init: UndiciRequestInit = {
    method: request.method,
    headers,
    body,
    signal: upstreamController.signal,
    // Forward 3xx as-is. Node's fetch defaults to redirect: "follow",
    // which silently walks Location headers on the SSR side — fatal
    // for OAuth, where the browser must navigate to accounts.google.com
    // itself, not receive Google's HTML rendered under localhost:5200.
    redirect: "manual",
    // `dispatcher` is undici's non-standard extension; it's accepted
    // by Node's global fetch (which is undici under the hood) and
    // routes this call through our longer-bound timeout pool.
    dispatcher: longLivedDispatcher,
  };

  let res: Response;
  try {
    res = await fetch(target, init);
  } catch (err) {
    request.signal.removeEventListener("abort", abortUpstream);
    const message = err instanceof Error ? err.message : String(err);
    const elapsedMs = Date.now() - upstreamStartedAt;
    // Surface the elapsed time so a stuck upstream is observable in
    // the dev playground logs — without this, a 1-hour-bound timeout
    // looks identical to "request handler hung" to the operator.
    console.warn(
      `[${label} proxy] fetch failed after ${elapsedMs}ms: ${message}`,
    );
    return new Response(
      JSON.stringify({
        error: `${label} proxy fetch failed: ${message}`,
        elapsedMs,
      }),
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

/** Build a SvelteKit `RequestHandler` that reverse-proxies the path
 * parameter (`params.path`, set by the catch-all `[...path]/+server.ts`
 * route) to the upstream service. Used by both `/api/daemon/*` and
 * `/api/tunnel/*` so they stay behaviorally identical. */
export function buildProxyHandler({ upstream, label }: BuildProxyOptions): RequestHandler {
  return ({ params, request }) => {
    const path = params.path ?? "";
    const target = new URL(`/${path}`, upstream);
    target.search = new URL(request.url).search;
    return executeProxyFetch(target, request, label);
  };
}

/** Build a Hono handler that reverse-proxies requests mounted at
 * `/api/${label}/*` to the upstream service. Used by the compiled
 * `playground` binary (`static-app.ts`) where the SvelteKit dev server is
 * unavailable and Hono mounts the `/api/{daemon,tunnel}/*` routes directly.
 * Lives here (next to `buildProxyHandler` + `executeProxyFetch`) so both
 * runtimes share the same OAuth-critical semantics and can be exercised by
 * a single Node-compatible test suite.
 *
 * The mount prefix is derived from `label` (`/api/${label}`) — the same
 * value `executeProxyFetch` stamps into `x-forwarded-prefix`. Keeping one
 * source of truth prevents the two from silently diverging (mount stripped
 * `/foo` while the upstream received `x-forwarded-prefix: /api/daemon`
 * would surface as wrong external URLs downstream, e.g. OAuth callbacks). */
export function buildHonoProxy(upstream: string, label: string) {
  const prefix = `/api/${label}`;
  return (c: { req: { url: string; raw: Request } }) => {
    const url = new URL(c.req.url);
    const path = url.pathname.startsWith(prefix)
      ? url.pathname.slice(prefix.length)
      : url.pathname;
    const target = new URL(path + url.search, upstream);
    return executeProxyFetch(target, c.req.raw, label);
  };
}
