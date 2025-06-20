#!/usr/bin/env deno run --allow-all

import { ConfigLoader } from "./src/core/config-loader.ts";

console.log("Testing MCP schema validation...");

try {
  const configLoader = new ConfigLoader("./examples/workspaces/mcp-test");
  const config = await configLoader.load();
  console.log("✅ MCP configuration loaded successfully!");
  console.log("MCP Servers:", Object.keys(config.workspace.mcp_servers || {}));
} catch (error) {
  console.error("❌ Configuration error:", error.message);
  console.error("Full error:", error);
}
