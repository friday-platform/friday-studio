/**
 * Platform MCP Server
 * Exposes platform-level capabilities through daemon HTTP API
 * Routes all operations through the daemon for consistency
 */

import { getAtlasDaemonUrl } from "@atlas/atlasd";
import { CancellationNotificationSchema } from "@atlas/core";
import type { Logger } from "@atlas/logger";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPrompts } from "./prompts/index.ts";
import type { PromptContext } from "./prompts/types.ts";
import { registerResources } from "./resources/index.ts";
import type { ResourceContext } from "./resources/types.ts";
import { registerTools } from "./tools/index.ts";
import type {
  ToolContext,
  ToolDispatcher,
  WorkspaceConfigProvider,
  WorkspaceProvider,
} from "./tools/types.ts";

export interface PlatformMCPServerDependencies {
  daemonUrl?: string; // Default: from getAtlasDaemonUrl()
  logger: Logger;
  workspaceProvider: WorkspaceProvider;
  workspaceConfigProvider: WorkspaceConfigProvider;
  /**
   * Optional NATS-mediated tool dispatcher. When provided, tools that have
   * been migrated to the worker model (e.g. `bash`) route execution through
   * `callTool` instead of running in-process.
   */
  toolDispatcher?: ToolDispatcher;
}

export class PlatformMCPServer {
  private server: McpServer;
  private daemonUrl: string;
  private logger: Logger;
  private workspaceProvider: WorkspaceProvider;
  private currentLoggingLevel: string = "info";
  private activeJobSessions = new Map<string, { sessionId: string; session: unknown }>(); // requestId -> session tracking

  constructor(dependencies: PlatformMCPServerDependencies) {
    this.daemonUrl = dependencies.daemonUrl || getAtlasDaemonUrl();
    this.logger = dependencies.logger;
    this.workspaceProvider = dependencies.workspaceProvider;

    // Initialize MCP server
    this.server = new McpServer(
      { name: "platform", version: "1.0.0" },
      { capabilities: { prompts: {}, tools: {}, resources: {}, logging: {} } },
    );

    // Create shared context for all tools
    const toolContext: ToolContext = {
      daemonUrl: this.daemonUrl,
      logger: this.logger,
      server: this.server,
      workspaceProvider: this.workspaceProvider,
      toolDispatcher: dependencies.toolDispatcher,
    };

    // Register all tools with shared context
    registerTools(this.server, toolContext);

    // Register resources with same DI pattern
    const resourceContext: ResourceContext = { logger: this.logger };
    registerResources(this.server, resourceContext);

    // Register prompts with same DI pattern
    const promptContext: PromptContext = { daemonUrl: this.daemonUrl, logger: this.logger };
    registerPrompts(this.server, promptContext);

    // Setup logging request handler
    this.setupLoggingHandlers();

    // Setup cancellation notification handler for MCP-triggered jobs
    this.setupCancellationHandler();

    this.logger.info("Platform MCP Server initialized", {
      daemonUrl: this.daemonUrl,
      serverName: "platform",
    });
  }

  /**
   * Setup cancellation notification handler for MCP-triggered jobs
   */
  private setupCancellationHandler(): void {
    // Import CancellationNotificationSchema
    this.server.server.setNotificationHandler(
      CancellationNotificationSchema,
      async (notification) => {
        const { requestId, reason } = notification.params;
        const tracked = this.activeJobSessions.get(requestId);

        if (tracked) {
          this.logger.info("Cancelling MCP-triggered job", {
            requestId,
            sessionId: tracked.sessionId,
            reason,
          });

          try {
            // Cancel the session
            await (tracked.session as { cancel: () => Promise<void> }).cancel();
            this.activeJobSessions.delete(requestId);
            this.logger.info("Job session cancelled", { requestId, sessionId: tracked.sessionId });
          } catch (error) {
            this.logger.error("Failed to cancel job session", { error, requestId });
          }
        } else {
          this.logger.debug("Cancellation notification for unknown requestId", { requestId });
        }
      },
    );

    this.logger.info("Cancellation notification handler registered");
  }

  /**
   * Setup logging request handlers
   */
  private setupLoggingHandlers(): void {
    // For McpServer, logging is handled automatically when capability is declared
    // The server will accept logging/setLevel requests when logging capability is present
    this.logger.info("Logging capability enabled for MCP server", {
      serverName: "platform",
      defaultLevel: this.currentLoggingLevel,
    });
  }

  /**
   * Get the MCP server instance
   */
  getServer(): McpServer {
    return this.server;
  }
}
