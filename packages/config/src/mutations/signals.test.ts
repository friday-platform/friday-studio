/**
 * Tests for signal mutation functions
 */

import { describe, expect, test } from "vitest";
import { createSignal, deleteSignal, patchSignalConfig, updateSignal } from "./signals.ts";
import {
  createJob,
  createTestConfig,
  expectError,
  httpSignal,
  scheduleSignal,
} from "./test-fixtures.ts";

describe("createSignal", () => {
  test("creates signal when signalId does not exist", () => {
    const config = createTestConfig();

    const result = createSignal(
      config,
      "new-webhook",
      httpSignal({ description: "New webhook signal" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.signals?.["new-webhook"]).toEqual(
        httpSignal({ description: "New webhook signal" }),
      );
    }
  });

  test("fails with conflict when signalId already exists", () => {
    const config = createTestConfig({
      signals: {
        "existing-signal": httpSignal({ description: "Existing signal", path: "/existing" }),
      },
    });

    const result = createSignal(
      config,
      "existing-signal",
      httpSignal({ description: "Duplicate signal", path: "/duplicate" }),
    );

    expectError(result, "conflict");
  });
});

describe("updateSignal", () => {
  test("updates signal when signalId exists", () => {
    const config = createTestConfig({
      signals: { webhook: httpSignal({ description: "Original description", path: "/old-path" }) },
    });

    const result = updateSignal(
      config,
      "webhook",
      httpSignal({ description: "Updated description", path: "/new-path", timeout: "60s" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.signals?.webhook).toEqual(
        httpSignal({ description: "Updated description", path: "/new-path", timeout: "60s" }),
      );
    }
  });

  test("fails with not_found when signalId does not exist", () => {
    const config = createTestConfig();

    const result = updateSignal(config, "nonexistent", httpSignal({ description: "Some signal" }));

    expectError(result, "not_found", (e) => {
      expect(e.entityId).toBe("nonexistent");
      expect(e.entityType).toBe("signal");
    });
  });

  test("allows provider type changes", () => {
    const config = createTestConfig({
      signals: { webhook: httpSignal({ description: "HTTP webhook" }) },
    });

    const result = updateSignal(
      config,
      "webhook",
      scheduleSignal({ description: "Changed to schedule" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.signals?.webhook?.provider).toBe("schedule");
    }
  });
});

describe("deleteSignal", () => {
  test("fails with not_found when signalId does not exist", () => {
    const config = createTestConfig();

    const result = deleteSignal(config, "nonexistent");

    expectError(result, "not_found", (e) => {
      expect(e.entityId).toBe("nonexistent");
      expect(e.entityType).toBe("signal");
    });
  });

  test("deletes signal when no jobs reference it", () => {
    const config = createTestConfig({
      signals: { webhook: httpSignal({ description: "Webhook" }) },
    });

    const result = deleteSignal(config, "webhook");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.signals?.webhook).toBeUndefined();
    }
  });

  test("fails with conflict when jobs reference the signal (without force)", () => {
    const config = createTestConfig({
      signals: { webhook: httpSignal({ description: "Webhook" }) },
      jobs: { "my-job": createJob({ triggers: [{ signal: "webhook" }] }) },
    });

    const result = deleteSignal(config, "webhook");

    expectError(result, "conflict", (e) => {
      expect(e.willUnlinkFrom).toHaveLength(1);
      expect(e.willUnlinkFrom[0]).toEqual({ type: "job", jobId: "my-job", remainingTriggers: 0 });
    });
  });

  test("cascade deletes triggers with force option", () => {
    const config = createTestConfig({
      signals: {
        webhook: httpSignal({ description: "Webhook" }),
        daily: scheduleSignal({ description: "Daily" }),
      },
      jobs: { "my-job": createJob({ triggers: [{ signal: "webhook" }, { signal: "daily" }] }) },
    });

    const result = deleteSignal(config, "webhook", { force: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.signals?.webhook).toBeUndefined();
      expect(result.value.signals).toHaveProperty("daily");
      expect(result.value.jobs?.["my-job"]?.triggers).toEqual([{ signal: "daily" }]);
    }
  });

  test("reports multiple affected jobs in conflict", () => {
    const config = createTestConfig({
      signals: { webhook: httpSignal({ description: "Webhook" }) },
      jobs: {
        "job-a": createJob({ triggers: [{ signal: "webhook" }] }),
        "job-b": createJob({ triggers: [{ signal: "webhook" }, { signal: "other" }] }),
      },
    });

    const result = deleteSignal(config, "webhook");

    expectError(result, "conflict", (e) => {
      expect(e.willUnlinkFrom).toHaveLength(2);
      expect(e.willUnlinkFrom).toContainEqual({
        type: "job",
        jobId: "job-a",
        remainingTriggers: 0,
      });
      expect(e.willUnlinkFrom).toContainEqual({
        type: "job",
        jobId: "job-b",
        remainingTriggers: 1,
      });
    });
  });
});

describe("patchSignalConfig", () => {
  test("patches schedule+timezone without affecting description or title", () => {
    const config = createTestConfig({
      signals: {
        daily: scheduleSignal({
          description: "Daily check",
          schedule: "0 9 * * *",
          timezone: "UTC",
        }),
      },
    });

    const result = patchSignalConfig(config, "daily", {
      schedule: "0 10 * * 1-5",
      timezone: "America/New_York",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const patched = result.value.signals?.daily;
      expect(patched?.description).toBe("Daily check");
      expect(patched?.provider).toBe("schedule");
      expect(patched).toMatchObject({
        config: { schedule: "0 10 * * 1-5", timezone: "America/New_York" },
      });
    }
  });

  test("returns not_found for missing signal", () => {
    const config = createTestConfig();

    const result = patchSignalConfig(config, "nonexistent", { schedule: "0 0 * * *" });

    expectError(result, "not_found", (e) => {
      expect(e.entityId).toBe("nonexistent");
      expect(e.entityType).toBe("signal");
    });
  });

  test("returns validation_error when merged config is invalid", () => {
    const config = createTestConfig({
      signals: { daily: scheduleSignal({ description: "Daily check" }) },
    });

    const result = patchSignalConfig(config, "daily", { schedule: "not a cron" });

    expectError(result, "validation");
  });
});
