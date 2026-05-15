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
 * Returns one entry per proposed key, preferring the user-typed value and
 * falling back to the proposed value. The card edits every value — secret
 * (password input + reveal toggle) and non-secret (plain text input) — so
 * the override is always the user's final word on what gets committed.
 * Values are sent exactly as typed; the server enforces POSIX-key and
 * no-newline at the schema layer and gates by `Object.hasOwn` on the
 * proposal to refuse key injection.
 *
 * @param entries - The proposed `[key, value]` pairs from the elicitation.
 * @param userValues - User-typed values keyed by env var name.
 */
export function buildVarsOverride(
  entries: ReadonlyArray<readonly [string, string]>,
  userValues: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, proposed] of entries) {
    out[key] = userValues[key] ?? proposed;
  }
  return out;
}
