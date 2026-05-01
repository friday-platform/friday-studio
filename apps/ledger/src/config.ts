import process from "node:process";
import { createLogger } from "@atlas/logger";
import { load } from "@std/dotenv";

const logger = createLogger({ component: "ledger-config" });

/** Loads environment from DOT_ENV file if specified. Must be called before accessing config. */
async function loadEnv(): Promise<void> {
  const dotEnvPath = process.env.DOT_ENV;
  if (dotEnvPath) {
    try {
      await load({ export: true, envPath: dotEnvPath });
    } catch {
      logger.warn("no .env file found, using env vars", { path: dotEnvPath });
    }
  } else {
    try {
      await load({ export: true });
    } catch {
      // Silent - no .env file is normal in production
    }
  }
}

/** Reads configuration from environment variables. */
export function readConfig() {
  return {
    /** Development mode - disables JWT verification and uses 'dev' user */
    devMode: process.env.DEV_MODE === "true",

    /** Port to listen on */
    port: parseInt(process.env.PORT ?? "3200", 10),

    /** Path to JWT public key PEM file (required in production) */
    jwtPublicKeyFile: process.env.JWT_PUBLIC_KEY_FILE,

    /** Path to SQLite database file */
    sqlitePath: process.env.SQLITE_PATH,
  } as const;
}

await loadEnv();

export const config = readConfig();
