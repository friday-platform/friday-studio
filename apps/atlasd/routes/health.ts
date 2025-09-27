import { daemonFactory } from "../src/factory.ts";

const healthRoutes = daemonFactory.createApp().get("/", (c) => {
  const ctx = c.get("app");

  return c.json({
    activeWorkspaces: ctx.runtimes.size,
    uptime: Date.now() - ctx.startTime,
    timestamp: new Date().toISOString(),
    version: { deno: Deno.version.deno, v8: Deno.version.v8, typescript: Deno.version.typescript },
  });
});

export { healthRoutes };
export type HealthRoutes = typeof healthRoutes;
