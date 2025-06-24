/**
 * Integration tests for MCP Configuration Service dual-mode resolution
 * Tests direct config mode (worker contexts) vs registry mode (main contexts)
 */

import { assertEquals, assertExists } from "jsr:@std/assert";
import { WorkspaceMCPConfigurationService } from "../../src/core/services/mcp-configuration-service.ts";
import { MCPServerRegistry } from "../../src/core/agents/mcp/mcp-server-registry.ts";

Deno.test("MCP Configuration Service - Dual Mode Resolution", async (t) => {
  // Reset registry before tests
  MCPServerRegistry.reset();

  await t.step("Registry mode - should use MCPServerRegistry when no direct configs", async () => {
    // Initialize registry first
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

    MCPServerRegistry.initialize(undefined, { mcp_servers: workspaceMcpServers });

    // Create service without direct configs (registry mode)
    const service = new WorkspaceMCPConfigurationService("test-workspace", "test-session");

    // Should get config from registry
    const configs = service.getServerConfigsForAgent("test-agent", ["test-server"]);
    assertEquals(configs.length, 1);
    assertEquals(configs[0].id, "test-server");
  });

  await t.step("Direct mode - should use direct configs when provided", () => {
    // Direct configs (as would be passed to worker)
    const directConfigs = {
      "worker-server": {
        transport: {
          type: "stdio" as const,
          command: "echo",
          args: ["worker"],
        },
        tools: {
          allowed: ["worker_tool"],
        },
        timeout_ms: 30000,
      },
    };

    // Create service with direct configs (worker mode)
    const service = new WorkspaceMCPConfigurationService(
      "test-workspace", 
      "test-session",
      directConfigs
    );

    // Should get config from direct configs, not registry
    const configs = service.getServerConfigsForAgent("test-agent", ["worker-server"]);
    assertEquals(configs.length, 1);
    assertEquals(configs[0].id, "worker-server");
    assertEquals(configs[0].tools?.allowed, ["worker_tool"]);
  });

  await t.step("ID assignment - should ensure all configs have proper id field", () => {
    // Direct configs without id field
    const directConfigs = {
      "no-id-server": {
        transport: {
          type: "stdio" as const,
          command: "echo",
        },
        // Note: no id field in the config
      },
    };

    const service = new WorkspaceMCPConfigurationService(
      "test-workspace",
      "test-session", 
      directConfigs
    );

    const configs = service.getServerConfigsForAgent("test-agent", ["no-id-server"]);
    assertEquals(configs.length, 1);
    // Should have id field added by service
    assertEquals(configs[0].id, "no-id-server");
  });

  await t.step("Fallback behavior - registry mode falls back gracefully", () => {
    // Service without direct configs, asking for non-existent server
    const service = new WorkspaceMCPConfigurationService("test-workspace", "test-session");

    const configs = service.getServerConfigsForAgent("test-agent", ["non-existent"]);
    assertEquals(configs.length, 0); // Should return empty array, not crash
  });

  // Cleanup
  MCPServerRegistry.reset();
});

Deno.test("MCP Configuration Service - Agent Environment Preparation", async (t) => {
  await t.step("Should prepare configs for agent execution worker environment", () => {
    const directConfigs = {
      "env-server": {
        transport: {
          type: "stdio" as const,
          command: "echo",
          args: ["env-test"],
        },
        tools: {
          allowed: ["env_tool"],
        },
      },
    };

    const service = new WorkspaceMCPConfigurationService(
      "test-workspace",
      "test-session",
      directConfigs
    );

    const configs = service.getServerConfigsForAgent("test-agent", ["env-server"]);
    
    // Should be suitable for agent environment
    assertEquals(configs.length, 1);
    assertExists(configs[0].id);
    assertExists(configs[0].transport);
    assertEquals(configs[0].transport.type, "stdio");
  });
});