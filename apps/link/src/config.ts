import { join } from "node:path";
import process from "node:process";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { load } from "@std/dotenv";

/**
 * Load environment from DOT_ENV file if specified (matches Go bounce pattern).
 * Must be called before accessing any config values.
 */
async function loadEnv(): Promise<void> {
  const dotEnvPath = process.env.DOT_ENV;
  if (dotEnvPath) {
    try {
      await load({ export: true, envPath: dotEnvPath });
    } catch {
      console.warn(`no .env file found at - ${dotEnvPath}, using env vars`);
    }
  } else {
    try {
      await load({ export: true });
    } catch {
      // Silent - no .env file is normal in production
    }
  }
}

/**
 * Read configuration from environment variables.
 * Called once at startup after loadEnv().
 */
export function readConfig() {
  return {
    /** Development mode - disables JWT verification and uses 'dev' user */
    devMode: process.env.LINK_DEV_MODE === "true",

    /** Port to listen on */
    port: parseInt(process.env.LINK_PORT ?? "3100", 10),

    /** Path to JWT public key PEM file (required in production) */
    jwtPublicKeyFile: process.env.LINK_JWT_PUBLIC_KEY_FILE,

    /** Path to Deno KV database file */
    dbPath: process.env.LINK_DB_PATH ?? join(getAtlasHome(), "credentials.db"),
  } as const;
}

// Load env file before reading config
await loadEnv();

/**
 * Link service configuration.
 * All environment variables are read here in one place.
 */
export const config = readConfig();
