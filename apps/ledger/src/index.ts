import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { ActivityStorageAdapter } from "@atlas/activity";
import { LocalActivityAdapter } from "@atlas/activity/local-adapter";
import { logger } from "@atlas/logger";
import { flush as flushSentry, initSentry } from "@atlas/sentry";
import { getFridayHome } from "@atlas/utils/paths.server";
import { getConnInfo } from "hono/deno";
import { HTTPException } from "hono/http-exception";
import { jwt } from "hono/jwt";
import { routePath } from "hono/route";
import { trimTrailingSlash } from "hono/trailing-slash";
import { createActivityRoutes } from "./activity-routes.ts";
import { config, readConfig } from "./config.ts";
import { factory } from "./factory.ts";
import { getMetrics, recordRequest } from "./metrics.ts";
import { createResourceRoutes } from "./routes.ts";
import { createSQLiteAdapter } from "./sqlite-adapter.ts";
import { ClientError, type ResourceStorageAdapter } from "./types.ts";

/** Factory function that produces a per-request adapter. Returns the shared SQLite instance. */
export type AdapterFactory = (userId: string) => ResourceStorageAdapter;

/** Factory function for per-request activity adapter. Same pattern as AdapterFactory. */
export type ActivityAdapterFactory = (userId: string) => ActivityStorageAdapter;

/**
 * Creates the Ledger application with dependency-injected adapter factories.
 * The factories are called per-request with the authenticated userId.
 */
export function createApp(
  adapterFactory: AdapterFactory,
  activityAdapterFactory?: ActivityAdapterFactory,
) {
  const cfg = readConfig();

  /** Extracts userId from JWT payload. In dev mode, falls back to 'dev'. */
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

  /** Logs requests with method, path, status, and duration. */
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
    .get("/health", (c) => c.json({ status: "ok", service: "ledger" }))
    .get("/metrics", (c) => {
      const res = c.text(getMetrics());
      res.headers.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return res;
    });

  if (!cfg.devMode) {
    if (!cfg.jwtPublicKeyFile) {
      throw new Error("JWT_PUBLIC_KEY_FILE required");
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
  }

  const adapterMiddleware = factory.createMiddleware(async (c, next) => {
    c.set("adapter", adapterFactory(c.get("userId")));
    await next();
  });

  const activityAdapterMiddleware = factory.createMiddleware(async (c, next) => {
    if (activityAdapterFactory) {
      c.set("activityAdapter", activityAdapterFactory(c.get("userId")));
    }
    await next();
  });

  baseApp.use("/v1/*", tenancyMiddleware);
  baseApp.use("/v1/*", adapterMiddleware);
  baseApp.use("/v1/activity/*", activityAdapterMiddleware);

  const app = baseApp
    .get("/v1/skill", async (c) => {
      const adapter = c.get("adapter");
      const toolsParam = c.req.query("tools");
      const availableTools = toolsParam ? toolsParam.split(",") : undefined;
      const skill = await adapter.getSkill(availableTools);
      return c.text(skill);
    })
    .route("/v1/resources", createResourceRoutes())
    .route("/v1/activity", createActivityRoutes())
    .onError((err, c) => {
      if (err instanceof HTTPException) throw err;

      if (err instanceof ClientError) {
        return c.json({ error: err.message }, err.status);
      }

      const detail = err instanceof Error ? err.message : "Unknown error";
      logger.error("Unhandled route error", { path: c.req.path, error: detail });
      return c.json({ error: "Internal server error" }, 500);
    });

  return app;
}

let server: Deno.HttpServer | null = null;
let isShuttingDown = false;

/** Graceful shutdown — stops server, destroys adapter, exits. */
async function shutdown(signal: string, adapter: ResourceStorageAdapter): Promise<void> {
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

    await adapter.destroy();
    logger.info("Adapter destroyed");

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

if (import.meta.main) {
  initSentry();

  const dbPath = config.sqlitePath ?? join(getFridayHome(), "ledger.db");
  const sqliteAdapter = await createSQLiteAdapter(dbPath);
  await sqliteAdapter.init();
  const lifecycleAdapter: ResourceStorageAdapter = sqliteAdapter;
  const adapterFactory: AdapterFactory = () => sqliteAdapter;
  const activityDbPath = config.sqlitePath
    ? join(config.sqlitePath, "..", "activity.db")
    : join(getFridayHome(), "activity.db");
  const sharedActivityAdapter = new LocalActivityAdapter(activityDbPath);
  const activityAdapterFactory: ActivityAdapterFactory = () => sharedActivityAdapter;
  logger.info("Ledger started with SQLite adapter", { path: dbPath });

  const app = createApp(adapterFactory, activityAdapterFactory);
  logger.info("Ledger service starting", { port: config.port });

  Deno.addSignalListener("SIGINT", () => shutdown("SIGINT", lifecycleAdapter));
  Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM", lifecycleAdapter));

  server = Deno.serve({ port: config.port, onListen: () => {}, handler: app.fetch });
}

export type {
  GetResourceOptions,
  MutateResult,
  ProvisionInput,
  PublishedResourceInfo,
  PublishResult,
  QueryResult,
  ResourceMetadata,
  ResourceStorageAdapter,
  ResourceVersion,
  ResourceWithData,
} from "./types.ts";
export {
  ResourceMetadataSchema,
  ResourceVersionSchema,
  ResourceWithDataSchema,
} from "./types.ts";
export type LedgerApp = ReturnType<typeof createApp>;
