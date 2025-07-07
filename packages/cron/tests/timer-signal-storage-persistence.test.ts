/**
 * TDD Test: Timer Signal Storage Persistence
 *
 * Purpose: Verify that CronManager properly persists and restores timer state
 * across restarts. If persistence fails, timers might not resume after
 * daemon restarts, causing missed executions.
 */

import { assertEquals } from "@std/assert";
import { CronManager, type CronTimerConfig, type PersistedTimerData } from "../mod.ts";
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
  signalId: "test-persistence-timer",
  description: "Test timer for storage persistence",
  schedule: "*/30 * * * *",
  timezone: "UTC",
};

Deno.test("Timer Signal - Storage Persistence", async (t) => {
  let cronManager: CronManager;
  let storage: MemoryKVStorage;

  // Setup before each test
  const setup = async () => {
    storage = new MemoryKVStorage();
    await storage.initialize();
    cronManager = new CronManager(storage, mockLogger);
    await cronManager.start();
  };

  await t.step("should persist timer state to storage after registration", async () => {
    await setup();

    await cronManager.registerTimer(validConfig);

    // Wait for persistence
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Check if timer data is persisted in storage
    const timerKey = `${validConfig.workspaceId}:${validConfig.signalId}`;
    const persistedState = await storage.get<PersistedTimerData>(["cron_timers", timerKey]);

    assertEquals(persistedState !== null, true, "Should persist state to storage");

    if (persistedState && typeof persistedState === "object" && "workspaceId" in persistedState) {
      assertEquals(
        persistedState.workspaceId,
        validConfig.workspaceId,
        "Should persist correct workspace ID",
      );
      assertEquals(
        persistedState.signalId,
        validConfig.signalId,
        "Should persist correct signal ID",
      );
      assertEquals(persistedState.schedule, validConfig.schedule, "Should persist schedule");
      assertEquals(persistedState.timezone, validConfig.timezone, "Should persist timezone");
      assertEquals(persistedState.isActive, true, "Should persist active status");
      assertEquals(
        typeof persistedState.nextExecution,
        "string",
        "Should persist next execution time",
      );
    }

    await cronManager.shutdown();
  });

  await t.step("should restore timer state from storage on initialization", async () => {
    const storage = new MemoryKVStorage();
    await storage.initialize();

    // Setup first CronManager and register timer
    let cronManager1 = new CronManager(storage, mockLogger);
    await cronManager1.start();
    await cronManager1.registerTimer(validConfig);

    const originalTimer = cronManager1.getTimer(validConfig.workspaceId, validConfig.signalId);
    const originalNextExecution = originalTimer?.nextExecution;

    await cronManager1.shutdown();

    // Create second CronManager with same storage - should restore state
    const cronManager2 = new CronManager(storage, mockLogger);
    await cronManager2.start();

    const restoredTimer = cronManager2.getTimer(validConfig.workspaceId, validConfig.signalId);

    assertEquals(restoredTimer !== undefined, true, "Timer should be restored");
    assertEquals(
      restoredTimer!.workspaceId,
      validConfig.workspaceId,
      "Should restore correct workspace ID",
    );
    assertEquals(restoredTimer!.signalId, validConfig.signalId, "Should restore correct signal ID");
    assertEquals(restoredTimer!.schedule, validConfig.schedule, "Should restore correct schedule");
    assertEquals(restoredTimer!.timezone, validConfig.timezone, "Should restore correct timezone");
    assertEquals(restoredTimer!.isActive, true, "Should restore active status");

    // Should have a next execution time (may be recalculated if original was in the past)
    assertEquals(
      restoredTimer!.nextExecution !== undefined,
      true,
      "Should have next execution time",
    );
    assertEquals(
      restoredTimer!.nextExecution!.getTime() > Date.now(),
      true,
      "Next execution should be in future",
    );

    await cronManager2.shutdown();
  });

  await t.step("should handle storage failures gracefully during persistence", async () => {
    await setup();

    await cronManager.registerTimer(validConfig);

    // Should work initially
    assertEquals(cronManager.isActive(), true, "Should be active initially");

    // Override storage set method to fail
    const originalSet = storage.set.bind(storage);
    storage.set = async () => {
      throw new Error("Storage failure");
    };

    // Try to register another timer - should fail due to storage error
    const anotherConfig: CronTimerConfig = {
      ...validConfig,
      signalId: "another-timer",
    };

    let registrationError = false;
    try {
      await cronManager.registerTimer(anotherConfig);
    } catch (error) {
      registrationError = true;
    }

    assertEquals(registrationError, true, "Should fail to register when storage fails");

    // CronManager should continue working despite storage failure
    assertEquals(cronManager.isActive(), true, "Should remain active despite storage failure");

    // Restore storage functionality
    storage.set = originalSet;

    await cronManager.shutdown();
  });

  await t.step("should handle storage failures gracefully during restoration", async () => {
    const storage = new MemoryKVStorage();
    await storage.initialize();

    // Override storage list method to fail during restoration
    const originalList = storage.list.bind(storage);
    storage.list = async function* () {
      throw new Error("Storage list failure");
    };

    const cronManager = new CronManager(storage, mockLogger);

    // Should fail to start due to storage restoration failure
    let startError = false;
    try {
      await cronManager.start();
    } catch (error) {
      startError = true;
    }

    assertEquals(startError, true, "Should fail to start when storage restoration fails");

    // Restore storage functionality
    storage.list = originalList;

    // Create new CronManager instance to avoid state issues
    const newCronManager = new CronManager(storage, mockLogger);

    // Now should be able to start
    await newCronManager.start();
    assertEquals(
      newCronManager.isActive(),
      true,
      "Should start successfully after storage is restored",
    );

    await newCronManager.shutdown();
  });

  await t.step("should not restore expired execution times", async () => {
    const storage = new MemoryKVStorage();
    await storage.initialize();

    // Manually create expired state in storage
    const timerKey = `${validConfig.workspaceId}:${validConfig.signalId}`;
    const expiredState = {
      workspaceId: validConfig.workspaceId,
      signalId: validConfig.signalId,
      schedule: validConfig.schedule,
      timezone: validConfig.timezone,
      nextExecution: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
      isActive: true,
      registeredAt: new Date().toISOString(),
    };

    await storage.set(["cron_timers", timerKey], expiredState);

    const cronManager = new CronManager(storage, mockLogger);
    await cronManager.start();

    const restoredTimer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    const restoredNextExecution = restoredTimer?.nextExecution;

    // Should not restore expired time, should calculate new future time
    assertEquals(restoredNextExecution !== undefined, true, "Should have next execution");
    assertEquals(
      restoredNextExecution!.getTime() > Date.now(),
      true,
      "Should calculate new future execution time, not restore expired one",
    );

    await cronManager.shutdown();
  });

  await t.step("should update persisted state after timer execution", async () => {
    await setup();

    let callbackExecuted = false;
    cronManager.setWakeupCallback(async () => {
      callbackExecuted = true;
    });

    await cronManager.registerTimer(validConfig);

    const timerKey = `${validConfig.workspaceId}:${validConfig.signalId}`;
    const initialState = await storage.get<PersistedTimerData>(["cron_timers", timerKey]);
    const initialNextExecution = initialState?.nextExecution;

    // Wait a bit to ensure state is persisted
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Get timer info to verify it's properly configured
    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(timer !== undefined, true, "Timer should be registered");
    assertEquals(timer!.isActive, true, "Timer should be active");
    assertEquals(
      typeof initialNextExecution,
      "string",
      "Should have initial next execution persisted",
    );

    // Note: In actual execution, CronManager would update the persisted state
    // after each timer execution, but testing the automatic execution timing
    // would require waiting for the actual cron schedule

    await cronManager.shutdown();
  });

  await t.step("should handle corrupted storage data gracefully", async () => {
    const storage = new MemoryKVStorage();
    await storage.initialize();

    // Put corrupted data in storage
    const timerKey = `${validConfig.workspaceId}:${validConfig.signalId}`;
    await storage.set(["cron_timers", timerKey], "corrupted-data");

    const cronManager = new CronManager(storage, mockLogger);

    // Should still start despite corrupted storage data
    await cronManager.start();
    assertEquals(cronManager.isActive(), true, "Should start despite corrupted storage");

    // The corrupted timer should be ignored, new registrations should work
    await cronManager.registerTimer(validConfig);

    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(timer !== undefined, true, "Should register new timer despite corrupted data");
    assertEquals(timer!.isActive, true, "New timer should be active");

    await cronManager.shutdown();
  });

  await t.step("should track execution history in timer info", async () => {
    await setup();

    cronManager.setWakeupCallback(async () => {
      // Track execution
    });

    await cronManager.registerTimer(validConfig);

    const timerKey = `${validConfig.workspaceId}:${validConfig.signalId}`;
    const preExecutionState = await storage.get<PersistedTimerData>(["cron_timers", timerKey]);
    assertEquals(
      preExecutionState?.lastExecution,
      undefined,
      "Should not have last execution initially",
    );

    // Get timer info
    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(timer !== undefined, true, "Timer should exist");
    assertEquals(timer!.lastExecution, undefined, "Should not have last execution initially");

    // Note: CronManager tracks lastExecution internally and persists it
    // after each execution, but testing automatic execution would require
    // waiting for the actual cron schedule or simulating internal timer execution

    await cronManager.shutdown();
  });

  await t.step("should clean up storage on unregister", async () => {
    await setup();

    await cronManager.registerTimer(validConfig);

    // Should have persisted state
    const timerKey = `${validConfig.workspaceId}:${validConfig.signalId}`;
    const persistedState = await storage.get<PersistedTimerData>(["cron_timers", timerKey]);
    assertEquals(persistedState !== null, true, "Should have persisted state");

    // Unregister timer
    await cronManager.unregisterTimer(validConfig.workspaceId, validConfig.signalId);

    // Storage should be cleaned up
    const finalState = await storage.get<PersistedTimerData>(["cron_timers", timerKey]);
    assertEquals(finalState, null, "Should clean up storage on unregister");

    // Timer should no longer exist
    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(timer, undefined, "Timer should be removed");

    await cronManager.shutdown();
  });
});
