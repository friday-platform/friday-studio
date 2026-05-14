/**
 * Link route - proxies credential management requests to Link service.
 *
 * The proxy adds X-Forwarded-* headers so Link can generate correct external URLs.
 * Link handles all URL generation internally - no rewriting needed here.
 */

import process from "node:process";
import { Hono } from "hono";
import { proxy } from "hono/proxy";
import { devOnlyMiddleware } from "../src/dev-only.ts";

const linkRoutes = new Hono();

// `/api/link/*` forwards every request to the Link service with the
// daemon's own `FRIDAY_KEY` attached as the bearer token. In multi-
// user deployments that's a shared-credential leak — any logged-in
// caller impersonates the daemon to Link. Gate the whole proxy to
// dev mode; Studio + the CLI both stamp `FRIDAY_ENV=dev` so local-
// first credential management keeps working.
linkRoutes.use("/*", devOnlyMiddleware());

/**
 * Where the daemon proxies /api/link/* requests to. Resolution order:
 *   1. LINK_SERVICE_URL — explicit override (production / Docker)
 *   2. http://localhost:$FRIDAY_PORT_LINK — desktop installs that
 *      moved link off the conventional 3100 (e.g. the launcher's
 *      port-override mechanism). Without this fallback the daemon
 *      hits :3100 (default) while link binds to FRIDAY_PORT_LINK,
 *      every credential lookup fails with ECONNREFUSED, and the
 *      workspace-chat agent can't reach Gmail / Slack / etc.
 *   3. http://localhost:3100 — legacy default for in-tree dev runs.
 */
// Scheme matches the s2s mesh: when FRIDAY_TLS_CERT/_KEY are set in
// the daemon's env, link is also listening on TLS via the same env
// pair (apps/link/src/index.ts), so the daemon must reach it over
// https. Without TLS env, fall back to http on loopback — the
// pre-s2s-mesh behavior.
const linkScheme = process.env.FRIDAY_TLS_CERT && process.env.FRIDAY_TLS_KEY ? "https" : "http";
const LINK_SERVICE_URL =
  process.env.LINK_SERVICE_URL ??
  (process.env.FRIDAY_PORT_LINK
    ? `${linkScheme}://localhost:${process.env.FRIDAY_PORT_LINK}`
    : `${linkScheme}://localhost:3100`);
const PROXY_PREFIX = "/api/link";

/**
 * Proxy all Link requests from /api/link/* to Link service /v1/*
 * Forwards Authorization header with FRIDAY_KEY for Link authentication.
 * Authenticates with Link using FRIDAY_KEY from env.
 */
linkRoutes.all("/*", (c) => {
  // Transform path: /api/link/foo → /v1/foo, /api/link/v1/foo → /v1/foo
  const strippedPath = c.req.path.replace(PROXY_PREFIX, "") || "/";
  const targetPath =
    strippedPath.startsWith("/v1") || strippedPath.startsWith("/internal")
      ? strippedPath
      : `/v1${strippedPath}`;
  const query = new URL(c.req.url).search;
  const targetUrl = `${LINK_SERVICE_URL}${targetPath}${query}`;

  const originalUrl = new URL(c.req.url);

  // Preserve forwarded headers from an upstream proxy (e.g. the
  // playground dev server at https://localhost:5200/api/daemon/*). Without
  // this, Link emits callback URLs pointing at the daemon's s2s TLS
  // listener (https://localhost:8080), which uses a non-browser-trusted
  // cert — the OAuth provider redirect lands on ERR_CERT_AUTHORITY_INVALID.
  // The prefix is concatenated so Link sees the full external path.
  const incomingHost = c.req.header("X-Forwarded-Host");
  const incomingProto = c.req.header("X-Forwarded-Proto");
  // Strip a trailing slash so concatenation with PROXY_PREFIX (which starts
  // with "/") doesn't produce a doubled separator. Today the only known
  // upstream emitter (the playground proxy) never sends one, but the daemon
  // is also reachable from tunnels / future deployments we don't control.
  const incomingPrefix = (c.req.header("X-Forwarded-Prefix") ?? "").replace(/\/$/, "");

  // Use a Headers instance so the case-insensitive `.set()` semantics
  // unambiguously override incoming X-Forwarded-* values. A plain-object
  // spread keeps both the lowercase key (from `Object.fromEntries`) and
  // the PascalCase override side-by-side and relies on Hono's internal
  // iteration order in `preprocessRequestInit` to pick the right one.
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Forwarded-Host", incomingHost ?? originalUrl.host);
  headers.set("X-Forwarded-Proto", incomingProto ?? originalUrl.protocol.replace(":", ""));
  headers.set("X-Forwarded-Prefix", `${incomingPrefix}${PROXY_PREFIX}`);

  // Authenticate with Link using service FRIDAY_KEY (read at request time, not module load)
  const atlasKey = process.env.FRIDAY_KEY;
  if (atlasKey) {
    headers.set("Authorization", `Bearer ${atlasKey}`);
  }

  return proxy(targetUrl, {
    raw: c.req.raw,
    headers,
    // Don't follow redirects - pass them through to the client
    customFetch: (req) => fetch(req, { redirect: "manual" }),
  });
});

export { linkRoutes };
