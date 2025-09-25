import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.ts";
import { registerArtifactsCreateTool } from "./create.ts";
import { registerArtifactsDeleteTool } from "./delete.ts";
import { registerArtifactsGetTool } from "./get.ts";
import { registerArtifactsGetByChatTool } from "./get-by-chat.ts";
import { registerArtifactsUpdateTool } from "./update.ts";

/** Register artifact MCP tools */
export function registerArtifactsTools(server: McpServer, ctx: ToolContext) {
  registerArtifactsCreateTool(server, ctx);
  registerArtifactsUpdateTool(server, ctx);
  registerArtifactsGetTool(server, ctx);
  registerArtifactsGetByChatTool(server, ctx);
  registerArtifactsDeleteTool(server, ctx);
}
