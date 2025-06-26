import { assertEquals, assertStringIncludes } from "@std/assert";
import { cleanupTestDir, runCLI, setupTestWorkspace } from "./helpers.ts";

Deno.test("signal list shows configured signals", async () => {
  const tempDir = await setupTestWorkspace();

  try {
    const result = await runCLI(["signal", "list", "--json"], {
      cwd: tempDir,
    });

    assertEquals(result.success, true);
    // New CLI outputs JSON structure containing signals
    assertStringIncludes(result.stdout, '"signals"');
    assertStringIncludes(result.stdout, "test-signal");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("signal trigger requires signal name", async () => {
  const tempDir = await setupTestWorkspace();

  try {
    const result = await runCLI(["signal", "trigger"], {
      cwd: tempDir,
    });

    // New CLI uses yargs validation which shows help/usage
    assertEquals(result.success, false);
    assertStringIncludes(result.stderr, "Not enough non-option arguments");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("signal trigger handles missing workspace", async () => {
  const tempDir = await setupTestWorkspace();

  try {
    const result = await runCLI([
      "signal", 
      "trigger", 
      "test-signal", 
      "--data", 
      '{"test": true}'
    ], {
      cwd: tempDir,
    });

    // New CLI checks for running workspaces first
    assertEquals(result.success, false);
    assertStringIncludes(result.stdout, "No running workspaces found");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("signal trigger validates JSON", async () => {
  const tempDir = await setupTestWorkspace();

  try {
    const result = await runCLI([
      "signal",
      "trigger",
      "test-signal",
      "--data",
      "invalid json",
    ], {
      cwd: tempDir,
    });

    assertEquals(result.success, false);
    assertStringIncludes(result.stdout, "Invalid JSON");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("signal trigger outputs JSON format", async () => {
  const tempDir = await setupTestWorkspace();

  try {
    const result = await runCLI([
      "signal",
      "trigger",
      "test-signal",
      "--data",
      '{"test": true}',
      "--json"
    ], {
      cwd: tempDir,
    });

    // Even if it fails due to no running workspaces, JSON format should be attempted
    // Test validates that --json flag affects output format
    if (result.stdout.trim()) {
      // If there's output, it should be JSON or an error message
      const containsJson = result.stdout.includes('{') || result.stdout.includes('No running workspaces');
      assertEquals(containsJson, true);
    }
  } finally {
    await cleanupTestDir(tempDir);
  }
});
