/**
 * Platform MCP Server for Atlas
 * Exposes platform-level capabilities through WorkspaceRuntime instances
 * This is the CORRECT implementation that routes through the runtime hierarchy
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AtlasConfig } from "../config-loader.ts";
import { WorkspaceRuntimeRegistry } from "../workspace-runtime-registry.ts";
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
  runtimeRegistry: WorkspaceRuntimeRegistry;
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

    logger.info("Platform MCP Server initialized with WorkspaceRuntimeRegistry", {
      activeWorkspaces: this.dependencies.runtimeRegistry.getActiveCount(),
    });
  }

  private setupTools(): void {
    // Platform capability: workspace.list - NOW ROUTES THROUGH RUNTIME REGISTRY
    this.server.registerTool(
      "workspace_list",
      {
        description: "List all active workspaces with runtime status",
        inputSchema: {},
      },
      () => {
        logger.info("MCP workspace_list called - querying active runtimes");

        const workspaces = this.dependencies.runtimeRegistry.listWorkspaces();

        logger.info("MCP workspace_list response", {
          activeWorkspaces: workspaces.length,
          workspaceIds: workspaces.map((w) => w.id),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  workspaces,
                  total: workspaces.length,
                  source: "active_runtimes",
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

    // Platform capability: workspace.create - ROUTES THROUGH RUNTIME REGISTRY
    this.server.registerTool(
      "workspace_create",
      {
        description: "Create a new workspace and start its runtime",
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
          const workspace = await this.dependencies.runtimeRegistry.createWorkspace({
            name,
            description,
            template,
            config,
          });

          logger.info("Workspace created via runtime registry", workspace);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    workspace,
                    message: `Workspace '${workspace.name}' created and runtime started`,
                    source: "runtime_registry",
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

    // Platform capability: workspace.delete - ROUTES THROUGH RUNTIME REGISTRY
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
          await this.dependencies.runtimeRegistry.deleteWorkspace(workspaceId, force);

          logger.info("Workspace deleted via runtime registry", { workspaceId });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    workspaceId,
                    message: `Workspace '${workspaceId}' runtime shutdown and deleted`,
                    source: "runtime_registry",
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

    // Platform capability: workspace.describe - ROUTES THROUGH RUNTIME REGISTRY
    this.server.registerTool(
      "workspace_describe",
      {
        description: "Get detailed runtime information about a workspace",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID to describe"),
        },
      },
      async ({ workspaceId }) => {
        logger.info("MCP workspace_describe called", { workspaceId });

        try {
          const workspace = await this.dependencies.runtimeRegistry.describeWorkspace(workspaceId);

          logger.info("Workspace described via runtime registry", {
            workspaceId,
            status: workspace.status,
            sessions: workspace.sessions?.length || 0,
            jobs: workspace.jobs?.length || 0,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ...workspace,
                    source: "runtime_registry",
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

    // Additional workspace operations through runtime registry
    this.server.registerTool(
      "workspace_trigger_job",
      {
        description: "Trigger a job in a specific workspace through its runtime",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          jobName: z.string().describe("Job name to trigger"),
          payload: z.record(z.string(), z.any()).optional().describe("Job payload"),
        },
      },
      async ({ workspaceId, jobName, payload }) => {
        logger.info("MCP workspace_trigger_job called", { workspaceId, jobName });

        try {
          const result = await this.dependencies.runtimeRegistry.triggerJob(
            workspaceId,
            jobName,
            payload,
          );

          logger.info("Job triggered via runtime registry", {
            workspaceId,
            jobName,
            sessionId: result.sessionId,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    workspaceId,
                    job: jobName,
                    sessionId: result.sessionId,
                    message: `Job '${jobName}' triggered in workspace '${workspaceId}' via runtime`,
                    source: "runtime_registry",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_trigger_job failed", {
            workspaceId,
            jobName,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    );

    this.server.registerTool(
      "workspace_process_signal",
      {
        description: "Process a signal in a specific workspace through its runtime",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          signalName: z.string().describe("Signal name to process"),
          payload: z.record(z.string(), z.any()).optional().describe("Signal payload"),
        },
      },
      async ({ workspaceId, signalName, payload }) => {
        logger.info("MCP workspace_process_signal called", { workspaceId, signalName });

        try {
          const result = await this.dependencies.runtimeRegistry.processSignal(
            workspaceId,
            signalName,
            payload || {},
          );

          logger.info("Signal processed via runtime registry", {
            workspaceId,
            signalName,
            sessionId: result.sessionId,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    workspaceId,
                    signal: signalName,
                    sessionId: result.sessionId,
                    message:
                      `Signal '${signalName}' processed in workspace '${workspaceId}' via runtime`,
                    source: "runtime_registry",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_process_signal failed", {
            workspaceId,
            signalName,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    );

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
      "workspace_trigger_job",
      "workspace_process_signal",
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
