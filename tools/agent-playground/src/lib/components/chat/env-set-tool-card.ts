/**
 * Pure helpers for `env-set-tool-card.svelte`. Extracted so the security-
 * relevant "which keys end up in the override payload" logic has unit tests
 * the Svelte component itself can't easily host.
 *
 * @module
 */

/**
 * Build the `varsOverride` payload for an env-write confirmation.
 *
 * Returns one entry per secret-looking key, preferring the user-typed value
 * and falling back to the proposed value. Values are sent exactly as typed;
 * non-secret keys are omitted (they commit with their proposed value, no
 * override needed).
 *
 * @param entries - The proposed `[key, value]` pairs from the elicitation.
 * @param userValues - User-typed values keyed by env var name.
 * @param isSecretKey - Heuristic for whether a key looks credential-bearing.
 */
export function buildVarsOverride(
  entries: ReadonlyArray<readonly [string, string]>,
  userValues: Readonly<Record<string, string>>,
  isSecretKey: (key: string) => boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, proposed] of entries) {
    if (!isSecretKey(key)) continue;
    out[key] = userValues[key] ?? proposed;
  }
  return out;
}
