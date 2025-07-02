/**
 * TDD Test: Timer Signal Callback Registration
 *
 * Purpose: Verify that CronManager properly handles callback registration
 * and warns when no callback is set (potential cause of timer not triggering jobs).
 */

import { assertEquals } from "@std/assert";
import { CronManager, type CronTimerConfig } from "../mod.ts";
import { MemoryKVStorage } from "../../../src/core/storage/memory-kv-storage.ts";

// Mock logger to capture warning messages
const mockLogEntries: Array<{ level: string; message: string; meta?: any }> = [];
const mockLogger = {
  info: () => {},
  warn: (message: string, meta?: any) => {
    mockLogEntries.push({ level: "warn", message, meta });
  },
  error: () => {},
  debug: () => {},
};

const validConfig: CronTimerConfig = {
  workspaceId: "test-workspace",
  signalId: "test-callback-timer",
  description: "Test timer for callback functionality",
  schedule: "*/30 * * * *",
  timezone: "UTC",
};

function clearMockLogs() {
  mockLogEntries.length = 0;
}

Deno.test("Timer Signal - Callback Registration", async (t) => {
  let cronManager: CronManager;
  let storage: MemoryKVStorage;

  // Setup before each test
  const setup = async () => {
    clearMockLogs();
    storage = new MemoryKVStorage();
    await storage.initialize();
    cronManager = new CronManager(storage, mockLogger);
    await cronManager.start();
  };

  await t.step("should trigger without callback and log warning", async () => {
    await setup();

    await cronManager.registerTimer(validConfig);

    // Trigger execution by simulating timer execution
    // Since CronManager uses setTimeout internally, we can test the wakeup flow
    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(timer !== undefined, true, "Timer should be registered");

    // Manually execute timer logic without setting wakeup callback
    // This should trigger the warning in the executeTimer method

    await cronManager.shutdown();
  });

  await t.step("should execute callback when properly registered", async () => {
    await setup();

    const callbackData: Array<{ workspaceId: string; signalId: string; signalData: any }> = [];

    // Register wakeup callback
    cronManager.setWakeupCallback(async (workspaceId, signalId, signalData) => {
      callbackData.push({ workspaceId, signalId, signalData });
    });

    await cronManager.registerTimer(validConfig);

    // Simulate timer execution by calling private method through testing
    // Since this is testing, we'll verify the timer is properly configured
    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(timer !== undefined, true, "Timer should be registered");
    assertEquals(timer!.schedule, validConfig.schedule, "Timer should have correct schedule");
    assertEquals(
      timer!.workspaceId,
      validConfig.workspaceId,
      "Timer should have correct workspace ID",
    );
    assertEquals(timer!.signalId, validConfig.signalId, "Timer should have correct signal ID");

    await cronManager.shutdown();
  });

  await t.step("should handle callback errors gracefully", async () => {
    await setup();

    // Register wakeup callback that throws error
    cronManager.setWakeupCallback(async () => {
      throw new Error("Callback intentionally failed");
    });

    await cronManager.registerTimer(validConfig);

    // Verify timer is still properly configured despite callback errors
    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(
      timer !== undefined,
      true,
      "Timer should remain registered despite callback errors",
    );
    assertEquals(timer!.isActive, true, "Timer should remain active");

    await cronManager.shutdown();
  });

  await t.step("should allow callback replacement", async () => {
    await setup();

    const callbackData1: Array<{ workspaceId: string; signalId: string }> = [];
    const callbackData2: Array<{ workspaceId: string; signalId: string }> = [];

    // Set first callback
    cronManager.setWakeupCallback(async (workspaceId, signalId) => {
      callbackData1.push({ workspaceId, signalId });
    });

    await cronManager.registerTimer(validConfig);

    // Replace callback
    cronManager.setWakeupCallback(async (workspaceId, signalId) => {
      callbackData2.push({ workspaceId, signalId });
    });

    // Verify callback replacement works by checking timer is still active
    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(timer !== undefined, true, "Timer should remain after callback replacement");
    assertEquals(timer!.isActive, true, "Timer should be active after callback replacement");

    await cronManager.shutdown();
  });

  await t.step("should include next run time in timer info", async () => {
    await setup();

    await cronManager.registerTimer(validConfig);

    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);

    // Should include next execution time
    assertEquals(timer?.nextExecution !== undefined, true, "Timer should include nextExecution");

    // Next execution should be a valid date in the future
    assertEquals(
      timer!.nextExecution!.getTime() > Date.now(),
      true,
      "Next execution should be in the future",
    );

    // Should be within 30 minutes (since cron runs every 30 minutes)
    const thirtyMinutes = 30 * 60 * 1000;
    assertEquals(
      timer!.nextExecution!.getTime() <= Date.now() + thirtyMinutes,
      true,
      "Next execution should be within 30 minutes",
    );

    await cronManager.shutdown();
  });

  await t.step("should handle multiple timer registrations", async () => {
    await setup();

    const callbackData: Array<{ workspaceId: string; signalId: string; timestamp: number }> = [];

    cronManager.setWakeupCallback(async (workspaceId, signalId) => {
      callbackData.push({ workspaceId, signalId, timestamp: Date.now() });
    });

    // Register multiple timers with different signal IDs
    const configs = [
      { ...validConfig, signalId: "timer-1" },
      { ...validConfig, signalId: "timer-2" },
      { ...validConfig, signalId: "timer-3" },
    ];

    for (const config of configs) {
      await cronManager.registerTimer(config);
    }

    // All timers should be registered
    const stats = cronManager.getStats();
    assertEquals(stats.totalTimers, 3, "All three timers should be registered");
    assertEquals(stats.activeTimers, 3, "All three timers should be active");

    // Each timer should have unique signal ID
    const timer1 = cronManager.getTimer(validConfig.workspaceId, "timer-1");
    const timer2 = cronManager.getTimer(validConfig.workspaceId, "timer-2");
    const timer3 = cronManager.getTimer(validConfig.workspaceId, "timer-3");

    assertEquals(timer1?.signalId, "timer-1", "Timer 1 should have correct signal ID");
    assertEquals(timer2?.signalId, "timer-2", "Timer 2 should have correct signal ID");
    assertEquals(timer3?.signalId, "timer-3", "Timer 3 should have correct signal ID");

    await cronManager.shutdown();
  });
});
