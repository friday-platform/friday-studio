/**
 * MCP Configuration Schema Validation Tests
 * Tests for type-safe MCP server configuration using Zod schemas
 */

import { expect } from "@std/expect";
import {
  MCPAuthConfigSchema,
  MCPServerConfigSchema,
  MCPToolsConfigSchema,
  MCPTransportConfigSchema,
} from "../../../src/core/agents/mcp/mcp-manager.ts";

Deno.test({
  name: "MCP Configuration - Valid SSE Transport",
  fn() {
    const sseConfig = {
      id: "weather-api",
      transport: {
        type: "sse",
        url: "https://weather-api.example.com/mcp",
      },
      auth: {
        type: "bearer",
        token_env: "WEATHER_TOKEN",
      },
      tools: {
        allowed: ["get_weather"],
      },
      timeout_ms: 30000,
    };

    // Should parse without errors
    const result = MCPServerConfigSchema.safeParse(sseConfig);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.transport.type).toBe("sse");
      if (result.data.transport.type === "sse") {
        expect(result.data.transport.url).toBe(
          "https://weather-api.example.com/mcp",
        );
      }
    }
  },
});

Deno.test({
  name: "MCP Configuration - Valid Stdio Transport",
  fn() {
    const stdioConfig = {
      id: "local-tools",
      transport: {
        type: "stdio",
        command: "node",
        args: ["./tools/local-server.js"],
      },
      tools: {
        allowed: ["file_read", "file_write"],
      },
    };

    const result = MCPServerConfigSchema.safeParse(stdioConfig);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.transport.type).toBe("stdio");
      if (result.data.transport.type === "stdio") {
        expect(result.data.transport.command).toBe("node");
        expect(result.data.transport.args).toEqual(["./tools/local-server.js"]);
      }
    }
  },
});

Deno.test({
  name: "MCP Configuration - Invalid Transport Type",
  fn() {
    const invalidConfig = {
      id: "bad-server",
      transport: {
        type: "invalid_transport",
        url: "https://example.com",
      },
    };

    const result = MCPServerConfigSchema.safeParse(invalidConfig);
    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  },
});

Deno.test({
  name: "MCP Configuration - SSE Cannot Have Command",
  fn() {
    const invalidSSEConfig = {
      type: "sse",
      url: "https://example.com/mcp",
      command: "node", // This should fail
    };

    const result = MCPTransportConfigSchema.safeParse(invalidSSEConfig);
    expect(result.success).toBe(false);
  },
});

Deno.test({
  name: "MCP Configuration - Stdio Cannot Have URL",
  fn() {
    const invalidStdioConfig = {
      type: "stdio",
      command: "node",
      url: "https://example.com", // This should fail
    };

    const result = MCPTransportConfigSchema.safeParse(invalidStdioConfig);
    expect(result.success).toBe(false);
  },
});

Deno.test({
  name: "MCP Configuration - Tool Filtering Validation",
  fn() {
    const toolsConfig = {
      allowed: ["get_weather", "get_forecast"],
      denied: ["delete_data", "system_exec"],
    };

    const result = MCPToolsConfigSchema.safeParse(toolsConfig);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.allowed).toEqual(["get_weather", "get_forecast"]);
      expect(result.data.denied).toEqual(["delete_data", "system_exec"]);
    }
  },
});

Deno.test({
  name: "MCP Configuration - Authentication Validation",
  fn() {
    const authConfigs = [
      {
        type: "bearer",
        token_env: "API_TOKEN",
      },
      {
        type: "api_key",
        token_env: "API_KEY",
        header: "X-API-Key",
      },
    ];

    for (const authConfig of authConfigs) {
      const result = MCPAuthConfigSchema.safeParse(authConfig);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.type).toBe(authConfig.type);
        expect(result.data.token_env).toBe(authConfig.token_env);
      }
    }
  },
});

Deno.test({
  name: "MCP Configuration - Default Values",
  fn() {
    const minimalConfig = {
      id: "minimal-server",
      transport: {
        type: "sse",
        url: "https://example.com/mcp",
      },
    };

    const result = MCPServerConfigSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.timeout_ms).toBe(30000); // Default value
    }
  },
});

Deno.test({
  name: "MCP Configuration - Type Safety Examples",
  fn() {
    // These examples demonstrate TypeScript compile-time type safety
    // (shown as runtime validation since we can't test compile-time in Deno.test)

    // Valid configurations
    const validSSE = {
      type: "sse" as const,
      url: "https://api.example.com/mcp",
    };

    const validStdio = {
      type: "stdio" as const,
      command: "python",
      args: ["-m", "my_mcp_server"],
    };

    expect(MCPTransportConfigSchema.safeParse(validSSE).success).toBe(true);
    expect(MCPTransportConfigSchema.safeParse(validStdio).success).toBe(true);

    // Invalid configurations would fail TypeScript compilation in real code
    const invalidMixed = {
      type: "sse" as const,
      url: "https://api.example.com/mcp",
      command: "node", // TypeScript would prevent this
    };

    // At runtime, Zod validation catches these errors
    expect(MCPTransportConfigSchema.safeParse(invalidMixed).success).toBe(
      false,
    );
  },
});
