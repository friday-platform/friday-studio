/**
 * Unit tests for the POST /shutdown route handler.
 *
 * The route's contract:
 *  - Respond 200 immediately ({ message: "Daemon shutdown initiated" }).
 *  - 100ms later, schedule a watchdog and await `daemon.shutdown()`.
 *  - On resolve: clear watchdog, log the clean-exit marker, `Deno.exit(0)`.
 *  - On reject:  clear watchdog, log the failure marker, `Deno.exit(1)`.
 *  - On hang:    watchdog fires, logs phase + memory, `Deno.exit(1)`.
 *
 * `Deno.exit` is stubbed so the test process survives. Fake timers drive
 * the 100ms scheduling delay and the watchdog deadline deterministically.
 *
 * The previous integration test spawned a real Deno subprocess via a
 * test-fixture shim and monkey-patched `daemon.shutdown` from inside the
 * fixture to exercise the watchdog. That fixture was the reason knip.json
 * needed an explicit ignore — replaced here by stubbing the right
 * boundary (`Deno.exit`) instead of patching production internals.
 */

import { logger } from "@atlas/logger";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppContext, AppVariables } from "../src/factory.ts";
import { daemonApp } from "./daemon.ts";

type DaemonStub = {
  shutdown: ReturnType<typeof vi.fn>;
  currentShutdownPhase: AppContext["daemon"]["currentShutdownPhase"];
};

function buildApp(daemon: DaemonStub) {
  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", { daemon } as unknown as AppContext);
    await next();
  });
  app.route("/", daemonApp);
  return app;
}

describe("POST /shutdown", () => {
  let exitMock: ReturnType<typeof vi.fn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitMock = vi.fn();
    vi.stubGlobal("Deno", {
      exit: exitMock,
      env: {
        get: (key: string) =>
          key === "ATLAS_SHUTDOWN_WATCHDOG_MS" ? "1500" : undefined,
      },
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
    });
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("responds 200 immediately and then exits 0 on clean shutdown", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const app = buildApp({ shutdown, currentShutdownPhase: "idle" });

    const res = await app.request("/shutdown", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ message: "Daemon shutdown initiated" });

    // Response is sent before the shutdown work runs.
    expect(shutdown).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();

    // Drive the 100ms scheduling delay + the awaited shutdown microtask.
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    expect(shutdown).toHaveBeenCalledOnce();
    expect(exitMock).toHaveBeenCalledWith(0);
    expect(infoSpy).toHaveBeenCalledWith("Shutdown complete, exiting", { exitCode: 0 });
    // Watchdog log must be absent on the clean path.
    expect(errorSpy).not.toHaveBeenCalledWith(
      "Shutdown watchdog fired",
      expect.anything(),
    );
  });

  it("fires the watchdog and exits 1 when daemon.shutdown() deadlocks", async () => {
    // Negative case: a hung shutdown must trip the safety net. Without
    // this assertion, a regression in the watchdog (wrong timer, missing
    // Deno.exit, misplaced clearTimeout) would ship undetected.
    const shutdown = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const app = buildApp({ shutdown, currentShutdownPhase: "phase-2" });

    const res = await app.request("/shutdown", { method: "POST" });
    expect(res.status).toBe(200);

    // 100ms scheduling delay → enters the inner async, sets up watchdog,
    // awaits the never-resolving shutdown.
    await vi.advanceTimersByTimeAsync(100);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(exitMock).not.toHaveBeenCalled();

    // Cross the 1500ms watchdog deadline (set via ATLAS_SHUTDOWN_WATCHDOG_MS).
    await vi.advanceTimersByTimeAsync(1500);

    expect(errorSpy).toHaveBeenCalledWith(
      "Shutdown watchdog fired",
      expect.objectContaining({
        phase: "phase-2",
        memoryUsage: expect.any(Object),
      }),
    );
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(infoSpy).not.toHaveBeenCalledWith("Shutdown complete, exiting", expect.anything());
  });

  it("exits 1 with the failure log when daemon.shutdown() rejects", async () => {
    const err = new Error("nats drain failed");
    const shutdown = vi.fn().mockRejectedValue(err);
    const app = buildApp({ shutdown, currentShutdownPhase: "phase-3-nats" });

    const res = await app.request("/shutdown", { method: "POST" });
    expect(res.status).toBe(200);

    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "shutdown failed, exiting with error",
      expect.objectContaining({ err, exitCode: 1 }),
    );
    // Failure path must not emit the clean-exit marker, and must clear
    // the watchdog before exiting.
    expect(infoSpy).not.toHaveBeenCalledWith("Shutdown complete, exiting", expect.anything());
    expect(errorSpy).not.toHaveBeenCalledWith("Shutdown watchdog fired", expect.anything());
  });
});
