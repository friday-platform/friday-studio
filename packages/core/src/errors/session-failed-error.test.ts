import { describe, expect, it } from "vitest";
import { SessionFailedError } from "./session-failed-error.ts";

describe("SessionFailedError", () => {
  it("is an instance of Error", () => {
    const err = new SessionFailedError("test-signal", "failed", "LLM timeout");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SessionFailedError);
  });

  it("formats message from signal ID, status, and error", () => {
    const err = new SessionFailedError("my-signal", "failed", "connection refused");
    expect(err.message).toBe("Signal 'my-signal' session failed: connection refused");
    expect(err.status).toBe("failed");
  });

  it("uses 'unknown error' when sessionError is undefined", () => {
    const err = new SessionFailedError("cron-job", "skipped");
    expect(err.message).toBe("Signal 'cron-job' session skipped: unknown error");
    expect(err.status).toBe("skipped");
  });

  it("carries cancelled status", () => {
    const err = new SessionFailedError("webhook", "cancelled", "user cancelled");
    expect(err.status).toBe("cancelled");
    expect(err.name).toBe("SessionFailedError");
  });

  it("is distinguishable from generic Error via instanceof", () => {
    const sessionErr = new SessionFailedError("sig", "failed", "oops");
    const genericErr = new Error("workspace not found");

    // This is the check the wakeup callback uses
    expect(sessionErr instanceof SessionFailedError).toBe(true);
    expect(genericErr instanceof SessionFailedError).toBe(false);
  });
});
