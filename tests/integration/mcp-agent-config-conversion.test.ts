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

  await t.step("should handle legacy mcp_servers format", async () => {
    // Test workspace agent config with LEGACY format
    const workspaceAgentConfig = {
      type: "llm" as const,
      model: "claude-3-5-haiku-20241022",
      purpose: "Test agent with legacy MCP format",
      mcp_servers: ["weather", "database"], // LEGACY format
    };

    const agentConfig = ConfigLoader.convertWorkspaceAgentConfig(workspaceAgentConfig);

    // Verify legacy format still works
    const llmConfig = agentConfig as any;
    assertExists(llmConfig.mcp_servers, "Should preserve mcp_servers field");
    assertEquals(llmConfig.mcp_servers.length, 2, "Should have 2 MCP servers");
    assertEquals(llmConfig.mcp_servers[0], "weather", "Should include weather server");
    assertEquals(llmConfig.mcp_servers[1], "database", "Should include database server");
  });

  await t.step("should prioritize new format over legacy format", async () => {
    // Test workspace agent config with BOTH formats (new should win)
    const workspaceAgentConfig = {
      type: "llm" as const,
      model: "claude-3-5-sonnet-20241022",
      purpose: "Test agent with both MCP formats",
      tools: {
        mcp: ["new-server"], // NEW format
      },
      mcp_servers: ["legacy-server"], // LEGACY format
    };

    const agentConfig = ConfigLoader.convertWorkspaceAgentConfig(workspaceAgentConfig);

    // New format should override legacy
    const llmConfig = agentConfig as any;
    assertExists(llmConfig.mcp_servers, "Should have mcp_servers field");
    assertEquals(llmConfig.mcp_servers.length, 1, "Should have 1 MCP server");
    assertEquals(llmConfig.mcp_servers[0], "new-server", "Should use new format, not legacy");
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
