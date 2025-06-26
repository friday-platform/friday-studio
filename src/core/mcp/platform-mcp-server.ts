/**
 * Platform MCP Server for Atlas
 * Exposes platform-level capabilities through WorkspaceRuntime instances
 * This is the CORRECT implementation that routes through the runtime hierarchy
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AtlasConfig } from "../config-loader.ts";
import { getWorkspaceManager } from "../workspace-manager.ts";
import { logger } from "../../utils/logger.ts";

// Platform capability types
interface WorkspaceCreateConfig {
  name: string;
  description?: string;
  template?: string;
  config?: Record<string, unknown>;
}

interface WorkspaceInfo {
  id: string;
  name: string;
  description?: string;
}

export interface PlatformMCPServerDependencies {
  atlasConfig: AtlasConfig;
}

export class PlatformMCPServer {
  private server: McpServer;
  private dependencies: PlatformMCPServerDependencies;

  constructor(dependencies: PlatformMCPServerDependencies) {
    this.dependencies = dependencies;
    this.server = new McpServer({
      name: "atlas-platform",
      version: "1.0.0",
    });
    this.setupTools();

    logger.info("Platform MCP Server initialized with WorkspaceManager");
  }

  private setupTools(): void {
    // Platform capability: workspace.list - ROUTES THROUGH WORKSPACE MANAGER
    this.server.registerTool(
      "workspace_list",
      {
        description: "List all workspaces with runtime status",
        inputSchema: {},
      },
      async () => {
        logger.info("MCP workspace_list called - querying WorkspaceManager");

        const manager = getWorkspaceManager();
        const workspaces = await manager.listWorkspaces();

        logger.info("MCP workspace_list response", {
          totalWorkspaces: workspaces.length,
          activeRuntimes: workspaces.filter((w) => w.hasActiveRuntime).length,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  workspaces,
                  total: workspaces.length,
                  source: "workspace_manager",
                  timestamp: new Date().toISOString(),
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );

    // Platform capability: workspace.create - ROUTES THROUGH WORKSPACE MANAGER
    this.server.registerTool(
      "workspace_create",
      {
        description: "Create a new workspace",
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
          const manager = getWorkspaceManager();
          const workspace = await manager.createWorkspace({
            name,
            description,
            template,
            config,
          });

          logger.info("Workspace created via WorkspaceManager", workspace);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    workspace,
                    message: `Workspace '${workspace.name}' created`,
                    source: "workspace_manager",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_create failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    );

    // Platform capability: workspace.delete - ROUTES THROUGH WORKSPACE MANAGER
    this.server.registerTool(
      "workspace_delete",
      {
        description: "Delete a workspace and shutdown its runtime",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID to delete"),
          force: z.boolean().default(false).describe("Force deletion"),
        },
      },
      async ({ workspaceId, force }) => {
        logger.info("MCP workspace_delete called", { workspaceId, force });

        try {
          const manager = getWorkspaceManager();
          await manager.deleteWorkspace(workspaceId, force);

          logger.info("Workspace deleted via WorkspaceManager", { workspaceId });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    workspaceId,
                    message: `Workspace '${workspaceId}' deleted`,
                    source: "workspace_manager",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_delete failed", {
            workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    );

    // Platform capability: workspace.describe - ROUTES THROUGH WORKSPACE MANAGER
    this.server.registerTool(
      "workspace_describe",
      {
        description: "Get detailed information about a workspace",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID to describe"),
        },
      },
      async ({ workspaceId }) => {
        logger.info("MCP workspace_describe called", { workspaceId });

        try {
          const manager = getWorkspaceManager();
          const workspace = await manager.describeWorkspace(workspaceId);

          logger.info("Workspace described via WorkspaceManager", {
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
                    source: "workspace_manager",
                    queryTime: new Date().toISOString(),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_describe failed", {
            workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    );

    // NOTE: Additional operations like workspace_trigger_job and workspace_process_signal
    // should route through the daemon API when implemented. For now, we focus on the
    // core workspace management operations.

    // Discoverable platform jobs (if any defined in atlas.yml)
    if (this.dependencies.atlasConfig.jobs) {
      for (const [jobName, jobSpec] of Object.entries(this.dependencies.atlasConfig.jobs)) {
        this.server.registerTool(
          `atlas_${jobName}`,
          {
            description: jobSpec.description || `Execute platform job: ${jobName}`,
            inputSchema: {
              payload: z.record(z.string(), z.any()).optional().describe("Job execution payload"),
            },
          },
          ({ payload }) => {
            // Platform jobs would need their own runtime implementation
            logger.warn("Platform job triggered but not implemented", { jobName, payload });
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      success: false,
                      job: jobName,
                      payload,
                      message: `Platform job '${jobName}' not yet implemented`,
                      error: "Platform jobs require dedicated runtime implementation",
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          },
        );
      }
    }
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
      ...Object.keys(this.dependencies.atlasConfig.jobs || {}).map((job) => `atlas_${job}`),
    ];
  }

  /**
   * Create platform MCP server configuration for clients
   */
  static createClientConfig(atlasUrl: string = "http://localhost:8080"): Record<string, unknown> {
    return {
      "atlas-platform": {
        command: "atlas-mcp-client",
        args: ["--target", `${atlasUrl}/platform`],
        env: {
          ATLAS_API_KEY: {
            from_env: "ATLAS_API_KEY",
            required: false,
          },
        },
      },
    };
  }
}
