/**
 * Comprehensive test suite for WatchdogTimer
 * Tests progress-based timeout behavior, configuration, and integration scenarios
 */

import { expect } from "@std/expect";
import { WatchdogTimer } from "../src/watchdog-timer.ts";
import type { WorkspaceTimeoutConfig } from "@atlas/config";

// Test helper to wait for a specified duration
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test helper to check if signal is aborted
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

Deno.test("WatchdogTimer - Default configuration", () => {
  const watchdog = new WatchdogTimer();
  
  expect(watchdog.signal).toBeInstanceOf(AbortSignal);
  expect(watchdog.isTimedOut).toBe(false);
  expect(isAborted(watchdog.signal)).toBe(false);
  
  // Clean up
  watchdog.abort();
});

Deno.test("WatchdogTimer - Custom configuration", () => {
  const config: WorkspaceTimeoutConfig = {
    progressTimeout: "30s",
    maxTotalTimeout: "10m",
  };
  
  const watchdog = new WatchdogTimer(config);
  
  expect(watchdog.signal).toBeInstanceOf(AbortSignal);
  expect(watchdog.isTimedOut).toBe(false);
  expect(isAborted(watchdog.signal)).toBe(false);
  
  // Clean up
  watchdog.abort();
});

Deno.test("WatchdogTimer - Progress reporting resets timer", async () => {
  const config: WorkspaceTimeoutConfig = {
    progressTimeout: "1s", // Short for testing  
    maxTotalTimeout: "10s",
  };
  
  const watchdog = new WatchdogTimer(config);
  
  // Wait 800ms (less than progress timeout)
  await delay(800);
  expect(watchdog.isTimedOut).toBe(false);
  
  // Report progress to reset timer
  watchdog.reportProgress();
  
  // Wait another 800ms (should still be valid due to progress reset)
  await delay(800);
  expect(watchdog.isTimedOut).toBe(false);
  
  // Clean up
  watchdog.abort();
});

Deno.test("WatchdogTimer - Progress timeout triggers abort", async () => {
  const config: WorkspaceTimeoutConfig = {
    progressTimeout: "1s", // Short for testing
    maxTotalTimeout: "10s",
  };
  
  const watchdog = new WatchdogTimer(config);
  
  expect(watchdog.isTimedOut).toBe(false);
  expect(isAborted(watchdog.signal)).toBe(false);
  
  // Wait longer than progress timeout without reporting progress
  await delay(1200);
  
  expect(watchdog.isTimedOut).toBe(true);
  expect(isAborted(watchdog.signal)).toBe(true);
});

Deno.test("WatchdogTimer - Max total timeout triggers abort", async () => {
  const config: WorkspaceTimeoutConfig = {
    progressTimeout: "1s",
    maxTotalTimeout: "2s", // Short for testing
  };
  
  const watchdog = new WatchdogTimer(config);
  
  // Report progress frequently to prevent progress timeout
  const progressInterval = setInterval(() => {
    if (!watchdog.isTimedOut) {
      watchdog.reportProgress();
    }
  }, 500);
  
  expect(watchdog.isTimedOut).toBe(false);
  
  // Wait longer than max total timeout
  await delay(2500);
  
  clearInterval(progressInterval);
  
  expect(watchdog.isTimedOut).toBe(true);
  expect(isAborted(watchdog.signal)).toBe(true);
});

Deno.test("WatchdogTimer - Manual abort", () => {
  const watchdog = new WatchdogTimer();
  
  expect(watchdog.isTimedOut).toBe(false);
  expect(isAborted(watchdog.signal)).toBe(false);
  
  watchdog.abort("Manual termination");
  
  expect(watchdog.isTimedOut).toBe(true);
  expect(isAborted(watchdog.signal)).toBe(true);
});

Deno.test("WatchdogTimer - Progress reporting after abort is ignored", () => {
  const watchdog = new WatchdogTimer();
  
  watchdog.abort("Test abort");
  expect(watchdog.isTimedOut).toBe(true);
  
  // This should not throw or affect the aborted state
  watchdog.reportProgress();
  expect(watchdog.isTimedOut).toBe(true);
  expect(isAborted(watchdog.signal)).toBe(true);
});

Deno.test("WatchdogTimer - Multiple abort calls are safe", () => {
  const watchdog = new WatchdogTimer();
  
  watchdog.abort("First abort");
  expect(watchdog.isTimedOut).toBe(true);
  
  // Multiple abort calls should not throw
  watchdog.abort("Second abort");
  watchdog.abort("Third abort");
  
  expect(watchdog.isTimedOut).toBe(true);
  expect(isAborted(watchdog.signal)).toBe(true);
});

Deno.test("WatchdogTimer - Integration with fetch-like operations", async () => {
  const config: WorkspaceTimeoutConfig = {
    progressTimeout: "2s",
    maxTotalTimeout: "10s",
  };
  
  const watchdog = new WatchdogTimer(config);
  
  // Simulate a long-running operation that reports progress
  const simulateOperation = async (): Promise<string> => {
    for (let i = 0; i < 3; i++) {
      // Check if operation was aborted
      if (watchdog.signal.aborted) {
        throw new Error("Operation aborted");
      }
      
      // Simulate work and report progress
      await delay(500);
      watchdog.reportProgress();
    }
    
    return "Operation completed";
  };
  
  const result = await simulateOperation();
  expect(result).toBe("Operation completed");
  expect(watchdog.isTimedOut).toBe(false);
  
  // Clean up
  watchdog.abort();
});

Deno.test("WatchdogTimer - Integration with aborted operations", async () => {
  const config: WorkspaceTimeoutConfig = {
    progressTimeout: "1s", // Short  
    maxTotalTimeout: "10s",
  };
  
  const watchdog = new WatchdogTimer(config);
  
  // Simulate operation that doesn't report progress
  const simulateHungOperation = async (): Promise<string> => {
    // Wait longer than progress timeout without reporting progress
    await delay(1500);
    
    if (watchdog.signal.aborted) {
      throw new Error("Operation was aborted due to timeout");
    }
    
    return "Should not reach here";
  };
  
  try {
    await simulateHungOperation();
    throw new Error("Operation should have been aborted");
  } catch (error) {
    expect((error as Error).message).toContain("aborted");
    expect(watchdog.isTimedOut).toBe(true);
  }
});