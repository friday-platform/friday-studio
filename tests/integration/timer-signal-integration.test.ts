/**
 * Timer Signal Integration Tests
 *
 * Tests timer signal provider integration with workspace runtime and signal processing
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { TimerSignalProvider } from "../../src/core/providers/builtin/timer-signal.ts";
import { ProviderRegistry } from "../../src/core/providers/registry.ts";
import { ProviderType } from "../../src/core/providers/types.ts";
import { MemoryKVStorage } from "../../src/core/storage/memory-kv-storage.ts";

describe("Timer Signal Integration", () => {
  let registry: ProviderRegistry;
  let storage: MemoryKVStorage;
  let cleanup: Array<() => void> = [];

  beforeEach(async () => {
    registry = new ProviderRegistry();
    storage = new MemoryKVStorage();
    await storage.initialize();
    cleanup = [];
  });

  afterEach(() => {
    // Clean up any providers or resources
    cleanup.forEach((fn) => fn());
    cleanup = [];
  });

  describe("Provider Registry Integration", () => {
    it("should register timer provider factory in registry", () => {
      // Verify that the timer provider factory is registered
      const factories = (registry as any).factories;
      expect(factories.has("timer")).toBe(true);
    });

    it("should create timer provider instances from registry", async () => {
      const config = {
        id: "test-timer",
        description: "Test timer",
        provider: "timer",
        schedule: "0 9 * * 1", // Monday 9 AM
      };

      const provider = await registry.createProvider(config);
      expect(provider).toBeTruthy();
      expect(provider.type).toBe(ProviderType.SIGNAL);
      expect(provider.id).toBe(config.id);

      cleanup.push(() => provider.teardown());
    });

    it("should support all timer provider variants", async () => {
      const variants = ["timer", "schedule", "cron", "cron-scheduler"];

      for (const variant of variants) {
        const config = {
          id: `test-${variant}`,
          description: `Test ${variant}`,
          provider: variant,
          schedule: "0 9 * * 1",
          ...(variant === "cron-scheduler" ? { timezone: "UTC" } : {}),
        };

        const provider = await registry.createProvider(config);
        expect(provider).toBeTruthy();
        expect(provider.type).toBe(ProviderType.SIGNAL);

        cleanup.push(() => provider.teardown());
      }
    });
  });

  describe("Signal Processing", () => {
    it("should generate proper signal data format", async () => {
      const config = {
        id: "test-signal-format",
        description: "Test signal format",
        provider: "timer",
        schedule: "*/5 * * * * *", // Every 5 seconds
      };

      const provider = new TimerSignalProvider(config, storage);
      let receivedSignal: any = null;

      provider.setSignalCallback((signal) => {
        receivedSignal = signal;
      });

      const signal = await provider.triggerManually();

      // Verify signal format matches expected workspace signal structure
      expect(signal).toMatchObject({
        id: config.id,
        type: "timer",
        timestamp: expect.any(String),
        data: {
          scheduled: config.schedule,
          timezone: expect.any(String),
        },
      });

      // Verify timestamp is valid ISO string
      expect(() => new Date(signal.timestamp)).not.toThrow();
      expect(new Date(signal.timestamp).toISOString()).toBe(signal.timestamp);

      cleanup.push(() => provider.teardown());
    });

    it("should include timezone information for cron-scheduler", async () => {
      const config = {
        id: "test-timezone",
        description: "Test timezone",
        provider: "cron-scheduler",
        schedule: "0 9 * * 1",
        timezone: "America/New_York",
      };

      const provider = new TimerSignalProvider(config, storage);
      const signal = await provider.triggerManually();

      expect(signal.data.timezone).toBe("America/New_York");

      cleanup.push(() => provider.teardown());
    });

    it("should calculate next run time correctly", async () => {
      const config = {
        id: "test-next-run",
        description: "Test next run calculation",
        provider: "timer",
        schedule: "0 */6 * * *", // Every 6 hours
      };

      const provider = new TimerSignalProvider(config, storage);
      provider.setup();

      // Wait for async setup
      await new Promise((resolve) => setTimeout(resolve, 100));

      const signal = await provider.triggerManually();

      if (signal.data.nextRun) {
        const nextRun = new Date(signal.data.nextRun);
        const now = new Date();

        // Next run should be in the future
        expect(nextRun.getTime()).toBeGreaterThan(now.getTime());

        // Should be within 6 hours (plus some buffer for test timing)
        const hoursDiff = (nextRun.getTime() - now.getTime()) / (1000 * 60 * 60);
        expect(hoursDiff).toBeLessThanOrEqual(6.1); // Small buffer for timing
      }

      cleanup.push(() => provider.teardown());
    });
  });

  describe("Persistence and Recovery", () => {
    it("should maintain scheduling across restarts", async () => {
      const config = {
        id: "test-persistence",
        description: "Test persistence",
        provider: "timer",
        schedule: "0 0 * * 0", // Weekly on Sunday
      };

      // First instance
      let provider1 = new TimerSignalProvider(config, storage);
      provider1.setup();

      // Wait for setup and scheduling
      await new Promise((resolve) => setTimeout(resolve, 200));

      const firstNextExecution = provider1.getNextExecution();
      expect(firstNextExecution).toBeTruthy();

      // Simulate restart
      provider1.teardown();

      // Wait for teardown and persistence
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Second instance - simulating daemon restart
      const provider2 = new TimerSignalProvider(config, storage);
      provider2.setup();

      // Wait for setup and state restoration
      await new Promise((resolve) => setTimeout(resolve, 200));

      const restoredNextExecution = provider2.getNextExecution();
      expect(restoredNextExecution).toBeTruthy();

      // Should restore approximately the same execution time
      if (firstNextExecution && restoredNextExecution) {
        const timeDiff = Math.abs(
          firstNextExecution.getTime() - restoredNextExecution.getTime(),
        );
        expect(timeDiff).toBeLessThan(2000); // Within 2 seconds
      }

      cleanup.push(() => provider2.teardown());
    });

    it("should handle missing storage gracefully", async () => {
      const config = {
        id: "test-no-storage",
        description: "Test without storage",
        provider: "timer",
        schedule: "0 12 * * *", // Daily at noon
      };

      // Provider without storage
      const provider = new TimerSignalProvider(config);

      expect(() => provider.setup()).not.toThrow();
      expect(() => provider.teardown()).not.toThrow();

      // Should still work for manual triggers
      const signal = await provider.triggerManually();
      expect(signal.id).toBe(config.id);

      cleanup.push(() => provider.teardown());
    });

    it("should clean up storage on provider removal", async () => {
      const config = {
        id: "test-cleanup",
        description: "Test cleanup",
        provider: "timer",
        schedule: "0 0 1 * *", // Monthly
      };

      const provider = new TimerSignalProvider(config, storage);
      provider.setup();

      // Wait for state persistence
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify state was persisted
      const persistedState = await storage.get(["timer_signals", config.id]);
      expect(persistedState).toBeTruthy();

      // Teardown should persist final state
      provider.teardown();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // State should still exist but marked as inactive
      const finalState = await storage.get(["timer_signals", config.id]);
      expect(finalState).toBeTruthy();
    });
  });

  describe("Multiple Timer Coordination", () => {
    it("should handle multiple timer providers simultaneously", async () => {
      const configs = [
        {
          id: "timer-1",
          description: "Timer 1",
          provider: "timer",
          schedule: "*/10 * * * * *", // Every 10 seconds
        },
        {
          id: "timer-2",
          description: "Timer 2",
          provider: "cron-scheduler",
          schedule: "*/15 * * * * *", // Every 15 seconds
          timezone: "UTC",
        },
        {
          id: "timer-3",
          description: "Timer 3",
          provider: "schedule",
          schedule: "*/20 * * * * *", // Every 20 seconds
        },
      ];

      const providers = configs.map((config) => new TimerSignalProvider(config, storage));
      const receivedSignals: any[] = [];

      // Set up signal collection
      providers.forEach((provider, index) => {
        provider.setSignalCallback((signal) => {
          receivedSignals.push({ providerIndex: index, signal });
        });
        provider.setup();
      });

      // Wait for all setups to complete
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Manually trigger all to verify they work independently
      for (let i = 0; i < providers.length; i++) {
        await providers[i].triggerManually();
      }

      // Should have received signals from all providers
      expect(receivedSignals.length).toBe(3);

      // Each provider should have generated its own signal
      const signalIds = receivedSignals.map((r) => r.signal.id);
      expect(signalIds).toContain("timer-1");
      expect(signalIds).toContain("timer-2");
      expect(signalIds).toContain("timer-3");

      // Different schedules should produce different next execution times
      const nextExecutions = providers.map((p) => p.getNextExecution()?.getTime()).filter(Boolean);
      expect(new Set(nextExecutions).size).toBeGreaterThan(1); // Should have different times

      // Clean up
      providers.forEach((provider) => {
        cleanup.push(() => provider.teardown());
      });
    });
  });

  describe("Edge Cases and Error Scenarios", () => {
    it("should handle leap year schedules", async () => {
      const config = {
        id: "test-leap-year",
        description: "Test leap year",
        provider: "timer",
        schedule: "0 0 29 2 *", // February 29th (leap year only)
      };

      const provider = new TimerSignalProvider(config, storage);

      // Should not throw even with leap year schedule
      expect(() => provider.setup()).not.toThrow();

      const signal = await provider.triggerManually();
      expect(signal.id).toBe(config.id);

      cleanup.push(() => provider.teardown());
    });

    it("should handle timezone edge cases", async () => {
      const config = {
        id: "test-timezone-edge",
        description: "Test timezone edge case",
        provider: "cron-scheduler",
        schedule: "0 2 * * *", // 2 AM (DST transition time)
        timezone: "America/New_York",
      };

      const provider = new TimerSignalProvider(config, storage);

      expect(() => provider.setup()).not.toThrow();

      const signal = await provider.triggerManually();
      expect(signal.data.timezone).toBe("America/New_York");

      cleanup.push(() => provider.teardown());
    });

    it("should handle very frequent schedules", async () => {
      const config = {
        id: "test-frequent",
        description: "Test frequent schedule",
        provider: "timer",
        schedule: "* * * * * *", // Every second
      };

      const provider = new TimerSignalProvider(config, storage);
      provider.setup();

      // Wait for setup
      await new Promise((resolve) => setTimeout(resolve, 100));

      const nextExecution = provider.getNextExecution();
      expect(nextExecution).toBeTruthy();

      // Next execution should be very soon (within 1 second)
      const timeDiff = nextExecution!.getTime() - Date.now();
      expect(timeDiff).toBeLessThanOrEqual(1000);
      expect(timeDiff).toBeGreaterThan(0);

      cleanup.push(() => provider.teardown());
    });
  });
});
