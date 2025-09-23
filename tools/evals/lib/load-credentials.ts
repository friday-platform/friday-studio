import { fetchCredentials, setToDenoEnv } from "@atlas/core";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { load } from "@std/dotenv";
import { exists } from "@std/fs";
import { join } from "@std/path";

/**
 * Fetches bundled API credentials and sets them as Deno environment variables.
 */
export async function loadCredentials() {
  await load({ export: true });

  // Load global Atlas configuration as fallback
  // Note: getAtlasHome() will return the appropriate path based on system/user mode
  const globalAtlasEnv = join(getAtlasHome(), ".env");
  if (await exists(globalAtlasEnv)) {
    await load({ export: true, envPath: globalAtlasEnv });
  }

  const atlasKey = Deno.env.get("ATLAS_KEY");
  if (!atlasKey) {
    throw new Error("ATLAS_KEY environment variable is not set");
  }
  const credentials = await fetchCredentials({ atlasKey, retries: 3, retryDelay: 2000 });
  setToDenoEnv(credentials);
}
