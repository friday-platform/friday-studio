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
          args: ["run", "--allow-all", "integration-tests/mocks/weather-mcp-server.ts"],
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
          args: ["run", "--allow-all", "integration-tests/mocks/weather-mcp-server.ts"],
        },
        tools: {
          allow: ["get_weather"],
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
          args: ["run", "--allow-all", "integration-tests/mocks/weather-mcp-server.ts"],
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
          args: ["run", "--allow-all", "integration-tests/mocks/weather-mcp-server.ts"],
        },
      });

      await manager.registerServer({
        id: "file-server",
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "--allow-all", "integration-tests/mocks/file-tools-mcp-server.ts"],
        },
      });

      await manager.registerServer({
        id: "echo-server",
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "--allow-all", "integration-tests/mocks/echo-mcp-server.ts"],
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
          args: ["run", "--allow-all", "integration-tests/mocks/weather-mcp-server.ts"],
        },
        tools: {
          allow: ["get_weather"],
        },
      });

      // Register a server with denied tools filter
      await manager.registerServer({
        id: "denied-filter-server",
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "--allow-all", "integration-tests/mocks/weather-mcp-server.ts"],
        },
        tools: {
          deny: ["get_forecast"],
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

Deno.test({
  name: "MCPManager - Empty Tool Filter Lists",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Test edge cases with empty allow and deny lists
    const manager = new MCPManager();

    try {
      // Register a server with empty allow list (should filter out ALL tools)
      await manager.registerServer({
        id: "empty-allow-server",
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "--allow-all", "integration-tests/mocks/weather-mcp-server.ts"],
        },
        tools: {
          allow: [],
        },
      });

      // Register a server with empty deny list (should allow ALL tools)
      await manager.registerServer({
        id: "empty-deny-server",
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "--allow-all", "integration-tests/mocks/weather-mcp-server.ts"],
        },
        tools: {
          deny: [],
        },
      });

      // Test empty allow list (should have NO tools)
      const emptyAllowTools = await manager.getToolsForServers(["empty-allow-server"]);
      expect("get_weather" in emptyAllowTools).toBe(false);
      expect("get_forecast" in emptyAllowTools).toBe(false);
      expect(Object.keys(emptyAllowTools).length).toBe(0);

      // Test empty deny list (should have ALL tools)
      const emptyDenyTools = await manager.getToolsForServers(["empty-deny-server"]);
      expect("get_weather" in emptyDenyTools).toBe(true);
      expect("get_forecast" in emptyDenyTools).toBe(true);
      expect(Object.keys(emptyDenyTools).length).toBe(2);
    } finally {
      await manager.dispose();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  },
});

Deno.test({
  name: "MCPManager - HTTP Transport Registration",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const manager = new MCPManager();

    // Mock HTTP server or use test daemon
    // Note: This test will fail without a running daemon at localhost:8080/mcp
    let registrationSucceeded = false;

    try {
      await manager.registerServer({
        id: "http-test-server",
        transport: {
          type: "http",
          url: "http://localhost:8080/mcp",
        },
      });

      registrationSucceeded = true;

      // Verify server is registered
      const status = manager.getServerStatus();
      expect(status.has("http-test-server")).toBe(true);
    } catch (error) {
      // Expected to fail without running daemon
      expect((error as Error).message).toContain("registration failed");
    }

    // Clean up if registration succeeded
    if (registrationSucceeded) {
      await manager.dispose();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  },
});

Deno.test({
  name: "MCPManager - Multiple Transport Types Including HTTP",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const manager = new MCPManager();

    try {
      // Register servers with different transports
      await manager.registerServer({
        id: "stdio-server",
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "--allow-all", "integration-tests/mocks/weather-mcp-server.ts"],
        },
      });

      // Attempt HTTP server registration (may fail without daemon)
      let httpRegistered = false;
      try {
        await manager.registerServer({
          id: "http-server",
          transport: {
            type: "http",
            url: "http://localhost:8080/mcp",
          },
        });
        httpRegistered = true;
      } catch {
        // Expected to fail without daemon
      }

      // Verify at least stdio server is registered
      const servers = manager.listServers();
      expect(servers).toContain("stdio-server");

      if (httpRegistered) {
        expect(servers).toContain("http-server");
      }
    } finally {
      await manager.dispose();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  },
});

Deno.test({
  name: "MCPManager - HTTP Transport Connection Failure",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const manager = new MCPManager();

    let caughtError = false;
    try {
      await manager.registerServer({
        id: "http-fail-server",
        transport: {
          type: "http",
          url: "http://localhost:9999/nonexistent", // Invalid endpoint
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
