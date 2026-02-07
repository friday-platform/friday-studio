import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import process from "node:process";
import { logger } from "@atlas/logger";
import { flush as flushSentry, initSentry } from "@atlas/sentry";
import { getConnInfo } from "hono/deno";
import { HTTPException } from "hono/http-exception";
import { jwt } from "hono/jwt";
import { routePath } from "hono/route";
import { trimTrailingSlash } from "hono/trailing-slash";
import postgres from "postgres";
import { CypherStorageAdapter } from "./adapters/cypher-storage-adapter.ts";
import { FileSystemStorageAdapter } from "./adapters/filesystem-adapter.ts";
import {
  NoOpPlatformRouteRepository,
  type PlatformRouteRepository,
  PostgresPlatformRouteRepository,
} from "./adapters/platform-route-repository.ts";
import { AppInstallService } from "./app-install/service.ts";
import { config, readConfig } from "./config.ts";
import { CypherHttpClient } from "./cypher-client.ts";
import { factory } from "./factory.ts";
import { getMetrics, recordRequest } from "./metrics.ts";
import { OAuthService } from "./oauth/service.ts";
import { registry } from "./providers/registry.ts";
import { createAppInstallRoutes } from "./routes/app-install.ts";
import { createCallbackRoutes } from "./routes/callback.ts";
import { createCredentialsRoutes, createInternalCredentialsRoutes } from "./routes/credentials.ts";
import { createOAuthRoutes } from "./routes/oauth.ts";
import { providersRouter } from "./routes/providers.ts";
import { createSummaryRoutes } from "./routes/summary.ts";
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
export function createApp(
  storage: StorageAdapter,
  oauthService: OAuthService,
  platformRouteRepo: PlatformRouteRepository,
) {
  // Read config fresh to support testing with different env vars
  const cfg = readConfig();

  // Callback base URL for OAuth redirects
  const callbackBase = Deno.env.get("LINK_CALLBACK_BASE") || "http://localhost:3000";

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
   * External URL middleware - computes base URL for external-facing URLs.
   * Respects X-Forwarded-* headers when behind a proxy, allowing Link to
   * generate correct redirect URLs and Location headers without the proxy
   * needing to rewrite them.
   *
   * Headers:
   * - X-Forwarded-Host: The original host the client connected to
   * - X-Forwarded-Proto: The original protocol (http/https)
   * - X-Forwarded-Prefix: Path prefix to prepend (e.g., /api/link)
   */
  const externalUrlMiddleware = factory.createMiddleware(async (c, next) => {
    const forwardedHost = c.req.header("X-Forwarded-Host");
    const forwardedProto = c.req.header("X-Forwarded-Proto") || "https";
    const forwardedPrefix = c.req.header("X-Forwarded-Prefix") || "";

    const baseUrl = forwardedHost
      ? `${forwardedProto}://${forwardedHost}${forwardedPrefix}`
      : new URL(c.req.url).origin;

    c.set("externalBaseUrl", baseUrl);
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

    logger.info("request", {
      method,
      path,
      status,
      durationMs: duration,
      userId: c.get("userId"),
      sourceIp: c.env ? getConnInfo(c).remote.address : undefined,
    });
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
          sourceIp: c.env ? getConnInfo(c).remote.address : undefined,
        });
        return err.getResponse();
      }
      throw err;
    });

    baseApp.use("/v1/*", jwtMiddleware);
    baseApp.use("/internal/*", jwtMiddleware);
  }

  // Apply auth token, tenancy, and external URL middleware to protected routes (after JWT verification)
  baseApp.use("/v1/*", authTokenMiddleware);
  baseApp.use("/v1/*", tenancyMiddleware);
  baseApp.use("/v1/*", externalUrlMiddleware);
  baseApp.use("/internal/*", authTokenMiddleware);
  baseApp.use("/internal/*", tenancyMiddleware);
  baseApp.use("/internal/*", externalUrlMiddleware);

  // Create AppInstallService
  const appInstallService = new AppInstallService(
    registry,
    storage,
    platformRouteRepo,
    callbackBase,
  );

  return (
    baseApp
      // Provider catalog routes
      .route("/v1/providers", providersRouter)
      // OAuth flow routes (authorize + refresh)
      .route("/v1/oauth", createOAuthRoutes(registry, oauthService, storage))
      // Unified callback routes (provider-namespaced for readability)
      .route("/v1/callback", createCallbackRoutes(oauthService, appInstallService))
      // Public credential management API (no secrets in responses)
      .route("/v1/credentials", createCredentialsRoutes(storage, oauthService))
      // Summary endpoint - aggregated providers and credentials
      .route("/v1/summary", createSummaryRoutes(storage))
      // Internal runtime access API (returns secrets with proactive OAuth refresh)
      .route("/internal/v1/credentials", createInternalCredentialsRoutes(storage, oauthService))
      // App install routes (Slack, GitHub, etc.)
      .route("/v1/app-install", createAppInstallRoutes(appInstallService))
  );
}

/** Postgres connection pool - stored for graceful shutdown */
let sql: ReturnType<typeof postgres> | null = null;

/** HTTP server instance - stored for graceful shutdown */
let server: Deno.HttpServer | null = null;

/**
 * Create storage adapter based on configuration.
 * Uses CypherStorageAdapter if Cypher and Postgres are configured, otherwise DenoKV.
 *
 * Note: Postgres connection is created independently for platform_route even when
 * using DenoKV for credential storage (e.g., when Cypher auth isn't available).
 */
function createStorage(): StorageAdapter {
  // Create Postgres connection if configured (needed for platform_route even without Cypher)
  if (config.postgresConnection) {
    sql = postgres(config.postgresConnection, config.postgresPool);
    logger.info("Postgres connection initialized", {
      postgres: config.postgresConnection.split("@")[1]?.split("/")[0] ?? "configured",
      pool: config.postgresPool,
    });
  }

  // Use Cypher + Postgres for credential storage if both are configured
  if (config.cypherServiceUrl && sql) {
    logger.info("Using CypherStorageAdapter", { cypherUrl: config.cypherServiceUrl });

    const cypher = new CypherHttpClient(config.cypherServiceUrl, () => {
      // Return the token from AsyncLocalStorage for the current request
      return Promise.resolve(getAuthToken());
    });

    return new CypherStorageAdapter(cypher, sql);
  }

  // Fall back to filesystem storage for credential storage (platform_route still uses Postgres if available)
  logger.info("Using FileSystemStorageAdapter");
  return new FileSystemStorageAdapter();
}

/** Shutdown state to prevent multiple shutdown attempts */
let isShuttingDown = false;

/**
 * Graceful shutdown - stop server, close connections, exit.
 * Handles Kubernetes SIGTERM with proper cleanup.
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info("Received signal, shutting down gracefully", { signal });

  // Timeout to prevent hanging - Kubernetes default terminationGracePeriodSeconds is 30s
  const shutdownTimeout = setTimeout(() => {
    logger.error("Shutdown timeout, forcing exit");
    process.exit(1);
  }, 25000);

  try {
    // Stop accepting new requests
    if (server) {
      await server.shutdown();
      logger.info("HTTP server stopped");
    }

    // Close database connections
    if (sql) {
      await sql.end({ timeout: 5 });
      logger.info("Postgres pool closed");
    }

    // Flush pending Sentry events
    await flushSentry();

    clearTimeout(shutdownTimeout);
    logger.info("Shutdown complete");
    process.exit(0);
  } catch (error) {
    clearTimeout(shutdownTimeout);
    logger.error("Error during shutdown", { error });
    process.exit(1);
  }
}

// Default storage adapter
const defaultStorage = createStorage();

// Default OAuth service for production
const defaultOAuthService = new OAuthService(registry, defaultStorage);

// Create platform route repository (Postgres required in production)
function createPlatformRouteRepo(): PlatformRouteRepository {
  if (sql) {
    return new PostgresPlatformRouteRepository(sql);
  }
  if (config.devMode) {
    logger.warn("Using NoOpPlatformRouteRepository - platform routes will not persist");
    return new NoOpPlatformRouteRepository();
  }
  throw new Error("POSTGRES_CONNECTION required in production for platform route storage");
}

const platformRouteRepo = createPlatformRouteRepo();

// Export app instance for testing and RPC type inference
export const app = createApp(defaultStorage, defaultOAuthService, platformRouteRepo);

// Export app type for RPC client (hc<LinkRoutes>())
export type LinkRoutes = typeof app;

export type {
  DynamicApiKeyProviderInput,
  DynamicOAuthProviderInput,
  DynamicProviderInput,
} from "./providers/types.ts";
export {
  DynamicApiKeyProviderInputSchema,
  DynamicOAuthProviderInputSchema,
  DynamicProviderInputSchema,
} from "./providers/types.ts";
// Export types for external use
export type { Credential, CredentialSummary, OAuthCredential } from "./types.ts";

// Only start server when run directly (not when imported for tests)
if (import.meta.main) {
  initSentry();
  logger.info("Link service starting", { port: config.port });

  // Register shutdown handlers
  Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));

  server = Deno.serve({ port: config.port, onListen: () => {}, handler: app.fetch });
}
