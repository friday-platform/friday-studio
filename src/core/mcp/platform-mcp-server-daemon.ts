/**
 * Platform MCP Server for Atlas (Daemon API version)
 * Exposes platform-level capabilities through daemon HTTP API calls
 * This is the CORRECT implementation that routes through the daemon
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { logger } from "../../utils/logger.ts";

export interface PlatformMCPServerDaemonDependencies {
  daemonUrl?: string; // Default: http://localhost:8080
}

export class PlatformMCPServerDaemon {
  private server: McpServer;
  private daemonUrl: string;

  constructor(dependencies: PlatformMCPServerDaemonDependencies = {}) {
    this.daemonUrl = dependencies.daemonUrl || "http://localhost:8080";
    this.server = new McpServer({
      name: "atlas-platform-daemon",
      version: "1.0.0",
    });
    this.setupTools();

    logger.info("Platform MCP Server (Daemon API) initialized", {
      daemonUrl: this.daemonUrl,
    });
  }

  private setupTools(): void {
    // Platform capability: workspace.list - ROUTES THROUGH DAEMON API
    this.server.registerTool(
      "workspace_list",
      {
        description: "List all workspaces through daemon API",
        inputSchema: {},
      },
      async () => {
        logger.info("MCP workspace_list called - querying daemon API");

        try {
          const response = await fetch(`${this.daemonUrl}/api/workspaces`);
          if (!response.ok) {
            throw new Error(`Daemon API error: ${response.status} ${response.statusText}`);
          }

          const workspaces = await response.json();

          logger.info("MCP workspace_list response", {
            totalWorkspaces: workspaces.length,
            activeRuntimes: workspaces.filter((w: any) => w.hasActiveRuntime).length,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    workspaces,
                    total: workspaces.length,
                    source: "daemon_api",
                    timestamp: new Date().toISOString(),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_list failed", { error });
          throw error;
        }
      },
    );

    // Platform capability: workspace.create - ROUTES THROUGH DAEMON API
    this.server.registerTool(
      "workspace_create",
      {
        description: "Create a new workspace through daemon API",
        inputSchema: {
          name: z.string().min(1).describe("Workspace name"),
          description: z.string().optional().describe("Workspace description"),
          template: z.string().optional().describe("Template to use"),
          config: z.record(z.string(), z.any()).optional().describe("Additional configuration"),
        },
      },
      async ({ name, description, template, config }) => {
        logger.info("MCP workspace_create called", { name, description, template });

        try {
          const response = await fetch(`${this.daemonUrl}/api/workspaces`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name,
              description,
              template,
              config,
            }),
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
              `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
            );
          }

          const workspace = await response.json();

          logger.info("Workspace created via daemon API", workspace);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    workspace,
                    message: `Workspace '${workspace.name}' created`,
                    source: "daemon_api",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_create failed", { error });
          throw error;
        }
      },
    );

    // Platform capability: workspace.delete - ROUTES THROUGH DAEMON API
    this.server.registerTool(
      "workspace_delete",
      {
        description: "Delete a workspace through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID to delete"),
          force: z.boolean().default(false).describe("Force deletion"),
        },
      },
      async ({ workspaceId, force }) => {
        logger.info("MCP workspace_delete called", { workspaceId, force });

        try {
          const url = new URL(`${this.daemonUrl}/api/workspaces/${workspaceId}`);
          if (force) {
            url.searchParams.set("force", "true");
          }

          const response = await fetch(url.toString(), {
            method: "DELETE",
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
              `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
            );
          }

          const result = await response.json();

          logger.info("Workspace deleted via daemon API", { workspaceId });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    workspaceId,
                    message: result.message,
                    source: "daemon_api",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_delete failed", { workspaceId, error });
          throw error;
        }
      },
    );

    // Platform capability: workspace.describe - ROUTES THROUGH DAEMON API
    this.server.registerTool(
      "workspace_describe",
      {
        description: "Get detailed information about a workspace through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID to describe"),
        },
      },
      async ({ workspaceId }) => {
        logger.info("MCP workspace_describe called", { workspaceId });

        try {
          const response = await fetch(`${this.daemonUrl}/api/workspaces/${workspaceId}`);
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
              `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
            );
          }

          const workspace = await response.json();

          logger.info("Workspace described via daemon API", {
            workspaceId,
            hasActiveRuntime: workspace.hasActiveRuntime,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ...workspace,
                    source: "daemon_api",
                    queryTime: new Date().toISOString(),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_describe failed", { workspaceId, error });
          throw error;
        }
      },
    );

    // Platform capability: workspace.trigger_signal - ROUTES THROUGH DAEMON API
    this.server.registerTool(
      "workspace_trigger_signal",
      {
        description: "Trigger a signal in a workspace through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          signalId: z.string().describe("Signal ID to trigger"),
          payload: z.record(z.string(), z.any()).optional().describe("Signal payload"),
        },
      },
      async ({ workspaceId, signalId, payload }) => {
        logger.info("MCP workspace_trigger_signal called", { workspaceId, signalId });

        try {
          const response = await fetch(
            `${this.daemonUrl}/api/workspaces/${workspaceId}/signals/${signalId}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(payload || {}),
            },
          );

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
              `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
            );
          }

          const result = await response.json();

          logger.info("Signal triggered via daemon API", {
            workspaceId,
            signalId,
            status: result.status,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    workspaceId,
                    signalId,
                    status: result.status,
                    message: result.message,
                    source: "daemon_api",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_trigger_signal failed", { workspaceId, signalId, error });
          throw error;
        }
      },
    );
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    await this.server.close();
  }

  /**
   * Get server instance for testing
   */
  getServer(): McpServer {
    return this.server;
  }

  /**
   * Get available tools
   */
  getAvailableTools(): string[] {
    return [
      "workspace_list",
      "workspace_create",
      "workspace_delete",
      "workspace_describe",
      "workspace_trigger_signal",
    ];
  }

  /**
   * Check if daemon is accessible
   */
  async checkDaemonHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.daemonUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Create platform MCP server configuration for clients
   */
  static createClientConfig(daemonUrl: string = "http://localhost:8080"): Record<string, unknown> {
    return {
      "atlas-platform-daemon": {
        command: "atlas-mcp-daemon-client",
        args: ["--daemon-url", daemonUrl],
        env: {
          ATLAS_DAEMON_URL: {
            value: daemonUrl,
          },
        },
      },
    };
  }
}
