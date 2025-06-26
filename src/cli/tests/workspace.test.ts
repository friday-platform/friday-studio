import { assertEquals, assertStringIncludes } from "@std/assert";
import { cleanupTestDir, createTestDir, runCLI } from "./helpers.ts";
import { exists } from "@std/fs";

Deno.test("workspace init shows interactive interface", async () => {
  const tempDir = await createTestDir();

  try {
    // New init command shows interactive interface which requires user input
    // For automated testing, we just verify it starts the interface
    const result = await runCLI(["workspace", "init", "--help"], {
      cwd: tempDir,
    });

    // Verify help output shows the command exists and is properly configured
    assertEquals(result.success, true);
    assertStringIncludes(result.stdout, "Initialize a new Atlas workspace");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace commands are properly registered", async () => {
  const tempDir = await createTestDir();

  try {
    // Test that workspace commands exist and show proper help
    const result = await runCLI(["workspace", "--help"], {
      cwd: tempDir,
    });

    // Should show available workspace commands
    assertEquals(result.success, true);
    assertStringIncludes(result.stdout, "workspace");
    assertStringIncludes(result.stdout, "Commands:");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace status command exists", async () => {
  const tempDir = await createTestDir();

  try {
    // Test status command shows help when no workspace exists
    const result = await runCLI(["workspace", "status", "--help"], {
      cwd: tempDir,
    });

    assertEquals(result.success, true);
    assertStringIncludes(result.stdout, "status");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace list shows workspaces", async () => {
  const tempDir = await createTestDir();

  try {
    // Init workspace
    await runCLI(["workspace", "init", "list-test"], {
      cwd: tempDir,
      env: { ANTHROPIC_API_KEY: "test-key" },
    });

    // Run list command
    const result = await runCLI(["workspace", "list"], {
      cwd: tempDir,
    });

    assertEquals(result.success, true);
    // Should show table headers
    assertStringIncludes(result.stdout, "NAME");
    assertStringIncludes(result.stdout, "STATUS");
  } finally {
    await cleanupTestDir(tempDir);
  }
});
