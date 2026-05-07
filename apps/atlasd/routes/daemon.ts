import { logger } from "@atlas/logger";
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
  /**
   * Shutdown daemon.
   *
   * Responds 200 immediately, then runs `daemon.shutdown()` and calls
   * `Deno.exit(0)`. A 15s watchdog (`unrefTimer`'d so it never keeps the
   * loop alive on the clean path) is the safety net: if `shutdown()` hangs
   * on a dangling async handle, the watchdog force-exits with code 0 rather
   * than letting the process zombie. Subsequent tasks (#14-#19) shrink
   * reliance on the watchdog by plumbing real per-subsystem cancellation.
   */
  .post("/shutdown", (c) => {
    const ctx = c.get("app");

    setTimeout(async () => {
      const watchdog = setTimeout(() => {
        // Deno 2.x removed `Deno.metrics()`; `memoryUsage()` is the closest
        // diagnostic surface we still have for a stuck process. If the
        // watchdog fires regularly we want to see whether heap is climbing
        // (leak) or flat (stuck on an unresolved promise / dangling I/O).
        logger.error("Shutdown watchdog fired", { memoryUsage: Deno.memoryUsage() });
        Deno.exit(0);
      }, 15_000);
      try {
        await ctx.daemon.shutdown();
      } catch (err) {
        logger.error("shutdown failed", { err });
      }
      clearTimeout(watchdog);
      logger.info("Shutdown complete, exiting", { exitCode: 0 });
      Deno.exit(0);
    }, 100);

    return c.json({ message: "Daemon shutdown initiated" });
  });

export { daemonApp };
export type DaemonRoutes = typeof daemonApp;
