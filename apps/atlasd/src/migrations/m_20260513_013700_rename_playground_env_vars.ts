/**
 * Migration: rename legacy `*PLAYGROUND*` env var keys in
 * `<friday_home>/.env` to their `*STUDIO_UI*` equivalents.
 *
 * The studio-ui binary used to be named `playground`. Three env var
 * names changed in the rename:
 *
 *   FRIDAY_PORT_PLAYGROUND  → FRIDAY_PORT_STUDIO_UI   (launcher port override)
 *   PLAYGROUND_PORT         → STUDIO_UI_PORT          (binary bind port)
 *   PLAYGROUND_HOST         → STUDIO_UI_HOST          (binary bind host)
 *
 * `FRIDAY_PORT_PLAYGROUND` is the only one the installer wrote by default;
 * the other two are normally injected by the launcher at boot and never
 * persisted. We still migrate them defensively in case a user added them
 * to `.env` by hand for debugging or custom setups.
 *
 * Behaviour for each pair:
 *   - .env missing → no-op (whole migration).
 *   - Only legacy present → rewrite the key, keep the value.
 *   - Only new present → no-op for that pair (already migrated).
 *   - Both present → **legacy value wins**: drop the new-key line and
 *     rewrite the legacy line. This is critical for FRIDAY_PORT_STUDIO_UI
 *     because the installer's `ensure_platform_env_vars` runs BEFORE
 *     `friday migrate` and seeds the new key at the installer default —
 *     so on every upgrade, both keys are temporarily present, and a
 *     user who customised the legacy key would otherwise silently lose
 *     their value to the default.
 *
 * Idempotent: re-running after success is a no-op. Line-by-line rewrite
 * preserves formatting, comments, and unrelated variables.
 */

import { join } from "node:path";
import { getFridayHome } from "@atlas/utils/paths.server";
import type { Migration } from "jetstream";

const RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["FRIDAY_PORT_PLAYGROUND", "FRIDAY_PORT_STUDIO_UI"],
  ["PLAYGROUND_PORT", "STUDIO_UI_PORT"],
  ["PLAYGROUND_HOST", "STUDIO_UI_HOST"],
];

export const migration: Migration = {
  id: "20260513_013700_rename_playground_env_vars",
  name: "rename legacy PLAYGROUND env var keys → STUDIO_UI",
  description:
    "Rewrites legacy *PLAYGROUND* keys (FRIDAY_PORT_PLAYGROUND, PLAYGROUND_PORT, " +
    "PLAYGROUND_HOST) in ~/.friday/local/.env to their *STUDIO_UI* equivalents " +
    "after the agent-playground → studio-ui rename. No-op if the file or any " +
    "particular legacy key is absent.",
  async run({ logger }) {
    const path = join(getFridayHome(), ".env");

    let raw: string;
    try {
      raw = await Deno.readTextFile(path);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        logger.debug(".env not present — nothing to migrate", { path });
        return;
      }
      throw err;
    }

    const rewritten = rewriteEnv(raw);
    if (rewritten === raw) {
      logger.debug("no legacy playground env vars found — nothing to migrate", { path });
      return;
    }

    await Deno.writeTextFile(path, rewritten);
    logger.info("rewrote legacy playground env vars", { path, renames: RENAMES.length });
  },
};

/**
 * Exported for testing. Pure function — given .env text, returns the
 * rewritten text (or the input unchanged if no migration is needed).
 *
 * Each rename pair is applied independently: if `FRIDAY_PORT_PLAYGROUND`
 * is present but `PLAYGROUND_PORT` isn't, only the first is rewritten.
 */
export function rewriteEnv(raw: string): string {
  let result = raw;
  for (const [legacy, replacement] of RENAMES) {
    result = rewriteKey(result, legacy, replacement);
  }
  return result;
}

/**
 * Apply one (legacy → new) rename to env text.
 *
 * - If only the legacy key is present, rewrite its key prefix in place.
 * - If only the new key is present, leave the file unchanged.
 * - If both are present, the legacy line wins: drop the new-key line
 *   and rewrite the legacy line. This preserves user customisations
 *   against the installer's add-if-missing default which runs before
 *   this migration on upgrade.
 *
 * The value is always preserved verbatim — quoting, whitespace after
 * the `=`, comments on the line are all left intact.
 */
function rewriteKey(raw: string, legacy: string, replacement: string): string {
  const lines = raw.split("\n");
  const legacyPresent = lines.some((line) => keyOf(line) === legacy);
  if (!legacyPresent) return raw;

  // Legacy is present, so we're definitely rewriting. If the new key
  // is also present, drop its line (legacy value wins per docstring).
  const out: string[] = [];
  for (const line of lines) {
    const key = keyOf(line);
    if (key === replacement) continue;
    if (key !== legacy) {
      out.push(line);
      continue;
    }
    // Rewrite the legacy key prefix, preserve everything after the `=`.
    const eq = line.indexOf("=");
    out.push(replacement + line.slice(eq));
  }
  return out.join("\n");
}

/**
 * Return the key of a `KEY=VALUE` line, or null for comments / blank
 * lines / malformed lines. Tolerates surrounding whitespace before the
 * key (rare but valid in some dotenv implementations).
 */
function keyOf(line: string): string | null {
  const trimmed = line.trimStart();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return null;
  return trimmed.slice(0, eq).trim();
}
