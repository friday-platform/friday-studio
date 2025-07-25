import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.ts";
import { registerTavilyTools } from "./tavily.ts";

export function registerWebTools(server: McpServer, ctx: ToolContext) {
  // Register Tavily web search tools
  registerTavilyTools(server, ctx);
}

// Re-export Tavily tools for backward compatibility
export { registerTavilyTools } from "./tavily.ts";
