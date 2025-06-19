/**
 * Telemetry Test - Validates concurrent worker logging behavior
 *
 * This test validates the implementation of Phase 1.1 of the Worker Logging & Telemetry Enhancement Plan.
 * It ensures that multiple workers can safely write to the same log files without corruption.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { logger } from "../src/utils/logger.ts";

const TEST_WORKSPACE_ID = "test-workspace-telemetry";
const TEST_LOG_DIR = join(Deno.env.get("HOME") || Deno.cwd(), ".atlas", "logs");
const TEST_WORKSPACE_LOG = join(TEST_LOG_DIR, "workspaces", `${TEST_WORKSPACE_ID}.log`);

// Clean up test logs before and after tests
async function cleanupTestLogs() {
  try {
    await Deno.remove(TEST_WORKSPACE_LOG);
  } catch {
    // Ignore if file doesn't exist
  }
}

// Clean up logger resources with error handling
function cleanupLogger() {
  try {
    logger.close();
  } catch {
    // Ignore if already closed
  }
}

// Inline worker script for concurrent logging validation
const WORKER_SCRIPT = `
import { logger } from "${new URL("../src/utils/logger.ts", import.meta.url).href}";

// Listen for messages from main thread
self.addEventListener("message", async (event) => {
  const { workerId, messageCount, workspaceId } = event.data;
  
  const childLogger = logger.createChildLogger({
    workerId: workerId,
    workerType: "test-worker",
    workspaceId: workspaceId,
  });
  
  try {
    // Write multiple log messages rapidly to test concurrent access
    for (let i = 0; i < messageCount; i++) {
      await childLogger.info(\`Worker \${workerId} - Message \${i + 1}\`, {
        messageIndex: i + 1,
        timestamp: Date.now(),
      });
      
      // Small delay to allow interleaving
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    // Send completion message
    self.postMessage({ workerId, status: "completed" });
  } catch (error) {
    // Send error message
    self.postMessage({ 
      workerId, 
      status: "error", 
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

// Signal ready
self.postMessage({ status: "ready" });
`;

Deno.test({
  name: "Worker Logging - Concurrent Access",
  sanitizeResources: false, // Logger is initialized globally
  fn: async (t) => {
    await t.step("Setup - Clean test environment", async () => {
      await cleanupTestLogs();
      await ensureDir(join(TEST_LOG_DIR, "workspaces"));
    });

    await t.step("Single Worker - Logger Initialization", async () => {
      const blob = new Blob([WORKER_SCRIPT], { type: "application/javascript" });
      const workerUrl = URL.createObjectURL(blob);

      const worker = new Worker(workerUrl, { type: "module" });

      // Wait for worker to be ready
      const readyPromise = new Promise((resolve) => {
        worker.onmessage = (event) => {
          if (event.data.status === "ready") {
            resolve(event.data);
          }
        };
      });

      await readyPromise;

      // Test that worker can initialize logger and write logs
      const completionPromise = new Promise((resolve, reject) => {
        worker.onmessage = (event) => {
          if (event.data.status === "completed") {
            resolve(event.data);
          } else if (event.data.status === "error") {
            reject(new Error(event.data.error));
          }
        };
      });

      worker.postMessage({
        workerId: "test-worker-1",
        messageCount: 5,
        workspaceId: TEST_WORKSPACE_ID,
      });

      await completionPromise;
      worker.terminate();
      URL.revokeObjectURL(workerUrl);

      // Verify logs were written
      const logContent = await Deno.readTextFile(TEST_WORKSPACE_LOG);
      expect(logContent).toContain("Worker test-worker-1 - Message 1");
      expect(logContent).toContain("Worker test-worker-1 - Message 5");
    });

    await t.step("Multiple Workers - Concurrent Logging", async () => {
      const WORKER_COUNT = 3;
      const MESSAGES_PER_WORKER = 10;
      const workers: Worker[] = [];
      const completionPromises: Promise<unknown>[] = [];

      const blob = new Blob([WORKER_SCRIPT], { type: "application/javascript" });
      const workerUrl = URL.createObjectURL(blob);

      // Create multiple workers
      for (let i = 0; i < WORKER_COUNT; i++) {
        const worker = new Worker(workerUrl, { type: "module" });
        workers.push(worker);

        // Wait for worker ready
        await new Promise((resolve) => {
          worker.onmessage = (event) => {
            if (event.data.status === "ready") {
              resolve(event.data);
            }
          };
        });

        // Set up completion promise
        const completionPromise = new Promise((resolve, reject) => {
          worker.onmessage = (event) => {
            if (event.data.status === "completed") {
              resolve(event.data);
            } else if (event.data.status === "error") {
              reject(new Error(event.data.error));
            }
          };
        });
        completionPromises.push(completionPromise);
      }

      // Start all workers simultaneously
      for (let i = 0; i < workers.length; i++) {
        workers[i].postMessage({
          workerId: `concurrent-worker-${i + 1}`,
          messageCount: MESSAGES_PER_WORKER,
          workspaceId: TEST_WORKSPACE_ID,
        });
      }

      // Wait for all workers to complete
      await Promise.all(completionPromises);

      // Cleanup workers
      workers.forEach((worker) => worker.terminate());
      URL.revokeObjectURL(workerUrl);

      // Verify all messages were written without corruption
      const logContent = await Deno.readTextFile(TEST_WORKSPACE_LOG);
      const logLines = logContent.trim().split("\n");

      // Count messages from each worker
      const workerMessageCounts = new Map<string, number>();

      for (const line of logLines) {
        try {
          const logEntry = JSON.parse(line);
          if (logEntry.message?.includes("concurrent-worker-")) {
            const workerId = logEntry.context?.workerId;
            if (workerId) {
              workerMessageCounts.set(workerId, (workerMessageCounts.get(workerId) || 0) + 1);
            }
          }
        } catch {
          // Skip invalid JSON lines
        }
      }

      // Verify each worker wrote all its messages
      expect(workerMessageCounts.size).toBe(WORKER_COUNT);

      for (let i = 0; i < WORKER_COUNT; i++) {
        const workerId = `concurrent-worker-${i + 1}`;
        const messageCount = workerMessageCounts.get(workerId) || 0;
        expect(messageCount).toBe(MESSAGES_PER_WORKER);
      }
    });

    await t.step("Log File Integrity - No Corruption", async () => {
      // Read the log file and verify all entries are valid JSON
      const logContent = await Deno.readTextFile(TEST_WORKSPACE_LOG);
      const logLines = logContent.trim().split("\n");

      let validJsonCount = 0;
      let invalidJsonCount = 0;

      for (const line of logLines) {
        if (line.trim() === "") continue;

        try {
          const logEntry = JSON.parse(line);
          expect(logEntry.timestamp).toBeDefined();
          expect(logEntry.level).toBeDefined();
          expect(logEntry.message).toBeDefined();
          expect(logEntry.pid).toBeDefined();
          validJsonCount++;
        } catch (error) {
          console.error(`Invalid JSON line: ${line}`);
          console.error(`Parse error: ${error instanceof Error ? error.message : String(error)}`);
          invalidJsonCount++;
        }
      }

      expect(invalidJsonCount).toBe(0);
      console.log(`✅ All ${validJsonCount} log entries are valid JSON`);
    });

    await t.step("Performance - Write Latency", async () => {
      const testLogger = logger.createChildLogger({
        workerId: "perf-test",
        workerType: "performance-test",
        workspaceId: TEST_WORKSPACE_ID,
      });

      const MESSAGE_COUNT = 100;
      const startTime = Date.now();

      // Write messages rapidly
      for (let i = 0; i < MESSAGE_COUNT; i++) {
        await testLogger.info(`Performance test message ${i + 1}`, {
          messageIndex: i + 1,
        });
      }

      const totalTime = Date.now() - startTime;
      const avgLatency = totalTime / MESSAGE_COUNT;

      console.log(
        `📊 Performance: ${MESSAGE_COUNT} messages in ${totalTime}ms (${
          avgLatency.toFixed(2)
        }ms avg)`,
      );

      // Verify latency is reasonable (< 10ms per message as per success criteria)
      expect(avgLatency).toBeLessThan(10);
    });

    await t.step("Cleanup - Remove test logs", async () => {
      // Close logger file handles to prevent leaks
      cleanupLogger();
      await cleanupTestLogs();
    });
  },
});

Deno.test({
  name: "Logger Context Propagation",
  sanitizeResources: false, // Logger is initialized globally
  fn: async (t) => {
    await t.step("Child Logger Context", async () => {
      // Create child logger with additional context
      const childLogger = logger.createChildLogger({
        workerId: "parent-worker",
        workerType: "context-test",
        workspaceId: "context-workspace",
        agentId: "test-agent",
        sessionId: "test-session",
      });

      await childLogger.info("Test context propagation");

      // Read logs and verify context is present
      const logs = await logger.readLogs("context-workspace", 10);
      const lastLog = logs[logs.length - 1];
      const logEntry = JSON.parse(lastLog);

      expect(logEntry.context?.workerId).toBe("parent-worker");
      expect(logEntry.context?.workerType).toBe("context-test");
      expect(logEntry.context?.workspaceId).toBe("context-workspace");
      expect(logEntry.context?.agentId).toBe("test-agent");
      expect(logEntry.context?.sessionId).toBe("test-session");
    });
  },
});

Deno.test({
  name: "Error Handling - Fallback Behavior",
  sanitizeResources: false, // Logger is initialized globally
  fn: async (t) => {
    await t.step("Graceful Degradation", async () => {
      // This test ensures that if file writing fails, the system gracefully falls back
      // We can't easily simulate file write failures, but we can test the logger handles
      // various edge cases gracefully

      const testLogger = logger.createChildLogger({
        workerId: "error-test",
        workerType: "error-handling",
        workspaceId: "error-workspace",
      });

      // Test with various message types
      await testLogger.info("Normal message");
      await testLogger.warn("Warning message");
      await testLogger.error("Error message");
      await testLogger.debug("Debug message");
      await testLogger.trace("Trace message");

      // Test with complex objects
      await testLogger.info("Complex object test", {
        nested: {
          object: "value",
          array: [1, 2, 3],
          nullValue: null,
          undefinedValue: undefined,
        },
      });

      // Verify logs were written successfully
      const logs = await logger.readLogs("error-workspace", 10);
      expect(logs.length).toBeGreaterThanOrEqual(6);
    });
  },
});
