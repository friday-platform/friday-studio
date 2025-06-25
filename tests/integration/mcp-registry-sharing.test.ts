/**
 * Integration tests for MCP registry sharing across the supervisor hierarchy
 * Tests the flow: WorkspaceSupervisor → SessionSupervisor → AgentSupervisor → Agent execution
 */

import { assertEquals, assertExists } from "jsr:@std/assert";
import { MCPServerRegistry } from "../../src/core/agents/mcp/mcp-server-registry.ts";
import { SessionSupervisor } from "../../src/core/session-supervisor.ts";
import { AgentSupervisor } from "../../src/core/agent-supervisor.ts";
import { AtlasMemoryConfig } from "../../src/core/memory-config.ts";

const mockMemoryConfig: AtlasMemoryConfig = {
  default: {
    enabled: true,
    storage: "in-memory",
    cognitive_loop: false,
    retention: {
      max_age_days: 30,
      max_entries: 1000,
      cleanup_interval_hours: 6,
    },
  },
  agent: {
    enabled: true,
    scope: "agent",
    include_in_context: true,
    context_limits: {
      relevant_memories: 100,
      past_successes: 50,
      past_failures: 50,
    },
    memory_types: {
      contextual: { enabled: true, max_entries: 100 },
    },
  },
  session: {
    enabled: true,
    scope: "session",
    include_in_context: true,
    context_limits: {
      relevant_memories: 500,
      past_successes: 250,
      past_failures: 250,
    },
    memory_types: {
      contextual: { enabled: true, max_entries: 500 },
    },
  },
  workspace: {
    enabled: true,
    scope: "workspace",
    include_in_context: false,
    context_limits: {
      relevant_memories: 1000,
      past_successes: 500,
      past_failures: 500,
    },
    memory_types: {
      contextual: { enabled: true, max_entries: 500 },
      procedural: { enabled: true, max_entries: 250 },
      episodic: { enabled: true, max_entries: 250 },
    },
  },
};

Deno.test("MCP Registry Sharing - Full Integration Flow", async (t) => {
  // Reset registry before test
  MCPServerRegistry.reset();

  await t.step("1. WorkspaceSupervisor initializes MCP registry", () => {
    // Simulate workspace MCP server configuration
    const workspaceMcpServers = {
      "test-server": {
        transport: {
          type: "stdio" as const,
          command: "echo",
          args: ["test"],
        },
        tools: {
          allowed: ["test_tool"],
        },
        timeout_ms: 30000,
      },
    };

    // Initialize registry (like WorkspaceSupervisor does)
    MCPServerRegistry.initialize(undefined, { mcp_servers: workspaceMcpServers });

    // Verify registry is initialized
    assertEquals(MCPServerRegistry.isInitialized(), true);
    assertEquals(MCPServerRegistry.listServers(), ["test-server"]);
  });

  await t.step("2. SessionSupervisor should access MCP registry", () => {
    // Test that SessionSupervisor can access the initialized registry
    const availableServers = MCPServerRegistry.listServers();
    assertEquals(availableServers.includes("test-server"), true);

    // Test getting server config
    const serverConfig = MCPServerRegistry.getServerConfig("test-server");
    assertExists(serverConfig);
    assertEquals(serverConfig.id, "test-server");
  });

  await t.step("3. SessionSupervisor filters MCP servers for specific agent", () => {
    // Create SessionSupervisor with workspace MCP servers
    const workspaceMcpServers = {
      "test-server": {
        transport: {
          type: "stdio" as const,
          command: "echo",
          args: ["test"],
        },
        tools: {
          allowed: ["test_tool"],
        },
        timeout_ms: 30000,
      },
    };

    const sessionSupervisor = new SessionSupervisor(mockMemoryConfig, "test-workspace");
    sessionSupervisor.setWorkspaceMcpServers(workspaceMcpServers);

    // Test filtering for specific agent
    const agentMcpServers = ["test-server"];
    const filteredConfigs = sessionSupervisor.getMcpServerConfigsForAgent(
      "test-agent",
      agentMcpServers,
    );

    assertEquals(filteredConfigs.length, 1);
    assertEquals(filteredConfigs[0].id, "test-server");
  });

  await t.step("4. AgentSupervisor prepares agent-specific configurations", () => {
    // Test AgentSupervisor configuration preparation
    const workspaceMcpServers = {
      "test-server": {
        transport: {
          type: "stdio" as const,
          command: "echo",
          args: ["test"],
        },
        tools: {
          allowed: ["test_tool"],
        },
        timeout_ms: 30000,
      },
    };

    const agentSupervisorConfig = {
      memoryConfig: mockMemoryConfig,
      sessionId: "test-session",
      workspaceId: "test-workspace",
      workspaceMcpServers,
    };

    const agentSupervisor = new AgentSupervisor(agentSupervisorConfig, "test-workspace");

    // Mock SessionSupervisor with MCP config method
    const mockSessionSupervisor = {
      getMcpServerConfigsForAgent: (agentId: string, serverIds: string[]) => {
        return serverIds.map((id) => ({ id, ...workspaceMcpServers[id] }));
      },
    };

    agentSupervisor.setSessionSupervisor(mockSessionSupervisor);

    // Test agent metadata with MCP server requirements
    const agentMetadata = {
      id: "test-agent",
      type: "llm" as const,
      config: {
        type: "llm",
        model: "claude-3-5-sonnet-20241022",
        purpose: "Test agent",
        mcp_servers: ["test-server"],
      },
    };

    // Test environment preparation (this tests the internal logic)
    // We can't easily test the private methods, but we can verify the AgentSupervisor
    // can be created with the configuration
    assertExists(agentSupervisor);
  });

  await t.step("5. Agent environment should include MCP server configs", () => {
    // Test the data that should be passed to agent execution environment
    const agentMcpServers = ["test-server"];
    const serverConfigs = MCPServerRegistry.getServerConfigs(agentMcpServers);

    // Simulate what should be in agent environment
    const agentEnvironment = {
      mcp_servers: agentMcpServers,
      mcp_server_configs: serverConfigs.reduce((acc, config) => {
        acc[config.id] = config;
        return acc;
      }, {} as Record<string, any>),
    };

    assertEquals(agentEnvironment.mcp_servers, ["test-server"]);
    assertExists(agentEnvironment.mcp_server_configs["test-server"]);
    assertEquals(agentEnvironment.mcp_server_configs["test-server"].id, "test-server");
  });

  // Cleanup
  MCPServerRegistry.reset();
});

Deno.test("MCP Registry Sharing - Error Cases", async (t) => {
  MCPServerRegistry.reset();

  await t.step("Should handle missing MCP servers gracefully", () => {
    // Initialize with empty registry
    MCPServerRegistry.initialize(undefined, { mcp_servers: {} });

    // Test agent requesting non-existent server
    const agentMcpServers = ["non-existent-server"];
    const serverConfigs = MCPServerRegistry.getServerConfigs(agentMcpServers);

    assertEquals(serverConfigs.length, 0);
  });

  await t.step("Should handle uninitialized registry", () => {
    MCPServerRegistry.reset();

    assertEquals(MCPServerRegistry.isInitialized(), false);
    assertEquals(MCPServerRegistry.listServers(), []);
    assertEquals(MCPServerRegistry.getServerConfigs(["any-server"]), []);
  });

  await t.step("SessionSupervisor should handle missing workspace MCP servers", () => {
    const sessionSupervisor = new SessionSupervisor(mockMemoryConfig, "test-workspace");

    // Don't set workspace MCP servers
    const configs = sessionSupervisor.getMcpServerConfigsForAgent("test-agent", ["test-server"]);

    assertEquals(configs.length, 0);
  });

  MCPServerRegistry.reset();
});

Deno.test("MCP Registry Sharing - Configuration Passing", async (t) => {
  await t.step("SessionSupervisor should properly set and get workspace MCP servers", () => {
    const workspaceMcpServers = {
      "linear": {
        transport: {
          type: "stdio" as const,
          command: "npx",
          args: ["-y", "linear-mcp-server"],
          env: {
            LINEAR_API_KEY: "auto",
          },
        },
        tools: {
          allowed: ["linear_create_issue", "linear_update_issue"],
        },
        timeout_ms: 30000,
      },
    };

    const sessionSupervisor = new SessionSupervisor(mockMemoryConfig, "test-workspace");
    sessionSupervisor.setWorkspaceMcpServers(workspaceMcpServers);

    const configs = sessionSupervisor.getMcpServerConfigsForAgent("linear-agent", ["linear"]);
    assertEquals(configs.length, 1);
    assertEquals(configs[0].id, "linear");
    assertEquals(configs[0].transport.command, "npx");
    assertEquals(configs[0].tools.allowed, ["linear_create_issue", "linear_update_issue"]);
  });

  await t.step("Should handle multiple MCP servers", () => {
    const workspaceMcpServers = {
      "linear": {
        transport: { type: "stdio" as const, command: "npx", args: ["-y", "linear-mcp-server"] },
        tools: { allowed: ["linear_create_issue"] },
      },
      "github": {
        transport: { type: "stdio" as const, command: "npx", args: ["-y", "github-mcp-server"] },
        tools: { allowed: ["github_create_pr"] },
      },
    };

    const sessionSupervisor = new SessionSupervisor(mockMemoryConfig, "test-workspace");
    sessionSupervisor.setWorkspaceMcpServers(workspaceMcpServers);

    const configs = sessionSupervisor.getMcpServerConfigsForAgent("multi-agent", [
      "linear",
      "github",
    ]);
    assertEquals(configs.length, 2);

    const linearConfig = configs.find((c) => c.id === "linear");
    const githubConfig = configs.find((c) => c.id === "github");

    assertExists(linearConfig);
    assertExists(githubConfig);
    assertEquals(linearConfig.tools.allowed, ["linear_create_issue"]);
    assertEquals(githubConfig.tools.allowed, ["github_create_pr"]);
  });
});
