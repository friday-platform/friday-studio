import { daemonFactory } from "../src/factory.ts";

const healthRoutes = daemonFactory.createApp().get("/", (c) => {
  const ctx = c.get("app");

  return c.json({
    // Active dispatch count — successor to the pre-deletion "active runtimes"
    // figure, sourced from the dispatch registry instead of an in-memory cache.
    activeWorkspaces: ctx.sessionDispatchRegistry.list().length,
    uptime: Date.now() - ctx.startTime,
    timestamp: new Date().toISOString(),
    version: { deno: Deno.version.deno, v8: Deno.version.v8, typescript: Deno.version.typescript },
  });
});

export { healthRoutes };
export type HealthRoutes = typeof healthRoutes;
