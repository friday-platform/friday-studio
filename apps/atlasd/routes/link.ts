/**
 * Link route - proxies credential management requests to Link service.
 *
 * The proxy adds X-Forwarded-* headers so Link can generate correct external URLs.
 * Link handles all URL generation internally - no rewriting needed here.
 */

import process from "node:process";
import { Hono } from "hono";
import { proxy } from "hono/proxy";

const linkRoutes = new Hono();

const LINK_SERVICE_URL = process.env.LINK_SERVICE_URL ?? "http://localhost:3100";
const PROXY_PREFIX = "/api/link";

/**
 * Proxy all Link requests from /api/link/* to Link service /v1/*
 * Forwards X-Atlas-User-ID header for tenant isolation.
 */
linkRoutes.all("/*", (c) => {
  // Transform path: /api/link/foo → /v1/foo, /api/link/v1/foo → /v1/foo
  const strippedPath = c.req.path.replace(PROXY_PREFIX, "") || "/";
  const targetPath = strippedPath.startsWith("/v1") ? strippedPath : `/v1${strippedPath}`;
  const query = new URL(c.req.url).search;
  const targetUrl = `${LINK_SERVICE_URL}${targetPath}${query}`;

  const originalUrl = new URL(c.req.url);

  return proxy(targetUrl, {
    ...c.req.raw,
    headers: {
      ...Object.fromEntries(c.req.raw.headers),
      // Ensure X-Atlas-User-ID is set (default to "dev" if missing)
      "X-Atlas-User-ID": c.req.header("X-Atlas-User-ID") || "dev",
      // Forwarded headers so Link can generate correct external URLs
      "X-Forwarded-Host": originalUrl.host,
      "X-Forwarded-Proto": originalUrl.protocol.replace(":", ""),
      "X-Forwarded-Prefix": PROXY_PREFIX,
    },
    // Don't follow redirects - pass them through to the client
    customFetch: (req) => fetch(req, { redirect: "manual" }),
  });
});

export { linkRoutes };
