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
   * `Deno.exit(0)`. A 15s watchdog is the safety net: if `shutdown()`
   * hangs on a dangling async handle, the watchdog force-exits. On the
   * clean path the watchdog is `clearTimeout`'d before `Deno.exit`, so it
   * never gets to run — `Deno.exit` short-circuits regardless of pending
   * timers, so neither side prolongs shutdown.
   *
   * Exit code semantics (matches the SIGTERM handler in atlas-daemon.ts):
   * - **0** — `daemon.shutdown()` resolved cleanly.
   * - **1** — watchdog fired (deadlock) OR `daemon.shutdown()` rejected.
   *   Both are graceful-teardown failures, externally observable so
   *   supervisors can distinguish them from a clean exit.
   *
   * Watchdog timeout is configurable via `ATLAS_SHUTDOWN_WATCHDOG_MS` for
   * tests that exercise the deadlock path (default 15000ms).
   *
   * Subsequent tasks (#14-#19) shrink reliance on the watchdog by plumbing
   * real per-subsystem cancellation.
   */
  .post("/shutdown", (c) => {
    const ctx = c.get("app");
    const watchdogMs = Number(Deno.env.get("ATLAS_SHUTDOWN_WATCHDOG_MS") ?? "15000") || 15_000;

    // Concurrent POSTs are safe: `daemon.shutdown()` is memoized internally
    // (see `AtlasDaemon.shutdown` — `shutdownPromise` coalesces callers).
    // Multiple POSTs fan out to N watchdogs and N `Deno.exit` calls, but
    // the first `Deno.exit` wins and the rest are no-ops by the time they
    // would fire. We accept the (rare) duplicate-watchdog log noise as the
    // simpler design over route-level state — single source of truth on
    // shutdown lives on the daemon, not in the HTTP handler.
    setTimeout(async () => {
      const watchdog = setTimeout(() => {
        // Deno 2.x removed `Deno.metrics()`; `memoryUsage()` is the closest
        // diagnostic surface we still have for a stuck process. If the
        // watchdog fires regularly we want to see whether heap is climbing
        // (leak) or flat (stuck on an unresolved promise / dangling I/O).
        // `phase` shows *which* `_doShutdown` step was in flight when the
        // deadlock happened — the diagnostic the watchdog exists for.
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
