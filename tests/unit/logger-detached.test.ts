import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { AtlasLogger } from "../../src/utils/logger.ts";

Deno.test("AtlasLogger - detached mode", async (t) => {
  const tempDir = await Deno.makeTempDir();
  const logFile = join(tempDir, "test-detached.log");

  // Temporarily disable test mode to allow file logging
  const originalTestMode = Deno.env.get("DENO_TESTING");
  Deno.env.delete("DENO_TESTING");

  // Reset logger AFTER changing env var to ensure clean state
  AtlasLogger.resetInstance();

  try {
    await t.step("should write logs to file in detached mode", async () => {
      // Get a fresh logger instance
      const logger = AtlasLogger.getInstance();

      // Initialize in detached mode
      await logger.initializeDetached(logFile);

      // Write some test logs
      await logger.info("Test info message");
      await logger.warn("Test warning message", { testContext: "value" });
      await logger.error("Test error message");

      // Close to ensure writes are flushed
      await logger.close();

      // Read the log file
      const content = await Deno.readTextFile(logFile);
      const lines = content.trim().split("\n");

      // Should have 4 lines (startup + 3 test logs)
      assertEquals(lines.length, 4);

      // Parse and verify each line
      const entries = lines.map((line) => JSON.parse(line));

      // First entry should be startup message
      assertEquals(entries[0].level, "info");
      assertEquals(entries[0].message, "Workspace starting in detached mode");
      assertExists(entries[0].context?.mode);
      assertEquals(entries[0].context.mode, "detached");

      // Test messages
      assertEquals(entries[1].level, "info");
      assertEquals(entries[1].message, "Test info message");

      assertEquals(entries[2].level, "warn");
      assertEquals(entries[2].message, "Test warning message");
      assertEquals(entries[2].context?.testContext, "value");

      assertEquals(entries[3].level, "error");
      assertEquals(entries[3].message, "Test error message");
    });

    await t.step("should not output to console in detached mode", async () => {
      // This is hard to test directly, but we can verify the logger state
      const logger = AtlasLogger.getInstance();

      // Create a new log file for this test
      const logFile2 = join(tempDir, "test-detached-2.log");
      await logger.initializeDetached(logFile2);

      // Write a log (if console output was happening, we'd see it in test output)
      await logger.info("This should not appear in console");

      await logger.close();

      // Verify it was written to file
      const content = await Deno.readTextFile(logFile2);
      const lines = content.trim().split("\n");
      assertEquals(lines.length, 2); // startup + test message
    });
  } finally {
    // Cleanup
    await AtlasLogger.getInstance().close();

    // Restore test mode
    if (originalTestMode) {
      Deno.env.set("DENO_TESTING", originalTestMode);
    }

    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("AtlasLogger - normal mode after detached", async () => {
  const tempDir = await Deno.makeTempDir();
  const detachedLog = join(tempDir, "detached.log");

  // Temporarily disable test mode to allow file logging
  const originalTestMode = Deno.env.get("DENO_TESTING");
  Deno.env.delete("DENO_TESTING");

  // Reset logger AFTER changing env var to ensure clean state
  AtlasLogger.resetInstance();

  try {
    const logger = AtlasLogger.getInstance();

    // First use detached mode
    await logger.initializeDetached(detachedLog);
    await logger.info("Detached message");
    await logger.close();

    // Then use normal mode
    await logger.initialize();
    await logger.info("Normal message");
    await logger.close();

    // The normal message should have gone to the global log, not the detached log
    const detachedContent = await Deno.readTextFile(detachedLog);
    const detachedLines = detachedContent.trim().split("\n");

    // Detached log should only have 2 entries (startup + detached message)
    assertEquals(detachedLines.length, 2);
  } finally {
    await AtlasLogger.getInstance().close();

    // Restore test mode
    if (originalTestMode) {
      Deno.env.set("DENO_TESTING", originalTestMode);
    }

    await Deno.remove(tempDir, { recursive: true });
  }
});
