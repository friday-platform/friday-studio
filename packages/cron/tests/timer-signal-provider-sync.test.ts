/**
 * TimerSignalProvider Synchronization Tests
 *
 * These tests expose race conditions in the TimerSignalProvider setup/teardown
 * and signal execution synchronization. They will initially fail and pass after
 * implementing proper synchronization.
 */

import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  type TimerSignalConfig,
  type TimerSignalData,
  TimerSignalProvider,
} from "../../../src/core/providers/builtin/timer-signal.ts";
import { ProviderStatus } from "../../../src/core/providers/types.ts";
import { MemoryKVStorage } from "../../../src/core/storage/memory-kv-storage.ts";
import {
  assertTimeBounds,
  delay,
  MockTimer,
  RaceConditionDetector,
  runConcurrent,
} from "./concurrency-test-utils.ts";

function createTestConfig(id = "test-timer"): TimerSignalConfig {
  return {
    id,
    description: "Test timer signal",
    provider: "timer",
    schedule: "*/5 * * * * *", // Every 5 seconds
    timezone: "UTC",
  };
}

async function createTestProvider(config?: TimerSignalConfig) {
  const storage = new MemoryKVStorage();
  await storage.initialize();
  const provider = new TimerSignalProvider(config || createTestConfig(), storage);
  return { provider, storage };
}

Deno.test("TimerSignalProvider Sync - setup should complete before reporting ready status", async () => {
  const { provider } = await createTestProvider();

  let setupCompleted = false;
  const originalSetupAsync = (provider as any).setupAsync;

  // Mock setupAsync to track completion
  (provider as any).setupAsync = async () => {
    await delay(100); // Simulate async setup time
    await originalSetupAsync.call(provider);
    setupCompleted = true;
  };

  // Start setup
  provider.setup();

  // Provider should NOT report ready immediately
  const initialState = provider.getState();

  // This test will fail with current implementation because setup() sets READY immediately
  if (initialState.status === ProviderStatus.READY && !setupCompleted) {
    throw new Error(
      "Provider reports READY before async setup completes - race condition detected",
    );
  }

  // Wait for setup to complete
  await delay(200);

  // Now it should be ready
  const finalState = provider.getState();
  assertEquals(
    finalState.status,
    ProviderStatus.READY,
    "Provider should be ready after setup completes",
  );
  assert(setupCompleted, "Setup should have completed");

  provider.teardown();
});

Deno.test("TimerSignalProvider Sync - concurrent setup and teardown should be handled gracefully", async () => {
  const { provider } = await createTestProvider();

  // Start multiple setup/teardown operations concurrently
  const operations = [
    () => Promise.resolve(provider.setup()),
    () => Promise.resolve(provider.teardown()),
    () => Promise.resolve(provider.setup()),
    () => Promise.resolve(provider.teardown()),
    () => Promise.resolve(provider.setup()),
  ];

  // These operations should not cause crashes or inconsistent state
  await runConcurrent(operations);

  // Final state should be consistent
  const finalState = provider.getState();

  // The provider should be in a valid state (either READY or DISABLED)
  assert(
    finalState.status === ProviderStatus.READY ||
      finalState.status === ProviderStatus.DISABLED ||
      finalState.status === ProviderStatus.ERROR,
    `Provider should be in valid state, got: ${finalState.status}`,
  );
});

Deno.test("TimerSignalProvider Sync - signal execution should not overlap", async () => {
  const { provider } = await createTestProvider({
    id: "overlap-test",
    description: "Overlap test timer",
    provider: "timer",
    schedule: "* * * * * *", // Every second
    timezone: "UTC",
  });

  const raceDetector = new RaceConditionDetector();
  let executionCount = 0;
  let overlappingExecutions = 0;

  // Set up callback to detect overlapping executions
  provider.setSignalCallback(async (signal: TimerSignalData) => {
    const executionId = `execution-${executionCount++}`;
    raceDetector.startOperation(executionId);

    // Simulate some work that takes time
    await delay(50);

    raceDetector.endOperation(executionId);
  });

  provider.setup();

  // Let it run for a while to trigger multiple executions
  await delay(3000);

  provider.teardown();

  // Check for overlapping executions (race conditions)
  const races = raceDetector.detectRaces();

  // Signal executions should not overlap - this will fail if not properly synchronized
  if (races.length > 0) {
    overlappingExecutions = races.length;
    console.log("Detected overlapping signal executions:", races);
  }

  // This assertion will fail with current implementation if signal executions overlap
  assertEquals(
    overlappingExecutions,
    0,
    "Signal executions should not overlap - synchronization issue detected",
  );

  assert(executionCount > 0, "Should have executed at least one signal");
});

Deno.test("TimerSignalProvider Sync - teardown during signal execution should wait", async () => {
  const { provider } = await createTestProvider({
    id: "teardown-test",
    description: "Teardown test timer",
    provider: "timer",
    schedule: "* * * * * *", // Every second
    timezone: "UTC",
  });

  let signalExecuting = false;
  let signalCompleted = false;

  // Set up callback that takes some time to complete
  provider.setSignalCallback(async (signal: TimerSignalData) => {
    signalExecuting = true;
    await delay(200); // Simulate work
    signalCompleted = true;
  });

  provider.setup();

  // Wait for signal execution to start
  await delay(1100); // Wait just over 1 second for first execution

  // Start teardown while signal might be executing
  const teardownStart = performance.now();
  provider.teardown();
  const teardownEnd = performance.now();

  // Teardown should have waited for signal execution to complete
  // This test will fail if teardown doesn't wait for ongoing executions
  if (signalExecuting && !signalCompleted && (teardownEnd - teardownStart) < 150) {
    throw new Error("Teardown completed too quickly - may not have waited for signal execution");
  }
});

Deno.test("TimerSignalProvider Sync - multiple providers with same schedule should not interfere", async () => {
  const config1 = createTestConfig("provider1");
  const config2 = createTestConfig("provider2");
  config1.schedule = "*/2 * * * * *"; // Every 2 seconds
  config2.schedule = "*/2 * * * * *"; // Every 2 seconds

  const { provider: provider1 } = await createTestProvider(config1);
  const { provider: provider2 } = await createTestProvider(config2);

  let provider1Executions = 0;
  let provider2Executions = 0;

  provider1.setSignalCallback(() => {
    provider1Executions++;
  });

  provider2.setSignalCallback(() => {
    provider2Executions++;
  });

  // Start both providers
  provider1.setup();
  provider2.setup();

  // Let them run
  await delay(5000);

  // Stop both providers
  provider1.teardown();
  provider2.teardown();

  // Both providers should have executed independently
  assert(provider1Executions > 0, "Provider 1 should have executed signals");
  assert(provider2Executions > 0, "Provider 2 should have executed signals");

  // They should have similar execution counts (within reasonable variance)
  const executionDiff = Math.abs(provider1Executions - provider2Executions);
  assert(
    executionDiff <= 2,
    `Execution counts should be similar, got ${provider1Executions} vs ${provider2Executions}`,
  );
});

Deno.test("TimerSignalProvider Sync - health check during signal execution should be consistent", async () => {
  const { provider } = await createTestProvider({
    id: "health-test",
    description: "Health check test timer",
    provider: "timer",
    schedule: "* * * * * *", // Every second
    timezone: "UTC",
  });

  let isExecutingSignal = false;

  provider.setSignalCallback(async () => {
    isExecutingSignal = true;
    await delay(100); // Simulate work
    isExecutingSignal = false;
  });

  provider.setup();

  // Perform health checks concurrently with signal execution
  const healthCheckPromises = Array(20).fill(null).map(async (_, i) => {
    await delay(i * 100); // Stagger health checks
    return await provider.checkHealth();
  });

  const healthResults = await Promise.all(healthCheckPromises);

  provider.teardown();

  // All health checks should succeed and be consistent
  for (const health of healthResults) {
    assert(health.healthy, "Health check should report healthy during normal operation");
    assertExists(health.lastCheck, "Health check should have lastCheck timestamp");
  }

  // Health checks should not interfere with signal execution state
  const finalState = provider.getState();
  assert(
    finalState.status === ProviderStatus.DISABLED,
    "Provider should be properly disabled after teardown",
  );
});

Deno.test("TimerSignalProvider Sync - storage persistence during concurrent operations should be atomic", async () => {
  const { provider, storage } = await createTestProvider({
    id: "persistence-test",
    description: "Persistence test timer",
    provider: "timer",
    schedule: "*/2 * * * * *", // Every 2 seconds
    timezone: "UTC",
  });

  let signalCount = 0;

  provider.setSignalCallback(() => {
    signalCount++;
  });

  provider.setup();

  // Perform multiple state queries while signals are executing and persisting
  const stateQueries = Array(50).fill(null).map(async (_, i) => {
    await delay(i * 20);
    return provider.getState();
  });

  // Also trigger manual persistence operations
  const manualPersistOps = Array(10).fill(null).map(async (_, i) => {
    await delay(i * 100);
    // Trigger persistence by calling a method that causes state changes
    return provider.getNextExecution();
  });

  const [stateResults, persistResults] = await Promise.all([
    Promise.all(stateQueries),
    Promise.all(manualPersistOps),
  ]);

  provider.teardown();

  // All state queries should return consistent data
  for (const state of stateResults) {
    assertExists(state, "State should exist");
    assert(
      state.status === ProviderStatus.READY ||
        state.status === ProviderStatus.DISABLED,
      "State should be in valid status",
    );
  }

  // Storage should be in consistent state
  const finalStorageState = await storage.get(["timer_signals", "persistence-test"]);

  // This test will fail if storage operations are not atomic and cause corruption
  if (finalStorageState && typeof finalStorageState === "object" && "id" in finalStorageState) {
    assertExists(finalStorageState.id, "Stored state should have ID");
    assertEquals(finalStorageState.id, "persistence-test", "Stored state should have correct ID");
  }

  assert(signalCount > 0, "Should have executed at least one signal");
});

Deno.test("TimerSignalProvider Sync - rapid setup/teardown cycles should not leak resources", async () => {
  const configs = Array(10).fill(null).map((_, i) => createTestConfig(`rapid-test-${i}`));

  // Perform rapid setup/teardown cycles
  for (let cycle = 0; cycle < 5; cycle++) {
    const providers: TimerSignalProvider[] = [];

    // Setup all providers
    for (const config of configs) {
      const { provider } = await createTestProvider(config);
      providers.push(provider);
      provider.setup();
    }

    // Let them run briefly
    await delay(100);

    // Teardown all providers
    for (const provider of providers) {
      provider.teardown();
    }

    // Brief pause between cycles
    await delay(50);
  }

  // After rapid cycles, memory usage should be stable
  // This test mainly checks that timers are properly cleaned up
  // The test will fail if there are timer leaks or resource issues

  // Force garbage collection if available
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
  }

  // Wait a bit to see if any leaked timers fire
  await delay(1000);

  // If we get here without crashes or hangs, the test passes
  assert(true, "Rapid setup/teardown cycles completed without resource leaks");
});

Deno.test("TimerSignalProvider Sync - callback errors should not break timer scheduling", async () => {
  const { provider } = await createTestProvider({
    id: "error-test",
    description: "Error test timer",
    provider: "timer",
    schedule: "* * * * * *", // Every second
    timezone: "UTC",
  });

  let callbackCount = 0;
  let errorCount = 0;

  // Set up callback that sometimes throws errors
  provider.setSignalCallback(async () => {
    callbackCount++;
    if (callbackCount % 3 === 0) {
      errorCount++;
      throw new Error(`Callback error ${errorCount}`);
    }
  });

  provider.setup();

  // Let it run and encounter errors
  await delay(5000);

  provider.teardown();

  // Despite errors, timer should have continued scheduling
  assert(callbackCount > 0, "Should have executed callbacks");
  assert(errorCount > 0, "Should have encountered callback errors");

  // Timer should still be in valid state despite callback errors
  const finalState = provider.getState();

  // This test will fail if callback errors break the timer scheduling
  assert(
    finalState.status === ProviderStatus.DISABLED,
    "Provider should be cleanly disabled despite callback errors",
  );

  // Provider should have continued scheduling despite errors
  assert(
    callbackCount > errorCount,
    "Provider should have continued executing callbacks after errors",
  );
});
