import { join } from "node:path";
import process from "node:process";
import { logger } from "@atlas/logger";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { load } from "@std/dotenv";

/** Load environment from DOT_ENV file if specified (matches Go bounce pattern). */
async function loadEnv(): Promise<void> {
  const dotEnvPath = process.env.DOT_ENV;
  if (dotEnvPath) {
    try {
      await load({ export: true, envPath: dotEnvPath });
    } catch {
      logger.warn("dotenv_not_found", { path: dotEnvPath });
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
 * PostgreSQL pool configuration matching Go services (cypher).
 * See: apps/cypher/service/service.go Init()
 */
const postgresPoolConfig = {
  max: 10,
  /** Go: MaxConnIdleTime = 5 min */
  idle_timeout: 5 * 60,
  /** Go: MaxConnLifetime = 15 min */
  max_lifetime: 15 * 60,
  connect_timeout: 30,
} as const;

/** Reads config from environment. Called once at startup after loadEnv(). */
export function readConfig() {
  return {
    /** Development mode - disables JWT verification and uses 'dev' user */
    devMode: process.env.LINK_DEV_MODE === "true",

    port: parseInt(process.env.LINK_PORT ?? "3100", 10),

    /** Path to JWT public key PEM file (required in production) */
    jwtPublicKeyFile: process.env.LINK_JWT_PUBLIC_KEY_FILE,

    /** Path to credentials database file */
    dbPath: process.env.LINK_DB_PATH ?? join(getAtlasHome(), "credentials.db"),

    /** Cypher encryption service URL (optional, for CypherStorageAdapter) */
    cypherServiceUrl: process.env.CYPHER_SERVICE_URL,

    /** PostgreSQL connection string (matches Go services) */
    postgresConnection: process.env.POSTGRES_CONNECTION,

    postgresPool: postgresPoolConfig,

    /** Base URL for signal-gateway (used to build Slack webhook URLs) */
    gatewayBase: process.env.GATEWAY_BASE,
  } as const;
}

await loadEnv();

export const config = readConfig();
