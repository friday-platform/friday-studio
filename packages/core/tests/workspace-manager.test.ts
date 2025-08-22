import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { WorkspaceManager, WorkspaceStatusEnum } from "@atlas/workspace";
import type { WorkspaceStatus } from "@atlas/workspace";
import { createKVStorage, StorageConfigs } from "../../../src/core/storage/index.ts";
import { RegistryStorageAdapter } from "../../../src/core/storage/registry-storage-adapter.ts";

// Set DENO_TESTING to disable logging during tests
Deno.env.set("DENO_TESTING", "true");

// Test helpers
async function createTestManager(): Promise<{
  manager: WorkspaceManager;
  registry: RegistryStorageAdapter;
  cleanup: () => Promise<void>;
}> {
  // Create an in-memory KV store for testing
  const storage = await createKVStorage(StorageConfigs.memory());
  const registry = new RegistryStorageAdapter(storage);
  await registry.initialize();

  const manager = new WorkspaceManager(registry);

  return {
    manager,
    registry,
    cleanup: async () => {
      await manager.close();
    },
  };
}

// Get test fixtures path
const fixturesPath = join(import.meta.dirname!, "fixtures");
const testWorkspacePath = join(fixturesPath, "test-workspace");

Deno.test("WorkspaceManager - System workspace registration", async () => {
  const { manager, cleanup } = await createTestManager();

  try {
    // Initialize with system workspace registration
    await manager.initialize({
      autoImport: false,
      registerSystemWorkspaces: true,
    });

    // Check that system workspaces are registered
    const systemWorkspaces = await manager.list({ includeSystem: true });
    const conversationWorkspace = systemWorkspaces.find((w) => w.id === "atlas-conversation");

    assertExists(conversationWorkspace);
    assertEquals(conversationWorkspace.name, "atlas-conversation");
    assertEquals(conversationWorkspace.path, "system://atlas-conversation");
    assertEquals(conversationWorkspace.metadata?.system, true);
    assertEquals(conversationWorkspace.status, "inactive");

    // Verify system workspaces are excluded by default
    const userWorkspaces = await manager.list();
    assertEquals(userWorkspaces.filter((w) => w.metadata?.system).length, 0);
  } finally {
    await cleanup();
  }
});

Deno.test("WorkspaceManager - Register filesystem workspace", async () => {
  const { manager, cleanup } = await createTestManager();

  try {
    await manager.initialize({
      autoImport: false,
      registerSystemWorkspaces: false,
    });

    // Register a test workspace
    const workspace = await manager.registerWorkspace(testWorkspacePath, {
      tags: ["test", "example"],
    });

    assertExists(workspace);
    assertEquals(workspace.name, "Test Workspace");
    assertEquals(workspace.path, await Deno.realPath(testWorkspacePath));
    assertEquals(workspace.metadata?.description, "A test workspace for unit tests");
    assertEquals(workspace.metadata?.tags, ["test", "example"]);
    assertExists(workspace.configHash);

    // Verify it appears in list
    const workspaces = await manager.list();
    assertEquals(workspaces.length, 1);
    assertEquals(workspaces[0].id, workspace.id);

    // Test idempotency - registering again returns same workspace
    const workspace2 = await manager.registerWorkspace(testWorkspacePath);
    assertEquals(workspace2.id, workspace.id);
  } finally {
    await cleanup();
  }
});

Deno.test("WorkspaceManager - Find workspace by different criteria", async () => {
  const { manager, cleanup } = await createTestManager();

  try {
    await manager.initialize({
      autoImport: false,
      registerSystemWorkspaces: false,
    });

    const workspace = await manager.registerWorkspace(testWorkspacePath);

    // Find by ID
    const byId = await manager.find({ id: workspace.id });
    assertExists(byId);
    assertEquals(byId.id, workspace.id);

    // Find by name
    const byName = await manager.find({ name: "Test Workspace" });
    assertExists(byName);
    assertEquals(byName.id, workspace.id);

    // Find by path
    const byPath = await manager.find({ path: testWorkspacePath });
    assertExists(byPath);
    assertEquals(byPath.id, workspace.id);

    // Find non-existent
    const notFound = await manager.find({ id: "non-existent" });
    assertEquals(notFound, null);
  } finally {
    await cleanup();
  }
});

Deno.test("WorkspaceManager - Load workspace configuration", async () => {
  const { manager, cleanup } = await createTestManager();

  try {
    await manager.initialize({
      autoImport: false,
      registerSystemWorkspaces: true,
    });

    // Test loading system workspace config
    const systemConfig = await manager.getWorkspaceConfig("atlas-conversation");
    assertExists(systemConfig);
    assertEquals(systemConfig.workspace.workspace.name, "atlas-conversation");
    assertExists(systemConfig.workspace);
    assertExists(systemConfig.workspace.signals);
    assertExists(systemConfig.workspace.jobs);
    assertExists(systemConfig.workspace.agents);

    // Register and load filesystem workspace config
    const workspace = await manager.registerWorkspace(testWorkspacePath);
    const config = await manager.getWorkspaceConfig(workspace.id);

    assertExists(config);
    assertEquals(config.workspace.workspace.name, "Test Workspace");
    assertExists(config.workspace.signals);
    assertExists(config.workspace.jobs);
    assertExists(config.workspace.agents);

    // Test non-existent workspace
    const notFound = await manager.getWorkspaceConfig("non-existent");
    assertEquals(notFound, null);
  } finally {
    await cleanup();
  }
});

Deno.test("WorkspaceManager - Delete workspace", async () => {
  const { manager, cleanup } = await createTestManager();

  try {
    await manager.initialize({
      autoImport: false,
      registerSystemWorkspaces: true,
    });

    // Register a workspace
    const workspace = await manager.registerWorkspace(testWorkspacePath);

    // Delete it
    await manager.deleteWorkspace(workspace.id);

    // Verify it's gone
    const found = await manager.find({ id: workspace.id });
    assertEquals(found, null);

    const workspaces = await manager.list();
    assertEquals(workspaces.length, 0);

    // Test deleting non-existent workspace
    await assertRejects(
      () => manager.deleteWorkspace("non-existent"),
      Error,
      "Workspace not found",
    );

    // Test system workspace deletion protection
    await assertRejects(
      () => manager.deleteWorkspace("atlas-conversation"),
      Error,
      "Cannot delete system workspace",
    );

    // Test force deletion of system workspace
    await manager.deleteWorkspace("atlas-conversation", { force: true });
    const systemWorkspace = await manager.find({ id: "atlas-conversation" });
    assertEquals(systemWorkspace, null);
  } finally {
    await cleanup();
  }
});

Deno.test("WorkspaceManager - Runtime management", async () => {
  const { manager, cleanup } = await createTestManager();

  try {
    await manager.initialize({
      autoImport: false,
      registerSystemWorkspaces: false,
    });

    const workspace = await manager.registerWorkspace(testWorkspacePath);

    // Initially no runtime
    assertEquals(manager.getActiveRuntimeCount(), 0);
    assertEquals(manager.getRuntime(workspace.id), undefined);

    // Create a mock runtime
    const mockRuntime = {
      shutdown: () => Promise.resolve(),
      getState: () => "running",
      getSessions: () => [],
      getWorkers: () => [],
    };

    // Register runtime
    await manager.registerRuntime(workspace.id, mockRuntime);

    assertEquals(manager.getActiveRuntimeCount(), 1);
    assertExists(manager.getRuntime(workspace.id));
    assertEquals(manager.getRuntime(workspace.id), mockRuntime);

    // Unregister runtime
    await manager.unregisterRuntime(workspace.id);
    assertEquals(manager.getActiveRuntimeCount(), 0);
    assertEquals(manager.getRuntime(workspace.id), undefined);
  } finally {
    await cleanup();
  }
});

Deno.test("WorkspaceManager - List with filtering", async () => {
  const { manager, registry, cleanup } = await createTestManager();

  try {
    await manager.initialize({
      autoImport: false,
      registerSystemWorkspaces: true,
    });

    // Register multiple workspaces
    const workspace1 = await manager.registerWorkspace(testWorkspacePath);

    // Create another test workspace
    const testWorkspace2Path = join(fixturesPath, "test-workspace-2");
    await Deno.mkdir(testWorkspace2Path, { recursive: true });
    await Deno.writeTextFile(
      join(testWorkspace2Path, "workspace.yml"),
      `version: "1.0"
workspace:
  id: "test-2"
  name: "Test Workspace 2"`,
    );

    const workspace2 = await manager.registerWorkspace(testWorkspace2Path);

    try {
      // List all user workspaces (no system)
      const userWorkspaces = await manager.list();
      assertEquals(userWorkspaces.length, 2);

      // List with system workspaces
      const allWorkspaces = await manager.list({ includeSystem: true });
      assertEquals(allWorkspaces.filter((w) => w.metadata?.system).length, 1);
      assertEquals(allWorkspaces.filter((w) => !w.metadata?.system).length, 2);

      // Update status and filter by it
      await registry.updateWorkspaceStatus(workspace1.id, WorkspaceStatusEnum.RUNNING);

      const runningWorkspaces = await manager.list({ status: WorkspaceStatusEnum.RUNNING });
      assertEquals(runningWorkspaces.length, 1);
      assertEquals(runningWorkspaces[0].id, workspace1.id);

      const inactiveWorkspaces = await manager.list({ status: WorkspaceStatusEnum.INACTIVE });
      assertEquals(inactiveWorkspaces.length, 1);
      assertEquals(inactiveWorkspaces[0].id, workspace2.id);
    } finally {
      // Cleanup test workspace 2
      try {
        await Deno.remove(testWorkspace2Path, { recursive: true });
      } catch {
        // Ignore if already removed
      }
    }
  } finally {
    await cleanup();
  }
});
