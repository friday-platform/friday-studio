import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { WorkspaceManager, WorkspaceStatus } from "../../src/core/workspace-manager.ts";

const testTimeout = 10000; // 10 seconds

Deno.test({
  name: "WorkspaceManager - Basic operations",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const manager = new WorkspaceManager();

    // Cleanup function
    const cleanup = async () => {
      await manager.close();
    };

    await t.step("should initialize successfully", async () => {
      await manager.initialize();
    });

    await t.step("should list empty workspaces initially", async () => {
      const workspaces = await manager.listWorkspaces();
      assertEquals(Array.isArray(workspaces), true);
    });

    await t.step("should create a new workspace", async () => {
      const result = await manager.createWorkspace({
        name: "test-workspace-manager",
        description: "Test workspace for WorkspaceManager",
      });

      assertExists(result.id);
      assertEquals(result.name, "test-workspace-manager");

      // Verify it exists
      const workspace = await manager.findById(result.id);
      assertExists(workspace);
      assertEquals(workspace.name, "test-workspace-manager");
    });

    await t.step("should find workspace by name", async () => {
      const workspace = await manager.findByName("test-workspace-manager");
      assertExists(workspace);
      assertEquals(workspace.name, "test-workspace-manager");
    });

    await t.step("should list workspaces including the new one", async () => {
      const workspaces = await manager.listWorkspaces();
      const testWorkspace = workspaces.find((w) => w.name === "test-workspace-manager");
      assertExists(testWorkspace);
      assertEquals(testWorkspace.hasActiveRuntime, false);
    });

    await t.step("should track runtime registration", async () => {
      // Find our test workspace
      const workspace = await manager.findByName("test-workspace-manager");
      assertExists(workspace);

      // Simulate runtime registration (we can't create a real runtime in tests)
      const mockRuntime = {
        getState: () => "running",
        getSessions: () => [],
        getWorkers: () => [],
        shutdown: async () => {},
      } as any;

      manager.registerRuntime(workspace.id, mockRuntime, {} as any, {
        name: workspace.name,
        description: workspace.metadata?.description,
      });

      // Verify runtime is tracked
      assertEquals(manager.isRuntimeActive(workspace.id), true);
      assertEquals(manager.getActiveRuntimeCount(), 1);

      // List should show active runtime
      const workspaces = await manager.listWorkspaces();
      const testWorkspace = workspaces.find((w) => w.name === "test-workspace-manager");
      assertExists(testWorkspace);
      assertEquals(testWorkspace.hasActiveRuntime, true);

      // Unregister runtime
      manager.unregisterRuntime(workspace.id);
      assertEquals(manager.isRuntimeActive(workspace.id), false);
      assertEquals(manager.getActiveRuntimeCount(), 0);
    });

    await t.step("should delete workspace", async () => {
      const workspace = await manager.findByName("test-workspace-manager");
      assertExists(workspace);

      await manager.deleteWorkspace(workspace.id, true);

      // Verify it's gone
      const deletedWorkspace = await manager.findById(workspace.id);
      assertEquals(deletedWorkspace, null);
    });

    await t.step("cleanup", async () => {
      await cleanup();
    });
  },
});

Deno.test({
  name: "WorkspaceManager - Workspace discovery",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const manager = new WorkspaceManager();

    // Cleanup function
    const cleanup = async () => {
      await manager.close();
    };

    await t.step("should discover workspaces", async () => {
      await manager.initialize();

      // This should find workspaces in the examples directory
      const discovered = await manager.discoverWorkspaces();
      assertEquals(Array.isArray(discovered), true);

      // Should find at least some example workspaces
      console.log(`Discovered ${discovered.length} workspaces`);
    });

    await t.step("should import existing workspaces", async () => {
      const imported = await manager.importExistingWorkspaces();
      assertEquals(typeof imported, "number");
      console.log(`Imported ${imported} workspaces`);
    });

    await t.step("cleanup", async () => {
      await cleanup();
    });
  },
});
