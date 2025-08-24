#!/usr/bin/env -S deno run --allow-all
/**
 * Simple Echo MCP Server for Integration Testing
 *
 * Implements a minimal MCP server with stdio transport for testing the MCP pool.
 * Provides basic echo and text manipulation tools using standard MCP SDK.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Create MCP server
const server = new McpServer({ name: "echo-test-server", version: "1.0.0" });

// Define Zod schemas for tools
const echoSchema = z.object({
  message: z.string().describe("The message to echo back"),
  prefix: z.string().optional().describe("Optional prefix to add"),
});

// Register echo tool
server.registerTool(
  "echo",
  { title: "Echo", description: "Echo back the provided message", inputSchema: echoSchema.shape },
  async (args) => {
    const { message, prefix } = echoSchema.parse(args);
    const result = prefix ? `${prefix}: ${message}` : message;
    return { content: [{ type: "text", text: result }] };
  },
);

const reverseSchema = z.object({ text: z.string().describe("The text to reverse") });

// Register reverse tool
server.registerTool(
  "reverse",
  { title: "Reverse", description: "Reverse the provided text", inputSchema: reverseSchema.shape },
  async (args) => {
    const { text } = reverseSchema.parse(args);
    const reversed = text.split("").reverse().join("");
    return { content: [{ type: "text", text: reversed }] };
  },
);

const uppercaseSchema = z.object({ text: z.string().describe("The text to convert to uppercase") });

// Register uppercase tool
server.registerTool(
  "uppercase",
  {
    title: "Uppercase",
    description: "Convert text to uppercase",
    inputSchema: uppercaseSchema.shape,
  },
  async (args) => {
    const { text } = uppercaseSchema.parse(args);
    return { content: [{ type: "text", text: text.toUpperCase() }] };
  },
);

// Start server with stdio transport
if (import.meta.main) {
  try {
    // Create and connect stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Handle graceful shutdown
    const handleShutdown = () => {
      console.error("Echo MCP server shutting down");
      Deno.exit(0);
    };

    // Listen for termination signals
    Deno.addSignalListener("SIGINT", handleShutdown);
    Deno.addSignalListener("SIGTERM", handleShutdown);

    // Also handle stdin close (when parent process closes stdio)
    addEventListener("unload", handleShutdown);
  } catch (error) {
    console.error("Echo MCP server failed to start:", error);
    Deno.exit(1);
  }
}
