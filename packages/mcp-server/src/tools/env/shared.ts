/**
 * Shared bits for the `env_*` platform tools.
 *
 * The tools are thin wrappers over the per-key daemon env routes:
 *   - `workspace` scope → `/api/workspaces/:id/env[/:key]`
 *   - `global`    scope → `/api/config/env[/:key]` (the daemon's `<friday-home>/.env`)
 *
 * Reads mask secret-looking keys before the value reaches an LLM — the
 * workspace `.env` is the *non-secret* value store by design, but the
 * daemon-global `.env` legitimately holds API keys, and a user can always
 * put a secret in the wrong place. Masking is a key-name heuristic, not a
 * value inspection.
 */

import { z } from "zod";

/** `workspace` (per-workspace `.env`) or `global` (the daemon's `.env`). */
export const EnvScopeSchema = z.enum(["workspace", "global"]);
export type EnvScope = z.infer<typeof EnvScopeSchema>;

/**
 * Key-name heuristic for "this probably holds a credential." Reads of a
 * matching key are masked; `env_set` shows the value masked-with-reveal in
 * its confirmation card and nudges toward Link.
 */
const SECRET_KEY_RE = /password|secret|token|key|credential/i;

/** True when `key` looks like it holds a secret. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/**
 * Opaque mask for a secret-bearing value. Fixed-width — no length leak, no
 * plaintext prefix/suffix; the value is genuinely withheld from tool output.
 */
export const MASKED_VALUE = "********";

/** Mask a single value when its key looks secret-bearing; pass through otherwise. */
export function maskForKey(key: string, value: string): string {
  return isSecretKey(key) ? MASKED_VALUE : value;
}

/** Mask every secret-looking key in an env map. Returns the masked map + the masked key list. */
export function maskEnvMap(env: Record<string, string>): {
  env: Record<string, string>;
  maskedKeys: string[];
} {
  const masked: Record<string, string> = {};
  const maskedKeys: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (isSecretKey(k)) {
      masked[k] = MASKED_VALUE;
      maskedKeys.push(k);
    } else {
      masked[k] = v;
    }
  }
  return { env: masked, maskedKeys };
}

/**
 * Resolve the daemon route base for a scope. `workspace` scope requires a
 * `workspaceId`; `global` ignores it.
 */
export function envRouteBase(
  daemonUrl: string,
  scope: EnvScope,
  workspaceId: string | undefined,
): { ok: true; base: string } | { ok: false; error: string } {
  if (scope === "global") {
    return { ok: true, base: `${daemonUrl}/api/config/env` };
  }
  if (!workspaceId) {
    return { ok: false, error: "workspaceId is required when scope is 'workspace'" };
  }
  return { ok: true, base: `${daemonUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/env` };
}
