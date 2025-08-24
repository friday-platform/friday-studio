#!/usr/bin/env -S deno run --allow-all

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-server", version: "1.0.0" });

// Register echo tool with Zod schema
server.registerTool(
  "echo",
  {
    description: "Echo back the input",
    inputSchema: { message: z.string().describe("Message to echo back") },
  },
  ({ message }) => {
    return { content: [{ type: "text", text: message }] };
  },
);

// Register reverse tool
server.registerTool(
  "reverse",
  {
    description: "Reverse a string",
    inputSchema: { text: z.string().describe("Text to reverse") },
  },
  ({ text }) => {
    return { content: [{ type: "text", text: text.split("").reverse().join("") }] };
  },
);

// Register uppercase tool
server.registerTool(
  "uppercase",
  {
    description: "Convert text to uppercase",
    inputSchema: { text: z.string().describe("Text to convert to uppercase") },
  },
  ({ text }) => {
    return { content: [{ type: "text", text: text.toUpperCase() }] };
  },
);

// Register word_count tool
server.registerTool(
  "word_count",
  {
    description: "Count words in text",
    inputSchema: { text: z.string().describe("Text to count words in") },
  },
  ({ text }) => {
    const wordCount = text
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0).length;
    return { content: [{ type: "text", text: wordCount.toString() }] };
  },
);

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
console.error("Echo MCP Server running on stdio");
