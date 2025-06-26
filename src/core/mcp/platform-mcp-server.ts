/**
 * Platform MCP Server for Atlas
 * Exposes platform-level capabilities through daemon HTTP API
 * Routes all operations through the daemon for consistency
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AtlasConfig } from "../config-loader.ts";
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
  atlasConfig?: AtlasConfig; // Optional - MCP server doesn't need local config
  daemonUrl?: string; // Default: http://localhost:8080
}

export class PlatformMCPServer {
  private server: McpServer;
  private dependencies: PlatformMCPServerDependencies;
  private daemonUrl: string;

  constructor(dependencies: PlatformMCPServerDependencies) {
    this.dependencies = dependencies;
    this.daemonUrl = dependencies.daemonUrl || "http://localhost:8080";
    this.server = new McpServer({
      name: "atlas-platform",
      version: "1.0.0",
    });
    this.setupTools();

    logger.info("Platform MCP Server initialized", {
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

    // Workspace capability: workspace_jobs_list - ROUTES THROUGH DAEMON API
    this.server.registerTool(
      "workspace_jobs_list",
      {
        description: "List all jobs in a workspace through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID to list jobs for"),
        },
      },
      async ({ workspaceId }) => {
        logger.info("MCP workspace_jobs_list called", { workspaceId });

        try {
          const response = await fetch(`${this.daemonUrl}/api/workspaces/${workspaceId}/jobs`);
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
              `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
            );
          }

          const jobs = await response.json();

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    jobs,
                    total: jobs.length,
                    workspaceId,
                    source: "daemon_api",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_jobs_list failed", { workspaceId, error });
          throw error;
        }
      },
    );

    // Workspace capability: workspace_jobs_describe - ROUTES THROUGH DAEMON API
    this.server.registerTool(
      "workspace_jobs_describe",
      {
        description: "Get detailed information about a specific job through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          jobName: z.string().describe("Job name to describe"),
        },
      },
      async ({ workspaceId, jobName }) => {
        logger.info("MCP workspace_jobs_describe called", { workspaceId, jobName });

        try {
          // Get all jobs and find the specific one
          const response = await fetch(`${this.daemonUrl}/api/workspaces/${workspaceId}/jobs`);
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
              `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
            );
          }

          const jobs = await response.json();
          const job = jobs.find((j: any) => j.name === jobName);

          if (!job) {
            throw new Error(`Job not found: ${jobName}`);
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    job,
                    workspaceId,
                    source: "daemon_api",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_jobs_describe failed", { workspaceId, jobName, error });
          throw error;
        }
      },
    );

    // Workspace capability: workspace_sessions_list - ROUTES THROUGH DAEMON API
    this.server.registerTool(
      "workspace_sessions_list",
      {
        description: "List all sessions in a workspace through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID to list sessions for"),
        },
      },
      async ({ workspaceId }) => {
        logger.info("MCP workspace_sessions_list called", { workspaceId });

        try {
          const response = await fetch(`${this.daemonUrl}/api/workspaces/${workspaceId}/sessions`);
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
              `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
            );
          }

          const sessions = await response.json();

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    sessions,
                    total: sessions.length,
                    workspaceId,
                    source: "daemon_api",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_sessions_list failed", { workspaceId, error });
          throw error;
        }
      },
    );

    // Workspace capability: workspace_sessions_describe - ROUTES THROUGH DAEMON API
    this.server.registerTool(
      "workspace_sessions_describe",
      {
        description: "Get detailed information about a specific session through daemon API",
        inputSchema: {
          sessionId: z.string().describe("Session ID to describe"),
        },
      },
      async ({ sessionId }) => {
        logger.info("MCP workspace_sessions_describe called", { sessionId });

        try {
          const response = await fetch(`${this.daemonUrl}/api/sessions/${sessionId}`);
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
              `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
            );
          }

          const session = await response.json();

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    session,
                    source: "daemon_api",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_sessions_describe failed", { sessionId, error });
          throw error;
        }
      },
    );

    // Workspace capability: workspace_sessions_cancel - ROUTES THROUGH DAEMON API
    this.server.registerTool(
      "workspace_sessions_cancel",
      {
        description: "Cancel a running session through daemon API",
        inputSchema: {
          sessionId: z.string().describe("Session ID to cancel"),
        },
      },
      async ({ sessionId }) => {
        logger.info("MCP workspace_sessions_cancel called", { sessionId });

        try {
          const response = await fetch(`${this.daemonUrl}/api/sessions/${sessionId}`, {
            method: "DELETE",
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
              `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
            );
          }

          const result = await response.json();

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    sessionId,
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
          logger.error("MCP workspace_sessions_cancel failed", { sessionId, error });
          throw error;
        }
      },
    );

    // Workspace capability: workspace_signals_list - ROUTES THROUGH DAEMON API
    this.server.registerTool(
      "workspace_signals_list",
      {
        description: "List all signals in a workspace through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID to list signals for"),
        },
      },
      async ({ workspaceId }) => {
        logger.info("MCP workspace_signals_list called", { workspaceId });

        try {
          const response = await fetch(`${this.daemonUrl}/api/workspaces/${workspaceId}/signals`);
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
              `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
            );
          }

          const signals = await response.json();

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    signals,
                    total: signals.length,
                    workspaceId,
                    source: "daemon_api",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_signals_list failed", { workspaceId, error });
          throw error;
        }
      },
    );

    // Workspace capability: workspace_signals_trigger - ROUTES THROUGH DAEMON API
    this.server.registerTool(
      "workspace_signals_trigger",
      {
        description: "Trigger a signal in a workspace through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          signalName: z.string().describe("Signal name to trigger"),
          payload: z.record(z.string(), z.any()).optional().describe("Signal payload"),
        },
      },
      async ({ workspaceId, signalName, payload }) => {
        logger.info("MCP workspace_signals_trigger called", { workspaceId, signalName });

        try {
          const response = await fetch(
            `${this.daemonUrl}/api/workspaces/${workspaceId}/signals/${signalName}`,
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

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    workspaceId,
                    signalName,
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
          logger.error("MCP workspace_signals_trigger failed", { workspaceId, signalName, error });
          throw error;
        }
      },
    );

    // Workspace capability: workspace_agents_list - ROUTES THROUGH DAEMON API
    this.server.registerTool(
      "workspace_agents_list",
      {
        description: "List all agents in a workspace through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID to list agents for"),
        },
      },
      async ({ workspaceId }) => {
        logger.info("MCP workspace_agents_list called", { workspaceId });

        try {
          const response = await fetch(`${this.daemonUrl}/api/workspaces/${workspaceId}/agents`);
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
              `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
            );
          }

          const agents = await response.json();

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    agents,
                    total: agents.length,
                    workspaceId,
                    source: "daemon_api",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_agents_list failed", { workspaceId, error });
          throw error;
        }
      },
    );

    // Workspace capability: workspace_agents_describe - ROUTES THROUGH DAEMON API
    this.server.registerTool(
      "workspace_agents_describe",
      {
        description: "Get detailed information about a specific agent through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          agentId: z.string().describe("Agent ID to describe"),
        },
      },
      async ({ workspaceId, agentId }) => {
        logger.info("MCP workspace_agents_describe called", { workspaceId, agentId });

        try {
          const response = await fetch(
            `${this.daemonUrl}/api/workspaces/${workspaceId}/agents/${agentId}`,
          );
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
              `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
            );
          }

          const agent = await response.json();

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    agent,
                    workspaceId,
                    source: "daemon_api",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          logger.error("MCP workspace_agents_describe failed", { workspaceId, agentId, error });
          throw error;
        }
      },
    );

    // Platform jobs are handled by the daemon, not the MCP server
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
   * Start the MCP server
   */
  async start(): Promise<void> {
    // Check daemon connectivity before starting
    const isHealthy = await this.checkDaemonHealth();
    if (!isHealthy) {
      throw new Error(
        `Atlas daemon not accessible at ${this.daemonUrl}. Please start the daemon first with 'atlas daemon start'`,
      );
    }

    logger.info("Daemon health check passed, starting MCP server");
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
      // Platform capabilities
      "workspace_list",
      "workspace_create",
      "workspace_delete",
      "workspace_describe",
      // Workspace capabilities (via daemon API)
      "workspace_jobs_list",
      "workspace_jobs_describe",
      "workspace_sessions_list",
      "workspace_sessions_describe",
      "workspace_sessions_cancel",
      "workspace_signals_list",
      "workspace_signals_trigger",
      "workspace_agents_list",
      "workspace_agents_describe",
      // Platform jobs are handled by the daemon
    ];
  }

  /**
   * Create platform MCP server configuration for clients
   */
  static createClientConfig(daemonUrl: string = "http://localhost:8080"): Record<string, unknown> {
    return {
      "atlas-platform": {
        command: "atlas",
        args: ["mcp", "serve"],
        env: {
          ATLAS_DAEMON_URL: daemonUrl,
        },
      },
    };
  }
}
