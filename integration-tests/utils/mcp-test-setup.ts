/**
 * Test utilities for MCP server setup and testing
 * Creates a dedicated test MCP server for integration tests
 */

import { experimental_createMCPClient } from "ai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod/v4";
import { findAvailablePort } from "../../src/utils/port-finder.ts";

export interface TestMCPServer {
  server: McpServer;
  port: number;
  url: string;
  shutdown: () => Promise<void>;
}

/**
 * Creates a test MCP server with simple test tools
 */
export async function createTestMCPServer(): Promise<TestMCPServer> {
  // Find available port using Atlas port finder utility
  const port = findAvailablePort();

  // Create MCP server with test tools
  const server = new McpServer({
    name: "test-mcp-server",
    version: "1.0.0",
  });

  // Register simple test tools
  server.registerTool("test_add", {
    title: "Test Addition Tool",
    description: "Add two numbers for testing",
    inputSchema: {
      a: z.number().describe("First number"),
      b: z.number().describe("Second number"),
    },
  }, async ({ a, b }) => ({
    content: [{
      type: "text",
      text: `Result: ${a + b}`,
    }],
  }));

  server.registerTool("test_echo", {
    title: "Test Echo Tool",
    description: "Echo back a message for testing",
    inputSchema: {
      message: z.string().describe("Message to echo"),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Optional metadata"),
    },
  }, async ({ message, metadata }) => ({
    content: [{
      type: "text",
      text: `Echo: ${message}${metadata ? ` (metadata: ${JSON.stringify(metadata)})` : ""}`,
    }],
  }));

  server.registerTool("test_workspace_list", {
    title: "Test Workspace List Tool",
    description: "Return mock workspace data for testing",
    inputSchema: {
      includeSystem: z.boolean().default(false).describe("Include system workspaces"),
    },
  }, async ({ includeSystem }) => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        workspaces: [
          { id: "test-workspace-1", name: "Test Workspace 1", path: "/test/workspace1" },
          { id: "test-workspace-2", name: "Test Workspace 2", path: "/test/workspace2" },
          ...(includeSystem
            ? [{ id: "system-workspace", name: "System", path: "system://test" }]
            : []),
        ],
      }),
    }],
  }));

  // Start server on random port with SSE transport
  const transport = new SSEServerTransport(`/mcp`, { port });
  await server.connect(transport);

  const url = `http://localhost:${port}/mcp`;

  return {
    server,
    port,
    url,
    shutdown: async () => {
      await server.close();
    },
  };
}

/**
 * Creates a test MCP client connected to the test server
 */
export async function createTestMCPClient(serverUrl: string) {
  // Use AI SDK's MCP client with HTTP transport to test server
  const client = await experimental_createMCPClient({
    transport: {
      type: "http",
      url: serverUrl,
    },
  });

  return client;
}

/**
 * Gets tools from the test MCP server using AI SDK's MCP client
 */
export async function getTestMCPTools(serverUrl: string) {
  const client = await createTestMCPClient(serverUrl);
  const tools = await client.tools();
  return tools;
}
