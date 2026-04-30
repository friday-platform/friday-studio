import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { logger } from "@atlas/logger";
import { flush as flushSentry, initSentry } from "@atlas/sentry";
import { getFridayHome } from "@atlas/utils/paths.server";
import { getConnInfo } from "hono/deno";
import { HTTPException } from "hono/http-exception";
import { jwt } from "hono/jwt";
import { routePath } from "hono/route";
import { trimTrailingSlash } from "hono/trailing-slash";
import postgres from "postgres";
import {
  type CommunicatorWiringRepository,
  PostgresCommunicatorWiringRepository,
} from "./adapters/communicator-wiring-repository.ts";
import { CypherStorageAdapter } from "./adapters/cypher-storage-adapter.ts";
import { FileSystemStorageAdapter } from "./adapters/filesystem-adapter.ts";
import {
  NoOpPlatformRouteRepository,
  type PlatformRouteRepository,
  PostgresPlatformRouteRepository,
} from "./adapters/platform-route-repository.ts";
import { SqliteCommunicatorWiringRepository } from "./adapters/sqlite-communicator-wiring-repository.ts";
import { AppInstallService } from "./app-install/service.ts";
import { getAuthToken, runWithAuthToken } from "./auth-context.ts";
import { config, readConfig } from "./config.ts";
import { CypherHttpClient } from "./cypher-client.ts";
import { factory } from "./factory.ts";
import { getMetrics, recordRequest } from "./metrics.ts";
import { OAuthService } from "./oauth/service.ts";
import {
  DISCORD_PROVIDER,
  SLACK_PROVIDER,
  TEAMS_PROVIDER,
  TELEGRAM_PROVIDER,
  WHATSAPP_PROVIDER,
} from "./providers/constants.ts";
import { discordProvider } from "./providers/discord.ts";
import { registry } from "./providers/registry.ts";
import { slackProvider } from "./providers/slack.ts";
import { teamsProvider } from "./providers/teams.ts";
import { telegramProvider } from "./providers/telegram.ts";
import { whatsappProvider } from "./providers/whatsapp.ts";
import { createAppInstallRoutes } from "./routes/app-install.ts";
import { createCallbackRoutes } from "./routes/callback.ts";
import { createCommunicatorRoutes } from "./routes/communicator.ts";
import { createCredentialsRoutes, createInternalCredentialsRoutes } from "./routes/credentials.ts";
import { createOAuthRoutes } from "./routes/oauth.ts";
import { providersRouter } from "./routes/providers.ts";
import { createSummaryRoutes } from "./routes/summary.ts";
import type { StorageAdapter } from "./types.ts";

/** Create Link application. Reads config fresh on each call to support testing. */
export function createApp(
  storage: StorageAdapter,
  oauthService: OAuthService,
  platformRouteRepo: PlatformRouteRepository,
  communicatorWiringRepo: CommunicatorWiringRepository,
) {
  const cfg = readConfig();
  const callbackBase = process.env.LINK_CALLBACK_BASE || "http://localhost:3000";

  const authTokenMiddleware = factory.createMiddleware((c, next) => {
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    return runWithAuthToken(token, () => next());
  });

  const tenancyMiddleware = factory.createMiddleware(async (c, next) => {
    if (cfg.devMode) {
      c.set("userId", "dev");
      await next();
      return;
    }

    const payload = c.get("jwtPayload");
    const userId = payload?.user_metadata?.tempest_user_id;
    if (!userId) {
      logger.error("JWT missing tempest_user_id", { path: c.req.path, sub: payload?.sub });
      return c.json({ error: "missing_user_id" }, 401);
    }
    c.set("userId", userId);
    await next();
  });

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

  const accessLogMiddleware = factory.createMiddleware(async (c, next) => {
    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    const status = c.res.status;
    const method = c.req.method;
    const path = c.req.path;

    if (path === "/health" || path === "/metrics") return;

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
    .use(accessLogMiddleware)
    .use(trimTrailingSlash())
    .get("/health", (c) => c.json({ status: "ok", service: "link" }))
    .get("/metrics", (c) => {
      c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return c.text(getMetrics());
    });

  if (!cfg.devMode) {
    if (!cfg.jwtPublicKeyFile) {
      throw new Error("LINK_JWT_PUBLIC_KEY_FILE required");
    }
    const publicKeyPem = readFileSync(cfg.jwtPublicKeyFile, "utf-8").trim();
    const jwtMiddleware = jwt({ alg: "RS256", secret: publicKeyPem });

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

  baseApp.use("/v1/*", authTokenMiddleware);
  baseApp.use("/v1/*", tenancyMiddleware);
  baseApp.use("/v1/*", externalUrlMiddleware);
  baseApp.use("/internal/*", authTokenMiddleware);
  baseApp.use("/internal/*", tenancyMiddleware);
  baseApp.use("/internal/*", externalUrlMiddleware);

  const appInstallService = new AppInstallService(
    registry,
    storage,
    platformRouteRepo,
    callbackBase,
  );

  if (!registry.has(SLACK_PROVIDER)) {
    registry.register(slackProvider);
  }

  if (!registry.has(TELEGRAM_PROVIDER)) {
    registry.register(telegramProvider);
  }

  if (!registry.has(DISCORD_PROVIDER)) {
    registry.register(discordProvider);
  }

  if (!registry.has(TEAMS_PROVIDER)) {
    registry.register(teamsProvider);
  }

  if (!registry.has(WHATSAPP_PROVIDER)) {
    registry.register(whatsappProvider);
  }

  return baseApp
    .route("/v1/providers", providersRouter)
    .route("/v1/oauth", createOAuthRoutes(registry, oauthService, storage))
    .route("/v1/callback", createCallbackRoutes(oauthService, appInstallService))
    .route("/v1/credentials", createCredentialsRoutes(storage, oauthService))
    .route("/v1/summary", createSummaryRoutes(storage))
    .route("/internal/v1/credentials", createInternalCredentialsRoutes(storage, oauthService))
    .route("/v1/app-install", createAppInstallRoutes(appInstallService))
    .route(
      "/internal/v1/communicator",
      createCommunicatorRoutes(communicatorWiringRepo, storage, registry),
    );
}

let sql: ReturnType<typeof postgres> | null = null;
let server: Deno.HttpServer | null = null;

/** Create storage adapter. Postgres is used for platform_route even without Cypher. */
function createStorage(): StorageAdapter {
  if (config.postgresConnection) {
    sql = postgres(config.postgresConnection, config.postgresPool);
    logger.info("Postgres connection initialized", {
      postgres: config.postgresConnection.split("@")[1]?.split("/")[0] ?? "configured",
      pool: config.postgresPool,
    });
  }

  if (config.cypherServiceUrl && sql) {
    logger.info("Using CypherStorageAdapter", { cypherUrl: config.cypherServiceUrl });

    const cypher = new CypherHttpClient(config.cypherServiceUrl, () =>
      Promise.resolve(getAuthToken()),
    );

    return new CypherStorageAdapter(cypher, sql);
  }

  logger.info("Using FileSystemStorageAdapter");
  return new FileSystemStorageAdapter();
}

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info("Received signal, shutting down gracefully", { signal });

  const shutdownTimeout = setTimeout(() => {
    logger.error("Shutdown timeout, forcing exit");
    process.exit(1);
  }, 25000);

  try {
    if (server) {
      await server.shutdown();
      logger.info("HTTP server stopped");
    }

    if (sql) {
      await sql.end({ timeout: 5 });
      logger.info("Postgres pool closed");
    }

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

const defaultStorage = createStorage();
const defaultOAuthService = new OAuthService(registry, defaultStorage);

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

function createCommunicatorWiringRepo(): CommunicatorWiringRepository {
  if (sql) {
    return new PostgresCommunicatorWiringRepository(sql);
  }
  if (config.devMode) {
    // `link/` collides with the link binary itself when the launcher
    // unpacks all binaries flat into ~/.friday/local — `link-data/`
    // is a sibling directory that can coexist.
    const dbDir = join(getFridayHome(), "link-data");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "wiring.db");
    logger.info("Using SqliteCommunicatorWiringRepository", { dbPath });
    return new SqliteCommunicatorWiringRepository(dbPath);
  }
  throw new Error("POSTGRES_CONNECTION required in production for communicator wiring storage");
}

const communicatorWiringRepo = createCommunicatorWiringRepo();

export const app = createApp(
  defaultStorage,
  defaultOAuthService,
  platformRouteRepo,
  communicatorWiringRepo,
);

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
export type { Credential, CredentialSummary, OAuthCredential } from "./types.ts";

if (import.meta.main) {
  initSentry();
  logger.info("Link service starting", { port: config.port });

  Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));

  server = Deno.serve({ port: config.port, onListen: () => {}, handler: app.fetch });
}
