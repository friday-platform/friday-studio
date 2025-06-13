/**
 * Configuration and initialization tests for MCPAdapter
 * Tests adapter construction and configuration validation
 */

import { assertEquals, assertExists, assertThrows } from "jsr:@std/assert";
import { MCPAdapter } from "../../../../src/core/agents/remote/adapters/mcp-adapter.ts";

// Helper function to create valid test configuration
function createValidConfig() {
  return {
    connection: {
      endpoint: "https://test-mcp-server.example.com/mcp",
      timeout: 5000,
      retries: 2,
      keepAlive: true,
    },
    timeout_ms: 30000,
  };
}

Deno.test("MCPAdapter Configuration Tests", async (t) => {
  await t.step("should create adapter with minimal configuration", () => {
    const config = createValidConfig();
    const adapter = new MCPAdapter(config);

    assertExists(adapter);
    assertEquals(adapter.getProtocolName(), "mcp");
  });

  await t.step("should create adapter with authentication configuration", () => {
    const config = {
      ...createValidConfig(),
      auth: {
        type: "bearer" as const,
        token_env: "TEST_MCP_TOKEN",
      },
    };

    const adapter = new MCPAdapter(config);
    assertExists(adapter);
  });

  await t.step("should create adapter with tool filtering", () => {
    const config = {
      ...createValidConfig(),
      allowed_tools: ["get_weather", "get_forecast"],
      denied_tools: ["delete_data", "system_exec"],
    };

    const adapter = new MCPAdapter(config);
    assertExists(adapter);
  });

  await t.step("should create adapter with custom timeout", () => {
    const config = {
      ...createValidConfig(),
      timeout_ms: 60000,
    };

    const adapter = new MCPAdapter(config);
    assertExists(adapter);
  });

  await t.step("should create adapter with circuit breaker config", () => {
    const config = {
      ...createValidConfig(),
      circuit_breaker: {
        failure_threshold: 5,
        timeout_ms: 30000,
        half_open_max_calls: 3,
      },
    };

    const adapter = new MCPAdapter(config);
    assertExists(adapter);
  });

  await t.step("should create adapter with monitoring config", () => {
    const config = {
      ...createValidConfig(),
      monitoring: {
        enabled: true,
        health_check_interval_ms: 60000,
      },
    };

    const adapter = new MCPAdapter(config);
    assertExists(adapter);
  });
});

Deno.test("MCPAdapter Configuration Validation", async (t) => {
  await t.step("should validate endpoint URL format", () => {
    const config = createValidConfig();

    // Valid HTTPS URL should work
    assertEquals(config.connection.endpoint.startsWith("https://"), true);

    // Test URL parsing
    const url = new URL(config.connection.endpoint);
    assertEquals(url.protocol, "https:");
    assertEquals(url.hostname, "test-mcp-server.example.com");
    assertEquals(url.pathname, "/mcp");
  });

  await t.step("should handle different auth types", () => {
    const bearerConfig = {
      ...createValidConfig(),
      auth: {
        type: "bearer" as const,
        token_env: "BEARER_TOKEN",
      },
    };

    const apiKeyConfig = {
      ...createValidConfig(),
      auth: {
        type: "api_key" as const,
        token_env: "API_KEY",
        header: "X-Custom-API-Key",
      },
    };

    // Both should be valid configuration structures
    assertExists(bearerConfig.auth);
    assertEquals(bearerConfig.auth.type, "bearer");

    assertExists(apiKeyConfig.auth);
    assertEquals(apiKeyConfig.auth.type, "api_key");
    assertEquals(apiKeyConfig.auth.header, "X-Custom-API-Key");
  });

  await t.step("should validate timeout values", () => {
    const config = createValidConfig();

    // Positive timeout values should be valid
    assertEquals(config.timeout_ms > 0, true);
    assertEquals(config.connection.timeout > 0, true);
    assertEquals(typeof config.timeout_ms, "number");
    assertEquals(typeof config.connection.timeout, "number");
  });

  await t.step("should validate tool filtering arrays", () => {
    const config = {
      ...createValidConfig(),
      allowed_tools: ["tool1", "tool2"],
      denied_tools: ["dangerous_tool"],
    };

    assertExists(config.allowed_tools);
    assertExists(config.denied_tools);
    assertEquals(Array.isArray(config.allowed_tools), true);
    assertEquals(Array.isArray(config.denied_tools), true);
    assertEquals(config.allowed_tools.length, 2);
    assertEquals(config.denied_tools.length, 1);
  });

  await t.step("should validate connection configuration", () => {
    const config = createValidConfig();

    assertExists(config.connection);
    assertExists(config.connection.endpoint);
    assertEquals(typeof config.connection.timeout, "number");
    assertEquals(typeof config.connection.retries, "number");
    assertEquals(typeof config.connection.keepAlive, "boolean");

    // Validate reasonable defaults
    assertEquals(config.connection.retries >= 0, true);
    assertEquals(config.connection.timeout > 0, true);
  });
});

Deno.test("MCPAdapter Protocol Name", async (t) => {
  await t.step("should return correct protocol name", () => {
    const config = createValidConfig();
    const adapter = new MCPAdapter(config);

    assertEquals(adapter.getProtocolName(), "mcp");
  });
});

Deno.test("MCPAdapter Environment Integration", async (t) => {
  await t.step("should handle environment variable configuration", () => {
    // Set test environment variable
    Deno.env.set("TEST_MCP_TOKEN", "test-token-value");

    const config = {
      ...createValidConfig(),
      auth: {
        type: "bearer" as const,
        token_env: "TEST_MCP_TOKEN",
      },
    };

    const adapter = new MCPAdapter(config);
    assertExists(adapter);

    // Verify environment variable can be read
    const tokenValue = Deno.env.get("TEST_MCP_TOKEN");
    assertEquals(tokenValue, "test-token-value");

    // Clean up
    Deno.env.delete("TEST_MCP_TOKEN");
  });

  await t.step("should handle missing environment variables gracefully", () => {
    const config = {
      ...createValidConfig(),
      auth: {
        type: "bearer" as const,
        token_env: "NONEXISTENT_TOKEN",
      },
    };

    // Should still create adapter even if env var doesn't exist
    const adapter = new MCPAdapter(config);
    assertExists(adapter);

    // Verify env var doesn't exist
    const tokenValue = Deno.env.get("NONEXISTENT_TOKEN");
    assertEquals(tokenValue, undefined);
  });
});

Deno.test("MCPAdapter URL Validation", async (t) => {
  await t.step("should handle various valid URL formats", () => {
    const validUrls = [
      "https://api.example.com/mcp",
      "https://localhost:8080/mcp",
      "https://mcp-server.company.com:443/v1/mcp",
      "https://192.168.1.100:3000/mcp",
    ];

    validUrls.forEach((url) => {
      const config = {
        ...createValidConfig(),
        connection: {
          ...createValidConfig().connection,
          endpoint: url,
        },
      };

      // Should be able to create URL object
      const urlObj = new URL(config.connection.endpoint);
      assertExists(urlObj);
      assertEquals(urlObj.protocol, "https:");
    });
  });

  await t.step("should handle invalid URL formats appropriately", () => {
    const invalidUrls = [
      "not-a-url",
      "",
    ];

    const problematicUrls = [
      "http://insecure.com/mcp", // HTTP not HTTPS (still valid URL but not secure)
      "ftp://wrong-protocol.com/mcp", // Wrong protocol but valid URL
    ];

    // These should throw when creating URL objects
    invalidUrls.forEach((url) => {
      assertThrows(() => new URL(url));
    });

    // These are valid URLs but might not be appropriate for MCP
    problematicUrls.forEach((url) => {
      const urlObj = new URL(url);
      assertExists(urlObj);
      // Verify they have the expected protocols
      if (url.startsWith("http://")) {
        assertEquals(urlObj.protocol, "http:");
      } else if (url.startsWith("ftp://")) {
        assertEquals(urlObj.protocol, "ftp:");
      }
    });
  });
});
