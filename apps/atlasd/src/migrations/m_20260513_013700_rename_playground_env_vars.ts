/**
 * Migration: rename `FRIDAY_PORT_PLAYGROUND` → `FRIDAY_PORT_STUDIO_UI`
 * in `<friday_home>/.env`.
 *
 * The studio-ui binary used to be named `playground`; the launcher's
 * port-override convention is `FRIDAY_PORT_<UPPERCASE_NAME>`, so the
 * old name produced `FRIDAY_PORT_PLAYGROUND`. After the rename the
 * launcher looks for `FRIDAY_PORT_STUDIO_UI` and would silently fall
 * back to the default 5200 for any user who customised the port
 * (multi-instance setups). This migration moves the value over so
 * customisations survive the upgrade.
 *
 * Behaviour:
 *   - .env missing → no-op.
 *   - Only PLAYGROUND present → rewrite the key, keep the value.
 *   - Only STUDIO_UI present → no-op (already migrated or fresh install).
 *   - Both present → drop the legacy PLAYGROUND line; STUDIO_UI wins
 *     because that's what the launcher reads.
 *
 * Idempotent: re-running after success is a no-op (the legacy key is
 * already gone). Line-by-line rewrite preserves formatting, comments,
 * and any other variables.
 */

import { join } from "node:path";
import { getFridayHome } from "@atlas/utils/paths.server";
import type { Migration } from "jetstream";

const LEGACY_KEY = "FRIDAY_PORT_PLAYGROUND";
const NEW_KEY = "FRIDAY_PORT_STUDIO_UI";

export const migration: Migration = {
  id: "20260513_013700_rename_playground_env_vars",
  name: "rename FRIDAY_PORT_PLAYGROUND → FRIDAY_PORT_STUDIO_UI",
  description:
    "Rewrites the legacy FRIDAY_PORT_PLAYGROUND key in ~/.friday/local/.env " +
    "to FRIDAY_PORT_STUDIO_UI after the agent-playground → studio-ui rename. " +
    "No-op if the file or legacy key is absent.",
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
      logger.debug("no legacy playground env var found — nothing to migrate", { path });
      return;
    }

    await Deno.writeTextFile(path, rewritten);
    logger.info("rewrote legacy playground env var", { path, from: LEGACY_KEY, to: NEW_KEY });
  },
};

/**
 * Exported for testing. Pure function — given .env text, returns the
 * rewritten text (or the input unchanged if no migration is needed).
 */
export function rewriteEnv(raw: string): string {
  const lines = raw.split("\n");
  const hasNewKey = lines.some((line) => keyOf(line) === NEW_KEY);

  const out: string[] = [];
  for (const line of lines) {
    const key = keyOf(line);
    if (key !== LEGACY_KEY) {
      out.push(line);
      continue;
    }
    if (hasNewKey) {
      // Both present — drop the legacy line; the new key already wins
      // at the launcher. Comment-only line above the dropped key is
      // left in place (might document the old name, but that's fine —
      // users can clean up by hand).
      continue;
    }
    // Rewrite the key prefix, preserve everything after the `=`.
    const eq = line.indexOf("=");
    out.push(NEW_KEY + line.slice(eq));
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
