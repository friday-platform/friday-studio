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

// Logger interface for dependency injection
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

export interface PlatformMCPServerDependencies {
  daemonUrl?: string; // Default: http://localhost:8080
  logger: Logger;
}

export class PlatformMCPServer {
  private server: McpServer;
  private daemonUrl: string;
  private logger: Logger;

  constructor(dependencies: PlatformMCPServerDependencies) {
    this.daemonUrl = dependencies.daemonUrl || "http://localhost:8080";
    this.logger = dependencies.logger;

    // Initialize MCP server
    this.server = new McpServer({
      name: "atlas-platform",
      version: "1.0.0",
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
