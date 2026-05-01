import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Must reset modules between tests to get fresh singleton evaluation
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SessionHistoryStorage facade", () => {
  test("selects CortexSessionHistoryAdapter when CORTEX_URL is set", async () => {
    vi.stubEnv("CORTEX_URL", "https://cortex.test");

    const { SessionHistoryStorage } = await import("./session-history-storage.ts");

    // appendEvent is a no-op on cortex — this verifies the cortex adapter was selected
    // (LocalSessionHistoryAdapter would attempt filesystem operations and throw)
    await expect(
      SessionHistoryStorage.appendEvent("sess-1", {
        type: "session:start",
        sessionId: "sess-1",
        workspaceId: "ws-1",
        jobName: "test",
        task: "test",
        timestamp: "2026-02-13T10:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });

  test("selects LocalSessionHistoryAdapter when CORTEX_URL is absent", async () => {
    vi.stubEnv("CORTEX_URL", "");

    const { SessionHistoryStorage } = await import("./session-history-storage.ts");

    // get() returns null for nonexistent session on local adapter (reads filesystem)
    const result = await SessionHistoryStorage.get("nonexistent-session");
    expect(result).toBeNull();
  });
});
