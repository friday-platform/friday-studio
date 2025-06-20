#!/usr/bin/env deno run --allow-all

import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";
import {
  MCPAuthConfigSchema,
  MCPToolsConfigSchema,
  MCPTransportConfigSchema,
} from "./src/core/agents/mcp/mcp-manager.ts";

console.log("Testing MCP schemas individually...");

// Test transport schema directly
const testTransport = {
  type: "stdio",
  command: "echo",
  args: ["hello"],
};

console.log("Testing transport schema...");
try {
  const result = MCPTransportConfigSchema.parse(testTransport);
  console.log("✅ Transport schema works:", result);
} catch (error) {
  console.error("❌ Transport schema error:", error.message);
}

// Test the workspace config
console.log("\nTesting workspace config...");
try {
  const content = await Deno.readTextFile("./examples/workspaces/mcp-test/workspace-simple.yml");
  const rawConfig = parseYaml(content);
  console.log("Raw MCP servers config:", rawConfig.mcp_servers);

  const WorkspaceMCPServerConfigSchema = z.object({
    transport: MCPTransportConfigSchema,
    auth: MCPAuthConfigSchema.optional(),
    tools: MCPToolsConfigSchema.optional(),
    timeout_ms: z.number().positive().default(30000),
  });

  const mcpServerConfig = rawConfig.mcp_servers["test-server"];
  console.log("Testing MCP server config:", mcpServerConfig);

  const result = WorkspaceMCPServerConfigSchema.parse(mcpServerConfig);
  console.log("✅ MCP server config works:", result);
} catch (error) {
  console.error("❌ MCP server config error:", error.message);
  console.error("Full error:", error);
}
