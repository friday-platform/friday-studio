/**
 * TDD Test: Timer Signal Workspace Runtime Integration
 *
 * Purpose: Verify that CronManager properly registers timer signals
 * and that timer callbacks correctly trigger job execution. This tests
 * the end-to-end flow that should happen in topic-summarizer workspace.
 */

import { assertEquals } from "@std/assert";
import { MemoryKVStorage } from "../../../src/core/storage/memory-kv-storage.ts";
import { CronManager, type CronTimerConfig } from "../mod.ts";

// Mock logger for testing
const mockLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// Mock workspace configuration similar to topic-summarizer
const mockWorkspaceConfig = {
  version: "1.0",
  workspace: {
    name: "test-timer-workspace",
    description: "Test workspace for timer signal integration",
  },
  signals: {
    "timer-test-scan": {
      description: "Test timer signal for integration testing",
      provider: "cron-scheduler",
      schedule: "*/30 * * * *",
      timezone: "UTC",
    },
    "manual-test-scan": {
      description: "Manual test signal",
      provider: "http",
      path: "/test-scan",
      method: "POST",
    },
  },
  jobs: {
    "test-discovery": {
      name: "test-discovery",
      description: "Test job triggered by timer",
      triggers: [{ signal: "timer-test-scan" }, { signal: "manual-test-scan" }],
      execution: { strategy: "sequential", agents: ["test-agent"] },
    },
  },
  agents: {
    "test-agent": {
      type: "llm",
      model: "claude-3-7-sonnet-latest",
      purpose: "Test agent for timer integration",
    },
  },
};

// Mock workspace runtime that tracks signal triggers
class MockWorkspaceRuntime {
  private cronManager: CronManager;
  private triggeredSignals: Array<{
    workspaceId: string;
    signalId: string;
    data: unknown;
    timestamp: number;
  }> = [];
  private registeredTimers = new Map<string, boolean>();

  constructor(private workspaceId: string) {
    const storage = new MemoryKVStorage();
    this.cronManager = new CronManager(storage, mockLogger);

    // Set up wakeup callback to track triggered signals
    this.cronManager.setWakeupCallback((workspaceId, signalId, signalData) => {
      this.triggeredSignals.push({
        workspaceId,
        signalId,
        data: signalData,
        timestamp: Date.now(),
      });
    });
  }

  async initialize(): Promise<void> {
    const storage = this.cronManager["storage"]; // Access private storage for initialization
    await storage.initialize();
    await this.cronManager.start();
  }

  async loadSignalProvider(
    signalId: string,
    config: { description: string; schedule?: string; timezone?: string; provider?: string },
  ): Promise<void> {
    // Only process timer/cron-scheduler signals
    if (!config.schedule) {
      throw new Error(`Signal ${signalId} is not a timer signal`);
    }

    const timerConfig: CronTimerConfig = {
      workspaceId: this.workspaceId,
      signalId: signalId,
      description: config.description,
      schedule: config.schedule,
      timezone: config.timezone || "UTC",
    };

    await this.cronManager.registerTimer(timerConfig);
    this.registeredTimers.set(signalId, true);
  }

  getTimer(signalId: string) {
    return this.cronManager.getTimer(this.workspaceId, signalId);
  }

  getTriggeredSignals(): Array<{
    workspaceId: string;
    signalId: string;
    data: unknown;
    timestamp: number;
  }> {
    return [...this.triggeredSignals];
  }

  hasTimerRegistered(signalId: string): boolean {
    return this.registeredTimers.get(signalId) === true;
  }

  getCronManager(): CronManager {
    return this.cronManager;
  }

  async shutdown(): Promise<void> {
    await this.cronManager.shutdown();
    this.triggeredSignals.length = 0;
    this.registeredTimers.clear();
  }
}

Deno.test("Timer Signal - Workspace Runtime Integration", async (t) => {
  await t.step("should register timer signals from workspace config", async () => {
    const runtime = new MockWorkspaceRuntime("test-workspace");
    await runtime.initialize();

    // Load timer signal from mock config
    const signalConfig = mockWorkspaceConfig.signals["timer-test-scan"];
    await runtime.loadSignalProvider("timer-test-scan", signalConfig);

    // Should have created and registered timer
    const timer = runtime.getTimer("timer-test-scan");
    assertEquals(timer !== undefined, true, "Should create timer");
    assertEquals(timer.schedule, "*/30 * * * *", "Should configure correct schedule");
    assertEquals(timer.timezone, "UTC", "Should configure correct timezone");
    assertEquals(timer.isActive, true, "Timer should be active");

    // Should have registered timer
    assertEquals(runtime.hasTimerRegistered("timer-test-scan"), true, "Should register timer");

    await runtime.shutdown();
  });

  await t.step("should have proper timer configuration for job execution", async () => {
    const runtime = new MockWorkspaceRuntime("test-workspace");
    await runtime.initialize();

    const signalConfig = mockWorkspaceConfig.signals["timer-test-scan"];
    await runtime.loadSignalProvider("timer-test-scan", signalConfig);

    // Should have properly configured timer
    const timer = runtime.getTimer("timer-test-scan");
    assertEquals(timer !== undefined, true, "Timer should be configured");
    assertEquals(timer.signalId, "timer-test-scan", "Should have correct signal ID");
    assertEquals(timer.schedule, "*/30 * * * *", "Should have correct schedule");
    assertEquals(timer.nextExecution !== undefined, true, "Should have next execution scheduled");
    assertEquals(
      timer.nextExecution.getTime() > Date.now(),
      true,
      "Next execution should be in future",
    );

    // CronManager should be active and managing the timer
    const cronManager = runtime.getCronManager();
    assertEquals(cronManager.isActive(), true, "CronManager should be active");

    const stats = cronManager.getStats();
    assertEquals(stats.totalTimers, 1, "Should have one timer registered");
    assertEquals(stats.activeTimers, 1, "Should have one active timer");

    await runtime.shutdown();
  });

  await t.step("should handle multiple timer signals independently", async () => {
    const runtime = new MockWorkspaceRuntime("test-workspace");
    await runtime.initialize();

    // Create two timer signals with different schedules
    const signal1Config = {
      description: "First timer",
      provider: "cron-scheduler",
      schedule: "*/30 * * * *",
      timezone: "UTC",
    };

    const signal2Config = {
      description: "Second timer",
      provider: "cron-scheduler",
      schedule: "*/15 * * * *", // Every 15 minutes
      timezone: "UTC",
    };

    await runtime.loadSignalProvider("timer-1", signal1Config);
    await runtime.loadSignalProvider("timer-2", signal2Config);

    // Should have both timers
    const timer1 = runtime.getTimer("timer-1");
    const timer2 = runtime.getTimer("timer-2");
    assertEquals(timer1 !== undefined, true, "Should have first timer");
    assertEquals(timer2 !== undefined, true, "Should have second timer");

    // Verify different schedules
    assertEquals(timer1.schedule, "*/30 * * * *", "Timer 1 should have 30-minute schedule");
    assertEquals(timer2.schedule, "*/15 * * * *", "Timer 2 should have 15-minute schedule");

    // Both should be active and have next executions
    assertEquals(timer1.isActive, true, "Timer 1 should be active");
    assertEquals(timer2.isActive, true, "Timer 2 should be active");
    assertEquals(timer1.nextExecution !== undefined, true, "Timer 1 should have next execution");
    assertEquals(timer2.nextExecution !== undefined, true, "Timer 2 should have next execution");

    // CronManager should track both timers
    const cronManager = runtime.getCronManager();
    const stats = cronManager.getStats();
    assertEquals(stats.totalTimers, 2, "Should have two timers registered");
    assertEquals(stats.activeTimers, 2, "Should have two active timers");

    await runtime.shutdown();
  });

  await t.step("should handle timer registration failures", async () => {
    const runtime = new MockWorkspaceRuntime("test-workspace");
    await runtime.initialize();

    // Try to load invalid timer config
    const invalidConfig = {
      description: "Invalid timer",
      provider: "cron-scheduler",
      schedule: "invalid-cron-expression",
      timezone: "UTC",
    };

    let loadError = false;
    try {
      await runtime.loadSignalProvider("invalid-timer", invalidConfig);
    } catch {
      loadError = true;
    }

    assertEquals(loadError, true, "Should throw on invalid timer config");
    assertEquals(runtime.getTimer("invalid-timer"), undefined, "Should not register invalid timer");
    assertEquals(
      runtime.hasTimerRegistered("invalid-timer"),
      false,
      "Should not mark invalid timer as registered",
    );

    // CronManager should remain functional
    const cronManager = runtime.getCronManager();
    assertEquals(
      cronManager.isActive(),
      true,
      "CronManager should remain active after failed registration",
    );

    await runtime.shutdown();
  });

  await t.step("should support centralized cron management pattern", async () => {
    // Create a shared CronManager instance (simulates daemon-level management)
    const sharedStorage = new MemoryKVStorage();
    await sharedStorage.initialize();
    const sharedCronManager = new CronManager(sharedStorage, mockLogger);
    await sharedCronManager.start();

    // Register timers for multiple workspaces
    const workspace1Config: CronTimerConfig = {
      workspaceId: "workspace-1",
      signalId: "timer-1",
      description: "Timer for workspace 1",
      schedule: "*/30 * * * *",
      timezone: "UTC",
    };

    const workspace2Config: CronTimerConfig = {
      workspaceId: "workspace-2",
      signalId: "timer-2",
      description: "Timer for workspace 2",
      schedule: "*/15 * * * *",
      timezone: "UTC",
    };

    await sharedCronManager.registerTimer(workspace1Config);
    await sharedCronManager.registerTimer(workspace2Config);

    // Should manage timers for both workspaces
    const timer1 = sharedCronManager.getTimer("workspace-1", "timer-1");
    const timer2 = sharedCronManager.getTimer("workspace-2", "timer-2");

    assertEquals(timer1 !== undefined, true, "Should manage workspace 1 timer");
    assertEquals(timer2 !== undefined, true, "Should manage workspace 2 timer");
    assertEquals(timer1.workspaceId, "workspace-1", "Timer 1 should belong to workspace 1");
    assertEquals(timer2.workspaceId, "workspace-2", "Timer 2 should belong to workspace 2");

    // Should track all timers centrally
    const stats = sharedCronManager.getStats();
    assertEquals(stats.totalTimers, 2, "Should track timers from multiple workspaces");
    assertEquals(stats.activeTimers, 2, "Should have all timers active");

    await sharedCronManager.shutdown();
  });

  await t.step("should properly sequence timer setup in workspace loading", async () => {
    const runtime = new MockWorkspaceRuntime("test-workspace");
    const setupSequence: string[] = [];

    // Simulate workspace loading sequence
    setupSequence.push("workspace-loading-start");

    // Initialize runtime
    await runtime.initialize();
    setupSequence.push("runtime-initialized");

    // Load multiple signals in sequence (like real workspace would)
    for (const [signalId, signalConfig] of Object.entries(mockWorkspaceConfig.signals)) {
      if (signalConfig.provider === "cron-scheduler") {
        setupSequence.push(`loading-signal-${signalId}`);
        await runtime.loadSignalProvider(signalId, signalConfig);
        setupSequence.push(`loaded-signal-${signalId}`);

        const timer = runtime.getTimer(signalId);
        const isHealthy =
          timer !== undefined && timer.isActive && timer.nextExecution !== undefined;
        setupSequence.push(`health-${signalId}-${isHealthy}`);
      }
    }

    setupSequence.push("workspace-loading-complete");

    // Verify proper sequence
    const expectedSequence = [
      "workspace-loading-start",
      "runtime-initialized",
      "loading-signal-timer-test-scan",
      "loaded-signal-timer-test-scan",
      "health-timer-test-scan-true",
      "workspace-loading-complete",
    ];

    assertEquals(setupSequence, expectedSequence, "Should follow expected loading sequence");

    // Timer should be properly configured
    const timer = runtime.getTimer("timer-test-scan");
    assertEquals(timer !== undefined, true, "Timer should be configured");
    assertEquals(timer.isActive, true, "Timer should be active after loading");
    assertEquals(
      timer.nextExecution !== undefined,
      true,
      "Timer should have next execution scheduled",
    );

    await runtime.shutdown();
  });

  await t.step("should handle workspace timer lifecycle properly", async () => {
    const runtime = new MockWorkspaceRuntime("test-workspace");
    await runtime.initialize();

    const signalConfig = mockWorkspaceConfig.signals["timer-test-scan"];
    await runtime.loadSignalProvider("timer-test-scan", signalConfig);

    // Timer should be properly configured
    const timer = runtime.getTimer("timer-test-scan");
    assertEquals(timer !== undefined, true, "Timer should be configured");
    assertEquals(timer.isActive, true, "Timer should be active");

    // Test unregistering workspace timers (simulates workspace shutdown)
    const cronManager = runtime.getCronManager();
    await cronManager.unregisterWorkspaceTimers("test-workspace");

    // Timer should be removed
    const removedTimer = runtime.getTimer("timer-test-scan");
    assertEquals(removedTimer, undefined, "Timer should be removed after workspace unregister");

    // CronManager should still be active but with no timers
    assertEquals(cronManager.isActive(), true, "CronManager should remain active");

    const stats = cronManager.getStats();
    assertEquals(stats.totalTimers, 0, "Should have no timers after workspace unregister");
    assertEquals(stats.activeTimers, 0, "Should have no active timers");

    await runtime.shutdown();
  });
});
