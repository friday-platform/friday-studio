import { Hono, type MiddlewareHandler } from "hono";
import { buildHonoProxy } from "./proxy.ts";
import { api } from "./router.ts";

export interface BuildStaticAppOptions {
  daemonUrl: string;
  tunnelUrl: string;
  indexHtml: () => Promise<string>;
  staticMiddleware?: MiddlewareHandler;
}

/**
 * Build the production playground Hono app without starting a listener.
 *
 * Kept separate from `static-server.ts` so tests can pin route ordering: API
 * routes must run before static serving / SPA fallback, or adapter-static
 * route stripping regresses silently.
 */
export function buildStaticApp(options: BuildStaticAppOptions): Hono {
  const proxies = new Hono()
    .all("/api/daemon/*", buildHonoProxy(options.daemonUrl, "daemon"))
    .all("/api/tunnel/*", buildHonoProxy(options.tunnelUrl, "tunnel"));

  const app = new Hono()
    .route("/", proxies)
    .route("/", api)
    .get("/", async (c) => c.html(await options.indexHtml()));

  if (options.staticMiddleware) {
    app.use("/*", options.staticMiddleware);
  }

  app.get("/*", async (c) => c.html(await options.indexHtml()));
  return app;
}
