/**
 * Daemon-global `.env` commit helpers.
 *
 * Writing the daemon's `<friday-home>/.env` is more than a file edit: the
 * running process memoizes `process.env` (the model catalog, the provider
 * registry), so a write has to mirror into `process.env` and bust those
 * caches — unless the key is hot-reload-denylisted, in which case it lands on
 * disk only and takes effect on the next daemon spawn.
 *
 * Extracted so every global-env write path shares one implementation: the
 * per-key `config.ts` routes and the `env-write` elicitation commit branch.
 * Workspace `.env` writes don't need any of this — they're read fresh at
 * spawn — so they just call `setEnvFileVar` directly.
 */

import { join } from "node:path";
import process from "node:process";
import { invalidateCatalog, resetRegistry } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { getFridayHome } from "@atlas/utils/paths.server";
import { deleteEnvFileVar, setEnvFileVar } from "@atlas/workspace";

/**
 * Keys written to the daemon `.env` but never mutated on the *running*
 * process — changing them mid-flight could brick the daemon (its own loader
 * paths, home dir) or partition reality between already-spawned and
 * future-spawned subprocesses. The next daemon spawn picks up the file value.
 */
export const HOT_RELOAD_DENYLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "FRIDAY_HOME",
  "FRIDAY_ENV",
  "FRIDAY_UV_PATH",
  "FRIDAY_AGENT_SDK_VERSION",
  "FRIDAY_AGENT_PYTHON",
  "FRIDAY_CLAUDE_PATH",
]);

function globalEnvPath(): string {
  return join(getFridayHome(), ".env");
}

/**
 * Mirror a per-key `.env` change into the running daemon's `process.env` and
 * bust the memoizing caches. Denylisted keys are skipped (disk-only).
 * `value === undefined` means delete.
 */
function syncEnvKeyInMemory(key: string, value: string | undefined): void {
  if (HOT_RELOAD_DENYLIST.has(key)) {
    logger.warn("Skipping in-memory sync for denylisted key (written to .env only)", { key });
    return;
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  resetRegistry();
  invalidateCatalog();
}

/** Set a key in the daemon-global `.env` and hot-reload the running process. */
export function commitGlobalEnvWrite(key: string, value: string): void {
  setEnvFileVar(globalEnvPath(), key, value);
  syncEnvKeyInMemory(key, value);
}

/**
 * Delete a key from the daemon-global `.env` and hot-reload the running
 * process. Returns whether the key was present.
 */
export function commitGlobalEnvDelete(key: string): boolean {
  const removed = deleteEnvFileVar(globalEnvPath(), key);
  if (removed) syncEnvKeyInMemory(key, undefined);
  return removed;
}
