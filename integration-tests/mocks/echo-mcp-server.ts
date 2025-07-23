#!/usr/bin/env -S deno run --allow-all

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const server = new McpServer({
  name: "echo-server",
  version: "1.0.0",
});

// Register echo tool with Zod schema
server.registerTool(
  "echo",
  {
    description: "Echo back the input",
    inputSchema: {
      message: z.string().describe("Message to echo back"),
    },
  },
  ({ message }) => {
    return {
      content: [
        { type: "text", text: message },
      ],
    };
  },
);

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
console.error("Echo MCP Server running on stdio");
