/**
 * Platform MCP Server for Atlas
 * Exposes platform-level capabilities through daemon HTTP API
 * Routes all operations through the daemon for consistency
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools/index.ts";
import type { ToolContext } from "./tools/types.ts";
import { registerResources } from "./resources/index.ts";
import type { ResourceContext } from "./resources/types.ts";
import { PromptContext } from "./prompts/types.ts";
import { registerPrompts } from "./prompts/index.ts";
import { getAtlasDaemonUrl } from "@atlas/tools";

// Logger interface for dependency injection
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

export interface PlatformMCPServerDependencies {
  daemonUrl?: string; // Default: from getAtlasDaemonUrl()
  logger: Logger;
}

export class PlatformMCPServer {
  private server: McpServer;
  private daemonUrl: string;
  private logger: Logger;

  constructor(dependencies: PlatformMCPServerDependencies) {
    this.daemonUrl = dependencies.daemonUrl || getAtlasDaemonUrl();
    this.logger = dependencies.logger;

    // Initialize MCP server
    this.server = new McpServer({
      name: "atlas-platform",
      version: "1.0.0",
      capabilities: {
        prompts: {},
        tools: {},
        resources: {},
      },
    });

    // Create shared context for all tools
    const toolContext: ToolContext = {
      daemonUrl: this.daemonUrl,
      logger: this.logger,
    };

    // Register all tools with shared context
    registerTools(this.server, toolContext);

    // Register resources with same DI pattern
    const resourceContext: ResourceContext = {
      logger: this.logger,
    };
    registerResources(this.server, resourceContext);

    // Register prompts with same DI pattern
    const promptContext: PromptContext = {
      daemonUrl: this.daemonUrl,
      logger: this.logger,
    };
    registerPrompts(this.server, promptContext);

    this.logger.info("Platform MCP Server initialized", {
      daemonUrl: this.daemonUrl,
      serverName: "atlas-platform",
    });
  }

  /**
   * Get the MCP server instance
   */
  getServer(): McpServer {
    return this.server;
  }
}
