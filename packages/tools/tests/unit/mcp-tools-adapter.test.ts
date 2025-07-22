/**
 * Unit tests for MCP Tools Adapter
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  createMCPToolsAdapter,
  getMCPTools,
  MCPToolsAdapter,
  type ToolCache,
} from "../../src/external-adapters/mcp-tools-adapter.ts";
import { MCPManager } from "@atlas/mcp";
import type { Tool } from "ai";

class MockMCPManager {
  private mockTools: Record<string, Tool> = {};
  private shouldThrow = false;

  setMockTools(tools: Record<string, Tool>): void {
    this.mockTools = tools;
  }

  setShouldThrow(shouldThrow: boolean): void {
    this.shouldThrow = shouldThrow;
  }

  async getToolsForServers(serverIds: string[]): Promise<Record<string, Tool>> {
    if (this.shouldThrow) {
      throw new Error("Mock provider error");
    }

    if (serverIds.includes("empty-server")) {
      return {};
    }

    return { ...this.mockTools };
  }
}

class MockToolCache implements ToolCache {
  private cache = new Map<string, readonly Tool[]>();

  get(key: string): readonly Tool[] | undefined {
    return this.cache.get(key);
  }

  set(key: string, tools: readonly Tool[]): void {
    this.cache.set(key, tools);
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// Test tools
const mockTools: Record<string, Tool> = {
  echo_tool: {
    description: "Echo tool for testing",
    parameters: { type: "object", properties: {} } as any,
    execute: async () => ({ result: "echo" }),
  },
  api_call: {
    description: "API call tool",
    parameters: { type: "object", properties: {} } as any,
    execute: async () => ({ result: "api" }),
  },
  dangerous_delete: {
    description: "Dangerous delete operation",
    parameters: { type: "object", properties: {} } as any,
    execute: async () => ({ result: "deleted" }),
  },
};

Deno.test("MCPToolsAdapter Unit Tests", async (t) => {
  await t.step("Constructor and dependency injection", () => {
    const mockManager = new MockMCPManager();
    const mockCache = new MockToolCache();

    const adapter = new MCPToolsAdapter(mockManager, mockCache);
    assertExists(adapter);

    // Should work with default cache
    const adapter2 = new MCPToolsAdapter(mockManager);
    assertExists(adapter2);
  });

  await t.step("Basic tool fetching with Result type", async () => {
    const mockManager = new MockMCPManager();
    mockManager.setMockTools(mockTools);

    const adapter = new MCPToolsAdapter(mockManager);

    const config = {
      mcpServers: ["test-server"],
      cache: { enabled: false },
    };

    const result = await adapter.getTools(config);

    assertEquals(result.success, true);
    if (result.success) {
      assertEquals(result.data.length, 3);

      // Verify tools are immutable
      assertEquals(Object.isFrozen(result.data), true);

      // Verify each tool
      for (const tool of result.data) {
        assertExists(tool.description);
        assertExists(tool.parameters);
        assertExists(tool.execute);
      }
    }
  });

  await t.step("Configuration validation", async () => {
    const mockManager = new MockMCPManager();
    const adapter = new MCPToolsAdapter(mockManager);

    // Invalid config should return error result
    const result1 = await adapter.getTools({
      mcpServers: [""], // Empty server name
    });

    assertEquals(result1.success, false);

    // Valid config should work
    const result2 = await adapter.getTools({
      mcpServers: ["test-server"],
    });

    assertEquals(result2.success, true);
  });

  await t.step("Tool filtering", async () => {
    const mockManager = new MockMCPManager();
    mockManager.setMockTools(mockTools);

    const adapter = new MCPToolsAdapter(mockManager);

    const config = {
      mcpServers: ["test-server"],
      filters: {
        include: [/^echo/, /^api/],
        exclude: [/dangerous/],
      },
      cache: { enabled: false },
    };

    const result = await adapter.getTools(config);

    assertEquals(result.success, true);
    if (result.success) {
      assertEquals(result.data.length, 2); // echo_tool and api_call

      const descriptions = result.data.map((t) => t.description);
      assertEquals(descriptions.includes("Echo tool for testing"), true);
      assertEquals(descriptions.includes("API call tool"), true);
      assertEquals(descriptions.includes("Dangerous delete operation"), false);
    }
  });

  await t.step("Caching behavior", async () => {
    const mockManager = new MockMCPManager();
    mockManager.setMockTools(mockTools);

    const mockCache = new MockToolCache();
    const adapter = new MCPToolsAdapter(mockManager, mockCache);

    const config = {
      mcpServers: ["test-server"],
      cache: { enabled: true },
    };

    // First call should fetch and cache
    const result1 = await adapter.getTools(config);
    assertEquals(result1.success, true);
    assertEquals(mockCache.size(), 1);

    // Second call should use cache
    const result2 = await adapter.getTools(config);
    assertEquals(result2.success, true);

    if (result1.success && result2.success) {
      assertEquals(result1.data.length, result2.data.length);
    }
  });

  await t.step("Cache clearing", async () => {
    const mockManager = new MockMCPManager();
    const mockCache = new MockToolCache();
    const adapter = new MCPToolsAdapter(mockManager, mockCache);

    // Add something to cache
    await adapter.getTools({
      mcpServers: ["test-server"],
      cache: { enabled: true },
    });

    assertEquals(mockCache.size() > 0, true);

    // Clear cache
    adapter.clearCache();
    assertEquals(mockCache.size(), 0);
  });

  await t.step("Cache statistics", () => {
    const mockManager = new MockMCPManager();
    const mockCache = new MockToolCache();
    const adapter = new MCPToolsAdapter(mockManager, mockCache);

    const stats = adapter.getCacheStats();
    assertEquals(typeof stats.size, "number");
    assertEquals(stats.size, 0);
  });

  await t.step("Error handling", async () => {
    const mockManager = new MockMCPManager();
    mockManager.setShouldThrow(true);

    const adapter = new MCPToolsAdapter(mockManager);

    const result = await adapter.getTools({
      mcpServers: ["error-server"],
    });

    assertEquals(result.success, false);
    if (!result.success) {
      assertEquals(result.error instanceof Error, true);
      assertEquals(result.error.message.includes("Mock provider error"), true);
    }
  });

  await t.step("Empty server list", async () => {
    const mockManager = new MockMCPManager();
    const adapter = new MCPToolsAdapter(mockManager);

    const result = await adapter.getTools({
      mcpServers: [],
    });

    assertEquals(result.success, true);
    if (result.success) {
      assertEquals(result.data.length, 0);
    }
  });

  await t.step("Empty tools response", async () => {
    const mockManager = new MockMCPManager();
    const adapter = new MCPToolsAdapter(mockManager);

    const result = await adapter.getTools({
      mcpServers: ["empty-server"],
    });

    assertEquals(result.success, true);
    if (result.success) {
      assertEquals(result.data.length, 0);
    }
  });
});

Deno.test("Factory Functions", async (t) => {
  await t.step("createMCPToolsAdapter factory", () => {
    const adapter = createMCPToolsAdapter();
    assertExists(adapter);

    // Should accept custom MCP manager
    const adapter2 = createMCPToolsAdapter(undefined);
    assertExists(adapter2);
  });

  await t.step("getMCPTools convenience function", async () => {
    // Test with empty servers to avoid MCP dependencies
    const tools = await getMCPTools([]);

    assertEquals(Array.isArray(tools), true);
    assertEquals(tools.length, 0);
    assertEquals(Object.isFrozen(tools), true); // Should be immutable
  });

  await t.step("getMCPTools error handling", async () => {
    let errorThrown = false;

    try {
      // This should fail with invalid config
      await getMCPTools([""], {}); // Empty server name
    } catch (error) {
      errorThrown = true;
      assertEquals(error instanceof Error, true);
    }

    assertEquals(errorThrown, true);
  });
});
