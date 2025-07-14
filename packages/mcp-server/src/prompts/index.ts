/**
 * Prompt registry for MCP server
 * Centralizes prompt registration and management
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type PromptContext } from "./types.ts";

// Import agent prompts
import { registerAgentListPrompt } from "./agent/list.ts";
import { registerAgentDescribePrompt } from "./agent/describe.ts";

// Import job prompts
import { registerJobListPrompt } from "./job/list.ts";
import { registerJobDescribePrompt } from "./job/describe.ts";

// Import library prompts
import { registerLibraryListPrompt } from "./library/list.ts";
import { registerLibraryGetPrompt } from "./library/get.ts";
import { registerLibrarySearchPrompt } from "./library/search.ts";

// Import session prompts
import { registerSessionListPrompt } from "./session/list.ts";
import { registerSessionDescribePrompt } from "./session/describe.ts";

// Import signals prompts
import { registerSignalListPrompt } from "./signal/list.ts";
import { registerSignalDescribePrompt } from "./signal/describe.ts";

// Import workspace prompts
import { registerWorkspaceListPrompt } from "./workspace/list.ts";
import { registerWorkspaceDescribePrompt } from "./workspace/describe.ts";

/**
 * Register all prompts with the MCP server
 */
export function registerPrompts(
  server: McpServer,
  context: PromptContext,
): void {
  // Agent prompts
  registerAgentListPrompt(server, context);
  registerAgentDescribePrompt(server, context);

  // Job prompts
  registerJobListPrompt(server, context);
  registerJobDescribePrompt(server, context);

  // Library prompts
  registerLibraryListPrompt(server, context);
  registerLibraryGetPrompt(server, context);
  registerLibrarySearchPrompt(server, context);

  // Session prompts
  registerSessionListPrompt(server, context);
  registerSessionDescribePrompt(server, context);

  // Signals prompts
  registerSignalListPrompt(server, context);
  registerSignalDescribePrompt(server, context);

  // Workspace prompts
  registerWorkspaceListPrompt(server, context);
  registerWorkspaceDescribePrompt(server, context);

  context.logger.info("Registered all prompts with MCP server");
}
