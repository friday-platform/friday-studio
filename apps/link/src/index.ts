import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { logger } from "@atlas/logger";
import { jwt } from "hono/jwt";
import { trimTrailingSlash } from "hono/trailing-slash";
import postgres from "postgres";
import { CypherStorageAdapter } from "./adapters/cypher-storage-adapter.ts";
import { DenoKVStorageAdapter } from "./adapters/deno-kv-adapter.ts";
import { config, readConfig } from "./config.ts";
import { CypherHttpClient } from "./cypher-client.ts";
import { factory } from "./factory.ts";
import { OAuthService } from "./oauth/service.ts";
import { registry } from "./providers/registry.ts";
import { createCredentialsRoutes, createInternalCredentialsRoutes } from "./routes/credentials.ts";
import { createOAuthRoutes } from "./routes/oauth.ts";
import { providersRouter } from "./routes/providers.ts";
import type { StorageAdapter } from "./types.ts";

/**
 * AsyncLocalStorage for per-request auth token.
 * Used by CypherHttpClient to get the token for the current request.
 */
const authTokenStorage = new AsyncLocalStorage<string>();

/**
 * Get the auth token for the current request from AsyncLocalStorage.
 */
function getAuthToken(): string {
  return authTokenStorage.getStore() ?? "";
}

/**
 * Create Link application with dependency-injected storage adapter and OAuth service.
 * Uses method chaining for proper type inference (critical for RPC).
 *
 * Reads config fresh on each call to support testing with different env vars.
 */
export function createApp(storage: StorageAdapter, oauthService: OAuthService) {
  // Read config fresh to support testing with different env vars
  const cfg = readConfig();

  /**
   * Auth token middleware - captures JWT for forwarding to Cypher service.
   * Stores token in AsyncLocalStorage so CypherHttpClient can access it.
   */
  const authTokenMiddleware = factory.createMiddleware((c, next) => {
    const authHeader = c.req.header("Authorization") ?? c.req.header("X-Atlas-Key");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : (authHeader ?? "");
    return authTokenStorage.run(token, () => next());
  });

  /**
   * Tenancy middleware - extracts userId from Traefik header (X-Atlas-User-ID).
   * In dev mode, falls back to 'dev' user if header is missing.
   * In production, requires the header to be present.
   */
  const tenancyMiddleware = factory.createMiddleware(async (c, next) => {
    const userId = c.req.header("X-Atlas-User-ID");
    if (!userId && !cfg.devMode) {
      return c.json({ error: "missing_user_id" }, 401);
    }
    c.set("userId", userId ?? "dev");
    await next();
  });

  /**
   * Access log middleware - logs all requests with method, path, status, and duration.
   */
  const accessLogMiddleware = factory.createMiddleware(async (c, next) => {
    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    const status = c.res.status;
    const method = c.req.method;
    const path = c.req.path;

    // Skip health checks to reduce noise
    if (path === "/health") return;

    logger.info("request", { method, path, status, durationMs: duration, userId: c.get("userId") });
  });

  const baseApp = factory
    .createApp()
    // Access logging (first middleware to capture all requests)
    .use(accessLogMiddleware)
    // Redirect trailing slashes to canonical paths
    .use(trimTrailingSlash())
    // Health check
    .get("/health", (c) => c.json({ status: "ok", service: "link" }));

  // Apply JWT verification in production mode
  if (!cfg.devMode) {
    if (!cfg.jwtPublicKeyFile) {
      throw new Error("LINK_JWT_PUBLIC_KEY_FILE required");
    }
    const publicKeyPem = readFileSync(cfg.jwtPublicKeyFile, "utf-8").trim();

    // hono/jwt can only check one header at a time, so we need to wrap it
    // to check both X-Atlas-Key and Authorization headers
    const jwtMiddleware = jwt({ alg: "RS256", secret: publicKeyPem });
    const jwtChecker = factory.createMiddleware((c, next) => {
      const atlasKey = c.req.header("X-Atlas-Key");
      if (atlasKey) {
        // Set as Authorization header so jwt middleware can find it
        c.req.raw.headers.set("Authorization", `Bearer ${atlasKey}`);
      }
      return jwtMiddleware(c, next);
    });

    baseApp.use("/v1/*", jwtChecker);
    baseApp.use("/internal/*", jwtChecker);
  }

  // Apply auth token and tenancy middleware to protected routes (after JWT verification)
  baseApp.use("/v1/*", authTokenMiddleware);
  baseApp.use("/v1/*", tenancyMiddleware);
  baseApp.use("/internal/*", authTokenMiddleware);
  baseApp.use("/internal/*", tenancyMiddleware);

  return (
    baseApp
      // Provider catalog routes
      .route("/v1/providers", providersRouter)
      // OAuth flow routes
      .route("/v1/oauth", createOAuthRoutes(registry, oauthService, storage))
      // Public credential management API (no secrets in responses)
      .route("/v1/credentials", createCredentialsRoutes(storage, oauthService))
      // Internal runtime access API (returns secrets with proactive OAuth refresh)
      .route("/internal/v1/credentials", createInternalCredentialsRoutes(storage, oauthService))
  );
}

/** Postgres connection pool - stored for graceful shutdown */
let sql: ReturnType<typeof postgres> | null = null;

/**
 * Create storage adapter based on configuration.
 * Uses CypherStorageAdapter if Cypher and Postgres are configured, otherwise DenoKV.
 */
function createStorage(): StorageAdapter {
  if (config.cypherServiceUrl && config.postgresConnection) {
    logger.info("Using CypherStorageAdapter", {
      cypherUrl: config.cypherServiceUrl,
      postgres: config.postgresConnection.split("@")[1]?.split("/")[0] ?? "configured",
      pool: config.postgresPool,
    });

    sql = postgres(config.postgresConnection, config.postgresPool);
    const cypher = new CypherHttpClient(config.cypherServiceUrl, () => {
      // Return the token from AsyncLocalStorage for the current request
      return Promise.resolve(getAuthToken());
    });

    return new CypherStorageAdapter(cypher, sql);
  }

  logger.info("Using DenoKVStorageAdapter", { dbPath: config.dbPath });
  return new DenoKVStorageAdapter(config.dbPath);
}

/**
 * Graceful shutdown - close database connections.
 */
async function shutdown(): Promise<void> {
  logger.info("Shutting down...");
  if (sql) {
    await sql.end({ timeout: 5 });
    logger.info("Postgres pool closed");
  }
}

// Default storage adapter
const defaultStorage = createStorage();

// Default OAuth service for production
const defaultOAuthService = new OAuthService(registry, defaultStorage);

// Export app instance for testing and RPC type inference
export const app = createApp(defaultStorage, defaultOAuthService);

// Export app type for RPC client (hc<LinkRoutes>())
export type LinkRoutes = typeof app;

// Export types for external use
export type { Credential, CredentialSummary, OAuthCredential } from "./types.ts";

// Only start server when run directly (not when imported for tests)
if (import.meta.main) {
  logger.info("Link service starting", { port: config.port });

  // Register shutdown handlers
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  Deno.serve({ port: config.port, onListen: () => {}, handler: app.fetch });
}
