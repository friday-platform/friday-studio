// Shared path resolution for the playground origin's browser-trusted
// TLS cert pair. Single source of truth — vite.config.ts (Node, Buffer
// reads) and static-server.ts (Deno, string reads) both import this
// and then read bytes with their own runtime API.
//
// The s2s cert pair (FRIDAY_TLS_CERT/_KEY) is for daemon + tunnel
// listeners, not the playground origin, and is intentionally NOT
// resolved here — those processes consume those env vars directly.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export interface TlsPaths {
  certPath: string;
  keyPath: string;
}

/** Resolve `{certPath, keyPath}` for the playground origin's browser-
 * trusted cert (mkcert-signed by scripts/setup-tls.sh). Returns `null`
 * when no cert pair exists, in which case callers fall back to plain
 * HTTP and the dev cycle is unchanged.
 *
 * Resolution order:
 *   1. `FRIDAY_BROWSER_TLS_CERT` + `FRIDAY_BROWSER_TLS_KEY` (explicit)
 *   2. `~/.friday/local/tls/browser.{crt,key}`
 *   3. `~/.atlas/tls/browser.{crt,key}`
 */
export function resolveBrowserTlsPaths(): TlsPaths | null {
  const candidates: TlsPaths[] = [];
  const envCert = process.env.FRIDAY_BROWSER_TLS_CERT;
  const envKey = process.env.FRIDAY_BROWSER_TLS_KEY;
  if (envCert && envKey) candidates.push({ certPath: envCert, keyPath: envKey });
  const home = homedir();
  for (const root of [join(home, ".friday", "local"), join(home, ".atlas")]) {
    candidates.push({
      certPath: join(root, "tls", "browser.crt"),
      keyPath: join(root, "tls", "browser.key"),
    });
  }
  for (const c of candidates) {
    if (existsSync(c.certPath) && existsSync(c.keyPath)) return c;
  }
  return null;
}
