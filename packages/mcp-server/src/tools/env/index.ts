/**
 * `env_*` platform tools — agent-callable CRUD over workspace / global `.env`.
 *
 * - `env_list` / `env_get` — read any workspace's (or the global) `.env`;
 *   secret-looking keys are masked before the value reaches an LLM.
 * - `env_set` — proposes a write via a chat confirmation card (non-blocking;
 *   the daemon applies it on confirm).
 * - `env_delete` — direct delete, scoped to the current workspace or global.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.ts";
import { registerEnvDeleteTool } from "./delete.ts";
import { registerEnvGetTool } from "./get.ts";
import { registerEnvListTool } from "./list.ts";
import { registerEnvSetTool } from "./set.ts";

/** Register all `env_*` tools with the MCP server. */
export function registerEnvTools(server: McpServer, ctx: ToolContext): void {
  registerEnvListTool(server, ctx);
  registerEnvGetTool(server, ctx);
  registerEnvSetTool(server, ctx);
  registerEnvDeleteTool(server, ctx);
}
