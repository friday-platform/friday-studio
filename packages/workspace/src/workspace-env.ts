/**
 * Workspace `.env` overlay.
 *
 * A workspace's `.env` file is the per-workspace store of *non-secret* env
 * values — agent env, per-server MCP plain-string settings, workspace-wide
 * env. It is loaded as an overlay at spawn time and layered between the
 * daemon's ambient `process.env` and any explicit per-agent/per-server `env:`
 * wiring (most specific wins).
 *
 * Lazy-on-write: an absent file is a valid empty overlay — no workspace
 * pre-creates one. The file appears when something first writes a value.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@atlas/logger";
import { parse as parseDotenv } from "@std/dotenv";

/**
 * Load a workspace's `.env` overlay from `<workspacePath>/.env`.
 *
 * Returns an empty record when the file is absent (valid empty overlay) or
 * unparseable (logged at debug — a malformed `.env` should not crash a spawn).
 * Read fresh on every call: the file is small and editable at runtime
 * (settings UI, env tools), so a cached copy would mask edits.
 */
export function loadWorkspaceEnv(workspacePath: string): Record<string, string> {
  const envPath = join(workspacePath, ".env");
  if (!existsSync(envPath)) return {};
  try {
    return parseDotenv(readFileSync(envPath, "utf-8"));
  } catch (error) {
    logger.debug("Could not parse workspace .env file", { workspacePath, error });
    return {};
  }
}
