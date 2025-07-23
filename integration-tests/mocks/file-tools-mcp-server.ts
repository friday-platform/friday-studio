#!/usr/bin/env -S deno run --allow-all

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const callHistory: Array<{ tool: string; timestamp: number }> = [];

function detectFeedbackLoop(toolName: string): void {
  const call = { tool: toolName, timestamp: Date.now() };
  callHistory.push(call);

  const recentCalls = callHistory.filter(
    (c) => c.timestamp > Date.now() - 1000 && c.tool === toolName,
  );

  if (recentCalls.length > 5) {
    throw new Error(`Feedback loop detected: ${toolName}`);
  }
}

const server = new McpServer({
  name: "file-tools-mock-server",
  version: "1.0.0",
});

// Register file tools with Zod schemas
server.registerTool(
  "file_read",
  {
    description: "Read file contents",
    inputSchema: {
      path: z.string().describe("Path to the file to read"),
    },
  },
  ({ path }) => {
    detectFeedbackLoop("file_read");

    return {
      content: [
        {
          type: "text",
          text: `Mock file contents for: ${path}`,
        },
      ],
    };
  },
);

server.registerTool(
  "file_write",
  {
    description: "Write file contents",
    inputSchema: {
      path: z.string().describe("Path to the file to write"),
      content: z.string().describe("Content to write to the file"),
    },
  },
  ({ path, content: _content }) => {
    detectFeedbackLoop("file_write");

    return {
      content: [
        {
          type: "text",
          text: `Successfully wrote to file: ${path}`,
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
console.error("File Tools MCP Server running on stdio");
