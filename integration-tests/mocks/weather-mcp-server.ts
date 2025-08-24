#!/usr/bin/env -S deno run --allow-all

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Feedback loop detection
const callHistory: Array<{ tool: string; timestamp: number }> = [];

function detectFeedbackLoop(toolName: string): void {
  const call = { tool: toolName, timestamp: Date.now() };
  callHistory.push(call);

  // Check for rapid repeated calls
  const recentCalls = callHistory.filter(
    (c) => c.timestamp > Date.now() - 1000 && c.tool === toolName,
  );

  if (recentCalls.length > 5) {
    throw new Error(
      `Potential feedback loop detected: ${toolName} called ${recentCalls.length} times in 1s`,
    );
  }
}

const server = new McpServer({ name: "weather-mock-server", version: "1.0.0" });

// Register weather tools with Zod schemas
server.registerTool(
  "get_weather",
  {
    description: "Get current weather for a location",
    inputSchema: { location: z.string().describe("The location to get weather for") },
  },
  ({ location }) => {
    detectFeedbackLoop("get_weather");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            location,
            temperature: 72,
            conditions: "sunny",
            timestamp: new Date().toISOString(),
          }),
        },
      ],
    };
  },
);

server.registerTool(
  "get_forecast",
  {
    description: "Get weather forecast",
    inputSchema: {
      location: z.string().describe("The location to get forecast for"),
      days: z.number().optional().default(3).describe("Number of days to forecast"),
    },
  },
  ({ location, days = 3 }) => {
    detectFeedbackLoop("get_forecast");

    const forecast = Array.from({ length: days }, (_, i) => ({
      day: i + 1,
      temperature: 70 + Math.random() * 20,
      conditions: ["sunny", "cloudy", "rainy"][Math.floor(Math.random() * 3)],
    }));

    return { content: [{ type: "text", text: JSON.stringify({ location, days, forecast }) }] };
  },
);

// Start the server
const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
console.error("Weather MCP Server running on stdio");
