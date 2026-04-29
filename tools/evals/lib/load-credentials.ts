import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { type Credentials, fetchCredentials, setToEnv } from "@atlas/core/credentials";
import { getFridayHome } from "@atlas/utils/paths.server";
import dotenv from "dotenv";

/** Override points for testing — production callers should omit. */
export interface CredentialDeps {
  fetch: (opts: { atlasKey: string; retries: number; retryDelay: number }) => Promise<Credentials>;
  setEnv: typeof setToEnv;
}

const prodDeps: CredentialDeps = { fetch: fetchCredentials, setEnv: setToEnv };

/**
 * Loads `.env` files and fetches bundled API credentials into `process.env`.
 *
 * Reads `.env` from cwd first, then falls back to `~/.atlas/.env`.
 * Requires `FRIDAY_KEY` to be present after dotenv loading.
 */
export async function loadCredentials(deps: CredentialDeps = prodDeps) {
  dotenv.config();

  const globalAtlasEnv = join(getFridayHome(), ".env");
  if (existsSync(globalAtlasEnv)) {
    dotenv.config({ path: globalAtlasEnv, override: true });
  }

  const atlasKey = process.env.FRIDAY_KEY;
  if (!atlasKey) {
    throw new Error("FRIDAY_KEY environment variable is not set");
  }

  const credentials = await deps.fetch({ atlasKey, retries: 3, retryDelay: 2000 });
  deps.setEnv(credentials);
}
