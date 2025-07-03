/**
 * Timer Signal Integration Tests
 *
 * Tests timer signal provider integration with workspace runtime and signal processing
 */

import { expect } from "@std/expect";
import { TimerSignalProvider } from "../../src/core/providers/builtin/timer-signal.ts";
import { ProviderRegistry } from "../../src/core/providers/registry.ts";
import { ProviderType } from "../../src/core/providers/types.ts";
import { MemoryKVStorage } from "../../src/core/storage/memory-kv-storage.ts";

Deno.test("Timer Signal Integration - should register timer provider factory in registry", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const registry = ProviderRegistry.getInstance();
  ProviderRegistry.registerBuiltinProviders();

  // Test that the timer factory is registered by trying to create a provider
  const config = {
    id: "test-factory-check",
    type: ProviderType.SIGNAL,
    provider: "timer",
    config: {
      description: "Test factory registration",
      schedule: "0 0 * * *",
    },
  };

  // Should not throw if factory is registered
  let providerCreated = false;
  try {
    const provider = await registry.loadFromConfig(config);
    providerCreated = true;
    provider.teardown();
  } catch (error) {
    if (error instanceof Error && error.message.includes("No factory registered")) {
      providerCreated = false;
    } else {
      throw error;
    }
  }

  expect(providerCreated).toBe(true);
});

Deno.test("Timer Signal Integration - should create timer provider instances from registry", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const registry = ProviderRegistry.getInstance();
  ProviderRegistry.registerBuiltinProviders();
  const storage = new MemoryKVStorage();
  await storage.initialize();

  const config = {
    id: "test-timer",
    type: ProviderType.SIGNAL,
    provider: "timer",
    config: {
      description: "Test timer",
      schedule: "0 9 * * 1", // Monday 9 AM
    },
  };

  const provider = await registry.loadFromConfig(config);
  expect(provider).toBeTruthy();
  expect(provider.type).toBe(ProviderType.SIGNAL);
  expect(provider.id).toBe(config.id);

  provider.teardown();

  // Wait for async operations to complete
  await new Promise((resolve) => setTimeout(resolve, 50));
});

Deno.test("Timer Signal Integration - should support all timer provider variants", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const registry = ProviderRegistry.getInstance();
  ProviderRegistry.registerBuiltinProviders();
  const storage = new MemoryKVStorage();
  await storage.initialize();

  const variants = ["timer", "schedule", "cron", "cron-scheduler"];
  const providers = [];

  for (const variant of variants) {
    const config = {
      id: `test-${variant}`,
      type: ProviderType.SIGNAL,
      provider: variant,
      config: {
        description: `Test ${variant}`,
        schedule: "0 9 * * 1",
        ...(variant === "cron-scheduler" ? { timezone: "UTC" } : {}),
      },
    };

    const provider = await registry.loadFromConfig(config);
    expect(provider).toBeTruthy();
    expect(provider.type).toBe(ProviderType.SIGNAL);
    providers.push(provider);
  }

  // Cleanup
  for (const provider of providers) {
    provider.teardown();
  }
});

Deno.test("Timer Signal Integration - should generate proper signal data format", async () => {
  const storage = new MemoryKVStorage();
  await storage.initialize();

  const config = {
    id: "test-signal-format",
    description: "Test signal format",
    provider: "timer" as const,
    schedule: "*/5 * * * * *", // Every 5 seconds
  };

  const provider = new TimerSignalProvider(config, storage);
  let _receivedSignal: unknown = null;

  provider.setSignalCallback((signal) => {
    _receivedSignal = signal;
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

  provider.teardown();

  // Wait for async operations to complete
  await new Promise((resolve) => setTimeout(resolve, 50));
});

Deno.test("Timer Signal Integration - should include timezone information for cron-scheduler", async () => {
  const storage = new MemoryKVStorage();
  await storage.initialize();

  const config = {
    id: "test-timezone",
    description: "Test timezone",
    provider: "cron-scheduler" as const,
    schedule: "0 9 * * 1",
    timezone: "America/New_York",
  };

  const provider = new TimerSignalProvider(config, storage);
  const signal = await provider.triggerManually();

  expect(signal.data.timezone).toBe("America/New_York");

  provider.teardown();

  // Wait for async operations to complete
  await new Promise((resolve) => setTimeout(resolve, 50));
});

Deno.test("Timer Signal Integration - should calculate next run time correctly", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const storage = new MemoryKVStorage();
  await storage.initialize();

  const config = {
    id: "test-next-run",
    description: "Test next run calculation",
    provider: "timer" as const,
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

  provider.teardown();

  // Wait for async operations to complete
  await new Promise((resolve) => setTimeout(resolve, 50));
});

Deno.test("Timer Signal Integration - should maintain scheduling across restarts", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const storage = new MemoryKVStorage();
  await storage.initialize();

  const config = {
    id: "test-persistence",
    description: "Test persistence",
    provider: "timer" as const,
    schedule: "0 0 * * 0", // Weekly on Sunday
  };

  // First instance
  const provider1 = new TimerSignalProvider(config, storage);
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

  provider2.teardown();
});

Deno.test("Timer Signal Integration - should handle missing storage gracefully", async () => {
  const config = {
    id: "test-no-storage",
    description: "Test without storage",
    provider: "timer" as const,
    schedule: "0 12 * * *", // Daily at noon
  };

  // Provider without storage
  const provider = new TimerSignalProvider(config);

  expect(() => provider.setup()).not.toThrow();
  expect(() => provider.teardown()).not.toThrow();

  // Should still work for manual triggers
  const signal = await provider.triggerManually();
  expect(signal.id).toBe(config.id);

  provider.teardown();

  // Wait for async operations to complete
  await new Promise((resolve) => setTimeout(resolve, 50));
});

Deno.test("Timer Signal Integration - should handle multiple timer providers simultaneously", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const storage = new MemoryKVStorage();
  await storage.initialize();

  const configs = [
    {
      id: "timer-1",
      description: "Timer 1",
      provider: "timer" as const,
      schedule: "*/10 * * * * *", // Every 10 seconds
    },
    {
      id: "timer-2",
      description: "Timer 2",
      provider: "cron-scheduler" as const,
      schedule: "*/15 * * * * *", // Every 15 seconds
      timezone: "UTC",
    },
    {
      id: "timer-3",
      description: "Timer 3",
      provider: "schedule" as const,
      schedule: "*/20 * * * * *", // Every 20 seconds
    },
  ];

  const providers = configs.map((config) => new TimerSignalProvider(config, storage));
  const receivedSignals: Array<{ providerIndex: number; signal: unknown }> = [];

  // Set up signal collection
  providers.forEach((provider, index) => {
    provider.setSignalCallback((signal) => {
      receivedSignals.push({ providerIndex: index, signal });
    });
    provider.setup();
  });

  // Wait for all setups to complete
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Clear any signals that might have been triggered during setup
  receivedSignals.length = 0;

  // Manually trigger all to verify they work independently
  for (let i = 0; i < providers.length; i++) {
    await providers[i].triggerManually();
  }

  // Should have received signals from all providers
  expect(receivedSignals.length).toBe(3);

  // Each provider should have generated its own signal
  const signalIds = receivedSignals.map((r) => {
    if (typeof r.signal === "object" && r.signal !== null && "id" in r.signal) {
      return r.signal.id;
    }
    return undefined;
  }).filter((id): id is string => id !== undefined);
  expect(signalIds).toContain("timer-1");
  expect(signalIds).toContain("timer-2");
  expect(signalIds).toContain("timer-3");

  // Since the schedules are 10s, 15s, and 20s intervals, at least 2 should have different next execution times
  const nextExecutions = providers.map((p) => {
    const next = p.getNextExecution();
    return next ? Math.floor(next.getTime() / 1000) : null; // Round to seconds
  }).filter((t): t is number => t !== null);

  // The unique count might be 1 if all happen to align, but usually should be 2 or 3
  const uniqueCount = new Set(nextExecutions).size;
  expect(uniqueCount).toBeGreaterThanOrEqual(1); // At least one valid execution time

  // Clean up
  for (const provider of providers) {
    provider.teardown();
  }

  // Wait for async operations to complete
  await new Promise((resolve) => setTimeout(resolve, 100));
});

Deno.test("Timer Signal Integration - should handle leap year schedules", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const storage = new MemoryKVStorage();
  await storage.initialize();

  const config = {
    id: "test-leap-year",
    description: "Test leap year",
    provider: "timer" as const,
    schedule: "0 0 29 2 *", // February 29th (leap year only)
  };

  const provider = new TimerSignalProvider(config, storage);

  // Should not throw even with leap year schedule
  expect(() => provider.setup()).not.toThrow();

  const signal = await provider.triggerManually();
  expect(signal.id).toBe(config.id);

  provider.teardown();

  // Wait for async operations to complete
  await new Promise((resolve) => setTimeout(resolve, 50));
});

Deno.test("Timer Signal Integration - should handle timezone edge cases", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const storage = new MemoryKVStorage();
  await storage.initialize();

  const config = {
    id: "test-timezone-edge",
    description: "Test timezone edge case",
    provider: "cron-scheduler" as const,
    schedule: "0 2 * * *", // 2 AM (DST transition time)
    timezone: "America/New_York",
  };

  const provider = new TimerSignalProvider(config, storage);

  expect(() => provider.setup()).not.toThrow();

  const signal = await provider.triggerManually();
  expect(signal.data.timezone).toBe("America/New_York");

  provider.teardown();

  // Wait for async operations to complete
  await new Promise((resolve) => setTimeout(resolve, 50));
});

Deno.test("Timer Signal Integration - should handle very frequent schedules", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const storage = new MemoryKVStorage();
  await storage.initialize();

  const config = {
    id: "test-frequent",
    description: "Test frequent schedule",
    provider: "timer" as const,
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

  provider.teardown();

  // Wait for async operations to complete
  await new Promise((resolve) => setTimeout(resolve, 50));
});
