/**
 * Platform MCP Server for Atlas
 * Exposes platform-level capabilities like workspace management
 */

import { McpServer } from "@modelcontextprotocol/server-stdio";
import { z } from "zod/v4";
import type { AtlasConfig } from "../config-loader.ts";

// Platform capability schemas
const WorkspaceCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  template: z.string().optional(),
  config: z.record(z.string(), z.any()).optional(),
});

const WorkspaceDeleteSchema = z.object({
  workspaceId: z.string(),
  force: z.boolean().default(false),
});

const WorkspaceDescribeSchema = z.object({
  workspaceId: z.string(),
});

export interface PlatformMCPServerDependencies {
  workspaceRegistry: {
    listWorkspaces(): Promise<Array<{ id: string; name: string; description?: string }>>;
    createWorkspace(config: any): Promise<{ id: string; name: string }>;
    deleteWorkspace(id: string, force?: boolean): Promise<void>;
    describeWorkspace(id: string): Promise<any>;
  };
  atlasConfig: AtlasConfig;
}

export class PlatformMCPServer {
  private server: McpServer;
  private dependencies: PlatformMCPServerDependencies;

  constructor(dependencies: PlatformMCPServerDependencies) {
    this.dependencies = dependencies;
    this.server = new McpServer("atlas-platform", "1.0.0");
    this.setupTools();
  }

  private setupTools(): void {
    // Platform capability: workspace.list
    this.server.registerTool(
      "workspace.list",
      {
        description: "List all workspaces in the Atlas instance",
        inputSchema: z.object({}),
      },
      async () => {
        const workspaces = await this.dependencies.workspaceRegistry.listWorkspaces();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                workspaces,
                total: workspaces.length,
              }, null, 2),
            },
          ],
        };
      },
    );

    // Platform capability: workspace.create
    this.server.registerTool(
      "workspace.create",
      {
        description: "Create a new workspace",
        inputSchema: WorkspaceCreateSchema,
      },
      async ({ name, description, template, config }) => {
        const workspace = await this.dependencies.workspaceRegistry.createWorkspace({
          name,
          description,
          template,
          config,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                workspace,
                message: `Workspace '${workspace.name}' created successfully`,
              }, null, 2),
            },
          ],
        };
      },
    );

    // Platform capability: workspace.delete
    this.server.registerTool(
      "workspace.delete",
      {
        description: "Delete a workspace",
        inputSchema: WorkspaceDeleteSchema,
      },
      async ({ workspaceId, force }) => {
        await this.dependencies.workspaceRegistry.deleteWorkspace(workspaceId, force);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                workspaceId,
                message: `Workspace '${workspaceId}' deleted successfully`,
              }, null, 2),
            },
          ],
        };
      },
    );

    // Platform capability: workspace.describe
    this.server.registerTool(
      "workspace.describe",
      {
        description: "Get detailed information about a workspace",
        inputSchema: WorkspaceDescribeSchema,
      },
      async ({ workspaceId }) => {
        const workspace = await this.dependencies.workspaceRegistry.describeWorkspace(workspaceId);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(workspace, null, 2),
            },
          ],
        };
      },
    );

    // Discoverable platform jobs (if any defined in atlas.yml)
    if (this.dependencies.atlasConfig.jobs) {
      for (const [jobName, jobSpec] of Object.entries(this.dependencies.atlasConfig.jobs)) {
        this.server.registerTool(
          `atlas.${jobName}`,
          {
            description: jobSpec.description || `Execute platform job: ${jobName}`,
            inputSchema: z.object({
              payload: z.record(z.string(), z.any()).optional(),
            }),
          },
          async ({ payload }) => {
            // This would trigger the job in the platform workspace
            // Implementation depends on how platform jobs are executed
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: true,
                    job: jobName,
                    payload,
                    message: `Platform job '${jobName}' triggered`,
                  }, null, 2),
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
    await this.server.connect({
      transport: {
        type: "stdio",
      },
    });
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
      "workspace.list",
      "workspace.create", 
      "workspace.delete",
      "workspace.describe",
      ...Object.keys(this.dependencies.atlasConfig.jobs || {}).map(job => `atlas.${job}`),
    ];
  }

  /**
   * Create platform MCP server configuration for clients
   */
  static createClientConfig(atlasUrl: string = "http://localhost:8080"): any {
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