/**
 * Prompt registry for MCP server
 * Centralizes prompt registration and management
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAgentDescribePrompt } from "./agent/describe.ts";

// Import agent prompts
import { registerAgentListPrompt } from "./agent/list.ts";
import { registerJobDescribePrompt } from "./job/describe.ts";

// Import job prompts
import { registerJobListPrompt } from "./job/list.ts";
// Import system prompts
import { registerSystemVersionPrompt } from "./platform/version.ts";
import { registerSessionDescribePrompt } from "./session/describe.ts";
// Import session prompts
import { registerSessionListPrompt } from "./session/list.ts";
import { registerSignalDescribePrompt } from "./signal/describe.ts";
// Import signals prompts
import { registerSignalListPrompt } from "./signal/list.ts";
import { registerSignalTriggerPrompt } from "./signal/trigger.ts";
import type { PromptContext } from "./types.ts";
import { registerWorkspaceDescribePrompt } from "./workspace/describe.ts";
// Import workspace prompts
import { registerWorkspaceListPrompt } from "./workspace/list.ts";

/**
 * Register all prompts with the MCP server
 */
export function registerPrompts(server: McpServer, context: PromptContext): void {
  // Agent prompts
  registerAgentListPrompt(server, context);
  registerAgentDescribePrompt(server, context);

  // Job prompts
  registerJobListPrompt(server, context);
  registerJobDescribePrompt(server, context);

  // Session prompts
  registerSessionListPrompt(server, context);
  registerSessionDescribePrompt(server, context);

  // Signals prompts
  registerSignalListPrompt(server, context);
  registerSignalDescribePrompt(server, context);
  registerSignalTriggerPrompt(server, context);

  // Workspace prompts
  registerWorkspaceListPrompt(server, context);
  registerWorkspaceDescribePrompt(server, context);

  // System
  registerSystemVersionPrompt(server, context);

  context.logger.info("Registered all prompts with MCP server");
}
