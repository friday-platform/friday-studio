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
   * Shutdown daemon. Responds 200, then runs `daemon.shutdown()` and exits.
   *
   * Exit codes: 0 on clean resolve; 1 if the watchdog fires or shutdown rejects
   * (supervisors distinguish failed teardown from clean exit).
   *
   * The 15s watchdog is a safety net for hangs on dangling async handles.
   */
  .post("/shutdown", (c) => {
    const ctx = c.get("app");
    const watchdogMs = Number(Deno.env.get("ATLAS_SHUTDOWN_WATCHDOG_MS") ?? "15000") || 15_000;

    // `daemon.shutdown()` is memoized, so concurrent POSTs coalesce; duplicate
    // watchdogs/exits are accepted as cheap noise rather than tracked here.
    setTimeout(async () => {
      const watchdog = setTimeout(() => {
        // memoryUsage() since Deno 2.x removed Deno.metrics(); `phase` shows
        // which `_doShutdown` step was in flight when the deadlock happened.
        logger.error("Shutdown watchdog fired", {
          phase: ctx.daemon.currentShutdownPhase,
          memoryUsage: Deno.memoryUsage(),
        });
        Deno.exit(1);
      }, watchdogMs);
      try {
        await ctx.daemon.shutdown();
        clearTimeout(watchdog);
        logger.info("Shutdown complete, exiting", { exitCode: 0 });
        Deno.exit(0);
      } catch (err) {
        clearTimeout(watchdog);
        logger.error("shutdown failed, exiting with error", { err, exitCode: 1 });
        Deno.exit(1);
      }
    }, 100);

    return c.json({ message: "Daemon shutdown initiated" });
  });

export { daemonApp };
export type DaemonRoutes = typeof daemonApp;
