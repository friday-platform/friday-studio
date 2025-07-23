import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.ts";
import { registerFetchTool } from "./fetch.ts";
import { registerWebSessionTools } from "./session.ts";
import { registerConsentTools } from "./consent.ts";

export function registerWebTools(server: McpServer, ctx: ToolContext) {
  // Register the original fetch tool
  registerFetchTool(server, ctx);

  // Register new session-based tools
  registerWebSessionTools(server, ctx);

  // Register consent handling tools
  registerConsentTools(server, ctx);
}

export { webSessionManager } from "./session-manager.ts";
