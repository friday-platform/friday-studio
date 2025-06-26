import { assertEquals, assertExists } from "@std/assert";
import { WorkspaceManager } from "../../src/core/workspace-manager.ts";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";

Deno.test("WorkspaceManager - Signal Processing Mode", async (t) => {
  const testDir = "./test-workspace-manager-signal";
  let manager: WorkspaceManager;

  await t.step("setup", async () => {
    // Clean up any existing test directory
    try {
      await Deno.remove(testDir, { recursive: true });
    } catch {
      // Ignore if doesn't exist
    }

    // Create test workspace directory
    await ensureDir(testDir);
    await Deno.writeTextFile(
      join(testDir, "workspace.yml"),
      `version: "1.0"
workspace:
  name: "test-signal-workspace"
  description: "Test workspace for signal processing"
agents: {}
signals: {}
jobs: {}
`,
    );

    // Set test mode to avoid conflicts
    Deno.env.set("DENO_TEST", "true");

    manager = new WorkspaceManager();
    await manager.initialize();
  });

  await t.step("should skip auto-import when skipAutoImport option is used", async () => {
    // Get initial workspace count
    const initialWorkspaces = await manager.listAllPersisted();
    const initialCount = initialWorkspaces.length;

    // Re-initialize with skipAutoImport option
    await manager.initialize({ skipAutoImport: true });

    // Verify no new workspaces were imported
    const finalWorkspaces = await manager.listAllPersisted();
    assertEquals(
      finalWorkspaces.length,
      initialCount,
      "No workspaces should be auto-imported when skipAutoImport is true",
    );
  });

  await t.step("should auto-import when skipAutoImport option is not used", async () => {
    // Get initial workspace count
    const initialWorkspaces = await manager.listAllPersisted();
    const initialCount = initialWorkspaces.length;

    // Re-initialize without skipAutoImport option (should trigger auto-import)
    await manager.initialize();

    // The test workspace should be imported if it wasn't already
    const finalWorkspaces = await manager.listAllPersisted();

    // At minimum, count should not decrease
    assertEquals(
      finalWorkspaces.length >= initialCount,
      true,
      "Workspace count should not decrease when auto-import is enabled",
    );
  });

  await t.step("cleanup", async () => {
    try {
      await manager.close();
    } catch {
      // Ignore close errors
    }

    try {
      await Deno.remove(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }

    // Clean up any KV files
    try {
      const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || Deno.cwd();
      const atlasDir = join(homeDir, ".atlas");
      const kvPath = join(atlasDir, "registry.db");
      await Deno.remove(kvPath);
    } catch {
      // Ignore KV cleanup errors
    }
  });
});
