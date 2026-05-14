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
// The launcher migrates stale http:// values in .env to https:// at boot
// (tools/friday-launcher/cert_env.go::migrateStaleURLSchemes) when the
// s2s mesh is up, so a literal env-var read here matches whatever the
// daemon / tunnel actually listen on. No consumer-side auto-upgrade
// needed — single source of truth lives in the launcher.
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

// OAuth callback shim. Gemini CLI Workspace Extension's Cloud Function
// (the public OAuth exchanger our Google providers piggy-back on for
// the verified consent screen) does a literal string check on the
// `state.uri` hostname — only `localhost` and `127.0.0.1` are allowed;
// see https://github.com/gemini-cli-extensions/workspace/blob/main/
// cloud_function/index.js#L91-L104. The desktop install opens the
// browser at `https://local.hellofriday.ai:PORT` because that's the
// only hostname the browser-trusted cert covers, so a callback URL
// derived from X-Forwarded-Host (e.g. local.hellofriday.ai:15200)
// fails that check and the Cloud Function falls back to its manual
// JSON-paste page — surfaces to the user as "what the fuck is this
// screen". The shim accepts the callback hop on plain HTTP at
// 127.0.0.1 (Cloud-Function-compatible host, no cert required) and
// 302-redirects to the same path + query on the TLS playground
// origin so the rest of the existing /api/daemon/api/link/v1/callback
// chain runs unchanged.
//
// The shim is intentionally minimal: it accepts only the canonical
// callback path prefix and rejects everything else with 404. No body,
// no method other than GET — anything weird is somebody probing us,
// not the OAuth flow.
const SHIM_PORT = Number(process.env.PLAYGROUND_OAUTH_SHIM_PORT ?? "0");
const SHIM_PATH_PREFIX = "/api/daemon/api/link/v1/callback/";
if (TLS && SHIM_PORT > 0) {
  // The TLS origin we redirect TO — must match the cert's CN so the
  // browser doesn't flash a warning between the Cloud Function and
  // Link's callback handler.
  const tlsOriginHost = process.env.PLAYGROUND_TLS_HOSTNAME ?? "local.hellofriday.ai";
  const tlsOrigin = `https://${tlsOriginHost}:${PORT}`;
  console.log(`[playground] oauth-shim listening on http://127.0.0.1:${SHIM_PORT}`);
  console.log(`[playground] oauth-shim redirects → ${tlsOrigin}${SHIM_PATH_PREFIX}*`);
  Deno.serve({ port: SHIM_PORT, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);
    if (req.method !== "GET" || !url.pathname.startsWith(SHIM_PATH_PREFIX)) {
      return new Response("not found", { status: 404 });
    }
    const target = `${tlsOrigin}${url.pathname}${url.search}`;
    return Response.redirect(target, 302);
  });
}
