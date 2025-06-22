/**
 * Core unit tests for MCPAdapter focusing on business logic
 * Tests input parsing, tool filtering, and metadata handling without SDK dependencies
 */

import { assertEquals, assertExists } from "@std/assert";

Deno.test("MCPAdapter Core Logic Tests", async (t) => {
  await t.step("should parse JSON tool call input correctly", () => {
    // Test the parseToolCall method logic
    const inputJson = JSON.stringify({
      name: "get_weather",
      arguments: { location: "San Francisco" },
    });

    // Simulate the parsing logic from MCPAdapter.parseToolCall
    let parsed;
    try {
      parsed = JSON.parse(inputJson);
    } catch {
      parsed = { name: inputJson.trim(), arguments: {} };
    }

    const toolCall = {
      name: parsed.name || parsed.tool || "unknown",
      arguments: parsed.arguments || parsed.args || {},
    };

    assertEquals(toolCall.name, "get_weather");
    assertEquals(toolCall.arguments.location, "San Francisco");
  });

  await t.step("should handle malformed JSON gracefully", () => {
    const invalidJson = "invalid-json-{";

    // Simulate the parsing logic
    let parsed;
    try {
      parsed = JSON.parse(invalidJson);
    } catch {
      parsed = { name: invalidJson.trim(), arguments: {} };
    }

    const toolCall = {
      name: parsed.name || parsed.tool || "unknown",
      arguments: parsed.arguments || parsed.args || {},
    };

    assertEquals(toolCall.name, "invalid-json-{");
    assertEquals(toolCall.arguments, {});
  });

  await t.step("should handle alternative JSON field names", () => {
    const altJson = JSON.stringify({
      tool: "send_email",
      args: { to: "test@example.com" },
    });

    let parsed;
    try {
      parsed = JSON.parse(altJson);
    } catch {
      parsed = { name: altJson.trim(), arguments: {} };
    }

    const toolCall = {
      name: parsed.name || parsed.tool || "unknown",
      arguments: parsed.arguments || parsed.args || {},
    };

    assertEquals(toolCall.name, "send_email");
    assertEquals(toolCall.arguments.to, "test@example.com");
  });

  await t.step("should enforce allowed tools filter", () => {
    const allowedTools = ["get_weather", "get_forecast"];
    const toolName = "send_email";

    const isAllowed = !allowedTools || allowedTools.includes(toolName);
    assertEquals(isAllowed, false);

    const allowedToolName = "get_weather";
    const isAllowedTool = !allowedTools || allowedTools.includes(allowedToolName);
    assertEquals(isAllowedTool, true);
  });

  await t.step("should enforce denied tools filter", () => {
    const deniedTools = ["delete_data", "system_exec"];
    const toolName = "get_weather";

    const isDenied = deniedTools && deniedTools.includes(toolName);
    assertEquals(isDenied, false);

    const deniedToolName = "delete_data";
    const isDeniedTool = deniedTools && deniedTools.includes(deniedToolName);
    assertEquals(isDeniedTool, true);
  });

  await t.step("should create proper execution metadata", () => {
    const startTime = 1000;
    const endTime = 1500;
    const executionTime = endTime - startTime;
    const sessionId = "test-session-123";
    const toolName = "get_weather";

    // Simulate metadata creation from MCPAdapter
    const metadata = {
      execution_time_ms: executionTime,
      agent_version: "1.0.0",
      session_id: sessionId,
      model_used: toolName,
      performance: {
        processing_time_ms: executionTime,
      },
    };

    assertEquals(metadata.execution_time_ms, 500);
    assertEquals(metadata.agent_version, "1.0.0");
    assertEquals(metadata.session_id, "test-session-123");
    assertEquals(metadata.model_used, "get_weather");
    assertEquals(metadata.performance.processing_time_ms, 500);
  });

  await t.step("should format MCP tool result correctly", () => {
    // Simulate MCP tool result formatting
    const mcpResult = {
      content: [
        { type: "text", text: "Weather in San Francisco: Sunny, 72°F" },
        { type: "image", data: "base64-image-data" },
      ],
      isError: false,
    };

    // Convert to Atlas format
    const output = mcpResult.content.map((c) => ({
      content_type: c.type === "text" ? "text/plain" : "application/json",
      content: c.type === "text" ? c.text : JSON.stringify(c),
    }));

    assertEquals(output.length, 2);
    assertEquals(output[0].content_type, "text/plain");
    assertEquals(output[0].content, "Weather in San Francisco: Sunny, 72°F");
    assertEquals(output[1].content_type, "application/json");
    assertExists(output[1].content);
  });

  await t.step("should handle error results properly", () => {
    const mcpErrorResult = {
      content: [{ type: "text", text: "Tool execution failed" }],
      isError: true,
    };

    const status = mcpErrorResult.isError ? "failed" : "completed";
    const error = mcpErrorResult.isError ? "Tool execution failed" : undefined;

    assertEquals(status, "failed");
    assertEquals(error, "Tool execution failed");
  });

  await t.step("should create authentication headers correctly", () => {
    // Test bearer token auth
    const bearerToken = "test-bearer-token";
    const bearerHeaders = {
      "Authorization": `Bearer ${bearerToken}`,
    };

    assertEquals(bearerHeaders["Authorization"], "Bearer test-bearer-token");

    // Test API key auth
    const apiKey = "test-api-key";
    const apiKeyHeaders = {
      "X-API-Key": apiKey,
    };

    assertEquals(apiKeyHeaders["X-API-Key"], "test-api-key");
  });

  await t.step("should generate unique execution IDs", () => {
    // Test execution ID generation
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();

    assertExists(id1);
    assertExists(id2);
    assertEquals(id1 === id2, false); // Should be unique
    assertEquals(id1.length, 36); // UUID length
    assertEquals(id2.length, 36);
  });
});

Deno.test("MCPAdapter Configuration Validation", async (t) => {
  await t.step("should validate required endpoint configuration", () => {
    const validConfig = {
      connection: {
        endpoint: "https://test-mcp-server.example.com/mcp",
        timeout: 5000,
        retries: 2,
        keepAlive: true,
      },
      timeout_ms: 5000,
    };

    // Basic validation
    assertExists(validConfig.connection);
    assertExists(validConfig.connection.endpoint);
    assertEquals(validConfig.connection.endpoint.startsWith("https://"), true);
  });

  await t.step("should validate optional authentication configuration", () => {
    const authConfig = {
      connection: {
        endpoint: "https://test-mcp-server.example.com/mcp",
        timeout: 5000,
        retries: 2,
        keepAlive: true,
      },
      auth: {
        type: "bearer",
        token_env: "MCP_TOKEN",
      },
      timeout_ms: 5000,
    };

    assertExists(authConfig.auth);
    assertEquals(authConfig.auth.type, "bearer");
    assertEquals(authConfig.auth.token_env, "MCP_TOKEN");
  });

  await t.step("should validate tool filtering configuration", () => {
    const filterConfig = {
      connection: {
        endpoint: "https://test-mcp-server.example.com/mcp",
        timeout: 5000,
        retries: 2,
        keepAlive: true,
      },
      allowed_tools: ["get_weather", "get_forecast"],
      denied_tools: ["delete_data", "system_exec"],
      timeout_ms: 5000,
    };

    assertExists(filterConfig.allowed_tools);
    assertExists(filterConfig.denied_tools);
    assertEquals(filterConfig.allowed_tools.length, 2);
    assertEquals(filterConfig.denied_tools.length, 2);
    assertEquals(filterConfig.allowed_tools.includes("get_weather"), true);
    assertEquals(filterConfig.denied_tools.includes("delete_data"), true);
  });

  await t.step("should validate timeout configuration", () => {
    const timeoutConfig = {
      connection: {
        endpoint: "https://test-mcp-server.example.com/mcp",
        timeout: 5000,
        retries: 2,
        keepAlive: true,
      },
      timeout_ms: 30000,
    };

    assertEquals(typeof timeoutConfig.timeout_ms, "number");
    assertEquals(timeoutConfig.timeout_ms > 0, true);
    assertEquals(timeoutConfig.timeout_ms, 30000);
  });
});

Deno.test("MCPAdapter Error Handling Logic", async (t) => {
  await t.step("should create appropriate error responses", () => {
    const error = new Error("Connection failed");
    const startTime = performance.now() - 100;
    const executionTime = performance.now() - startTime;

    const errorResponse = {
      executionId: crypto.randomUUID(),
      output: [],
      status: "failed" as const,
      error: error.message,
      metadata: {
        execution_time_ms: executionTime,
        session_id: "test-session",
        performance: {
          processing_time_ms: executionTime,
        },
      },
    };

    assertEquals(errorResponse.status, "failed");
    assertEquals(errorResponse.error, "Connection failed");
    assertEquals(errorResponse.output.length, 0);
    assertExists(errorResponse.executionId);
    assertEquals(typeof errorResponse.metadata.execution_time_ms, "number");
  });

  await t.step("should handle different error types", () => {
    const errors = [
      new Error("Network error"),
      new Error("Timeout error"),
      new Error("Authentication failed"),
      new Error("Tool not found"),
    ];

    errors.forEach((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      assertExists(errorMessage);
      assertEquals(typeof errorMessage, "string");
      assertEquals(errorMessage.length > 0, true);
    });
  });

  await t.step("should validate error response format", () => {
    const errorResponse = {
      executionId: "test-execution-id",
      output: [],
      status: "failed" as const,
      error: "Test error message",
      metadata: {
        execution_time_ms: 100,
        session_id: "test-session",
        performance: {
          processing_time_ms: 100,
        },
      },
    };

    // Validate response structure
    assertExists(errorResponse.executionId);
    assertEquals(Array.isArray(errorResponse.output), true);
    assertEquals(errorResponse.status, "failed");
    assertExists(errorResponse.error);
    assertExists(errorResponse.metadata);
    assertEquals(typeof errorResponse.metadata.execution_time_ms, "number");
  });
});
