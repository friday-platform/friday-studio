#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --unstable-broadcast-channel --unstable-worker-options

/**
 * Tests for worker timeout error handling
 * This test reproduces the uncaught promise error from worker timeouts
 */

// NOTE: WorkerManager doesn't exist in the actor-based architecture
// // import { WorkerManager } from "../../src/core/utils/worker-manager.ts"; // Replaced by actor-based architecture
import { expect } from "@std/expect";

// NOTE: These tests commented out - WorkerManager no longer exists in actor-based architecture
/*
Deno.test({
  name: "Worker timeout should be caught properly",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const manager = new WorkerManager();

    // Create a worker that never responds to tasks (simulates stuck agent)
    const testWorkerCode = `
    /// <reference no-default-lib="true" />
    /// <reference lib="deno.worker" />

    import { BaseWorker } from "${
      new URL("../../src/core/workers/base-worker.ts", import.meta.url).href
    }";

    class TimeoutTestWorker extends BaseWorker {
      constructor() {
        super("timeout-test-worker", "test");
      }

      protected override async initialize(config) {
        this.log("Timeout test worker initialized");
      }

      protected override async processTask(taskId, data) {
        this.log("Processing task but will never respond:", taskId, data);
        // Simulate a stuck agent - never return or throw
        return new Promise(() => {}); // Never resolves
      }

      protected override async cleanup() {
        this.log("Cleaning up timeout test worker");
      }
    }

    new TimeoutTestWorker();
  `;

    const tempFile = await Deno.makeTempFile({ suffix: ".ts" });
    await Deno.writeTextFile(tempFile, testWorkerCode);

    try {
      const _worker = await manager.spawnWorker(
        { id: "timeout-worker", type: "agent", config: { name: "Timeout Worker" } },
        new URL(`file://${tempFile}`).href,
      );

      // Wait for initialization
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // This should timeout and throw an error, but we want to catch it
      let caughtError: Error | null = null;

      try {
        // Send a task that will timeout (reduce timeout to 2 seconds for faster testing)
        await manager.sendTask("timeout-worker", "timeout-task", {
          action: "stuck",
          message: "This will timeout",
        }, 2000); // 2 second timeout
      } catch (error) {
        caughtError = error as Error;
      }

      // Verify the error was caught and has the expected message
      expect(caughtError).toBeDefined();
      expect(caughtError?.message).toContain("timeout after");
      expect(caughtError?.message).toContain("timeout-task");

      await manager.shutdown();
    } finally {
      await Deno.remove(tempFile);
    }
  },
});
*/

// NOTE: This test also commented out - WorkerManager no longer exists in actor-based architecture
/*
Deno.test({
  name: "WorkspaceRuntime should handle worker timeout errors gracefully",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // This test simulates the exact scenario from the logs where workspace-runtime
    // calls sendTask but doesn't handle the timeout error
    const manager = new WorkerManager();

    const testWorkerCode = `
    /// <reference no-default-lib="true" />
    /// <reference lib="deno.worker" />

    self.onmessage = (event) => {
      if (event.data.type === 'init') {
        self.postMessage({ type: 'initialized' });
      }
      // Never respond to task messages - simulates timeout
    };
  `;

    const tempFile = await Deno.makeTempFile({ suffix: ".ts" });
    await Deno.writeTextFile(tempFile, testWorkerCode);

    try {
      const _worker = await manager.spawnWorker(
        { id: "supervisor-worker", type: "supervisor" as const },
        new URL(`file://${tempFile}`).href,
      );

      // Wait for initialization
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // This simulates the exact call from WorkspaceRuntime.processSignal
      // that's causing the uncaught promise error
      let errorWasCaught = false;

      try {
        await manager.sendTask(
          "supervisor-worker",
          crypto.randomUUID(), // taskId
          {
            action: "processSignal",
            signal: {
              id: "test-signal",
              provider: "test",
            },
            payload: { test: "data" },
            sessionId: crypto.randomUUID(),
          },
          2000, // 2 second timeout for faster testing
        );
      } catch (error) {
        errorWasCaught = true;
        expect(error.message).toContain("timeout after");
      }

      // The error should be caught, not uncaught
      expect(errorWasCaught).toBe(true);

      await manager.shutdown();
    } finally {
      await Deno.remove(tempFile);
    }
  },
});
*/
