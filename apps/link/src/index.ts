import { readFileSync } from "node:fs";
import { logger } from "@atlas/logger";
import { jwt } from "hono/jwt";
import { trimTrailingSlash } from "hono/trailing-slash";
import * as jose from "jose";
import { DenoKVStorageAdapter } from "./adapters/deno-kv-adapter.ts";
import { config, readConfig } from "./config.ts";
import { factory } from "./factory.ts";
import { OAuthService } from "./oauth/service.ts";
import { registry } from "./providers/registry.ts";
import { createCredentialsRoutes, createInternalCredentialsRoutes } from "./routes/credentials.ts";
import { createOAuthRoutes } from "./routes/oauth.ts";
import { providersRouter } from "./routes/providers.ts";
import type { StorageAdapter } from "./types.ts";

/**
 * Create Link application with dependency-injected storage adapter and OAuth service.
 * Uses method chaining for proper type inference (critical for RPC).
 *
 * Reads config fresh on each call to support testing with different env vars.
 */
export async function createApp(_storage: StorageAdapter, _oauthService: OAuthService) {
  // Read config fresh to support testing with different env vars
  const cfg = readConfig();

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

  const baseApp = factory
    .createApp()
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
    // Import PEM as KeyLike for hono/jwt
    const publicKey = await jose.importSPKI(publicKeyPem, "RS256");

    // hono/jwt can only check one header at a time, so we need to wrap it
    // to check both X-Atlas-Key and Authorization headers
    const jwtMiddleware = jwt({ alg: "RS256", secret: publicKey });
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

  // Apply tenancy middleware to protected routes (after JWT verification)
  baseApp.use("/v1/*", tenancyMiddleware);
  baseApp.use("/internal/*", tenancyMiddleware);

  return (
    baseApp
      // Provider catalog routes
      .route("/v1/providers", providersRouter)
      // OAuth flow routes
      .route("/v1/oauth", createOAuthRoutes(registry, _oauthService, _storage))
      // Public credential management API (no secrets in responses)
      .route("/v1/credentials", createCredentialsRoutes(_storage, _oauthService))
      // Internal runtime access API (returns secrets with proactive OAuth refresh)
      .route("/internal/v1/credentials", createInternalCredentialsRoutes(_storage, _oauthService))
  );
}

// Default storage adapter
const defaultStorage = new DenoKVStorageAdapter(config.dbPath);

// Default OAuth service for production
const defaultOAuthService = new OAuthService(registry, defaultStorage);

// Export app instance for testing and RPC type inference (await at module load)
export const app = await createApp(defaultStorage, defaultOAuthService);

// Export app type for RPC client (hc<LinkRoutes>())
export type LinkRoutes = typeof app;

// Only start server when run directly (not when imported for tests)
if (import.meta.main) {
  logger.info("Link service starting", { kvPath: config.dbPath, port: config.port });
  Deno.serve({ port: config.port, handler: app.fetch });
}
