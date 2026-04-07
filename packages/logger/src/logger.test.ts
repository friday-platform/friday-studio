/**
 * Tests for logger crash resilience and log level filtering.
 *
 * Uses ConsoleOnlyLogger to test BaseLogger behavior without
 * AtlasLoggerV2's DENO_TESTING early-return guard.
 */

import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogLevelCache } from "./base-logger.ts";
import { logger } from "./console-only.ts";

describe("BaseLogger crash resilience", () => {
  beforeEach(() => {
    resetLogLevelCache();
  });

  it("survives when console.debug throws WouldBlock error", () => {
    const originalDebug = console.debug;
    console.debug = vi.fn(() => {
      throw new Error("Resource temporarily unavailable (os error 11)");
    });

    expect(() => {
      logger.debug("test message", { test: true });
    }).not.toThrow();

    console.debug = originalDebug;
  });

  it("survives when console.warn throws WouldBlock error", () => {
    const originalWarn = console.warn;
    console.warn = vi.fn(() => {
      throw new Error("Resource temporarily unavailable (os error 11)");
    });

    expect(() => {
      logger.warn("test warning", { test: true });
    }).not.toThrow();

    console.warn = originalWarn;
  });

  it("survives when console.error throws WouldBlock error", () => {
    const originalError = console.error;
    console.error = vi.fn(() => {
      throw new Error("Resource temporarily unavailable (os error 11)");
    });

    expect(() => {
      logger.error("test error", { test: true });
    }).not.toThrow();

    console.error = originalError;
  });

  it("survives when console.info throws WouldBlock error", () => {
    const originalInfo = console.info;
    console.info = vi.fn(() => {
      throw new Error("Resource temporarily unavailable (os error 11)");
    });

    expect(() => {
      logger.info("test info", { test: true });
    }).not.toThrow();

    console.info = originalInfo;
  });

  it("re-throws non-WouldBlock errors from console methods", () => {
    const originalDebug = console.debug;
    console.debug = vi.fn(() => {
      throw new Error("some other error");
    });

    expect(() => {
      logger.debug("test message");
    }).toThrow("some other error");

    console.debug = originalDebug;
  });
});

describe("ATLAS_LOG_LEVEL filtering", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.ATLAS_LOG_LEVEL;
    resetLogLevelCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ATLAS_LOG_LEVEL;
    } else {
      process.env.ATLAS_LOG_LEVEL = originalEnv;
    }
    resetLogLevelCache();
  });

  it("suppresses debug logs when ATLAS_LOG_LEVEL=info", () => {
    process.env.ATLAS_LOG_LEVEL = "info";
    resetLogLevelCache();
    const consoleSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    logger.debug("this should not appear", { test: true });

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("outputs info logs when ATLAS_LOG_LEVEL=info", () => {
    process.env.ATLAS_LOG_LEVEL = "info";
    resetLogLevelCache();
    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    logger.info("this should appear", { test: true });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("suppresses debug and info logs when ATLAS_LOG_LEVEL=warn", () => {
    process.env.ATLAS_LOG_LEVEL = "warn";
    resetLogLevelCache();
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    logger.debug("debug msg", { test: true });
    logger.info("info msg", { test: true });

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("outputs warn logs when ATLAS_LOG_LEVEL=warn", () => {
    process.env.ATLAS_LOG_LEVEL = "warn";
    resetLogLevelCache();
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    logger.warn("this warning should appear", { test: true });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("outputs debug logs when ATLAS_LOG_LEVEL=debug", () => {
    process.env.ATLAS_LOG_LEVEL = "debug";
    resetLogLevelCache();
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    logger.debug("this debug should appear", { test: true });

    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it("defaults to debug when ATLAS_LOG_LEVEL is not set", () => {
    delete process.env.ATLAS_LOG_LEVEL;
    resetLogLevelCache();
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    logger.debug("should appear by default", { test: true });

    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });
});

describe("log entry truncation", () => {
  beforeEach(() => {
    resetLogLevelCache();
  });

  it("truncates console output exceeding 32KB", () => {
    const consoleSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const bigValue = "x".repeat(40_000);
    logger.debug("test", { bigField: bigValue });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = String(consoleSpy.mock.calls[0]?.[0] ?? "");
    expect(output.length).toBeLessThan(bigValue.length);
    expect(output).toContain("[truncated,");

    consoleSpy.mockRestore();
  });

  it("does not truncate entries under 32KB", () => {
    const consoleSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const smallValue = "x".repeat(100);
    logger.debug("test", { field: smallValue });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = String(consoleSpy.mock.calls[0]?.[0] ?? "");
    expect(output).toContain(smallValue);
    expect(output).not.toContain("[truncated,");

    consoleSpy.mockRestore();
  });
});
