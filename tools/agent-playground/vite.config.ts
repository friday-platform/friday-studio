import { readFileSync } from "node:fs";
import process from "node:process";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { resolveBrowserTlsPaths } from "./tls-paths.ts";

// HTTP/2 + TLS for the playground origin. Vite 7's `server.https` switches
// the dev server from `node:http` (HTTP/1.1) to `node:http2.createSecureServer`
// with `allowHTTP1: true` fallback — once we hand it cert+key bytes, the
// browser negotiates h2 over ALPN and the 6-socket-per-origin HTTP/1.1
// limit (which deadlocks once the playground's 3 SSE feeds × multiple
// tabs run out of sockets) goes away.
//
// This origin's cert must be browser-trusted: `FRIDAY_BROWSER_TLS_CERT/_KEY`
// (mkcert-signed, system trust store installed by `scripts/setup-tls.sh`).
// The s2s `FRIDAY_TLS_CERT/_KEY` pair is for daemon + tunnel listeners and
// is intentionally NOT browser-trusted — browser traffic to those services
// flows through this origin's `/api/{daemon,tunnel}/*` proxies instead.
const tlsPaths = resolveBrowserTlsPaths();
const tls = tlsPaths
  ? { cert: readFileSync(tlsPaths.certPath), key: readFileSync(tlsPaths.keyPath) }
  : null;
const scheme = tls ? "https" : "http";

// S2S TLS: daemon and tunnel run on https when FRIDAY_TLS_CERT/_KEY is set
// in their environments. NODE_EXTRA_CA_CERTS must point at the private CA
// before Node starts — Node 25 reads it once when the default secure
// context is created, which happens before our config evaluates. The
// `scripts/run-playground-vite.sh` wrapper sets it before exec'ing node.
// Without it, the SvelteKit dev proxy's fetch to https://daemon errors
// with `fetch failed`.
const s2sTls = Boolean(process.env.FRIDAY_TLS_CERT && process.env.FRIDAY_TLS_KEY);
if (s2sTls && !process.env.NODE_EXTRA_CA_CERTS) {
  console.warn(
    "[vite] S2S TLS env set but NODE_EXTRA_CA_CERTS unset — SSR proxy fetches to https daemon will fail. Launch via `deno task playground` (uses scripts/run-playground-vite.sh wrapper).",
  );
}

// Effective daemon URL for SSR-side proxy + Hono route fetches. Honors
// FRIDAYD_URL (launcher / wizard / FAST_DEVELOPMENT mode set this — port
// 18080 is the FAST default), falling back to localhost:8080. When the
// daemon is listening on TLS but the configured URL is http://, upgrade
// the scheme: the daemon's listener is TLS-only, so cleartext requests
// would fail with HTTPParserError. We deliberately do NOT downgrade
// https→http: a user with explicit https config knows their setup.
function effectiveDaemonUrl(): string {
  const s2sScheme = s2sTls ? "https" : "http";
  const explicit = process.env.FRIDAYD_URL;
  if (explicit) {
    if (s2sTls && explicit.startsWith("http://")) {
      return "https://" + explicit.slice("http://".length);
    }
    return explicit;
  }
  return `${s2sScheme}://localhost:8080`;
}
const DAEMON_URL = effectiveDaemonUrl();
const TUNNEL_URL = `${s2sTls ? "https" : "http"}://localhost:9090`;

console.log(`[vite] dev server scheme: ${scheme}://  daemon: ${DAEMON_URL}  tunnel: ${TUNNEL_URL}`);

export default defineConfig({
  plugins: [sveltekit()],
  // `process.env` → `{}` keeps stray `process.env.X` references in third-party
  // client-bundled code from crashing the browser. The downside is it also
  // wipes them in route SSR modules (hooks.server.ts is exempt because
  // SvelteKit loads it directly without going through vite's transform).
  // Anything route-side that needs a build-time value must come through an
  // explicit `define` key — see `__FRIDAY_DAEMON_BASE_URL__` below, which
  // the dev daemon proxy reads to decide between http:// and https://.
  define: {
    "process.env": "{}",
    __FRIDAY_DAEMON_BASE_URL__: JSON.stringify(DAEMON_URL),
    __FRIDAY_TUNNEL_BASE_URL__: JSON.stringify(TUNNEL_URL),
  },
  resolve: {
    alias: {
      // @db/sqlite uses Deno FFI — stub it out for Vite SSR (runs under Node).
      // The playground never actually calls Database methods at SSR time.
      "@db/sqlite": new URL("src/lib/server/stubs/db-sqlite.ts", import.meta.url).pathname,
    },
    // Deno's npm cache keeps multiple svelte installs in `.deno/svelte@<ver>/`
    // and sub-packages may symlink to a stale one (e.g. @tanstack/svelte-query@6.1.13
    // → svelte@5.55.3). The compiler plugin picks up 5.55.4 from root node_modules
    // but Vite's dep optimizer pre-bundled the runtime from 5.55.3 via a sub-package,
    // producing a "Cannot read properties of undefined (reading 'call')" in
    // `get_next_sibling` at mount. Dedupe forces a single svelte runtime.
    dedupe: ["svelte", "@tanstack/svelte-query"],
  },
  ssr: {
    // @opentelemetry/api is a transitive dep of the ai SDK — not available
    // in the SSR module graph. Externalizing prevents Vite from trying to
    // resolve it during dev HMR (the app runs client-only via adapter-static).
    external: ["@opentelemetry/api", "@db/sqlite"],
  },
  optimizeDeps: {
    // Deno's npm resolver produces orphaned sub-trees (e.g. two @tanstack/svelte-query
    // installs pinning different svelte versions). When Vite's optimizer runs it
    // can discover deps at two different hashes and fall into a stuck state where
    // `@ai-sdk/svelte` returns 504 "Outdated Optimize Dep" for the old hash the
    // transformed page modules still reference. Pre-declaring the heavy client deps
    // anchors the optimizer's first-pass scan so all hashes are consistent.
    include: ["@ai-sdk/svelte", "ai", "@tanstack/svelte-query", "svelte"],
  },
  server: {
    port: 5200,
    hmr: { overlay: false },
    fs: { allow: ["../.."] },
    https: tls ?? undefined,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Permissions-Policy": "local-fonts=()",
    },
  },
});
