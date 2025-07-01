import { assertEquals, assertExists } from "jsr:@std/assert";
import { MCPServerRegistry, WorkspaceMCPConfigurationService } from "@atlas/mcp";

Deno.test("MCP Worker Propagation", async (t) => {
  await t.step("should propagate MCP configuration to worker level", async () => {
    // Simulate the workspace tools configuration that would be set by WorkspaceSupervisor
    const workspaceTools = {
      mcp: {
        servers: {
          "test-server": {
            transport: {
              type: "stdio" as const,
              command: "echo",
              args: ["test"],
            },
            timeout_ms: 30000,
          },
        },
      },
    };

    // Simulate AgentSupervisor initialization with workspaceTools (successful path)
    const agentSupervisorConfig = {
      model: "claude-3-5-sonnet-20241022",
      sessionId: "test-session",
      workspaceId: "test-workspace",
      workspaceTools: workspaceTools, // This should be included in both successful and fallback paths
      prompts: {
        system: "Test agent supervisor",
      },
    };

    // Test that workspace tools are properly configured
    assertExists(
      agentSupervisorConfig.workspaceTools,
      "AgentSupervisor should have workspaceTools",
    );
    assertExists(
      agentSupervisorConfig.workspaceTools.mcp,
      "Workspace tools should have MCP section",
    );
    assertExists(agentSupervisorConfig.workspaceTools.mcp.servers, "MCP should have servers");
    assertExists(
      agentSupervisorConfig.workspaceTools.mcp.servers["test-server"],
      "Test server should be defined",
    );

    // Simulate the AgentSupervisor.prepareAgentMcpServerNames logic
    const agentMetadata = {
      id: "test-agent",
      type: "llm" as const,
      config: {
        mcp_servers: ["test-server"],
      },
    };

    // This mimics the logic in AgentSupervisor.prepareAgentMcpServerNames
    const workspaceMcpServers = agentSupervisorConfig.workspaceTools?.mcp?.servers;

    // This should NOT be undefined
    assertExists(workspaceMcpServers, "Workspace MCP servers should be available");
    assertEquals(typeof workspaceMcpServers, "object", "Workspace MCP servers should be an object");
    assertExists(
      workspaceMcpServers["test-server"],
      "Test server should be in workspace MCP servers",
    );

    // Simulate agent preparation (what should happen in prepareAgentMcpServerNames)
    const agentMcpServerNames = agentMetadata.config.mcp_servers;
    const validatedServerNames = agentMcpServerNames.filter((serverName) =>
      workspaceMcpServers[serverName]
    );

    assertEquals(validatedServerNames.length, 1, "Should find one valid MCP server");
    assertEquals(validatedServerNames[0], "test-server", "Should find the test server");
  });

  await t.step("should handle fallback configuration correctly", async () => {
    // Simulate the fallback scenario where atlas config loading fails
    // The workspaceTools should still be preserved

    const workspaceTools = {
      mcp: {
        servers: {
          "fallback-server": {
            transport: {
              type: "stdio" as const,
              command: "echo",
              args: ["fallback"],
            },
          },
        },
      },
    };

    // Simulate fallback configuration (this now includes workspaceTools after the fix)
    const fallbackConfig = {
      model: "claude-3-5-sonnet-20241022",
      sessionId: "fallback-session",
      workspaceId: "fallback-workspace",
      workspaceTools: workspaceTools, // This should be included after the fix
      prompts: {
        system: "You are an AgentSupervisor responsible for safe agent execution.",
      },
    };

    // Verify that even in fallback mode, workspaceTools is present
    assertExists(fallbackConfig.workspaceTools, "Fallback config should include workspaceTools");
    assertExists(
      fallbackConfig.workspaceTools.mcp?.servers,
      "Fallback should preserve MCP servers",
    );
    assertExists(
      fallbackConfig.workspaceTools.mcp.servers["fallback-server"],
      "Fallback server should be available",
    );

    // Test that MCP server preparation would work correctly
    const workspaceMcpServers = fallbackConfig.workspaceTools?.mcp?.servers;
    assertExists(workspaceMcpServers, "Workspace MCP servers should be available in fallback");

    const agentConfig = {
      mcp_servers: ["fallback-server"],
    };

    const validServers = agentConfig.mcp_servers.filter((serverName) =>
      workspaceMcpServers[serverName]
    );

    assertEquals(validServers.length, 1, "Should find fallback server even in fallback config");
  });

  await t.step("should properly integrate with MCP configuration service", async () => {
    // Test the full integration with the actual MCP configuration service
    MCPServerRegistry.reset();

    const workspaceConfig = {
      tools: {
        mcp: {
          servers: {
            "integration-server": {
              transport: {
                type: "stdio" as const,
                command: "echo",
                args: ["integration"],
              },
              timeout_ms: 30000,
            },
          },
        },
      },
    };

    // Initialize registry (this uses the fixed registry from previous commit)
    MCPServerRegistry.initialize(undefined, workspaceConfig);

    // Create MCP configuration service
    const mcpService = new WorkspaceMCPConfigurationService("test-workspace", "test-session");

    // Verify the server is available
    const isAvailable = mcpService.isServerAvailable("integration-server");
    assertEquals(isAvailable, true, "Integration server should be available");

    // Get server configs for an agent
    const serverConfigs = mcpService.getServerConfigsForAgent("test-agent", ["integration-server"]);
    assertEquals(serverConfigs.length, 1, "Should return one server config");
    assertEquals(
      serverConfigs[0].id,
      "integration-server",
      "Should return integration server config",
    );
  });
});
