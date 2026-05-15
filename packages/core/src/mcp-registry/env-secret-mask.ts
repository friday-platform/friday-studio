/**
 * Key-name heuristic for masking secret-bearing env values.
 *
 * Single source of truth. The workspace `.env` is the non-secret value store
 * by design, but users put credentials in the wrong place — so env reads mask
 * values whose *key name* looks credential-bearing. Both the platform MCP
 * `env_*` tools (`@atlas/mcp-server`) and the chat-side env tools
 * (`@atlas/system`) consume this; a divergent copy would mask a key on one
 * surface and leak it on the other.
 *
 * Masking is a key-name heuristic, not a value inspection.
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
