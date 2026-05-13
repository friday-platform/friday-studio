// Shared path resolution for the playground origin's browser-trusted
// TLS cert pair. Single source of truth — vite.config.ts (Node, Buffer
// reads) and static-server.ts (Deno, string reads) both import this
// and then read bytes with their own runtime API.
//
// The s2s cert pair (FRIDAY_TLS_CERT/_KEY) is for daemon + tunnel
// listeners, not the playground origin, and is intentionally NOT
// resolved here — those processes consume those env vars directly.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { X509Certificate } from "node:crypto";

export interface TlsPaths {
  certPath: string;
  keyPath: string;
}

/** Resolve `{certPath, keyPath}` for the playground origin's browser-
 * trusted cert. Returns `null` when no usable pair exists — caller
 * falls back to plain HTTP and the dev cycle is unchanged.
 *
 * "Usable" means: both files exist AND the cert is currently within
 * its `notBefore..notAfter` window. An expired cert would make every
 * page load show a browser security warning; the user gets a better
 * experience falling back to http:// while the launcher's TTL-based
 * renewer (friday-launcher/tls_renewer.go) fetches a fresh one and
 * triggers a restart. Same applies to a `notBefore` in the future —
 * usually a clock-skew symptom on the user's machine.
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
    if (!existsSync(c.certPath) || !existsSync(c.keyPath)) continue;
    if (!isCertCurrentlyValid(c.certPath)) continue;
    return c;
  }
  return null;
}

/** Parse the first cert in a PEM file and check that `now` is within
 * `notBefore..notAfter`. Returns `false` on any parse / IO error so a
 * malformed cert is treated the same as an expired one: don't serve,
 * fall back to http and let the renewer fix it.
 *
 * Uses `X509Certificate` from `node:crypto`, which is available in
 * both Node ≥ 15.6 and Deno ≥ 1.30 — both runtimes that consume this
 * module.
 */
function isCertCurrentlyValid(path: string): boolean {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    return false;
  }
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(bytes);
  } catch {
    return false;
  }
  const now = Date.now();
  const notBefore = Date.parse(cert.validFrom);
  const notAfter = Date.parse(cert.validTo);
  if (Number.isNaN(notBefore) || Number.isNaN(notAfter)) return false;
  return now >= notBefore && now <= notAfter;
}
