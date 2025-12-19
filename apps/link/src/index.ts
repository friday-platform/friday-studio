import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { logger } from "@atlas/logger";
import { HTTPException } from "hono/http-exception";
import { jwt } from "hono/jwt";
import { routePath } from "hono/route";
import { trimTrailingSlash } from "hono/trailing-slash";
import postgres from "postgres";
import { CypherStorageAdapter } from "./adapters/cypher-storage-adapter.ts";
import { DenoKVStorageAdapter } from "./adapters/deno-kv-adapter.ts";
import { config, readConfig } from "./config.ts";
import { CypherHttpClient } from "./cypher-client.ts";
import { factory } from "./factory.ts";
import { getMetrics, recordRequest } from "./metrics.ts";
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
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    return authTokenStorage.run(token, () => next());
  });

  /**
   * Tenancy middleware - extracts userId from JWT payload.
   * In dev mode, falls back to 'dev' user.
   * In production, requires JWT with user_metadata.tempest_user_id.
   */
  const tenancyMiddleware = factory.createMiddleware(async (c, next) => {
    // In dev mode (no JWT verification), use fallback
    if (cfg.devMode) {
      c.set("userId", "dev");
      await next();
      return;
    }

    // In prod, extract from verified JWT payload
    const payload = c.get("jwtPayload");
    const userId = payload?.user_metadata?.tempest_user_id;
    if (!userId) {
      logger.error("JWT missing tempest_user_id", { path: c.req.path, sub: payload?.sub });
      return c.json({ error: "missing_user_id" }, 401);
    }
    c.set("userId", userId);
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

    // Skip health checks and metrics to reduce noise
    if (path === "/health" || path === "/metrics") return;

    // Record metrics using route pattern (e.g., /v1/credentials/:id) for bounded cardinality
    recordRequest(method, routePath(c), status, duration);

    logger.info("request", { method, path, status, durationMs: duration, userId: c.get("userId") });
  });

  const baseApp = factory
    .createApp()
    // Access logging (first middleware to capture all requests)
    .use(accessLogMiddleware)
    // Redirect trailing slashes to canonical paths
    .use(trimTrailingSlash())
    // Health check
    .get("/health", (c) => c.json({ status: "ok", service: "link" }))
    // Prometheus metrics
    .get("/metrics", (c) => {
      c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return c.text(getMetrics());
    });

  // Apply JWT verification in production mode
  if (!cfg.devMode) {
    if (!cfg.jwtPublicKeyFile) {
      throw new Error("LINK_JWT_PUBLIC_KEY_FILE required");
    }
    const publicKeyPem = readFileSync(cfg.jwtPublicKeyFile, "utf-8").trim();
    const jwtMiddleware = jwt({ alg: "RS256", secret: publicKeyPem });

    // Log JWT failures (HTTPException.cause contains the actual error)
    baseApp.onError((err, c) => {
      if (err instanceof HTTPException && err.status === 401) {
        logger.error("JWT verification failed", {
          path: c.req.path,
          error: err.cause instanceof Error ? err.cause.message : err.message,
        });
        return err.getResponse();
      }
      throw err;
    });

    baseApp.use("/v1/*", jwtMiddleware);
    baseApp.use("/internal/*", jwtMiddleware);
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
