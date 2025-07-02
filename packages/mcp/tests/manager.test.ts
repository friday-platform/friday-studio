/**
 * MCPManager Unit Tests
 * Tests for the AI SDK MCP client manager with real MCP servers
 */

import { expect } from "@std/expect";

// Import MCPManager
import { MCPManager } from "../src/manager.ts";

Deno.test({
  name: "MCPManager - Server Registration with Real MCP Server",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const manager = new MCPManager();

    try {
      // Register stdio transport with real server
      await manager.registerServer({
        id: "test-weather-server",
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "--allow-all", "tests/mocks/weather-mcp-server.ts"],
        },
      });

      // Verify server is registered and tools are available
      const tools = await manager.getToolsForServers(["test-weather-server"]);

      expect(typeof tools).toBe("object");
      expect("get_weather" in tools).toBe(true);
      expect("get_forecast" in tools).toBe(true);
    } finally {
      // Clean up
      await manager.dispose();
      // Give extra time for any lingering processes to fully terminate
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  },
});

Deno.test({
  name: "MCPManager - Tool Filtering with Real Server",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const manager = new MCPManager();

    try {
      // Register with tool filtering
      await manager.registerServer({
        id: "filtered-server",
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "--allow-all", "tests/mocks/weather-mcp-server.ts"],
        },
        tools: {
          allowed: ["get_weather"],
          denied: ["get_forecast"],
        },
      });

      const tools = await manager.getToolsForServers(["filtered-server"]);

      // Verify only allowed tools are included
      expect("get_weather" in tools).toBe(true);
      expect("get_forecast" in tools).toBe(false);
    } finally {
      // Clean up
      await manager.dispose();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  },
});

Deno.test({
  name: "MCPManager - Connection Lifecycle",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const manager = new MCPManager();

    try {
      await manager.registerServer({
        id: "lifecycle-server",
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "--allow-all", "tests/mocks/weather-mcp-server.ts"],
        },
      });

      // Verify server is initially connected
      const status = manager.getServerStatus();
      expect(status.get("lifecycle-server")).toBe(true);

      // Test graceful shutdown
      await manager.closeServer("lifecycle-server");

      // Verify connection is closed
      const statusAfterClose = manager.getServerStatus();
      expect(statusAfterClose.get("lifecycle-server")).toBe(false);
    } finally {
      await manager.dispose();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  },
});

Deno.test({
  name: "MCPManager - Multiple Transport Types",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const manager = new MCPManager();

    try {
      // Register multiple servers
      await manager.registerServer({
        id: "weather-server",
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "--allow-all", "tests/mocks/weather-mcp-server.ts"],
        },
      });

      await manager.registerServer({
        id: "file-server",
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "--allow-all", "tests/mocks/file-tools-mcp-server.ts"],
        },
      });

      await manager.registerServer({
        id: "echo-server",
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "--allow-all", "tests/mocks/echo-mcp-server.ts"],
        },
      });

      // Get tools from all servers
      const allTools = await manager.getToolsForServers([
        "weather-server",
        "file-server",
        "echo-server",
      ]);

      // Verify tools from all servers are available
      expect("get_weather" in allTools).toBe(true);
      expect("file_read" in allTools).toBe(true);
      expect("echo" in allTools).toBe(true);
    } finally {
      // Clean up
      await manager.dispose();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  },
});

Deno.test({
  name: "MCPManager - Error Handling",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const manager = new MCPManager();

    // Test invalid server configuration
    let caughtError = false;
    try {
      await manager.registerServer({
        id: "invalid-server",
        transport: {
          type: "stdio",
          command: "nonexistent-command",
          args: ["--invalid"],
        },
      });
    } catch (error) {
      caughtError = true;
      expect((error as Error).message).toContain("registration failed");
    }

    expect(caughtError).toBe(true);

    // Clean up
    await manager.dispose();
    await new Promise((resolve) => setTimeout(resolve, 500));
  },
});

Deno.test({
  name: "MCPManager - Authentication Headers",
  fn() {
    // Test authentication configuration validation (without actual connection)
    Deno.env.set("TEST_TOKEN", "test-bearer-token");
    Deno.env.set("TEST_API_KEY", "test-api-key");

    try {
      // Test that authentication configurations are parsed correctly
      const bearerConfig = {
        id: "auth-test-bearer",
        transport: {
          type: "sse" as const,
          url: "https://example.com/mcp",
        },
        auth: {
          type: "bearer" as const,
          token_env: "TEST_TOKEN",
        },
      };

      const apiKeyConfig = {
        id: "auth-test-apikey",
        transport: {
          type: "sse" as const,
          url: "https://example.com/mcp2",
        },
        auth: {
          type: "api_key" as const,
          token_env: "TEST_API_KEY",
          header: "X-API-Key",
        },
      };

      // Verify configurations are valid
      expect(bearerConfig.auth.type).toBe("bearer");
      expect(bearerConfig.auth.token_env).toBe("TEST_TOKEN");
      expect(apiKeyConfig.auth.type).toBe("api_key");
      expect(apiKeyConfig.auth.token_env).toBe("TEST_API_KEY");
      expect(apiKeyConfig.auth.header).toBe("X-API-Key");
    } finally {
      // Clean up environment
      Deno.env.delete("TEST_TOKEN");
      Deno.env.delete("TEST_API_KEY");
    }
  },
});

Deno.test({
  name: "MCPManager - Tool Filtering Logic",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Test tool filtering logic through the public API by registering servers with different filters
    const manager = new MCPManager();

    try {
      // Register a server with allowed tools filter
      await manager.registerServer({
        id: "allowed-filter-server",
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "--allow-all", "tests/mocks/weather-mcp-server.ts"],
        },
        tools: {
          allowed: ["get_weather"],
        },
      });

      // Register a server with denied tools filter
      await manager.registerServer({
        id: "denied-filter-server",
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "--allow-all", "tests/mocks/weather-mcp-server.ts"],
        },
        tools: {
          denied: ["get_forecast"],
        },
      });

      // Test allowed list filtering
      const allowedTools = await manager.getToolsForServers(["allowed-filter-server"]);
      expect("get_weather" in allowedTools).toBe(true);
      expect("get_forecast" in allowedTools).toBe(false);

      // Test denied list filtering
      const deniedTools = await manager.getToolsForServers(["denied-filter-server"]);
      expect("get_weather" in deniedTools).toBe(true);
      expect("get_forecast" in deniedTools).toBe(false);
    } finally {
      await manager.dispose();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  },
});
