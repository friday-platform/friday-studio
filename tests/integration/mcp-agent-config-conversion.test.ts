import { assertEquals, assertExists } from "jsr:@std/assert";
import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";

Deno.test("MCP Agent Config Conversion", async (t) => {
  await t.step("should convert tools.mcp to mcp_servers in LLM agent config", async () => {
    // Test workspace agent config with NEW format
    const workspaceAgentConfig = {
      type: "llm" as const,
      model: "claude-3-5-sonnet-20241022",
      purpose: "Test agent with new MCP format",
      tools: {
        mcp: ["linear", "filesystem"], // NEW format
      },
    };

    // Convert to agent config (what SessionSupervisor expects) using static method
    const agentConfig = ConfigLoader.convertWorkspaceAgentConfig(workspaceAgentConfig);

    // Verify conversion
    assertEquals(agentConfig.type, "llm");

    // Cast to LLMAgentConfig for type safety
    const llmConfig = agentConfig as any; // We know it's LLM type
    assertEquals(llmConfig.model, "claude-3-5-sonnet-20241022");
    assertEquals(llmConfig.purpose, "Test agent with new MCP format");

    // The key test: tools.mcp should be converted to mcp_servers
    assertExists(llmConfig.mcp_servers, "Should have mcp_servers field");
    assertEquals(Array.isArray(llmConfig.mcp_servers), true, "mcp_servers should be array");
    assertEquals(llmConfig.mcp_servers.length, 2, "Should have 2 MCP servers");
    assertEquals(llmConfig.mcp_servers[0], "linear", "Should include linear server");
    assertEquals(llmConfig.mcp_servers[1], "filesystem", "Should include filesystem server");
  });

  await t.step("should handle tools.mcp.servers format", async () => {
    // Test workspace agent config with tools.mcp.servers format
    const workspaceAgentConfig = {
      type: "llm" as const,
      model: "claude-3-5-haiku-20241022",
      purpose: "Test agent with tools.mcp.servers format",
      tools: {
        mcp: ["weather", "database"], // New format
      },
    };

    const agentConfig = ConfigLoader.convertWorkspaceAgentConfig(workspaceAgentConfig);

    // Verify new format works
    const llmConfig = agentConfig as any;
    assertExists(llmConfig.mcp_servers, "Should have mcp_servers field");
    assertEquals(llmConfig.mcp_servers.length, 2, "Should have 2 MCP servers");
    assertEquals(llmConfig.mcp_servers[0], "weather", "Should include weather server");
    assertEquals(llmConfig.mcp_servers[1], "database", "Should include database server");
  });

  await t.step("should handle tools.mcp array format correctly", async () => {
    // Test workspace agent config with proper tools.mcp array format
    const workspaceAgentConfig = {
      type: "llm" as const,
      model: "claude-3-5-sonnet-20241022",
      purpose: "Test agent with tools.mcp array format",
      tools: {
        mcp: ["server-a", "server-b", "server-c"], // NEW format with multiple servers
      },
    };

    const agentConfig = ConfigLoader.convertWorkspaceAgentConfig(workspaceAgentConfig);

    // Should extract all servers from tools.mcp
    const llmConfig = agentConfig as any;
    assertExists(llmConfig.mcp_servers, "Should have mcp_servers field");
    assertEquals(llmConfig.mcp_servers.length, 3, "Should have 3 MCP servers");
    assertEquals(llmConfig.mcp_servers[0], "server-a", "Should include server-a");
    assertEquals(llmConfig.mcp_servers[1], "server-b", "Should include server-b");
    assertEquals(llmConfig.mcp_servers[2], "server-c", "Should include server-c");
  });

  await t.step("should handle no MCP configuration", async () => {
    // Test workspace agent config with no MCP configuration
    const workspaceAgentConfig = {
      type: "llm" as const,
      model: "claude-3-5-haiku-20241022",
      purpose: "Test agent without MCP tools",
    };

    const agentConfig = ConfigLoader.convertWorkspaceAgentConfig(workspaceAgentConfig);

    // Should handle gracefully
    assertEquals(agentConfig.type, "llm");
    const llmConfig = agentConfig as any;
    assertEquals(llmConfig.model, "claude-3-5-haiku-20241022");
    // mcp_servers should be undefined (not an empty array)
    assertEquals(llmConfig.mcp_servers, undefined, "Should be undefined when no MCP config");
  });

  await t.step("should handle non-LLM agents correctly", async () => {
    // Test tempest agent config
    const tempestAgentConfig = {
      type: "tempest" as const,
      agent: "content-processor",
      version: "2.0.0",
      purpose: "Test tempest agent",
      config: {
        modes: ["fast", "thorough"],
      },
    };

    const agentConfig = ConfigLoader.convertWorkspaceAgentConfig(tempestAgentConfig);

    // Should convert correctly without MCP concerns
    assertEquals(agentConfig.type, "tempest");
    assertEquals((agentConfig as any).agent, "content-processor");
    assertEquals((agentConfig as any).version, "2.0.0");
    assertExists((agentConfig as any).config, "Should preserve config");
  });
});
