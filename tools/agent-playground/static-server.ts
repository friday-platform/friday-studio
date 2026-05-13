/**
 * Production entry point for the bundled `playground` binary.
 *
 * Serves the SvelteKit static build (`build/`) on a fixed port, proxies
 * `/api/daemon/*` to the local atlasd daemon, and forwards `/api/*` to
 * the embedded Hono router. The build output is embedded into the binary
 * via `deno compile --include build`, so the executable is fully
 * self-contained.
 */
import process from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serveStatic } from "hono/deno";
import { api } from "./src/lib/server/router.ts";
import { resolveBrowserTlsPaths } from "./tls-paths.ts";

const PORT = Number(process.env.PLAYGROUND_PORT ?? "5200");
const HOST = process.env.PLAYGROUND_HOST ?? "127.0.0.1";

// Browser-facing TLS for this origin. The cert here must be browser-trusted
// (mkcert-signed); the s2s `FRIDAY_TLS_CERT/_KEY` pair used by daemon +
// tunnel is private-CA-signed and intentionally not browser-trusted —
// browser traffic to those services goes through this origin's
// /api/{daemon,tunnel}/* proxies instead. When a pair is found, `Deno.serve`
// negotiates h2 over ALPN and the per-origin 6-socket HTTP/1.1 cap goes
// away. No cert → HTTP fallback, behaviour unchanged.
const tlsPaths = resolveBrowserTlsPaths();
const TLS = tlsPaths
  ? { cert: Deno.readTextFileSync(tlsPaths.certPath), key: Deno.readTextFileSync(tlsPaths.keyPath) }
  : null;
const SCHEME = TLS ? "https" : "http";
// Daemon and tunnel scheme depend on their own s2s cert env, not on this
// origin's browser cert. They're separate listeners with separate certs.
const S2S_SCHEME = process.env.FRIDAY_TLS_CERT && process.env.FRIDAY_TLS_KEY ? "https" : "http";
const DAEMON_URL = process.env.FRIDAYD_URL ?? `${S2S_SCHEME}://localhost:8080`;
const TUNNEL_URL = process.env.EXTERNAL_TUNNEL_URL ?? `${S2S_SCHEME}://localhost:9090`;

// Resolve `./build` relative to this source file, so the path is correct
// both when running via `deno run` from any cwd and when running as a
// `deno compile`'d binary (which embeds the build dir at this same path).
const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD_ROOT = join(HERE, "build");
const INDEX_HTML = join(BUILD_ROOT, "index.html");

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

// Reverse proxy for browser → local service. The SvelteKit dev server has
// per-route versions of this under src/routes/api/{daemon,tunnel}/[...path]/,
// but adapter-static strips all server routes — the production binary has
// no proxy unless we explicitly mount it. Without it,
// /api/daemon/api/workspaces/X falls through to the SPA fallback returning
// index.html, surfacing as "Unexpected token '<', '<!doctype' is not valid
// JSON" on every page that loads workspace config.
function buildProxy(prefix: string, upstream: string, label: string) {
  return async (c: { req: { url: string; method: string; raw: Request } }) => {
    const url = new URL(c.req.url);
    const path = url.pathname.replace(new RegExp(`^${prefix}`), "");
    const target = new URL(path + url.search, upstream);

    const headers = new Headers(c.req.raw.headers);
    headers.delete("host");
    headers.delete("content-length");

    // Buffer the request body for methods that carry one. Streaming with
    // `duplex: "half"` races the response: when the upstream short-circuits
    // (e.g. 401 before consuming the body) the in-flight body sender can
    // error with `TypeError: fetch failed`, swallowing the real status code.
    let body: BodyInit | null = null;
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      body = new Uint8Array(await c.req.raw.arrayBuffer());
    }

    const upstreamController = new AbortController();
    const abortUpstream = () => upstreamController.abort();
    c.req.raw.signal.addEventListener("abort", abortUpstream, { once: true });

    let res: Response;
    try {
      res = await fetch(target, {
        method: c.req.method,
        headers,
        body,
        signal: upstreamController.signal,
      });
    } catch (err) {
      c.req.raw.signal.removeEventListener("abort", abortUpstream);
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: `${label} proxy fetch failed: ${message}` }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }

    // Strip headers that don't survive the proxy / HTTP/2 boundary:
    //  - content-encoding: fetch() already decompressed; forwarding makes
    //    the browser double-decompress.
    //  - content-length: chunked re-encoding may invalidate it.
    //  - HTTP/1.1 connection-specific headers: when this binary serves TLS
    //    (https://) the Deno HTTP server negotiates h2 with the browser;
    //    h2 forbids `transfer-encoding`, `connection`, etc. The upstream
    //    is h1.1, so its responses carry these — drop them.
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

    // SSE: pass the body stream through unbuffered so live event streams
    // don't get held up at our proxy boundary. Wrap the body so browser
    // disconnects cancel the upstream fetch instead of leaving
    // subscriptions and file descriptors open behind the proxy.
    if (res.headers.get("content-type")?.includes("text/event-stream")) {
      if (!res.body) {
        c.req.raw.signal.removeEventListener("abort", abortUpstream);
        return new Response(null, { status: res.status, headers: responseHeaders });
      }
      c.req.raw.signal.removeEventListener("abort", abortUpstream);
      const stream = proxyAbortableBody(res.body, c.req.raw.signal, abortUpstream);
      return new Response(stream, { status: res.status, headers: responseHeaders });
    }

    c.req.raw.signal.removeEventListener("abort", abortUpstream);
    return new Response(res.body, { status: res.status, headers: responseHeaders });
  };
}

const proxies = new Hono()
  .all("/api/daemon/*", buildProxy("/api/daemon", DAEMON_URL, "daemon"))
  .all("/api/tunnel/*", buildProxy("/api/tunnel", TUNNEL_URL, "tunnel"));

let CACHED_HTML: string | null = null;
async function indexHtml(): Promise<string> {
  if (CACHED_HTML === null) CACHED_HTML = await Deno.readTextFile(INDEX_HTML);
  return CACHED_HTML;
}

const app = new Hono()
  .route("/", proxies)
  .route("/", api)
  .get("/", async (c) => c.html(await indexHtml()))
  .use(
    "/*",
    serveStatic({
      root: BUILD_ROOT,
      rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
    }),
  )
  // SPA fallback: any GET that doesn't resolve to a file or `/api/*` route
  // gets the SvelteKit shell so client-side routing can take over.
  .get("/*", async (c) => c.html(await indexHtml()));

// Log only origins (protocol+host+port) — these are config URLs the user
// expects in plain text, but never log paths or query strings.
function origin(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return "<invalid url>";
  }
}
console.log(`[playground] listening on ${SCHEME}://${HOST}:${PORT}`);
console.log(`[playground] daemon proxy → ${origin(DAEMON_URL)}`);
console.log(`[playground] tunnel proxy → ${origin(TUNNEL_URL)}`);
Deno.serve(
  TLS ? { port: PORT, hostname: HOST, cert: TLS.cert, key: TLS.key } : { port: PORT, hostname: HOST },
  app.fetch,
);
