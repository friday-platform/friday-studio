/**
 * Platform MCP Server for Atlas
 * Exposes platform-level capabilities through daemon HTTP API
 * Routes all operations through the daemon for consistency
 */

import { getAtlasDaemonUrl } from "@atlas/atlasd";
import { validateSignalPayload } from "@atlas/config";
import { CancellationNotificationSchema } from "@atlas/core";
import type { Logger } from "@atlas/logger";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerPrompts } from "./prompts/index.ts";
import type { PromptContext } from "./prompts/types.ts";
import { registerResources } from "./resources/index.ts";
import type { ResourceContext } from "./resources/types.ts";
import { registerTools } from "./tools/index.ts";
import { executeJob } from "./tools/jobs/execute.ts";
import type { ToolContext, WorkspaceConfigProvider, WorkspaceProvider } from "./tools/types.ts";
import { createErrorResponse } from "./tools/utils.ts";

export interface PlatformMCPServerDependencies {
  daemonUrl?: string; // Default: from getAtlasDaemonUrl()
  logger: Logger;
  workspaceProvider: WorkspaceProvider;
  workspaceConfigProvider: WorkspaceConfigProvider;
}

export class PlatformMCPServer {
  private server: McpServer;
  private daemonUrl: string;
  private logger: Logger;
  private workspaceProvider: WorkspaceProvider;
  private workspaceConfigProvider: WorkspaceConfigProvider;
  private currentLoggingLevel: string = "info";
  private activeJobSessions = new Map<string, { sessionId: string; session: unknown }>(); // requestId -> session tracking

  constructor(dependencies: PlatformMCPServerDependencies) {
    this.daemonUrl = dependencies.daemonUrl || getAtlasDaemonUrl();
    this.logger = dependencies.logger;
    this.workspaceProvider = dependencies.workspaceProvider;
    this.workspaceConfigProvider = dependencies.workspaceConfigProvider;

    // Initialize MCP server
    this.server = new McpServer({
      name: "atlas-platform",
      version: "1.0.0",
      capabilities: { prompts: {}, tools: {}, resources: {}, logging: {}, notifications: {} },
    });

    // Create shared context for all tools
    const toolContext: ToolContext = {
      daemonUrl: this.daemonUrl,
      logger: this.logger,
      server: this.server,
      workspaceProvider: this.workspaceProvider,
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

    // Register single generic job execution tool (replaces per-workspace registration)
    this.registerTriggerJobTool();

    this.logger.info("Platform MCP Server initialized", {
      daemonUrl: this.daemonUrl,
      serverName: "atlas-platform",
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
      serverName: "atlas-platform",
      defaultLevel: this.currentLoggingLevel,
    });
  }

  /**
   * Get the MCP server instance
   */
  getServer(): McpServer {
    return this.server;
  }

  /**
   * Register a single generic job execution tool that accepts workspaceId, jobName, and payload
   */
  private registerTriggerJobTool(): void {
    const toolName = "atlas_workspace_job_execute";

    const inputSchema = {
      workspaceId: z.string().describe("Target workspace identifier"),
      jobName: z.string().describe("Name of the job to execute"),
      payload: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Signal payload. Should match any of the job's signals."),
      streamId: z.string().optional().describe("Optional stream id to emit events to"),
    };

    this.server.tool(toolName, inputSchema, async (params, extra) => {
      const { workspaceId, jobName, payload, streamId } = params;

      // Extract requestId from MCP SDK's extra parameter
      let requestId: string | undefined;
      if (extra?._meta?.requestId && typeof extra._meta?.requestId === "string") {
        requestId = extra._meta?.requestId;
      }

      // Prepare workspace config
      const mergedConfig = await this.workspaceConfigProvider?.getWorkspaceConfig(workspaceId);
      if (!mergedConfig) {
        return createErrorResponse(`Workspace config not found for '${workspaceId}'`);
      }

      const jobs = mergedConfig.workspace?.jobs || {};
      const jobSpec = jobs[jobName];
      if (!jobSpec) {
        return createErrorResponse(`Job '${jobName}' not found in workspace '${workspaceId}'`);
      }

      // Determine first trigger and corresponding signal
      const triggers = jobSpec.triggers || [];
      if (triggers.length === 0) {
        return createErrorResponse(
          `Job '${jobName}' has no triggers; cannot determine target signal for payload generation`,
        );
      }

      const firstTrigger = triggers[0];
      if (!firstTrigger) {
        return createErrorResponse(
          `Job '${jobName}' has no first trigger available for payload generation`,
        );
      }
      const firstSignalName = firstTrigger.signal;
      const signalConfig =
        mergedConfig.workspace?.signals?.[firstSignalName] ||
        mergedConfig.atlas?.signals?.[firstSignalName];
      if (!signalConfig) {
        return createErrorResponse(
          `Signal '${firstSignalName}' not found in workspace or atlas configuration`,
        );
      }

      let validated = false;
      for (const trigger of jobSpec.triggers || []) {
        const signal = mergedConfig.workspace?.signals?.[trigger.signal];
        if (signal) {
          const parsed = validateSignalPayload(signal, payload);
          if (parsed.success) {
            validated = true;
            this.logger.info("Payload validated for signal", {
              signalName: trigger.signal,
              jobName,
              workspaceId,
            });
            break;
          }
        }
      }

      if (!validated) {
        return createErrorResponse(
          `Payload validation failed for '${jobName}', payload data is not valid for any signal`,
        );
      }

      try {
        const result = await executeJob(
          {
            daemonUrl: this.daemonUrl,
            logger: this.logger,
            server: this.server,
            workspaceProvider: this.workspaceProvider,
          },
          workspaceId,
          jobName,
          { payload: payload, streamId },
          requestId
            ? (session) => {
                const sessionId = (session as { id: string }).id;
                const rid = requestId as string;
                this.activeJobSessions.set(rid, { sessionId, session });
                this.logger.debug("Tracking job session for cancellation", {
                  requestId,
                  sessionId,
                  toolName,
                  workspaceId,
                  jobName,
                });
              }
            : undefined,
        );

        // Clean up tracking after execution completes
        if (requestId) {
          this.activeJobSessions.delete(requestId);
          this.logger.debug("Removed completed job session from tracking", { requestId });
        }
        return result;
      } catch (error) {
        this.logger.error("Job execution via tool failed", { error, workspaceId, jobName });
        return createErrorResponse(
          `Job ${jobName} execution failed in workspace ${workspaceId}`,
          error,
        );
      }
    });
  }
}
