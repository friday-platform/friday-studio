import { assertEquals, assertStringIncludes } from "@std/assert";
import { cleanupTestDir, createTestDir, runCLI } from "./helpers.ts";
import { exists } from "@std/fs";

Deno.test("workspace init creates workspace.yml", async () => {
  const tempDir = await createTestDir();

  try {
    // Run init command
    const result = await runCLI(["workspace", "init", "test-workspace"], {
      cwd: tempDir,
      env: { ANTHROPIC_API_KEY: "test-key" },
    });

    // Check output
    assertEquals(result.success, true);
    assertStringIncludes(result.stdout, "Workspace initialized successfully");

    // Check workspace.yml was created
    const workspaceYmlExists = await exists(`${tempDir}/workspace.yml`);
    assertEquals(workspaceYmlExists, true);

    // Check .atlas directory was created
    const atlasExists = await exists(`${tempDir}/.atlas`);
    assertEquals(atlasExists, true);

    // Check .env was created
    const envExists = await exists(`${tempDir}/.env`);
    assertEquals(envExists, true);
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace init detects existing workspace.yml", async () => {
  const tempDir = await createTestDir();

  try {
    // Create existing workspace.yml
    await Deno.writeTextFile(
      `${tempDir}/workspace.yml`,
      `
version: "1.0"
workspace:
  name: "Existing Workspace"
`,
    );

    // Run init command
    const result = await runCLI(["workspace", "init"], {
      cwd: tempDir,
    });

    // Should detect existing workspace
    assertEquals(result.success, true);
    assertStringIncludes(result.stdout, "Workspace already initialized");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace status shows workspace info", async () => {
  const tempDir = await createTestDir();

  try {
    // First init workspace
    await runCLI(["workspace", "init", "status-test"], {
      cwd: tempDir,
      env: { ANTHROPIC_API_KEY: "test-key" },
    });

    // Run status command
    const result = await runCLI(["workspace", "status"], {
      cwd: tempDir,
    });

    assertEquals(result.success, true);
    assertStringIncludes(result.stdout, "Workspace Status");
    assertStringIncludes(result.stdout, "Name:");
    assertStringIncludes(result.stdout, "status-test");
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
