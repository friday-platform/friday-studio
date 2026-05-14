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
import { buildHonoProxy } from "./src/lib/server/proxy.ts";
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

// Reverse proxy for browser → local service. The SvelteKit dev server has
// per-route versions of this under src/routes/api/{daemon,tunnel}/[...path]/,
// but adapter-static strips all server routes — the production binary has
// no proxy unless we explicitly mount it. Without it,
// /api/daemon/api/workspaces/X falls through to the SPA fallback returning
// index.html, surfacing as "Unexpected token '<', '<!doctype' is not valid
// JSON" on every page that loads workspace config.
//
// All header rewriting, X-Forwarded-* injection, redirect: "manual",
// SSE + abort handling lives in `src/lib/server/proxy.ts` so the dev hook
// and this binary share a single implementation (and a single test suite).
const proxies = new Hono()
  .all("/api/daemon/*", buildHonoProxy("/api/daemon", DAEMON_URL, "daemon"))
  .all("/api/tunnel/*", buildHonoProxy("/api/tunnel", TUNNEL_URL, "tunnel"));

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
