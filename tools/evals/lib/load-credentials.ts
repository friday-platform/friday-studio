import { access } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fetchCredentials, setToEnv } from "@atlas/core/credentials";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { load } from "@std/dotenv";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches bundled API credentials and sets them as environment variables.
 */
export async function loadCredentials() {
  await load({ export: true });

  // Load global Atlas configuration as fallback
  // Note: getAtlasHome() will return the appropriate path based on system/user mode
  const globalAtlasEnv = join(getAtlasHome(), ".env");
  if (await exists(globalAtlasEnv)) {
    await load({ export: true, envPath: globalAtlasEnv });
  }

  const atlasKey = process.env.ATLAS_KEY;
  if (!atlasKey) {
    throw new Error("ATLAS_KEY environment variable is not set");
  }
  const credentials = await fetchCredentials({ atlasKey, retries: 3, retryDelay: 2000 });
  setToEnv(credentials);
}
