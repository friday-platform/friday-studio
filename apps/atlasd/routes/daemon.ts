import { daemonFactory } from "../src/factory.ts";

const daemonApp = daemonFactory
  .createApp()
  /** Get daemon status */
  .get("/status", (c) => {
    const ctx = c.get("app");

    return c.json({
      status: "running",
      ...ctx.daemon.getStatus(),
      memoryUsage: Deno.memoryUsage(),
      workspaces: Array.from(ctx.daemon.getActiveWorkspaces()),
    } as const);
  })
  /** Shutdown daemon */
  .post("/shutdown", (c) => {
    const ctx = c.get("app");

    // Graceful shutdown endpoint
    // Don't await - respond immediately then shutdown
    setTimeout(() => ctx.daemon.shutdown(), 100);

    return c.json({ message: "Daemon shutdown initiated" });
  });

export { daemonApp };
export type DaemonRoutes = typeof daemonApp;
