import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fetchCredentials, setToEnv } from "@atlas/core/credentials";
import { getAtlasHome } from "@atlas/utils/paths.server";
import dotenv from "dotenv";

/**
 * Fetches bundled API credentials and sets them as Node environment variables.
 */
export async function loadCredentials() {
  dotenv.config();

  // Load global Atlas configuration as fallback
  // Note: getAtlasHome() will return the appropriate path based on system/user mode
  const globalAtlasEnv = join(getAtlasHome(), ".env");
  if (existsSync(globalAtlasEnv)) {
    dotenv.config({ path: globalAtlasEnv, override: true });
  }

  const atlasKey = process.env.ATLAS_KEY;
  if (!atlasKey) {
    throw new Error("ATLAS_KEY environment variable is not set");
  }
  const credentials = await fetchCredentials({ atlasKey, retries: 3, retryDelay: 2000 });
  setToEnv(credentials);
}
