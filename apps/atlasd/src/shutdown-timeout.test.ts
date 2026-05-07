/**
 * Tests for withShutdownTimeout. Covers all four behavioral branches:
 * bare-promise back-compat, signal-aware thunk, timeout firing (which must
 * abort the step controller BEFORE the warn lands), and null/undefined.
 *
 * The warn-and-continue invariant is what keeps one hung shutdown step from
 * blocking the others — every path that produces an error must end in
 * logger.warn, never a thrown rejection.
 */

import { logger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withShutdownTimeout } from "./atlas-daemon.ts";

describe("withShutdownTimeout", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("returns immediately for undefined task without warning", async () => {
    await withShutdownTimeout("noop", undefined, 1000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns immediately for null task without warning", async () => {
    await withShutdownTimeout("noop", null, 1000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("resolves silently when bare promise completes before timeout", async () => {
    await withShutdownTimeout("ok", Promise.resolve("done"), 1000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("swallows bare promise rejection and logs warning", async () => {
    await withShutdownTimeout("boom", Promise.reject(new Error("kaboom")), 1000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "Shutdown step failed or timed out",
      expect.objectContaining({ label: "boom", error: expect.stringContaining("kaboom") }),
    );
  });

  it("times out a bare never-resolving promise within ms + 50", async () => {
    const start = Date.now();
    await withShutdownTimeout("hang", new Promise<void>(() => {}), 60);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(60 + 50);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "Shutdown step failed or timed out",
      expect.objectContaining({
        label: "hang",
        error: expect.stringContaining('shutdown step "hang" exceeded 60ms'),
      }),
    );
  });

  it("invokes thunk with an unaborted signal and stays unaborted on natural resolve", async () => {
    let captured: AbortSignal | undefined;
    await withShutdownTimeout(
      "fast-thunk",
      (signal) => {
        captured = signal;
        expect(signal.aborted).toBe(false);
        return Promise.resolve();
      },
      1000,
    );
    expect(warnSpy).not.toHaveBeenCalled();
    expect(captured?.aborted).toBe(false);
  });

  it("aborts the step signal BEFORE the warning is logged on timeout", async () => {
    vi.useFakeTimers();
    let captured: AbortSignal | undefined;
    let abortedAtWarnTime: boolean | undefined;
    warnSpy.mockImplementation(() => {
      abortedAtWarnTime = captured?.aborted;
    });

    const pending = withShutdownTimeout(
      "abort-me",
      (signal) => {
        captured = signal;
        return new Promise<void>(() => {});
      },
      100,
    );

    await vi.advanceTimersByTimeAsync(100);
    await pending;

    expect(captured?.aborted).toBe(true);
    expect(captured?.reason).toBeInstanceOf(Error);
    expect(String(captured?.reason)).toContain('shutdown step "abort-me" exceeded 100ms');
    expect(abortedAtWarnTime).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("swallows a thunk that throws synchronously and logs the warning", async () => {
    await withShutdownTimeout(
      "sync-throw",
      () => {
        throw new Error("synchronous boom");
      },
      1000,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "Shutdown step failed or timed out",
      expect.objectContaining({
        label: "sync-throw",
        error: expect.stringContaining("synchronous boom"),
      }),
    );
  });
});
