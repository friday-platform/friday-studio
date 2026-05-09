import type { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// HTTP/2 + TLS resolution. Vite 7's `server.https` switches the underlying
// dev server from `node:http` (HTTP/1.1) to `node:http2.createSecureServer`
// with `allowHTTP1: true` fallback — so once we hand it cert+key bytes,
// the browser negotiates h2 over ALPN and the 6-socket-per-origin HTTP/1.1
// limit (which deadlocks once the playground's 3 SSE feeds × multiple tabs
// run out of sockets) goes away.
//
// Resolution order: env vars → ~/.friday/local/tls → ~/.atlas/tls. The
// first pair where both files exist wins; otherwise we run plain HTTP and
// the dev cycle is unchanged. Run `bash scripts/setup-tls.sh` to populate.
function resolveTls(): { cert: Buffer; key: Buffer } | null {
  const candidates: Array<[string, string]> = [];
  const envCert = process.env.FRIDAY_TLS_CERT;
  const envKey = process.env.FRIDAY_TLS_KEY;
  if (envCert && envKey) candidates.push([envCert, envKey]);
  const home = homedir();
  candidates.push([
    join(home, ".friday", "local", "tls", "localhost.crt"),
    join(home, ".friday", "local", "tls", "localhost.key"),
  ]);
  candidates.push([
    join(home, ".atlas", "tls", "localhost.crt"),
    join(home, ".atlas", "tls", "localhost.key"),
  ]);
  for (const [c, k] of candidates) {
    if (existsSync(c) && existsSync(k)) {
      return { cert: readFileSync(c), key: readFileSync(k) };
    }
  }
  return null;
}

const tls = resolveTls();
const scheme = tls ? "https" : "http";

// Trust for the mkcert root CA has to be plumbed in via `NODE_EXTRA_CA_CERTS`
// *before* Node starts — Node 25 reads it once when the default secure
// context is created, which happens before our config evaluates. The
// `scripts/run-playground-vite.sh` wrapper sets it from `mkcert -CAROOT`
// before exec'ing node. Without it, the SvelteKit dev proxy's fetch to
// https://daemon errors with `fetch failed`.
if (tls && !process.env.NODE_EXTRA_CA_CERTS) {
  console.warn(
    "[vite] TLS cert found but NODE_EXTRA_CA_CERTS unset — SSR proxy fetches to https daemon will fail. Launch via `deno task playground` (uses scripts/run-playground-vite.sh wrapper).",
  );
}

// Effective daemon URL for SSR-side proxy + Hono route fetches. Honors
// FRIDAYD_URL (launcher / wizard / FAST_DEVELOPMENT mode set this — port
// 18080 is the FAST default), falling back to localhost:8080. When TLS
// is on but the configured URL is http://, upgrade the scheme: the
// daemon's listener is TLS-only, so cleartext requests would fail with
// HTTPParserError. We deliberately do NOT downgrade https→http: a user
// with explicit https config knows their setup.
function effectiveDaemonUrl(): string {
  const explicit = process.env.FRIDAYD_URL;
  if (explicit) {
    if (tls && explicit.startsWith("http://")) {
      return "https://" + explicit.slice("http://".length);
    }
    return explicit;
  }
  return `${scheme}://localhost:8080`;
}
const DAEMON_URL = effectiveDaemonUrl();

// `EXTERNAL_DAEMON_URL` / `EXTERNAL_TUNNEL_URL` flow into the runtime
// config the SvelteKit hook injects on the served HTML. When TLS is on
// the page is https://, so any direct browser fetch to a plain http://
// origin would be blocked as mixed content (Chrome makes a localhost
// exception, Firefox/Safari don't). Default both to the resolved scheme;
// webhook-tunnel reads FRIDAY_TLS_CERT/_KEY itself and binds TLS so the
// browser→tunnel hop matches. Explicit env wins for split-host setups.
process.env.EXTERNAL_DAEMON_URL ??= DAEMON_URL;
process.env.EXTERNAL_TUNNEL_URL ??= `${scheme}://localhost:9090`;

console.log(`[vite] dev server scheme: ${scheme}://  daemon: ${DAEMON_URL}`);

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
