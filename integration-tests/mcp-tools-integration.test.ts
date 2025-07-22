/**
 * MCP Tools Integration Tests
 *
 * Comprehensive integration testing for MCP tools functionality:
 * - Atlas ecosystem integration (registry, LLM providers)
 * - Error handling and edge cases
 * - Filtering, caching, and configuration
 * - Mock-based testing for reliability
 */

import { assertEquals, assertExists, assertGreater } from "@std/assert";
import { getAtlasToolRegistry, MCPToolsAdapter, type MCPToolsAdapterConfig } from "@atlas/tools";
import { LLMProvider } from "@atlas/core";
import type { Tool } from "ai";

// Mock MCP manager for reliable testing
const createMockMCPManager = (tools: Record<string, Tool>) => ({
  async getToolsForServers(_servers: string[]): Promise<Record<string, Tool>> {
    return tools;
  },
});

Deno.test("MCP Tools Integration", async (t) => {
  // Setup - use mocks for testing
  Deno.env.set("ATLAS_USE_LLM_MOCKS", "true");

  await t.step("Atlas ecosystem integration", async () => {
    // Test registry integration with MCP tools
    const registry = getAtlasToolRegistry();

    const mcpConfig: MCPToolsAdapterConfig = {
      mcpServers: ["test-server"],
      cache: { enabled: true, ttl: 300000, maxSize: 100 },
    };

    // Test getMCPTools method
    const mcpTools = await registry.getMCPTools(mcpConfig);
    assertExists(mcpTools);
    assertEquals(Array.isArray(mcpTools), true);

    // Test combined tools
    const result = await registry.getAllToolsWithMCP(mcpConfig);
    assertExists(result.atlasTools);
    assertExists(result.mcpTools);
    assertExists(result.combined);

    // Verify Atlas tools exist
    assertGreater(Object.keys(result.atlasTools).length, 0);
    assertEquals(Array.isArray(result.mcpTools), true);
  });

  await t.step("LLM Provider integration", async () => {
    // Test MCP tools work with LLM Provider
    const registry = getAtlasToolRegistry();
    const tools = await registry.getAllToolsWithMCP({
      mcpServers: ["test-server"],
    });

    // Use combined tools with LLM Provider
    const response = await LLMProvider.generateText(
      "Test message",
      {
        model: "claude-3-sonnet-20240229",
        tools: tools.combined,
      },
    );

    assertExists(response);
    assertExists(response.text);
  });

  await t.step("Mock tool provider functionality", async () => {
    // Test adapter with comprehensive mock tools
    const mockTools = {
      "test_echo": {
        description: "Echo back input",
        parameters: {
          type: "object" as const,
          properties: {
            message: { type: "string" as const, description: "Message to echo" },
          },
          required: ["message"],
        },
        execute: async ({ message }: { message: string }) => `Echo: ${message}`,
      },
      "test_calculator": {
        description: "Perform calculations",
        parameters: {
          type: "object" as const,
          properties: {
            operation: { type: "string" as const, description: "Operation to perform" },
            a: { type: "number" as const, description: "First number" },
            b: { type: "number" as const, description: "Second number" },
          },
          required: ["operation", "a", "b"],
        },
        execute: async ({ operation, a, b }: { operation: string; a: number; b: number }) => {
          switch (operation) {
            case "add":
              return `${a + b}`;
            case "multiply":
              return `${a * b}`;
            default:
              return "Unknown operation";
          }
        },
      },
    };

    const mockManager = createMockMCPManager(mockTools);
    const adapter = new MCPToolsAdapter(mockManager);

    const result = await adapter.getTools({ mcpServers: ["mock-server"] });
    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.data.length, 2);

      // Test tool execution
      const echoTool = result.data[0];
      const calcTool = result.data[1];

      assertExists(echoTool.execute);
      assertExists(calcTool.execute);

      const echoResult = await echoTool.execute({ message: "test" });
      assertEquals(echoResult, "Echo: test");

      const calcResult = await calcTool.execute({ operation: "add", a: 5, b: 3 });
      assertEquals(calcResult, "8");
    }
  });

  await t.step("Filtering functionality", async () => {
    const mockTools = {
      "data_processor": {
        description: "Process data",
        parameters: { type: "object" as const, properties: {} },
        execute: async () => "processed",
      },
      "analysis_tool": {
        description: "Analyze data",
        parameters: { type: "object" as const, properties: {} },
        execute: async () => "analyzed",
      },
      "dangerous_delete": {
        description: "Delete everything",
        parameters: { type: "object" as const, properties: {} },
        execute: async () => "deleted",
      },
    };

    const mockManager = createMockMCPManager(mockTools);
    const adapter = new MCPToolsAdapter(mockManager);

    const config: MCPToolsAdapterConfig = {
      mcpServers: ["test-server"],
      filters: {
        include: [/^data_/, /^analysis_/], // Only data and analysis tools
        exclude: [/dangerous/], // Exclude dangerous tools
      },
    };

    const result = await adapter.getTools(config);
    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.data.length, 2); // Should exclude dangerous_delete
      const toolDescriptions = result.data.map((t) => t.description);
      assertEquals(toolDescriptions.includes("Process data"), true);
      assertEquals(toolDescriptions.includes("Analyze data"), true);
      assertEquals(toolDescriptions.includes("Delete everything"), false);
    }
  });

  await t.step("Caching behavior", async () => {
    let callCount = 0;
    const mockTools = {
      "cached_tool": {
        description: "Cached tool",
        parameters: { type: "object" as const, properties: {} },
        execute: async () => `call-${++callCount}`,
      },
    };

    const provider = {
      async getToolsForServers(_servers: readonly string[]): Promise<Record<string, Tool>> {
        callCount++;
        return mockTools;
      },
    };

    const adapter = new MCPToolsAdapter(provider);

    const config: MCPToolsAdapterConfig = {
      mcpServers: ["test-server"],
      cache: {
        enabled: true,
        ttl: 1000, // 1 second
        maxSize: 10,
      },
    };

    // First call
    const result1 = await adapter.getTools(config);
    assertEquals(result1.success, true);
    assertEquals(callCount, 1);

    // Second call should use cache
    const result2 = await adapter.getTools(config);
    assertEquals(result2.success, true);
    assertEquals(callCount, 1); // Should still be 1 due to caching
  });

  await t.step("Error handling and edge cases", async () => {
    // Test with invalid configuration using factory function
    const { createMCPToolsAdapter } = await import(
      "../packages/tools/src/external-adapters/mcp-tools-adapter.ts"
    );
    const adapter = createMCPToolsAdapter();

    // Malformed config
    const invalidResult = await adapter.getTools({ invalidProperty: "test" } as any);
    assertEquals(invalidResult.success, false);
    assertExists(invalidResult.error);

    // Empty server list (should succeed)
    const emptyResult = await adapter.getTools({ mcpServers: [] });
    assertEquals(emptyResult.success, true);
    if (emptyResult.success) {
      assertEquals(emptyResult.data.length, 0);
    }

    // Test with non-existent server (should handle gracefully)
    const nonExistentResult = await adapter.getTools({
      mcpServers: ["non-existent-server"],
    });
    // Should either succeed with empty array or fail gracefully
    if (nonExistentResult.success) {
      assertEquals(Array.isArray(nonExistentResult.data), true);
    } else {
      assertExists(nonExistentResult.error);
    }
  });

  await t.step("Registry fallback behavior", async () => {
    // Test registry handles MCP failures gracefully
    const registry = getAtlasToolRegistry();

    try {
      // Try with invalid MCP config - should not crash registry
      const tools = await registry.getAllToolsWithMCP({
        mcpServers: ["invalid-server"],
      });

      // Should still have Atlas tools even if MCP fails
      assertExists(tools.atlasTools);
      assertGreater(Object.keys(tools.atlasTools).length, 0);
    } catch (error) {
      // If it throws, should be informative
      assertExists(error.message);
      assertEquals(error instanceof Error, true);
    }
  });

  await t.step("Configuration validation", async () => {
    const mockManager = createMockMCPManager({});
    const adapter = new MCPToolsAdapter(mockManager);

    // Test various configuration edge cases
    const configs = [
      { mcpServers: [] }, // Valid empty
      { mcpServers: ["server1", "server2"] }, // Valid multiple
      { mcpServers: ["server"], cache: { enabled: false } }, // Valid with disabled cache
      { mcpServers: ["server"], cache: { enabled: true, ttl: 5000, maxSize: 50 } }, // Valid full config
    ];

    for (const config of configs) {
      const result = await adapter.getTools(config);
      assertEquals(result.success, true);
    }
  });
});
