import { assertEquals, assertRejects } from "@std/assert";
import { PlatformMCPServer } from "../../src/core/mcp/platform-mcp-server.ts";
import { WorkspaceRegistryManager } from "../../src/core/workspace-registry.ts";
import { ConfigLoader } from "../../src/core/config-loader.ts";

Deno.test("MCP Platform Server - Workspace Operations", async (t) => {
  let mcpServer: PlatformMCPServer;
  let workspaceRegistry: WorkspaceRegistryManager;

  await t.step("setup", async () => {
    // Create test workspace registry
    workspaceRegistry = new WorkspaceRegistryManager();
    await workspaceRegistry.initialize();

    // Load test atlas config
    const configLoader = new ConfigLoader();
    const mergedConfig = await configLoader.load();
    const atlasConfig = mergedConfig.atlas;

    // Check if registry has required methods
    console.log("Registry has listWorkspaces:", typeof workspaceRegistry.listWorkspaces);
    console.log("Registry prototype methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(workspaceRegistry)));

    // Create MCP server
    mcpServer = new PlatformMCPServer({
      workspaceRegistry,
      atlasConfig,
    });
  });

  await t.step("workspace_list tool exists", () => {
    const tools = mcpServer.getAvailableTools();
    console.log("Available tools:", tools);
    assertEquals(tools.includes("workspace_list"), true);
  });

  await t.step("can call listWorkspaces directly", async () => {
    const workspaces = await workspaceRegistry.listWorkspaces();
    console.log("Direct call result:", workspaces);
    assertEquals(Array.isArray(workspaces), true);
  });

  await t.step("test workspace_create", async () => {
    const testWorkspaceName = `test-workspace-${Date.now()}`;
    
    try {
      const result = await workspaceRegistry.createWorkspace({
        name: testWorkspaceName,
        description: "Test workspace for MCP integration test",
      });
      
      assertEquals(typeof result.id, "string");
      assertEquals(result.name, testWorkspaceName);
      
      // Clean up
      await workspaceRegistry.deleteWorkspace(result.id, true);
    } catch (error) {
      console.error("Create workspace test failed:", error);
      throw error;
    }
  });

  await t.step("test workspace_list after create", async () => {
    const testWorkspaceName = `test-list-workspace-${Date.now()}`;
    
    // Create a workspace
    const created = await workspaceRegistry.createWorkspace({
      name: testWorkspaceName,
      description: "Test workspace for list test",
    });
    
    // List workspaces
    const workspaces = await workspaceRegistry.listWorkspaces();
    const foundWorkspace = workspaces.find(w => w.id === created.id);
    
    assertEquals(foundWorkspace?.name, testWorkspaceName);
    assertEquals(foundWorkspace?.description, "Test workspace for list test");
    
    // Clean up
    await workspaceRegistry.deleteWorkspace(created.id, true);
  });

  await t.step("test workspace_describe", async () => {
    const testWorkspaceName = `test-describe-workspace-${Date.now()}`;
    
    // Create a workspace
    const created = await workspaceRegistry.createWorkspace({
      name: testWorkspaceName,
      description: "Test workspace for describe test",
    });
    
    // Describe workspace
    const described = await workspaceRegistry.describeWorkspace(created.id);
    
    assertEquals(described.id, created.id);
    assertEquals(described.name, testWorkspaceName);
    assertEquals(described.description, "Test workspace for describe test");
    assertEquals(typeof described.path, "string");
    assertEquals(typeof described.createdAt, "string");
    
    // Clean up
    await workspaceRegistry.deleteWorkspace(created.id, true);
  });

  await t.step("test workspace_delete", async () => {
    const testWorkspaceName = `test-delete-workspace-${Date.now()}`;
    
    // Create a workspace
    const created = await workspaceRegistry.createWorkspace({
      name: testWorkspaceName,
      description: "Test workspace for delete test",
    });
    
    // Verify it exists
    const beforeDelete = await workspaceRegistry.describeWorkspace(created.id);
    assertEquals(beforeDelete.id, created.id);
    
    // Delete it
    await workspaceRegistry.deleteWorkspace(created.id, true);
    
    // Verify it's gone
    await assertRejects(
      () => workspaceRegistry.describeWorkspace(created.id),
      Error,
      `Workspace ${created.id} not found`
    );
  });
});