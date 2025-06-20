import { assertEquals, assertStringIncludes } from "@std/assert";
import { cleanupTestDir, createTestDir, runCLI } from "../../tests/helpers.ts";
import { join } from "@std/path";
import * as yaml from "@std/yaml";

Deno.test("workspace status - shows error when workspace not found by id", async () => {
  const tempDir = await createTestDir();

  try {
    const result = await runCLI(["workspace", "status", "nonexistent-id"], {
      cwd: tempDir,
    });

    // Note: React CLI components don't exit with error code, they just display error text
    assertEquals(result.success, true);
    assertStringIncludes(result.stdout, "Error: Workspace 'nonexistent-id' not found");
    assertStringIncludes(result.stdout, "Use 'atlas workspace list' to see");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace status - shows error when no workspace in current directory", async () => {
  const tempDir = await createTestDir();

  try {
    const result = await runCLI(["workspace", "status"], {
      cwd: tempDir,
    });

    // Note: React CLI components don't exit with error code, they just display error text
    assertEquals(result.success, true);
    assertStringIncludes(result.stdout, "No workspace found in current directory");
    assertStringIncludes(result.stdout, "atlas workspace init");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace status - shows status for current workspace", async () => {
  const tempDir = await createTestDir();

  try {
    // Initialize workspace first
    await runCLI(["workspace", "init", "StatusTest", "."], {
      cwd: tempDir,
      env: { ANTHROPIC_API_KEY: "test-key" },
    });

    // Run status command from workspace directory
    const result = await runCLI(["workspace", "status"], {
      cwd: tempDir,
    });

    assertEquals(result.success, true);
    assertStringIncludes(result.stdout, "Workspace Status");
    assertStringIncludes(result.stdout, "StatusTest");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace status - handles workspace not registered error", async () => {
  const tempDir = await createTestDir();

  try {
    // Create workspace.yml without registering
    const workspaceYml = {
      version: "1.0",
      workspace: {
        id: "unregistered-id",
        name: "UnregisteredWorkspace",
        description: "Unregistered workspace",
      },
      signals: {},
      jobs: {},
      agents: {},
    };

    await Deno.writeTextFile(
      join(tempDir, "workspace.yml"),
      yaml.stringify(workspaceYml),
    );

    // Run status command
    const result = await runCLI(["workspace", "status"], {
      cwd: tempDir,
    });

    // Note: React CLI components don't exit with error code, they just display error text
    assertEquals(result.success, true);
    assertStringIncludes(result.stdout, "Workspace exists but is not registered");
    assertStringIncludes(result.stdout, "atlas workspace init");
  } finally {
    await cleanupTestDir(tempDir);
  }
});
