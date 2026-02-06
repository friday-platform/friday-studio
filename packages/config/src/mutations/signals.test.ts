/**
 * Tests for signal mutation functions
 */

import { describe, expect, test } from "vitest";
import { createSignal, deleteSignal, updateSignal } from "./signals.ts";
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

  test("fails with invalid_operation when provider type changes", () => {
    const config = createTestConfig({
      signals: { webhook: httpSignal({ description: "HTTP webhook" }) },
    });

    const result = updateSignal(
      config,
      "webhook",
      scheduleSignal({ description: "Changed to schedule" }),
    );

    expectError(result, "invalid_operation", (e) => expect(e.message).toContain("provider type"));
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
