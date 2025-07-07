/**
 * Timer Signal Provider Tests
 *
 * Tests for the cron-based timer signal provider functionality
 */

import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import {
  type TimerSignalConfig,
  type TimerSignalData,
  TimerSignalProvider,
} from "../../../src/core/providers/builtin/timer-signal.ts";
import { ProviderStatus } from "../../../src/core/providers/types.ts";
import { MemoryKVStorage } from "../../../src/core/storage/memory-kv-storage.ts";

const basicConfig: TimerSignalConfig = {
  id: "test-timer",
  description: "Test timer signal",
  provider: "timer",
  schedule: "*/5 * * * * *", // Every 5 seconds for testing
};

const cronSchedulerConfig: TimerSignalConfig = {
  id: "test-cron-scheduler",
  description: "Test cron scheduler signal",
  provider: "cron-scheduler",
  schedule: "0 9 * * 1", // Monday 9 AM
  timezone: "America/Los_Angeles",
};

async function setupTest() {
  const storage = new MemoryKVStorage();
  await storage.initialize();
  return { storage };
}

async function teardownProvider(provider?: TimerSignalProvider, storage?: MemoryKVStorage) {
  if (provider) {
    provider.teardown();
    // Wait longer for teardown to complete and timers to clear
    await delay(50);
  }
  if (storage) {
    try {
      await storage.close();
      // Wait a bit for file handles to close
      await delay(10);
    } catch {
      // Ignore close errors
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test("TimerSignalProvider - should validate required schedule field", () => {
  assertThrows(
    () => {
      new TimerSignalProvider({
        id: "test",
        description: "Test",
        provider: "timer",
        schedule: "",
      });
    },
    Error,
    "Timer signal provider requires 'schedule' configuration",
  );
});

Deno.test("TimerSignalProvider - should validate cron expression format", () => {
  assertThrows(
    () => {
      new TimerSignalProvider({
        id: "test",
        description: "Test",
        provider: "timer",
        schedule: "invalid cron",
      });
    },
    Error,
    "Invalid cron expression",
  );
});

Deno.test("TimerSignalProvider - should validate timezone if provided", () => {
  assertThrows(
    () => {
      new TimerSignalProvider({
        id: "test",
        description: "Test",
        provider: "cron-scheduler",
        schedule: "0 9 * * 1",
        timezone: "Invalid/Timezone",
      });
    },
    Error,
    "Invalid timezone",
  );
});

Deno.test({
  name: "TimerSignalProvider - should accept valid configuration",
  sanitizeResources: false, // Skip resource leak detection for this test
  async fn() {
    const { storage } = await setupTest();
    let provider: TimerSignalProvider | undefined;

    try {
      provider = new TimerSignalProvider(basicConfig, storage);
      assert(provider !== undefined);
    } finally {
      await teardownProvider(provider, storage);
    }
  },
});

Deno.test("TimerSignalProvider - should initialize with NOT_CONFIGURED status", async () => {
  const { storage } = await setupTest();
  let provider: TimerSignalProvider | undefined;

  try {
    provider = new TimerSignalProvider(basicConfig, storage);
    const state = provider.getState();
    assertEquals(state.status, ProviderStatus.NOT_CONFIGURED);
  } finally {
    await teardownProvider(provider, storage);
  }
});

Deno.test("TimerSignalProvider - should transition to READY status after setup", async () => {
  const { storage } = await setupTest();
  let provider: TimerSignalProvider | undefined;

  try {
    provider = new TimerSignalProvider(basicConfig, storage);
    provider.setup();

    // Wait a bit for async setup to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    const state = provider.getState();
    assertEquals(state.status, ProviderStatus.READY);
  } finally {
    await teardownProvider(provider, storage);
  }
});

Deno.test("TimerSignalProvider - should transition to DISABLED status after teardown", async () => {
  const { storage } = await setupTest();
  let provider: TimerSignalProvider | undefined;

  try {
    provider = new TimerSignalProvider(basicConfig, storage);
    provider.setup();
    provider.teardown();

    const state = provider.getState();
    assertEquals(state.status, ProviderStatus.DISABLED);
  } finally {
    await teardownProvider(provider, storage);
  }
});

Deno.test("TimerSignalProvider - should provide health status", async () => {
  const { storage } = await setupTest();
  let provider: TimerSignalProvider | undefined;

  try {
    provider = new TimerSignalProvider(basicConfig, storage);
    provider.setup();

    // Wait for async setup
    await new Promise((resolve) => setTimeout(resolve, 100));

    const health = await provider.checkHealth();
    assertEquals(health.healthy, true);
    assert(health.message?.includes("Timer signal scheduled"));
  } finally {
    await teardownProvider(provider, storage);
  }
});

Deno.test("TimerSignalProvider - should return correct provider ID", async () => {
  const { storage } = await setupTest();
  let provider: TimerSignalProvider | undefined;

  try {
    provider = new TimerSignalProvider(basicConfig, storage);
    assertEquals(provider.getProviderId(), basicConfig.id);
  } finally {
    await teardownProvider(provider, storage);
  }
});

Deno.test("TimerSignalProvider - should return correct provider type", async () => {
  const { storage } = await setupTest();
  let provider: TimerSignalProvider | undefined;

  try {
    provider = new TimerSignalProvider(basicConfig, storage);
    assertEquals(provider.getProviderType(), basicConfig.provider);
  } finally {
    await teardownProvider(provider, storage);
  }
});

Deno.test("TimerSignalProvider - should return schedule", async () => {
  const { storage } = await setupTest();
  let provider: TimerSignalProvider | undefined;

  try {
    provider = new TimerSignalProvider(basicConfig, storage);
    assertEquals(provider.getSchedule(), basicConfig.schedule);
  } finally {
    await teardownProvider(provider, storage);
  }
});

Deno.test("TimerSignalProvider - should use UTC as default timezone", async () => {
  const { storage } = await setupTest();
  let provider: TimerSignalProvider | undefined;

  try {
    provider = new TimerSignalProvider(basicConfig, storage);
    assertEquals(provider.getTimezone(), "UTC");
  } finally {
    await teardownProvider(provider, storage);
  }
});

Deno.test("TimerSignalProvider - should use specified timezone for cron-scheduler", async () => {
  const { storage } = await setupTest();
  let provider: TimerSignalProvider | undefined;

  try {
    provider = new TimerSignalProvider(cronSchedulerConfig, storage);
    assertEquals(provider.getTimezone(), "America/Los_Angeles");
  } finally {
    await teardownProvider(provider, storage);
  }
});

Deno.test("TimerSignalProvider - should call signal callback when manually triggered", async () => {
  const { storage } = await setupTest();
  let provider: TimerSignalProvider | undefined;
  let signalReceived: TimerSignalData | undefined;

  try {
    provider = new TimerSignalProvider(basicConfig, storage);
    provider.setSignalCallback((signal) => {
      signalReceived = signal;
    });

    const signal = await provider.triggerManually();

    assertExists(signalReceived);
    if (signalReceived) {
      assertEquals(signalReceived.id, basicConfig.id);
      assertEquals(signalReceived.type, "timer");
      assertEquals(signalReceived.data.scheduled, basicConfig.schedule);
    }
  } finally {
    await teardownProvider(provider, storage);
  }
});

Deno.test("TimerSignalProvider - should include correct signal data structure", async () => {
  const { storage } = await setupTest();
  let provider: TimerSignalProvider | undefined;

  try {
    provider = new TimerSignalProvider(basicConfig, storage);
    const signal = await provider.triggerManually();

    assertEquals(signal.id, basicConfig.id);
    assertEquals(signal.type, "timer");
    assert(typeof signal.timestamp === "string");
    assertEquals(signal.data.scheduled, basicConfig.schedule);
    assertEquals(signal.data.timezone, "UTC");

    // Verify timestamp is valid ISO string
    const timestamp = new Date(signal.timestamp);
    assert(!isNaN(timestamp.getTime()));
  } finally {
    await teardownProvider(provider, storage);
  }
});

Deno.test("TimerSignalProvider - should calculate next execution time", async () => {
  const { storage } = await setupTest();
  let provider: TimerSignalProvider | undefined;

  try {
    provider = new TimerSignalProvider(basicConfig, storage);
    provider.setup();

    // Wait for async setup
    await new Promise((resolve) => setTimeout(resolve, 100));

    const nextExecution = provider.getNextExecution();
    assertExists(nextExecution);
    assert(nextExecution!.getTime() > Date.now());
  } finally {
    await teardownProvider(provider, storage);
  }
});

Deno.test("TimerSignalProvider - should schedule execution within expected time range", async () => {
  const { storage } = await setupTest();
  let provider: TimerSignalProvider | undefined;

  try {
    // Use a more predictable schedule for testing
    const testConfig = {
      ...basicConfig,
      schedule: "*/10 * * * * *", // Every 10 seconds
    };

    provider = new TimerSignalProvider(testConfig, storage);
    provider.setup();

    // Wait for async setup
    await new Promise((resolve) => setTimeout(resolve, 100));

    const nextExecution = provider.getNextExecution();
    assertExists(nextExecution);
    const now = Date.now();
    const timeDiff = nextExecution!.getTime() - now;

    // Should be scheduled within the next 10 seconds
    assert(timeDiff > 0);
    assert(timeDiff <= 10000);
  } finally {
    await teardownProvider(provider, storage);
  }
});

Deno.test("TimerSignalProvider - should persist state to storage when available", async () => {
  const { storage } = await setupTest();
  let provider: TimerSignalProvider | undefined;

  try {
    provider = new TimerSignalProvider(basicConfig, storage);
    provider.setup();

    // Wait for async setup and persistence
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Check if state was persisted
    const persistedState = await storage.get(["timer_signals", basicConfig.id]);
    assertExists(persistedState);
    assertEquals((persistedState as any).id, basicConfig.id);
    assertEquals((persistedState as any).schedule, basicConfig.schedule);
  } finally {
    await teardownProvider(provider);
  }
});

Deno.test("TimerSignalProvider - should work without storage", async () => {
  let provider: TimerSignalProvider | undefined;

  try {
    provider = new TimerSignalProvider(basicConfig); // No storage provided

    // Should not throw
    provider.setup();
    provider.teardown();

    // Should still work for manual triggers
    const signal = await provider.triggerManually();
    assertEquals(signal.id, basicConfig.id);
  } finally {
    await teardownProvider(provider);
  }
});

Deno.test("TimerSignalProvider - should support all provider variants", async () => {
  const { storage } = await setupTest();
  const variants: Array<"timer" | "schedule" | "cron" | "cron-scheduler"> = [
    "timer",
    "schedule",
    "cron",
    "cron-scheduler",
  ];

  for (const variant of variants) {
    let provider: TimerSignalProvider | undefined;

    try {
      const config = {
        ...basicConfig,
        id: `test-${variant}`,
        provider: variant,
        ...(variant === "cron-scheduler" ? { timezone: "UTC" } : {}),
      };

      provider = new TimerSignalProvider(config, storage);
      assertEquals(provider.getProviderType(), variant);
    } finally {
      await teardownProvider(provider, storage);
    }
  }
});

Deno.test("TimerSignalProvider - should handle storage errors gracefully", async () => {
  // Create a mock storage that throws errors
  const errorStorage = {
    async get() {
      throw new Error("Storage error");
    },
    async set() {
      throw new Error("Storage error");
    },
    async initialize() {},
  } as any;

  let provider: TimerSignalProvider | undefined;

  try {
    provider = new TimerSignalProvider(basicConfig, errorStorage);

    // Should not throw even with failing storage
    provider.setup();
    provider.teardown();

    // Should still work for manual triggers
    const signal = await provider.triggerManually();
    assertEquals(signal.id, basicConfig.id);
  } finally {
    await teardownProvider(provider);
  }
});
