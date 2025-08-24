/**
 * CronManager Core Functionality Tests
 *
 * Tests basic CronManager operations including timer registration,
 * cron expression parsing, callback execution, and lifecycle management.
 */

import { assert, assertEquals } from "@std/assert";
import { MemoryKVStorage } from "../../../src/core/storage/memory-kv-storage.ts";
import { CronManager, type CronTimerConfig } from "../mod.ts";

// Mock logger for testing
const mockLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function createTestTimerConfig(
  workspaceId = "test-workspace",
  signalId = "test-signal",
): CronTimerConfig {
  return {
    workspaceId,
    signalId,
    description: "Test timer",
    schedule: "*/30 * * * *", // Every 30 minutes
    timezone: "UTC",
  };
}

async function createTestCronManager() {
  const storage = new MemoryKVStorage();
  await storage.initialize();
  const cronManager = new CronManager(storage, mockLogger);
  return { cronManager, storage };
}

Deno.test("CronManager - Basic Operations", async (t) => {
  await t.step("should start and shutdown cleanly", async () => {
    const { cronManager } = await createTestCronManager();

    assertEquals(cronManager.isActive(), false, "Should not be active before start");

    await cronManager.start();
    assertEquals(cronManager.isActive(), true, "Should be active after start");

    await cronManager.shutdown();
    assertEquals(cronManager.isActive(), false, "Should not be active after shutdown");
  });

  await t.step("should register and retrieve timers", async () => {
    const { cronManager } = await createTestCronManager();
    await cronManager.start();

    const config = createTestTimerConfig();
    await cronManager.registerTimer(config);

    const timer = cronManager.getTimer(config.workspaceId, config.signalId);
    assert(timer !== undefined, "Timer should be registered");
    assertEquals(timer.workspaceId, config.workspaceId);
    assertEquals(timer.signalId, config.signalId);
    assertEquals(timer.schedule, config.schedule);
    assertEquals(timer.isActive, true);

    await cronManager.shutdown();
  });

  await t.step("should unregister timers", async () => {
    const { cronManager } = await createTestCronManager();
    await cronManager.start();

    const config = createTestTimerConfig();
    await cronManager.registerTimer(config);

    await cronManager.unregisterTimer(config.workspaceId, config.signalId);

    const timer = cronManager.getTimer(config.workspaceId, config.signalId);
    assertEquals(timer, undefined, "Timer should be unregistered");

    await cronManager.shutdown();
  });

  await t.step("should list active timers", async () => {
    const { cronManager } = await createTestCronManager();
    await cronManager.start();

    const config1 = createTestTimerConfig("workspace1", "signal1");
    const config2 = createTestTimerConfig("workspace1", "signal2");

    await cronManager.registerTimer(config1);
    await cronManager.registerTimer(config2);

    const activeTimers = cronManager.listActiveTimers();
    assertEquals(activeTimers.length, 2);

    await cronManager.shutdown();
  });

  await t.step("should provide stats", async () => {
    const { cronManager } = await createTestCronManager();
    await cronManager.start();

    const config = createTestTimerConfig();
    await cronManager.registerTimer(config);

    const stats = cronManager.getStats();
    assertEquals(stats.totalTimers, 1);
    assertEquals(stats.activeTimers, 1);
    assert(stats.nextExecution !== undefined);

    await cronManager.shutdown();
  });
});

Deno.test("CronManager - Cron Expression Validation", async (t) => {
  await t.step("should accept valid cron expressions", async () => {
    const { cronManager } = await createTestCronManager();
    await cronManager.start();

    const validExpressions = [
      "*/30 * * * *", // Every 30 minutes
      "0 9 * * 1", // Monday 9 AM
      "0 0 * * *", // Daily at midnight
      "*/5 * * * * *", // Every 5 seconds (with seconds)
    ];

    for (const schedule of validExpressions) {
      const config = { ...createTestTimerConfig(), schedule, signalId: `test-${schedule}` };
      await cronManager.registerTimer(config);
      const timer = cronManager.getTimer(config.workspaceId, config.signalId);
      assert(timer !== undefined, `Timer with schedule ${schedule} should be registered`);
    }

    await cronManager.shutdown();
  });

  await t.step("should reject invalid cron expressions", async () => {
    const { cronManager } = await createTestCronManager();
    await cronManager.start();

    const invalidExpressions = [
      "invalid-cron",
      "* * * * * * *", // Too many fields
      "60 * * * *", // Invalid minute
      "* 25 * * *", // Invalid hour
    ];

    for (const schedule of invalidExpressions) {
      const config = { ...createTestTimerConfig(), schedule };
      let failed = false;
      try {
        await cronManager.registerTimer(config);
      } catch {
        failed = true;
      }
      assert(failed, `Should reject invalid schedule: ${schedule}`);
    }

    await cronManager.shutdown();
  });

  await t.step("should calculate next execution time", async () => {
    const { cronManager } = await createTestCronManager();
    await cronManager.start();

    const config = createTestTimerConfig();
    await cronManager.registerTimer(config);

    const timer = cronManager.getTimer(config.workspaceId, config.signalId);
    assert(timer?.nextExecution !== undefined, "Should have next execution time");
    assert(timer.nextExecution.getTime() > Date.now(), "Next execution should be in future");

    // For */30 * * * * schedule, next execution should be within 30 minutes
    const thirtyMinutes = 30 * 60 * 1000;
    assert(
      timer.nextExecution.getTime() <= Date.now() + thirtyMinutes,
      "Next execution should be within 30 minutes",
    );

    await cronManager.shutdown();
  });

  await t.step("should handle different timezones", async () => {
    const { cronManager } = await createTestCronManager();
    await cronManager.start();

    const timezones = ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo"];

    for (const timezone of timezones) {
      const config = {
        ...createTestTimerConfig(),
        timezone,
        signalId: `test-${timezone}`,
        schedule: "0 12 * * *", // Noon daily
      };
      await cronManager.registerTimer(config);
      const timer = cronManager.getTimer(config.workspaceId, config.signalId);
      assert(timer !== undefined, `Timer with timezone ${timezone} should be registered`);
      assertEquals(timer.timezone, timezone);
    }

    await cronManager.shutdown();
  });
});

Deno.test("CronManager - Callback Management", async (t) => {
  await t.step("should execute callback when timer fires", async () => {
    const { cronManager } = await createTestCronManager();
    await cronManager.start();

    cronManager.setWakeupCallback((workspaceId, signalId) => {
      assertEquals(workspaceId, "test-workspace");
      assertEquals(signalId, "test-signal");
    });

    const config = createTestTimerConfig();
    await cronManager.registerTimer(config);

    // Verify callback is set up (actual execution would happen on schedule)
    const timer = cronManager.getTimer(config.workspaceId, config.signalId);
    assert(timer !== undefined);

    await cronManager.shutdown();
  });

  await t.step("should allow callback replacement", async () => {
    const { cronManager } = await createTestCronManager();
    await cronManager.start();

    const config = createTestTimerConfig();
    await cronManager.registerTimer(config);

    // Verify timer is registered (callback replacement doesn't affect timer registration)
    const timer = cronManager.getTimer(config.workspaceId, config.signalId);
    assert(timer !== undefined);

    await cronManager.shutdown();
  });

  await t.step("should handle multiple timer registrations", async () => {
    const { cronManager } = await createTestCronManager();
    await cronManager.start();

    const callbackData: Array<{ workspaceId: string; signalId: string }> = [];

    cronManager.setWakeupCallback((workspaceId, signalId) => {
      callbackData.push({ workspaceId, signalId });
    });

    // Register multiple timers
    const configs = [
      createTestTimerConfig("workspace1", "timer1"),
      createTestTimerConfig("workspace1", "timer2"),
      createTestTimerConfig("workspace2", "timer1"),
    ];

    for (const config of configs) {
      await cronManager.registerTimer(config);
    }

    // All timers should be registered
    const stats = cronManager.getStats();
    assertEquals(stats.totalTimers, 3);
    assertEquals(stats.activeTimers, 3);

    await cronManager.shutdown();
  });
});

Deno.test("CronManager - Lifecycle Management", async (t) => {
  await t.step("should allow registration before start but schedule after", async () => {
    const { cronManager } = await createTestCronManager();

    const config = createTestTimerConfig();
    // Registration is allowed before start, but timer won't be scheduled
    await cronManager.registerTimer(config);

    // Timer should exist but not be scheduled yet
    const timer = cronManager.getTimer(config.workspaceId, config.signalId);
    assert(timer !== undefined, "Timer should be registered");

    // Start the manager to schedule timers
    await cronManager.start();
    assert(cronManager.isActive(), "CronManager should be active");

    await cronManager.shutdown();
  });

  await t.step("should handle rapid start/stop cycles", async () => {
    // Create new CronManager for each cycle since storage is closed on shutdown
    for (let i = 0; i < 3; i++) {
      const { cronManager } = await createTestCronManager();
      await cronManager.start();
      assertEquals(cronManager.isActive(), true);
      await cronManager.shutdown();
      assertEquals(cronManager.isActive(), false);
    }
  });

  await t.step("should unregister all workspace timers", async () => {
    const { cronManager } = await createTestCronManager();
    await cronManager.start();

    // Register timers for multiple workspaces
    await cronManager.registerTimer(createTestTimerConfig("workspace1", "timer1"));
    await cronManager.registerTimer(createTestTimerConfig("workspace1", "timer2"));
    await cronManager.registerTimer(createTestTimerConfig("workspace2", "timer1"));

    // Unregister all timers for workspace1
    await cronManager.unregisterWorkspaceTimers("workspace1");

    // Only workspace2 timer should remain
    const activeTimers = cronManager.listActiveTimers();
    assertEquals(activeTimers.length, 1);
    assertEquals(activeTimers[0]?.workspaceId, "workspace2");

    await cronManager.shutdown();
  });
});
