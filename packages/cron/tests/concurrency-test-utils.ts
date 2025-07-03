/**
 * Concurrency Testing Utilities
 *
 * Provides utilities for testing race conditions, concurrent operations,
 * and timing-sensitive scenarios in the Atlas cron system.
 */

import { assertEquals, assertRejects } from "@std/assert";

/**
 * Simulates concurrent execution of multiple async operations
 */
export async function runConcurrent<T>(
  operations: (() => Promise<T>)[],
  delayMs = 0,
): Promise<T[]> {
  // Add small random delays to increase chance of race conditions
  const delayedOperations = operations.map((op, index) => async () => {
    if (delayMs > 0) {
      await delay(Math.random() * delayMs);
    }
    return await op();
  });

  return await Promise.all(delayedOperations.map((op) => op()));
}

/**
 * Runs an operation multiple times concurrently to stress test for race conditions
 */
export async function stressTest<T>(
  operation: () => Promise<T>,
  iterations = 50,
  concurrency = 10,
): Promise<T[]> {
  const operations = Array(iterations).fill(null).map(() => operation);
  const batches: Promise<T[]>[] = [];

  // Process in batches to control concurrency
  for (let i = 0; i < operations.length; i += concurrency) {
    const batch = operations.slice(i, i + concurrency);
    batches.push(runConcurrent(batch, 10));
  }

  const results = await Promise.all(batches);
  return results.flat();
}

/**
 * Utility to create deterministic delays for testing
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mock timer that can be controlled for testing
 */
export class MockTimer {
  private timers = new Map<number, { callback: () => void; delay: number; created: number }>();
  private currentTime = 0;
  private nextId = 1;

  setTimeout(callback: () => void, delay: number): number {
    const id = this.nextId++;
    this.timers.set(id, {
      callback,
      delay,
      created: this.currentTime,
    });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  /**
   * Advance time and trigger any timers that should fire
   */
  advanceTime(ms: number): void {
    this.currentTime += ms;

    const readyTimers = Array.from(this.timers.entries())
      .filter(([_, timer]) => this.currentTime >= timer.created + timer.delay)
      .sort(([_1, a], [_2, b]) => (a.created + a.delay) - (b.created + b.delay));

    for (const [id, timer] of readyTimers) {
      this.timers.delete(id);
      try {
        timer.callback();
      } catch (error) {
        // Timer callback errors shouldn't break the mock
        console.warn("Timer callback error:", error);
      }
    }
  }

  /**
   * Get count of active timers
   */
  getActiveTimerCount(): number {
    return this.timers.size;
  }

  /**
   * Clear all timers
   */
  clearAll(): void {
    this.timers.clear();
  }

  /**
   * Get current mock time
   */
  getCurrentTime(): number {
    return this.currentTime;
  }
}

/**
 * Race condition detector that tracks timing of operations
 */
export class RaceConditionDetector {
  private operations = new Map<string, { start: number; end?: number; data?: any }>();
  private overlaps: Array<{ op1: string; op2: string; overlap: number }> = [];

  /**
   * Mark the start of an operation
   */
  startOperation(operationId: string, data?: any): void {
    this.operations.set(operationId, {
      start: performance.now(),
      data,
    });
  }

  /**
   * Mark the end of an operation
   */
  endOperation(operationId: string): void {
    const operation = this.operations.get(operationId);
    if (operation) {
      operation.end = performance.now();
    }
  }

  /**
   * Check for overlapping operations that could cause race conditions
   */
  detectRaces(): Array<{ op1: string; op2: string; overlap: number }> {
    const completed = Array.from(this.operations.entries())
      .filter(([_, op]) => op.end !== undefined)
      .map(([id, op]) => ({ id, start: op.start, end: op.end! }));

    this.overlaps = [];

    for (let i = 0; i < completed.length; i++) {
      for (let j = i + 1; j < completed.length; j++) {
        const op1 = completed[i];
        const op2 = completed[j];

        // Check for time overlap
        const overlapStart = Math.max(op1.start, op2.start);
        const overlapEnd = Math.min(op1.end, op2.end);

        if (overlapStart < overlapEnd) {
          this.overlaps.push({
            op1: op1.id,
            op2: op2.id,
            overlap: overlapEnd - overlapStart,
          });
        }
      }
    }

    return this.overlaps;
  }

  /**
   * Assert that no race conditions were detected
   */
  assertNoRaces(): void {
    const races = this.detectRaces();
    if (races.length > 0) {
      throw new Error(`Race conditions detected: ${JSON.stringify(races, null, 2)}`);
    }
  }

  /**
   * Clear all tracked operations
   */
  clear(): void {
    this.operations.clear();
    this.overlaps = [];
  }
}

/**
 * Utility to simulate storage contention and failures
 */
export class MockStorageWithContention {
  private storage = new Map<string, any>();
  private locks = new Set<string>();
  private contention = new Map<string, number>();
  private failureRate = 0;

  /**
   * Set the failure rate for storage operations (0-1)
   */
  setFailureRate(rate: number): void {
    this.failureRate = Math.max(0, Math.min(1, rate));
  }

  /**
   * Simulate a storage operation with potential contention
   */
  async operation<T>(
    key: string,
    operation: () => Promise<T>,
    timeout = 1000,
  ): Promise<T> {
    // Simulate random failures
    if (Math.random() < this.failureRate) {
      throw new Error(`Storage operation failed for key: ${key}`);
    }

    // Track contention
    if (this.locks.has(key)) {
      this.contention.set(key, (this.contention.get(key) || 0) + 1);
    }

    // Wait for lock
    const startTime = Date.now();
    while (this.locks.has(key)) {
      if (Date.now() - startTime > timeout) {
        throw new Error(`Storage lock timeout for key: ${key}`);
      }
      await delay(1);
    }

    // Acquire lock
    this.locks.add(key);

    try {
      // Add small delay to increase chance of contention
      await delay(Math.random() * 10);
      return await operation();
    } finally {
      this.locks.delete(key);
    }
  }

  /**
   * Get contention statistics
   */
  getContentionStats(): Map<string, number> {
    return new Map(this.contention);
  }

  /**
   * Clear all locks and reset contention stats
   */
  reset(): void {
    this.locks.clear();
    this.contention.clear();
    this.storage.clear();
  }

  /**
   * Basic storage operations for testing
   */
  async get(key: string[]): Promise<any> {
    const keyStr = key.join(":");
    return this.operation(keyStr, async () => {
      return this.storage.get(keyStr);
    });
  }

  async set(key: string[], value: any): Promise<void> {
    const keyStr = key.join(":");
    return this.operation(keyStr, async () => {
      this.storage.set(keyStr, value);
    });
  }

  async delete(key: string[]): Promise<void> {
    const keyStr = key.join(":");
    return this.operation(keyStr, async () => {
      this.storage.delete(keyStr);
    });
  }

  /**
   * List entries with a given prefix (for KV storage compatibility)
   */
  async *list(prefix: string[]): AsyncIterable<{ key: string[]; value: any }> {
    const prefixStr = prefix.join(":");

    for (const [key, value] of this.storage.entries()) {
      if (key.startsWith(prefixStr)) {
        yield {
          key: key.split(":"),
          value,
        };
      }
    }
  }

  /**
   * Initialize method for compatibility
   */
  async initialize(): Promise<void> {
    // No-op for mock storage
  }
}

/**
 * Utility to assert that operations complete within expected time bounds
 */
export async function assertTimeBounds<T>(
  operation: () => Promise<T>,
  minMs: number,
  maxMs: number,
  description = "Operation",
): Promise<T> {
  const start = performance.now();
  const result = await operation();
  const elapsed = performance.now() - start;

  if (elapsed < minMs) {
    throw new Error(`${description} completed too quickly: ${elapsed}ms < ${minMs}ms`);
  }
  if (elapsed > maxMs) {
    throw new Error(`${description} took too long: ${elapsed}ms > ${maxMs}ms`);
  }

  return result;
}

/**
 * Utility to test that concurrent operations maintain data consistency
 */
export async function assertDataConsistency<T>(
  initialState: T,
  operations: Array<(state: T) => Promise<T>>,
  validator: (finalState: T) => boolean,
  description = "Data consistency",
): Promise<T> {
  let currentState = initialState;

  // Run all operations concurrently, each getting the initial state
  const results = await runConcurrent(
    operations.map((op) => () => op(currentState)),
  );

  // The final state should be consistent regardless of operation order
  // This is a simplified consistency check - real implementations may vary
  const finalState = results[results.length - 1];

  if (!validator(finalState)) {
    throw new Error(`${description} check failed. Final state: ${JSON.stringify(finalState)}`);
  }

  return finalState;
}
