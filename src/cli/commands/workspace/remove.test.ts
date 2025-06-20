import { assertEquals, assertStringIncludes } from "@std/assert";
import { cleanupTestDir, createTestDir, runCLI } from "../../tests/helpers.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { WorkspaceStatus as WSStatus } from "../../../core/workspace-registry-types.ts";

Deno.test("workspace remove - shows error when no workspace id or name provided", async () => {
  const tempDir = await createTestDir();

  try {
    const result = await runCLI(["workspace", "remove"], {
      cwd: tempDir,
    });

    // Note: React CLI components don't exit with error code, they just display error text
    assertEquals(result.success, true);
    assertStringIncludes(result.stdout, "Error: Workspace ID or name is required");
    assertStringIncludes(result.stdout, "atlas workspace remove");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace remove - shows error when workspace not found", async () => {
  const tempDir = await createTestDir();

  try {
    const result = await runCLI(["workspace", "remove", "nonexistent-workspace"], {
      cwd: tempDir,
    });

    // Note: React CLI components don't exit with error code, they just display error text
    assertEquals(result.success, true);
    assertStringIncludes(result.stdout, "Error: Workspace 'nonexistent-workspace' not found");
    assertStringIncludes(result.stdout, "atlas workspace list");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace remove - removes stopped workspace successfully", async () => {
  const tempDir = await createTestDir();

  try {
    // Initialize workspace first
    await runCLI(["workspace", "init", "RemoveTest", "."], {
      cwd: tempDir,
      env: { ANTHROPIC_API_KEY: "test-key" },
    });

    // Remove the workspace
    const result = await runCLI(["workspace", "remove", "RemoveTest"], {
      cwd: tempDir,
    });

    assertEquals(result.success, true);
    assertStringIncludes(result.stdout, "✓ Workspace removed from registry");
    assertStringIncludes(result.stdout, "Name: RemoveTest");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace remove - shows error when removing running workspace without force", async () => {
  const tempDir = await createTestDir();

  try {
    // Initialize workspace first
    await runCLI(["workspace", "init", "RunningRemove", "."], {
      cwd: tempDir,
      env: { ANTHROPIC_API_KEY: "test-key" },
    });

    // Get the registered workspace and mark as running
    const registry = getWorkspaceRegistry();
    await registry.initialize();
    const workspace = await registry.findByName("RunningRemove");

    if (workspace) {
      await registry.updateStatus(workspace.id, WSStatus.RUNNING, {
        port: 8080,
        pid: Deno.pid, // Use current process ID so it's actually running
      });
    }

    // Try to remove without force
    const result = await runCLI(["workspace", "remove", "RunningRemove"], {
      cwd: tempDir,
    });

    // Note: React CLI components don't exit with error code, they just display error text
    assertEquals(result.success, true);
    assertStringIncludes(result.stdout, "Error: Cannot remove running workspace");
    assertStringIncludes(result.stdout, "atlas workspace stop");
    assertStringIncludes(result.stdout, "or use --force flag");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace remove - removes running workspace with force flag", async () => {
  const tempDir = await createTestDir();

  try {
    // Initialize workspace first
    await runCLI(["workspace", "init", "ForceRemove", "."], {
      cwd: tempDir,
      env: { ANTHROPIC_API_KEY: "test-key" },
    });

    // Get the registered workspace and mark as running
    const registry = getWorkspaceRegistry();
    await registry.initialize();
    const workspace = await registry.findByName("ForceRemove");

    if (workspace) {
      await registry.updateStatus(workspace.id, WSStatus.RUNNING, {
        port: 8080,
        pid: Deno.pid, // Use current process ID so it's actually running
      });
    }

    // Remove with force flag
    const result = await runCLI(["workspace", "remove", "ForceRemove", "--force"], {
      cwd: tempDir,
    });

    assertEquals(result.success, true);
    assertStringIncludes(result.stdout, "✓ Workspace removed from registry");
    assertStringIncludes(result.stdout, "Name: ForceRemove");
  } finally {
    await cleanupTestDir(tempDir);
  }
});
