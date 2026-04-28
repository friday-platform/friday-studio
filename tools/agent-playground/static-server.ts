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

const PORT = Number(process.env.PLAYGROUND_PORT ?? "5200");
const HOST = process.env.PLAYGROUND_HOST ?? "127.0.0.1";
const DAEMON_URL = process.env.FRIDAYD_URL ?? "http://localhost:8080";

// Resolve `./build` relative to this source file, so the path is correct
// both when running via `deno run` from any cwd and when running as a
// `deno compile`'d binary (which embeds the build dir at this same path).
const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD_ROOT = join(HERE, "build");
const INDEX_HTML = join(BUILD_ROOT, "index.html");

// Daemon proxy for /api/daemon/*. The SvelteKit dev server has this as
// src/routes/api/daemon/[...path]/+server.ts, but adapter-static strips
// all server routes — the production binary has no daemon proxy unless
// we explicitly mount one here. Without it, /api/daemon/api/workspaces/X
// falls through to the SPA fallback returning index.html, surfacing as
// "Unexpected token '<', '<!doctype' is not valid JSON" on every page
// that loads workspace config.
const daemonProxy = new Hono().all("/api/daemon/*", async (c) => {
  const url = new URL(c.req.url);
  // Strip the /api/daemon prefix; preserve query string.
  const path = url.pathname.replace(/^\/api\/daemon/, "");
  const target = new URL(path + url.search, DAEMON_URL);

  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  headers.delete("content-length");

  // Buffer the request body for methods that carry one. Streaming with
  // `duplex: "half"` races the response: when the daemon short-circuits
  // (e.g. 401 from requireUser before consuming the body) the in-flight
  // body sender can error with `TypeError: fetch failed`, swallowing the
  // upstream's real status code. Buffering eliminates the race so the
  // browser sees the actual 401 and the user gets a useful message.
  let body: BodyInit | null = null;
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    body = new Uint8Array(await c.req.raw.arrayBuffer());
  }

  let res: Response;
  try {
    res = await fetch(target, { method: c.req.method, headers, body });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `daemon proxy fetch failed: ${message}` }, 502);
  }

  // SSE: pass the body stream through unbuffered so live event streams
  // don't get held up at our proxy boundary.
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    return new Response(res.body, { status: res.status, headers: res.headers });
  }

  // Strip content-encoding/length — fetch() decompressed the body, so
  // forwarding the original encoding header makes the browser try to
  // decompress again. Drop content-length too; chunked is fine.
  const responseHeaders = new Headers(res.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  return new Response(res.body, { status: res.status, headers: responseHeaders });
});

const app = new Hono()
  .route("/", daemonProxy)
  .route("/", api)
  .use(
    "/*",
    serveStatic({
      root: BUILD_ROOT,
      rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
    }),
  )
  // SPA fallback: any GET that doesn't resolve to a file or `/api/*` route
  // gets the SvelteKit shell so client-side routing can take over.
  .get("/*", async (c) => {
    const html = await Deno.readTextFile(INDEX_HTML);
    return c.html(html);
  });

console.log(`[playground] listening on http://${HOST}:${PORT}`);
console.log(`[playground] daemon proxy → ${DAEMON_URL}`);
Deno.serve({ port: PORT, hostname: HOST }, app.fetch);
