/**
 * TDD Test: Timer Signal Cron Expression Parsing
 *
 * Purpose: Verify that the cron expression (every 30 minutes) used in topic-summarizer
 * workspace is parsed correctly and schedules execution every 30 minutes.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { CronManager, type CronTimerConfig } from "../mod.ts";
import { MemoryKVStorage } from "../../../src/core/storage/memory-kv-storage.ts";

// Mock logger for testing
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const validConfig: CronTimerConfig = {
  workspaceId: "test-workspace",
  signalId: "test-timer",
  description: "Test timer for cron parsing",
  schedule: "*/30 * * * *", // Every 30 minutes - same as topic-summarizer
  timezone: "UTC",
};

Deno.test("Timer Signal - Cron Expression Parsing", async (t) => {
  let cronManager: CronManager;
  let storage: MemoryKVStorage;

  // Setup before each test
  const setup = async () => {
    storage = new MemoryKVStorage();
    await storage.initialize();
    cronManager = new CronManager(storage, mockLogger);
  };

  await t.step("should parse */30 * * * * cron expression without errors", async () => {
    await setup();

    // Should not throw during timer registration
    await cronManager.registerTimer(validConfig);

    // Verify timer is registered
    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(timer?.schedule, "*/30 * * * *");
    assertEquals(timer?.timezone, "UTC");
  });

  await t.step("should reject invalid cron expressions", async () => {
    await setup();

    const invalidConfig = {
      ...validConfig,
      schedule: "invalid cron expression",
    };

    let errorThrown = false;
    try {
      await cronManager.registerTimer(invalidConfig);
    } catch (error) {
      errorThrown = true;
      assertEquals(
        error instanceof Error && error.message.includes("Invalid cron expression"),
        true,
        "Should throw invalid cron expression error",
      );
    }

    assertEquals(errorThrown, true, "Should throw error for invalid cron expression");
  });

  await t.step("should schedule next execution within 30 minutes", async () => {
    await setup();
    await cronManager.registerTimer(validConfig);

    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    const nextExecution = timer?.nextExecution;
    const now = Date.now();
    const thirtyMinutes = 30 * 60 * 1000; // 30 minutes in milliseconds

    // Next execution should be in the future
    assertEquals(nextExecution !== undefined, true, "Next execution should be scheduled");
    assertEquals(nextExecution!.getTime() > now, true, "Next execution should be in the future");

    // Next execution should be within 30 minutes (since cron runs every 30 minutes)
    assertEquals(
      nextExecution!.getTime() <= now + thirtyMinutes,
      true,
      "Next execution should be within 30 minutes",
    );
  });

  await t.step("should handle different timezones", async () => {
    await setup();

    const pacificConfig = {
      ...validConfig,
      signalId: "pacific-timer",
      timezone: "America/Los_Angeles",
    };

    await cronManager.registerTimer(pacificConfig);

    const timer = cronManager.getTimer(pacificConfig.workspaceId, pacificConfig.signalId);
    assertEquals(timer?.timezone, "America/Los_Angeles");
    assertEquals(timer?.nextExecution !== undefined, true);
  });

  await t.step("should validate standard cron expressions", async () => {
    await setup();

    const testCases = [
      { schedule: "0 9 * * 1", desc: "Every Monday at 9 AM" },
      { schedule: "0 0 * * *", desc: "Daily at midnight" },
      { schedule: "0 12 * * 1-5", desc: "Weekdays at noon" },
      { schedule: "*/15 * * * *", desc: "Every 15 minutes" },
    ];

    for (const [index, testCase] of testCases.entries()) {
      const config = {
        ...validConfig,
        signalId: `timer-${index}`,
        schedule: testCase.schedule,
        description: testCase.desc,
      };

      // Should not throw
      await cronManager.registerTimer(config);

      const timer = cronManager.getTimer(config.workspaceId, config.signalId);
      assertEquals(timer?.schedule, testCase.schedule);
    }
  });
});
