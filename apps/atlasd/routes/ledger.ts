/**
 * Proxies resource storage requests to the Ledger service.
 * Adds X-Forwarded-* headers so Ledger can generate correct external URLs.
 */

import process from "node:process";
import { Hono } from "hono";
import { proxy } from "hono/proxy";

const ledgerRoutes = new Hono();

const LEDGER_SERVICE_URL = process.env.LEDGER_URL ?? "http://localhost:3200";
const PROXY_PREFIX = "/api/ledger";

/** Proxies /api/ledger/* to Ledger /v1/*, forwarding ATLAS_KEY for auth. */
ledgerRoutes.all("/*", (c) => {
  const strippedPath = c.req.path.startsWith(PROXY_PREFIX)
    ? c.req.path.slice(PROXY_PREFIX.length) || "/"
    : "/";
  const targetPath =
    strippedPath === "/health" || strippedPath.startsWith("/v1")
      ? strippedPath
      : `/v1${strippedPath}`;
  const query = new URL(c.req.url).search;
  const targetUrl = `${LEDGER_SERVICE_URL}${targetPath}${query}`;

  const originalUrl = new URL(c.req.url);

  // Whitelist safe headers — don't forward Cookie, Authorization, or other
  // client-specific headers to the internal Ledger service.
  const FORWARDED_HEADERS = ["content-type", "accept", "content-length"] as const;
  const headers: Record<string, string> = {
    "X-Forwarded-Host": originalUrl.host,
    "X-Forwarded-Proto": originalUrl.protocol.replace(":", ""),
    "X-Forwarded-Prefix": PROXY_PREFIX,
  };
  for (const name of FORWARDED_HEADERS) {
    const value = c.req.header(name);
    if (value) {
      headers[name] = value;
    }
  }

  const atlasKey = process.env.ATLAS_KEY;
  if (atlasKey) {
    headers.Authorization = `Bearer ${atlasKey}`;
  }

  return proxy(targetUrl, { raw: c.req.raw, headers });
});

export { ledgerRoutes };
