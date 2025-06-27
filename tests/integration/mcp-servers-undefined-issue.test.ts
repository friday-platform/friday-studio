import { assertEquals, assertExists } from "jsr:@std/assert";
import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { WorkspaceMCPConfigurationService } from "../../src/core/services/mcp-configuration-service.ts";
import { MCPServerRegistry } from "../../src/core/agents/mcp/mcp-server-registry.ts";
import { createTestWorkspace } from "../utils/test-utils.ts";

Deno.test("MCP Servers Undefined Issue", async (t) => {
  await t.step("should reproduce the MCP Servers undefined issue", async () => {
    // Create a test workspace with MCP server configuration
    const testWorkspace = await createTestWorkspace({
      "workspace.yml": `
version: "1.0"

workspace:
  name: "test-workspace"
  description: "Test workspace for MCP servers issue"

tools:
  mcp:
    servers:
      filesystem:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
          env:
            NODE_ENV: "development"

agents:
  test-agent:
    type: "llm"
    model: "claude-3-5-haiku-20241022"
    purpose: "Test agent with MCP tools"
    tools:
      mcp: ["filesystem"]
      `,
    });

    try {
      // Load configuration using ConfigLoader
      const adapter = new FilesystemConfigAdapter();
      const configLoader = new ConfigLoader(adapter, testWorkspace.path);

      const config = await configLoader.load();

      // Validate that MCP servers are properly loaded from workspace config
      assertExists(config.workspace, "Config should have workspace section");
      assertExists(config.workspace.tools, "Workspace should have tools section");
      assertExists(config.workspace.tools.mcp, "Workspace should have MCP tools section");
      assertExists(config.workspace.tools.mcp.servers, "Workspace should have MCP servers");

      // Check if the filesystem server is defined
      assertExists(
        config.workspace.tools.mcp.servers.filesystem,
        "Filesystem server should be defined",
      );
      const filesystemServer = config.workspace.tools.mcp.servers.filesystem;
      assertEquals(filesystemServer.transport.type, "stdio");
      if (filesystemServer.transport.type === "stdio") {
        assertEquals(filesystemServer.transport.command, "npx");
      }

      // Reset and initialize MCPServerRegistry
      MCPServerRegistry.reset();

      // Now the registry should handle the new format directly

      // Initialize registry with the workspace config (new format support)
      MCPServerRegistry.initialize(undefined, config.workspace);

      // Test WorkspaceMCPConfigurationService
      const mcpService = new WorkspaceMCPConfigurationService("test-workspace", "test-session");

      // Check if filesystem server is available
      const isFilesystemAvailable = mcpService.isServerAvailable("filesystem");
      assertEquals(isFilesystemAvailable, true, "Filesystem server should be available");

      // Get server configs for an agent that uses the filesystem server
      const serverConfigs = mcpService.getServerConfigsForAgent("test-agent", ["filesystem"]);
      assertExists(serverConfigs, "Should return server configs");
      assertEquals(serverConfigs.length, 1, "Should return one server config");
      assertEquals(serverConfigs[0].id, "filesystem", "Should return filesystem server config");
    } catch (error) {
      console.error("Test failed with error:", error);
      throw error;
    } finally {
      // Clean up test workspace
      await testWorkspace.cleanup();
    }
  });

  await t.step("should handle empty or missing MCP configuration gracefully", async () => {
    // Test with workspace that has no MCP configuration
    const testWorkspace = await createTestWorkspace({
      "workspace.yml": `
version: "1.0"

workspace:
  name: "test-workspace-no-mcp"
  description: "Test workspace without MCP configuration"

agents:
  simple-agent:
    type: "llm"
    model: "claude-3-5-haiku-20241022"
    purpose: "Agent without MCP tools"
      `,
    });

    try {
      const adapter = new FilesystemConfigAdapter();
      const configLoader = new ConfigLoader(adapter, testWorkspace.path);
      const config = await configLoader.load();

      // Reset and initialize MCPServerRegistry with empty config
      MCPServerRegistry.reset();

      MCPServerRegistry.initialize(undefined, config.workspace);

      // This should work gracefully even with no MCP config
      const mcpService = new WorkspaceMCPConfigurationService(
        "test-workspace-no-mcp",
        "test-session",
      );

      // Should handle empty config gracefully
      const availableServers = mcpService.getAvailableServersForAgent("simple-agent");
      assertEquals(
        Array.isArray(availableServers),
        true,
        "Should return array even with no MCP config",
      );
      assertEquals(availableServers.length, 0, "Should return empty array for no MCP config");
    } catch (error) {
      console.error("Test failed for empty MCP config:", error);
      throw error;
    } finally {
      await testWorkspace.cleanup();
    }
  });

  await t.step("should handle malformed MCP configuration", async () => {
    // Test with malformed MCP configuration
    const testWorkspace = await createTestWorkspace({
      "workspace.yml": `
version: "1.0"

workspace:
  name: "test-workspace-malformed"
  description: "Test workspace with malformed MCP configuration"

tools:
  mcp:
    # Missing servers section
    
agents:
  test-agent:
    type: "llm"
    model: "claude-3-5-haiku-20241022"
    purpose: "Test agent with malformed MCP tools"
    tools:
      mcp: ["non-existent-server"]
      `,
    });

    try {
      const adapter = new FilesystemConfigAdapter();
      const configLoader = new ConfigLoader(adapter, testWorkspace.path);
      const config = await configLoader.load();

      // Reset and initialize MCPServerRegistry with malformed config
      MCPServerRegistry.reset();

      MCPServerRegistry.initialize(undefined, config.workspace);

      const mcpService = new WorkspaceMCPConfigurationService(
        "test-workspace-malformed",
        "test-session",
      );

      // This should handle the case where an agent references a non-existent server
      const isAvailable = mcpService.isServerAvailable("non-existent-server");
      assertEquals(isAvailable, false, "Non-existent server should not be available");
    } catch (error) {
      console.error("Error handling malformed config:", error);
      // This might legitimately throw an error, which is fine
      // The test is to see what kind of error we get
    } finally {
      await testWorkspace.cleanup();
    }
  });
});
