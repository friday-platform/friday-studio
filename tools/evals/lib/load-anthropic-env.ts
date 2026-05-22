import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { getFridayHome } from "@atlas/utils/paths.server";
import dotenv from "dotenv";

/**
 * Load Anthropic credentials for a non-daemon eval and fail fast if missing.
 *
 * The workspace-chat evals don't need a full `loadCredentials()` (which goes
 * through the gateway and requires `FRIDAY_KEY`) — they only need
 * `ANTHROPIC_API_KEY` reachable via dotenv. This helper loads the project
 * `.env`, then layers in `~/.atlas/.env` (override: true) so the global key
 * wins over a stale repo-local one.
 *
 * @param callerLabel  Surfaced in the error message when the key is missing.
 *                     Keep it human-readable ("workspace-chat evals", "title-gen eval", ...).
 */
export function loadAnthropicEnv(callerLabel: string): void {
  dotenv.config();
  const globalAtlasEnv = join(getFridayHome(), ".env");
  if (existsSync(globalAtlasEnv)) {
    dotenv.config({ path: globalAtlasEnv, override: true });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(`ANTHROPIC_API_KEY is required to run ${callerLabel}`);
  }
}
