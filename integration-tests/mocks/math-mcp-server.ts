#!/usr/bin/env -S deno run --allow-all

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "math-server", version: "1.0.0" });

// Register calculate tool for basic arithmetic
server.registerTool(
  "calculate",
  {
    description: "Perform basic arithmetic calculations",
    inputSchema: {
      expression: z
        .string()
        .describe("Mathematical expression to evaluate (e.g., '2 + 2', '10 * 5')"),
    },
  },
  ({ expression }) => {
    try {
      // Simple safe evaluation for basic arithmetic
      // In production, use a proper math parser
      const sanitized = expression.replace(/[^0-9+\-*/().\s]/g, "");
      if (sanitized !== expression) {
        throw new Error("Invalid characters in expression");
      }

      // Using Function constructor for simple math evaluation
      // This is safer than eval but still should be replaced with a proper parser in production
      const result = new Function("return " + sanitized)();

      return { content: [{ type: "text", text: result.toString() }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  },
);

// Register random_number tool
server.registerTool(
  "random_number",
  {
    description: "Generate a random number within a range",
    inputSchema: {
      min: z.number().default(0).describe("Minimum value (inclusive)"),
      max: z.number().default(100).describe("Maximum value (inclusive)"),
    },
  },
  ({ min, max }) => {
    const result = Math.floor(Math.random() * (max - min + 1)) + min;
    return { content: [{ type: "text", text: result.toString() }] };
  },
);

// Register statistics tool
server.registerTool(
  "statistics",
  {
    description: "Calculate statistics for a list of numbers",
    inputSchema: { numbers: z.array(z.number()).describe("Array of numbers to analyze") },
  },
  ({ numbers }) => {
    if (numbers.length === 0) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Empty array" }) }] };
    }

    const sum = numbers.reduce((a, b) => a + b, 0);
    const mean = sum / numbers.length;
    const sorted = [...numbers].sort((a, b) => a - b);
    const median =
      sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);

    const stats = { count: numbers.length, sum, mean, median, min, max };

    return { content: [{ type: "text", text: JSON.stringify(stats) }] };
  },
);

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
console.error("Math MCP Server running on stdio");
