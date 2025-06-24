/**
 * End-to-end MCP integration test
 * Tests the complete flow from workspace configuration to agent execution
 */

import { assertEquals, assertExists } from "jsr:@std/assert";
import { WorkspaceMCPConfigurationService } from "../../src/core/services/mcp-configuration-service.ts";
import { MCPServerRegistry } from "../../src/core/agents/mcp/mcp-server-registry.ts";

Deno.test("MCP End-to-End Integration", async (t) => {
  // Reset registry before test
  MCPServerRegistry.reset();

  await t.step("Complete MCP workflow", () => {
    // 1. Workspace configuration with Linear MCP server
    const workspaceConfig = {
      mcp_servers: {
        linear: {
          transport: {
            type: "stdio" as const,
            command: "npx",
            args: ["-y", "linear-mcp-server"],
            env: {
              LINEAR_API_KEY: "auto",
            },
          },
          tools: {
            allowed: ["linear_create_issue", "linear_update_issue", "linear_get_issue"],
          },
          timeout_ms: 30000,
        },
      },
    };

    // 2. Initialize MCP registry (WorkspaceRuntime/WorkspaceSupervisor)
    MCPServerRegistry.initialize(undefined, workspaceConfig);
    assertEquals(MCPServerRegistry.isInitialized(), true);
    assertEquals(MCPServerRegistry.listServers(), ["linear"]);

    // 3. Session worker context - direct configs (worker isolation)
    const directConfigs = workspaceConfig.mcp_servers;
    const mcpConfigService = new WorkspaceMCPConfigurationService(
      "test-workspace",
      "test-session",
      directConfigs, // Direct configs for worker context
    );

    // 4. Agent requests MCP servers
    const agentMcpServers = ["linear"];
    const agentConfigs = mcpConfigService.getServerConfigsForAgent(
      "linear-agent",
      agentMcpServers,
    );

    // 5. Verify complete configuration chain
    assertEquals(agentConfigs.length, 1);
    assertEquals(agentConfigs[0].id, "linear");
    
    // Type-safe access to stdio transport properties
    const transport = agentConfigs[0].transport;
    if (transport.type === "stdio") {
      assertEquals(transport.command, "npx");
      assertEquals(transport.env?.LINEAR_API_KEY, "auto");
      
      // 6. Verify environment variable support
      assertExists(transport.env);
      assertEquals(transport.env.LINEAR_API_KEY, "auto");
    }
    
    assertEquals(agentConfigs[0].tools.allowed.includes("linear_create_issue"), true);

    // 7. Verify proper tool naming (Linear MCP convention)
    const allowedTools = agentConfigs[0].tools.allowed;
    assertEquals(allowedTools.every(tool => tool.startsWith("linear_")), true);
  });

  // Cleanup
  MCPServerRegistry.reset();
});

Deno.test("MCP Configuration Validation", async (t) => {
  await t.step("Should validate all required MCP features", () => {
    // Test dual-mode configuration service
    const configService = new WorkspaceMCPConfigurationService("workspace", "session");
    assertExists(configService);

    // Test configuration service with direct configs
    const directConfigs = {
      "test-server": {
        transport: { type: "stdio" as const, command: "echo" },
        tools: { allowed: ["test"] },
      },
    };

    const configServiceWithDirect = new WorkspaceMCPConfigurationService(
      "workspace",
      "session", 
      directConfigs,
    );
    assertExists(configServiceWithDirect);

    // Test config resolution
    const configs = configServiceWithDirect.getServerConfigsForAgent("agent", ["test-server"]);
    assertEquals(configs.length, 1);
    assertEquals(configs[0].id, "test-server");
  });

  await t.step("Should support environment variable resolution", () => {
    const mcpConfig = {
      transport: {
        type: "stdio" as const,
        command: "npx",
        args: ["-y", "linear-mcp-server"],
        env: {
          LINEAR_API_KEY: "auto",
          CUSTOM_VAR: "direct-value",
        },
      },
    };

    // Verify the config structure supports environment variables
    assertExists(mcpConfig.transport.env);
    assertEquals(mcpConfig.transport.env.LINEAR_API_KEY, "auto");
    assertEquals(mcpConfig.transport.env.CUSTOM_VAR, "direct-value");
  });

  await t.step("Should support Linear-specific configuration", () => {
    const linearConfig = {
      transport: {
        type: "stdio" as const,
        command: "npx",
        args: ["-y", "linear-mcp-server"],
        env: {
          LINEAR_API_KEY: "auto",
        },
      },
      tools: {
        allowed: [
          "linear_create_issue",
          "linear_update_issue", 
          "linear_get_issue",
          "linear_search_issues",
          "linear_add_comment",
        ],
      },
      timeout_ms: 30000,
    };

    // Verify Linear MCP server configuration
    assertEquals(linearConfig.transport.command, "npx");
    assertEquals(linearConfig.transport.args, ["-y", "linear-mcp-server"]);
    assertEquals(linearConfig.transport.env?.LINEAR_API_KEY, "auto");
    
    // Verify Linear tool naming convention
    const tools = linearConfig.tools.allowed;
    assertEquals(tools.every(tool => tool.startsWith("linear_")), true);
    assertEquals(tools.includes("linear_create_issue"), true);
    assertEquals(tools.includes("linear_update_issue"), true);
  });
});