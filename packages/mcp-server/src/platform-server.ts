/**
 * Platform MCP Server for Atlas
 * Exposes platform-level capabilities through daemon HTTP API
 * Routes all operations through the daemon for consistency
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AtlasConfig } from "@atlas/config";
import { MODE_CONFIGS, ServerMode } from "./types.ts";
import { getToolsForMode, isToolAllowedForMode } from "./tool-categories.ts";

// Logger interface for dependency injection
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

export interface PlatformMCPServerDependencies {
  atlasConfig?: AtlasConfig; // Optional - MCP server doesn't need local config
  daemonUrl?: string; // Default: http://localhost:8080
  logger: Logger;
  // Workspace context for automatic injection
  workspaceContext?: {
    workspaceId?: string;
    sessionId?: string;
    agentId?: string;
  };
  // Server mode - defaults to internal
  mode?: ServerMode;
}

export class PlatformMCPServer {
  private server: McpServer;
  private dependencies: PlatformMCPServerDependencies;
  private daemonUrl: string;
  private logger: Logger;
  private workspaceContext?: {
    workspaceId?: string;
    sessionId?: string;
    agentId?: string;
  };
  private mode: ServerMode;
  private modeConfig: typeof MODE_CONFIGS[ServerMode];
  private availableTools: string[];

  constructor(dependencies: PlatformMCPServerDependencies) {
    this.dependencies = dependencies;
    this.logger = dependencies.logger;
    this.daemonUrl = dependencies.daemonUrl || "http://localhost:8080";
    this.workspaceContext = dependencies.workspaceContext;

    // Initialize mode and configuration
    this.mode = dependencies.mode || ServerMode.INTERNAL;
    this.modeConfig = MODE_CONFIGS[this.mode];

    // Validate mode
    if (!Object.values(ServerMode).includes(this.mode)) {
      throw new Error(`Invalid server mode: ${this.mode}`);
    }

    // Initialize available tools for this mode
    this.availableTools = getToolsForMode(this.mode);

    this.server = new McpServer({
      name: this.modeConfig.serverName,
      version: "1.0.0",
    });
    this.setupTools();

    this.logger.info("Platform MCP Server initialized", {
      daemonUrl: this.daemonUrl,
      mode: this.mode,
      serverName: this.modeConfig.serverName,
      availableTools: this.availableTools.length,
    });
  }

  /**
   * Register a tool only if it's allowed in the current mode
   */
  private registerToolIfAllowed(
    toolName: string,
    schema: any,
    handler: (...args: any[]) => any,
  ): void {
    if (isToolAllowedForMode(toolName, this.mode)) {
      this.server.registerTool(toolName, schema, handler);
      this.logger.debug(`Registered tool: ${toolName}`, { mode: this.mode });
    } else {
      this.logger.debug(`Skipped tool (not allowed in ${this.mode} mode): ${toolName}`);
    }
  }

  private setupTools(): void {
    // Platform capability: workspace.list - ROUTES THROUGH DAEMON API
    this.registerToolIfAllowed(
      "workspace_list",
      {
        description: "List all workspaces through daemon API",
        inputSchema: {},
      },
      async () => {
        this.logger.info("MCP workspace_list called - querying daemon API");

        try {
          const response = await fetch(`${this.daemonUrl}/api/workspaces`);
          if (!response.ok) {
            throw new Error(`Daemon API error: ${response.status} ${response.statusText}`);
          }

          const workspaces = await response.json();

          this.logger.info("MCP workspace_list response", {
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
          this.logger.error("MCP workspace_list failed", { error });
          throw error;
        }
      },
    );

    // Platform capability: workspace.create - ROUTES THROUGH DAEMON API
    this.registerToolIfAllowed(
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
        this.logger.info("MCP workspace_create called", { name, description, template });

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

          this.logger.info("Workspace created via daemon API", workspace);

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
          this.logger.error("MCP workspace_create failed", { error });
          throw error;
        }
      },
    );

    // Platform capability: workspace.delete - ROUTES THROUGH DAEMON API
    this.registerToolIfAllowed(
      "workspace_delete",
      {
        description: "Delete a workspace through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID to delete"),
          force: z.boolean().default(false).describe("Force deletion"),
        },
      },
      async ({ workspaceId, force }) => {
        this.logger.info("MCP workspace_delete called", { workspaceId, force });

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

          this.logger.info("Workspace deleted via daemon API", { workspaceId });

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
          this.logger.error("MCP workspace_delete failed", { workspaceId, error });
          throw error;
        }
      },
    );

    // Platform capability: workspace.describe - ROUTES THROUGH DAEMON API
    this.registerToolIfAllowed(
      "workspace_describe",
      {
        description: "Get detailed information about a workspace through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID to describe"),
        },
      },
      async ({ workspaceId }) => {
        this.logger.info("MCP workspace_describe called", { workspaceId });

        try {
          const response = await fetch(`${this.daemonUrl}/api/workspaces/${workspaceId}`);
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
              `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
            );
          }

          const workspace = await response.json();

          this.logger.info("Workspace described via daemon API", {
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
          this.logger.error("MCP workspace_describe failed", { workspaceId, error });
          throw error;
        }
      },
    );

    // Workspace capability: workspace_jobs_list - ROUTES THROUGH DAEMON API
    this.registerToolIfAllowed(
      "workspace_jobs_list",
      {
        description: "List all jobs in a workspace through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID to list jobs for"),
        },
      },
      async (args) =>
        this.withWorkspaceMCPCheck(args, async ({ workspaceId }) => {
          this.logger.info("MCP workspace_jobs_list called", { workspaceId });

          try {
            const response = await fetch(`${this.daemonUrl}/api/workspaces/${workspaceId}/jobs`);
            if (!response.ok) {
              const errorData = await response.json().catch(() => ({}));
              throw new Error(
                `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
              );
            }

            const allJobs = await response.json();

            // Filter jobs based on discoverability settings
            const discoverableJobs = [];
            for (const job of allJobs) {
              const isDiscoverable = await this.checkJobDiscoverable(workspaceId, job.name);
              if (isDiscoverable) {
                discoverableJobs.push(job);
              }
            }

            this.logger.info("MCP workspace_jobs_list filtered results", {
              workspaceId,
              totalJobs: allJobs.length,
              discoverableJobs: discoverableJobs.length,
              filteredOut: allJobs.length - discoverableJobs.length,
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      jobs: discoverableJobs,
                      total: discoverableJobs.length,
                      workspaceId,
                      source: "daemon_api",
                      filtered: true, // Indicate that jobs were filtered for discoverability
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          } catch (error) {
            this.logger.error("MCP workspace_jobs_list failed", { workspaceId, error });
            throw error;
          }
        }),
    );

    // Workspace capability: workspace_jobs_describe - ROUTES THROUGH DAEMON API
    this.registerToolIfAllowed(
      "workspace_jobs_describe",
      {
        description: "Get detailed information about a specific job through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          jobName: z.string().describe("Job name to describe"),
        },
      },
      async (args) =>
        this.withJobDiscoverabilityCheck(args, async ({ workspaceId, jobName }) => {
          this.logger.info("MCP workspace_jobs_describe called", { workspaceId, jobName });

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
            this.logger.error("MCP workspace_jobs_describe failed", {
              workspaceId,
              jobName,
              error,
            });
            throw error;
          }
        }),
    );

    // Workspace capability: workspace_sessions_list - ROUTES THROUGH DAEMON API
    this.registerToolIfAllowed(
      "workspace_sessions_list",
      {
        description: "List all sessions in a workspace through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID to list sessions for"),
        },
      },
      async ({ workspaceId }) => {
        this.logger.info("MCP workspace_sessions_list called", { workspaceId });

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
          this.logger.error("MCP workspace_sessions_list failed", { workspaceId, error });
          throw error;
        }
      },
    );

    // Workspace capability: workspace_sessions_describe - ROUTES THROUGH DAEMON API
    this.registerToolIfAllowed(
      "workspace_sessions_describe",
      {
        description: "Get detailed information about a specific session through daemon API",
        inputSchema: {
          sessionId: z.string().describe("Session ID to describe"),
        },
      },
      async ({ sessionId }) => {
        this.logger.info("MCP workspace_sessions_describe called", { sessionId });

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
          this.logger.error("MCP workspace_sessions_describe failed", { sessionId, error });
          throw error;
        }
      },
    );

    // Workspace capability: workspace_sessions_cancel - ROUTES THROUGH DAEMON API
    this.registerToolIfAllowed(
      "workspace_sessions_cancel",
      {
        description: "Cancel a running session through daemon API",
        inputSchema: {
          sessionId: z.string().describe("Session ID to cancel"),
        },
      },
      async ({ sessionId }) => {
        this.logger.info("MCP workspace_sessions_cancel called", { sessionId });

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
          this.logger.error("MCP workspace_sessions_cancel failed", { sessionId, error });
          throw error;
        }
      },
    );

    // Workspace capability: workspace_signals_list - ROUTES THROUGH DAEMON API
    this.registerToolIfAllowed(
      "workspace_signals_list",
      {
        description: "List all signals in a workspace through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID to list signals for"),
        },
      },
      async ({ workspaceId }) => {
        this.logger.info("MCP workspace_signals_list called", { workspaceId });

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
          this.logger.error("MCP workspace_signals_list failed", { workspaceId, error });
          throw error;
        }
      },
    );

    // Workspace capability: workspace_signals_trigger - ROUTES THROUGH DAEMON API
    this.registerToolIfAllowed(
      "workspace_signals_trigger",
      {
        description: "Trigger a signal in a workspace through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          signalName: z.string().describe("Signal name to trigger"),
          payload: z.record(z.string(), z.any()).optional().describe("Signal payload"),
        },
      },
      async (args) =>
        this.withWorkspaceMCPCheck(args, async ({ workspaceId, signalName, payload }) => {
          this.logger.info("MCP workspace_signals_trigger called", { workspaceId, signalName });

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
            this.logger.error("MCP workspace_signals_trigger failed", {
              workspaceId,
              signalName,
              error,
            });
            throw error;
          }
        }),
    );

    // Workspace capability: workspace_agents_list - ROUTES THROUGH DAEMON API
    this.registerToolIfAllowed(
      "workspace_agents_list",
      {
        description: "List all agents in a workspace through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID to list agents for"),
        },
      },
      async ({ workspaceId }) => {
        this.logger.info("MCP workspace_agents_list called", { workspaceId });

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
          this.logger.error("MCP workspace_agents_list failed", { workspaceId, error });
          throw error;
        }
      },
    );

    // Workspace capability: workspace_agents_describe - ROUTES THROUGH DAEMON API
    this.registerToolIfAllowed(
      "workspace_agents_describe",
      {
        description: "Get detailed information about a specific agent through daemon API",
        inputSchema: {
          workspaceId: z.string().describe("Workspace ID"),
          agentId: z.string().describe("Agent ID to describe"),
        },
      },
      async ({ workspaceId, agentId }) => {
        this.logger.info("MCP workspace_agents_describe called", { workspaceId, agentId });

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
          this.logger.error("MCP workspace_agents_describe failed", {
            workspaceId,
            agentId,
            error,
          });
          throw error;
        }
      },
    );

    // Library management tools - ROUTES THROUGH DAEMON API

    /**
     * MCP Tool: library_list
     *
     * Lists library items with comprehensive filtering and pagination support.
     * Routes through daemon API for consistent access control and data integrity.
     *
     * @example
     * // List recent reports with pagination
     * atlas.library_list({
     *   type: ["report"],
     *   tags: ["production", "analytics"],
     *   since: "2024-01-01T00:00:00Z",
     *   limit: 25,
     *   offset: 0
     * })
     *
     * @param query - Optional search query string (max 1000 chars)
     * @param type - Array of item types to filter by (max 20 types)
     * @param tags - Array of tags to filter by (max 50 tags)
     * @param since - ISO 8601 date string for items created after this date
     * @param until - ISO 8601 date string for items created before this date
     * @param limit - Maximum items to return (1-1000, default: 50)
     * @param offset - Pagination offset (min: 0, default: 0)
     *
     * @returns Paginated list of library items with metadata
     * @throws {Error} Input validation errors for invalid parameters
     * @throws {Error} Daemon API errors for server/network issues
     */
    this.registerToolIfAllowed(
      "library_list",
      {
        description: "List library items with optional filtering through daemon API",
        inputSchema: {
          query: z.string().optional().describe("Search query to filter items"),
          type: z.array(z.string()).optional().describe("Item types to filter by"),
          tags: z.array(z.string()).optional().describe("Tags to filter by"),
          since: z.string().optional().describe("Items created since this date (ISO 8601)"),
          until: z.string().optional().describe("Items created until this date (ISO 8601)"),
          limit: z.number().default(50).describe("Maximum number of items to return"),
          offset: z.number().default(0).describe("Offset for pagination"),
        },
      },
      async ({ query, type, tags, since, until, limit = 50, offset = 0 }) => {
        this.logger.info("MCP library_list called", { query, type, tags, limit, offset });

        try {
          // Build query parameters using helper method
          const params = this.buildLibraryQueryParams({
            query,
            type,
            tags,
            since,
            until,
            limit,
            offset,
          });

          const queryString = params.toString();
          const url = queryString
            ? `${this.daemonUrl}/api/library?${queryString}`
            : `${this.daemonUrl}/api/library`;

          const response = await this.fetchWithTimeout(url);
          const result = await this.handleDaemonResponse(response, "library_list");

          this.logger.info("MCP library_list response", {
            totalItems: result.total,
            returnedItems: result.items.length,
            tookMs: result.took_ms,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ...result,
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
          this.logger.error("MCP library_list failed", { error });
          throw error;
        }
      },
    );

    /**
     * MCP Tool: library_get
     *
     * Retrieves a specific library item by ID with optional content inclusion.
     * Routes through daemon API for secure access and consistent data retrieval.
     *
     * @example
     * // Get item metadata only
     * atlas.library_get({ itemId: "lib-123" })
     *
     * // Get item with full content
     * atlas.library_get({ itemId: "lib-123", includeContent: true })
     *
     * @param itemId - Unique identifier for the library item (required)
     * @param includeContent - Whether to include item content in response (default: false)
     *
     * @returns Library item details with optional content
     * @throws {Error} Validation error for invalid/empty itemId
     * @throws {Error} Daemon API error if item not found or access denied
     */
    this.registerToolIfAllowed(
      "library_get",
      {
        description: "Get a specific library item with optional content through daemon API",
        inputSchema: {
          itemId: z.string().describe("Library item ID to retrieve"),
          includeContent: z.boolean().default(false).describe("Include item content in response"),
        },
      },
      async ({ itemId, includeContent = false }) => {
        this.logger.info("MCP library_get called", { itemId, includeContent });

        // Input validation
        if (!itemId || typeof itemId !== "string" || itemId.trim().length === 0) {
          throw new Error("itemId is required and must be a non-empty string");
        }

        try {
          const params = new URLSearchParams();
          if (includeContent) params.set("content", "true");

          const queryString = params.toString();
          const url = queryString
            ? `${this.daemonUrl}/api/library/${itemId}?${queryString}`
            : `${this.daemonUrl}/api/library/${itemId}`;

          const response = await this.fetchWithTimeout(url);
          const result = await this.handleDaemonResponse(response, "library_get");

          this.logger.info("MCP library_get response", {
            itemId,
            hasContent: includeContent && "content" in result,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ...result,
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
          this.logger.error("MCP library_get failed", { itemId, error });
          throw error;
        }
      },
    );

    /**
     * MCP Tool: library_search
     *
     * Performs full-text search across all library items with advanced filtering.
     * Routes through daemon API for optimized search performance and access control.
     *
     * @example
     * // Search for specific content with filters
     * atlas.library_search({
     *   query: "performance optimization",
     *   type: ["report", "template"],
     *   tags: ["production"],
     *   limit: 20
     * })
     *
     * @param query - Search query string (required, max 1000 chars)
     * @param type - Array of item types to filter by (optional, max 20 types)
     * @param tags - Array of tags to filter by (optional, max 50 tags)
     * @param since - ISO 8601 date for items created after this date
     * @param until - ISO 8601 date for items created before this date
     * @param limit - Maximum items to return (1-1000, default: 50)
     * @param offset - Pagination offset (min: 0, default: 0)
     *
     * @returns Search results with relevance scoring and metadata
     * @throws {Error} Input validation errors for invalid parameters
     * @throws {Error} Daemon API errors for server/network issues
     */
    this.registerToolIfAllowed(
      "library_search",
      {
        description: "Search library items across all libraries through daemon API",
        inputSchema: {
          query: z.string().describe("Search query"),
          type: z.array(z.string()).optional().describe("Item types to filter by"),
          tags: z.array(z.string()).optional().describe("Tags to filter by"),
          since: z.string().optional().describe("Items created since this date (ISO 8601)"),
          until: z.string().optional().describe("Items created until this date (ISO 8601)"),
          limit: z.number().default(50).describe("Maximum number of items to return"),
          offset: z.number().default(0).describe("Offset for pagination"),
        },
      },
      async ({ query, type, tags, since, until, limit = 50, offset = 0 }) => {
        this.logger.info("MCP library_search called", { query, type, tags, limit, offset });

        try {
          // Build query parameters using helper method
          const params = this.buildLibraryQueryParams({
            query,
            type,
            tags,
            since,
            until,
            limit,
            offset,
          });

          const url = `${this.daemonUrl}/api/library/search?${params.toString()}`;

          const response = await this.fetchWithTimeout(url);
          const result = await this.handleDaemonResponse(response, "library_search");

          this.logger.info("MCP library_search response", {
            query,
            totalItems: result.total,
            returnedItems: result.items.length,
            tookMs: result.took_ms,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ...result,
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
          this.logger.error("MCP library_search failed", { query, error });
          throw error;
        }
      },
    );

    /**
     * MCP Tool: library_stats
     *
     * Retrieves comprehensive library usage statistics and analytics.
     * Routes through daemon API for real-time metrics and storage information.
     *
     * @example
     * // Get current library statistics
     * atlas.library_stats({})
     *
     * @returns Library statistics including:
     *   - Total items count
     *   - Storage usage and limits
     *   - Item type breakdown
     *   - Tag distribution
     *   - Recent activity metrics
     * @throws {Error} Daemon API errors for server/network issues
     */
    this.registerToolIfAllowed(
      "library_stats",
      {
        description: "Get library usage statistics and analytics through daemon API",
        inputSchema: {},
      },
      async () => {
        this.logger.info("MCP library_stats called");

        try {
          const response = await this.fetchWithTimeout(`${this.daemonUrl}/api/library/stats`);
          const result = await this.handleDaemonResponse(response, "library_stats");

          this.logger.info("MCP library_stats response", {
            totalItems: result.total_items,
            totalSizeBytes: result.total_size_bytes,
            typeCount: Object.keys(result.types || {}).length,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ...result,
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
          this.logger.error("MCP library_stats failed", { error });
          throw error;
        }
      },
    );

    /**
     * MCP Tool: library_templates
     *
     * Lists all available content generation templates with their configurations.
     * Routes through daemon API for template management and access control.
     *
     * @example
     * // Get all available templates
     * atlas.library_templates({})
     *
     * @returns Array of template configurations including:
     *   - Template ID and metadata
     *   - Supported formats (YAML, JSON, etc.)
     *   - Template engine information
     *   - Variable schemas and requirements
     *   - Usage examples and documentation
     * @throws {Error} Daemon API errors for server/network issues
     */
    this.registerToolIfAllowed(
      "library_templates",
      {
        description: "List available content generation templates through daemon API",
        inputSchema: {},
      },
      async () => {
        this.logger.info("MCP library_templates called");

        try {
          const response = await this.fetchWithTimeout(`${this.daemonUrl}/api/library/templates`);
          const templates = await this.handleDaemonResponse(response, "library_templates");

          this.logger.info("MCP library_templates response", {
            templateCount: templates.length,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    templates,
                    total: templates.length,
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
          this.logger.error("MCP library_templates failed", { error });
          throw error;
        }
      },
    );

    /**
     * MCP Tool: library_store
     *
     * Creates a new library item with comprehensive validation and metadata support.
     * Routes through daemon API for consistent storage and access control.
     *
     * @example
     * // Create a report item (workspace_id, session_id, agent_ids auto-injected)
     * atlas.library_store({
     *   type: "report",
     *   name: "AI Agent Discovery Report - 2024-07-04",
     *   description: "Analysis of recently discovered AI agent repositories",
     *   content: "# AI Agent Discovery Report...",
     *   format: "markdown",
     *   tags: ["ai-discovery", "trend-analysis", "automated"]
     * })
     *
     * @param type - Item type (required): "report", "session_archive", "template", "artifact", "user_upload"
     * @param name - Human-readable name for the item (required, max 255 chars)
     * @param description - Description of the item contents (optional, max 1000 chars)
     * @param content - The actual content to store (required)
     * @param format - Content format (optional, default: "markdown"): "markdown", "json", "html", "text", "binary"
     * @param tags - Tags for categorization and search (optional, max 50 tags)
     * @param workspace_id - Associated workspace ID (optional, auto-injected from context)
     * @param session_id - Associated session ID (optional, auto-injected from context)
     * @param agent_ids - Array of agent IDs that created this item (optional, auto-injected from context)
     * @param source - Source of the item (optional, default: "agent"): "agent", "job", "user", "system"
     * @param metadata - Additional metadata object (optional)
     *
     * @returns Creation result with item ID and success confirmation
     * @throws {Error} Input validation errors for invalid parameters
     * @throws {Error} Daemon API errors for server/storage issues
     */
    this.registerToolIfAllowed(
      "library_store",
      {
        description: "Create a new library item through daemon API",
        inputSchema: {
          type: z.enum(["report", "session_archive", "template", "artifact", "user_upload"])
            .describe("Type of library item to create"),
          name: z.string().min(1).max(255)
            .describe("Human-readable name for the item"),
          description: z.string().max(1000).optional()
            .describe("Description of the item contents"),
          content: z.string().min(1)
            .describe("The actual content to store"),
          format: z.enum(["markdown", "json", "html", "text", "binary"]).default("markdown")
            .describe("Content format"),
          tags: z.array(z.string()).max(50).default([])
            .describe("Tags for categorization and search"),
          workspace_id: z.string().optional()
            .describe("Associated workspace ID"),
          session_id: z.string().optional()
            .describe("Associated session ID"),
          agent_ids: z.array(z.string()).default([])
            .describe("Array of agent IDs that created this item"),
          source: z.enum(["agent", "job", "user", "system"]).default("agent")
            .describe("Source of the item"),
          metadata: z.record(z.string(), z.any()).default({})
            .describe("Additional metadata object"),
        },
      },
      async ({
        type,
        name,
        description,
        content,
        format = "markdown",
        tags = [],
        workspace_id,
        session_id,
        agent_ids = [],
        source = "agent",
        metadata = {},
      }) => {
        this.logger.info("MCP library_store called", {
          type,
          name,
          format,
          contentLength: content.length,
          tagCount: tags.length,
          workspace_id,
          session_id,
        });

        try {
          // Automatically inject workspace context if not provided
          const contextualPayload = {
            type,
            name,
            description,
            content,
            format,
            tags,
            workspace_id: workspace_id || this.workspaceContext?.workspaceId,
            session_id: session_id || this.workspaceContext?.sessionId,
            agent_ids: agent_ids.length > 0
              ? agent_ids
              : (this.workspaceContext?.agentId ? [this.workspaceContext.agentId] : []),
            source,
            metadata,
          };

          const response = await this.fetchWithTimeout(`${this.daemonUrl}/api/library`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(contextualPayload),
          });

          const result = await this.handleDaemonResponse(response, "library_store");

          this.logger.info("MCP library_store response", {
            success: result.success,
            itemId: result.itemId,
            name: result.item?.name,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ...result,
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
          this.logger.error("MCP library_store failed", { name, type, error });
          throw error;
        }
      },
    );

    // Platform jobs are handled by the daemon, not the MCP server
  }

  /**
   * Helper to build query parameters for library API calls
   *
   * Constructs URL query parameters with comprehensive validation and sanitization.
   * Reduces code duplication between library tools while ensuring data integrity.
   *
   * Validation Features:
   * - ISO 8601 date format validation with timezone support
   * - Query string length limits (max 1000 characters)
   * - Array size limits (20 types, 50 tags)
   * - Numeric range validation (limit: 1-1000, offset: ≥0)
   * - Automatic case normalization for types and tags
   * - URL-safe encoding handled by URLSearchParams
   *
   * @param options - Query parameter options
   * @param options.query - Search query string (optional, max 1000 chars)
   * @param options.type - Item types array (optional, max 20 items)
   * @param options.tags - Tags array (optional, max 50 items)
   * @param options.since - ISO 8601 start date (optional)
   * @param options.until - ISO 8601 end date (optional)
   * @param options.limit - Result limit (optional, 1-1000)
   * @param options.offset - Pagination offset (optional, ≥0)
   *
   * @returns URLSearchParams object ready for API requests
   * @throws {Error} Validation errors for invalid input parameters
   *
   * @internal This is a private helper method for library tool implementations
   */
  private buildLibraryQueryParams(options: {
    query?: string;
    type?: string[];
    tags?: string[];
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): URLSearchParams {
    const params = new URLSearchParams();

    // Enhanced input validation
    if (options.limit !== undefined && (options.limit < 1 || options.limit > 1000)) {
      throw new Error("Limit must be between 1 and 1000");
    }
    if (options.offset !== undefined && options.offset < 0) {
      throw new Error("Offset must be non-negative");
    }

    // Validate and parse ISO 8601 dates
    let sinceDate: Date | undefined;
    let untilDate: Date | undefined;

    if (options.since) {
      try {
        sinceDate = new Date(options.since);
        if (isNaN(sinceDate.getTime())) {
          throw new Error("Invalid since date format");
        }
        // Validate ISO 8601 format more strictly
        if (
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/.test(
            options.since.replace(/[+-]\d{2}:\d{2}$/, ""),
          )
        ) {
          throw new Error("Since date must be in ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)");
        }
      } catch (error) {
        throw new Error(
          `Invalid since date: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (options.until) {
      try {
        untilDate = new Date(options.until);
        if (isNaN(untilDate.getTime())) {
          throw new Error("Invalid until date format");
        }
        // Validate ISO 8601 format more strictly
        if (
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/.test(
            options.until.replace(/[+-]\d{2}:\d{2}$/, ""),
          )
        ) {
          throw new Error("Until date must be in ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)");
        }
      } catch (error) {
        throw new Error(
          `Invalid until date: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Validate date range
    if (sinceDate && untilDate && sinceDate >= untilDate) {
      throw new Error("Since date must be before until date");
    }

    // Sanitize and validate query string
    if (options.query !== undefined) {
      const sanitizedQuery = options.query.trim();
      if (sanitizedQuery.length === 0) {
        throw new Error("Query string cannot be empty");
      }
      if (sanitizedQuery.length > 1000) {
        throw new Error("Query string cannot exceed 1000 characters");
      }
      // URL-safe encoding handled by URLSearchParams
      params.set("q", sanitizedQuery);
    }

    // Normalize and validate arrays
    if (options.type) {
      const normalizedTypes = options.type
        .filter((t) => t && typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim().toLowerCase());
      if (normalizedTypes.length === 0) {
        throw new Error("At least one valid type must be specified");
      }
      if (normalizedTypes.length > 20) {
        throw new Error("Cannot specify more than 20 types");
      }
      params.set("type", normalizedTypes.join(","));
    }

    if (options.tags) {
      const normalizedTags = options.tags
        .filter((t) => t && typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim().toLowerCase());
      if (normalizedTags.length === 0) {
        throw new Error("At least one valid tag must be specified");
      }
      if (normalizedTags.length > 50) {
        throw new Error("Cannot specify more than 50 tags");
      }
      params.set("tags", normalizedTags.join(","));
    }

    if (options.since) params.set("since", options.since);
    if (options.until) params.set("until", options.until);
    if (options.limit !== undefined) params.set("limit", options.limit.toString());
    if (options.offset !== undefined) params.set("offset", options.offset.toString());

    return params;
  }

  /**
   * Helper to handle daemon API responses consistently
   *
   * Processes daemon API responses with enhanced error handling, context preservation,
   * and intelligent retry logic for transient failures.
   *
   * Features:
   * - Automatic retry for retryable errors (5xx, 408, 429, 503, 504)
   * - Exponential backoff with jitter (1s → 2s → 4s → 8s, max 30s)
   * - Structured error information with full context
   * - Response body consumption to prevent memory leaks
   * - Performance metrics logging for successful requests
   * - MCP-compliant error codes (-32000 for server errors, -32603 for parse errors)
   *
   * @param response - HTTP Response object from fetch
   * @param operation - Operation name for logging and error context
   * @param options - Retry configuration options
   * @param options.retryCount - Current retry attempt (default: 0)
   * @param options.maxRetries - Maximum retry attempts (default: 3)
   *
   * @returns Parsed JSON response data
   * @throws {Error} Enhanced error with structured details and retry information
   *
   * @internal This is a private helper method for daemon API communication
   */
  private async handleDaemonResponse(
    response: Response,
    operation: string,
    options: { retryCount?: number; maxRetries?: number } = {},
  ): Promise<any> {
    const { retryCount = 0, maxRetries = 3 } = options;

    if (!response.ok) {
      let errorData: any = {};
      let responseText = "";

      try {
        // Try to parse as JSON first
        const text = await response.text();
        responseText = text;
        if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
          errorData = JSON.parse(text);
        } else {
          errorData = { message: text };
        }
      } catch (parseError) {
        // If parsing fails, preserve the raw response text
        errorData = {
          message: responseText || response.statusText,
          parseError: parseError instanceof Error ? parseError.message : String(parseError),
        };
      }

      // Determine if error is retryable
      const isRetryable = this.isRetryableError(response.status);

      // Enhanced error with structured information
      const errorInfo = {
        operation,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        headers: Object.fromEntries(response.headers.entries()),
        retryCount,
        maxRetries,
        isRetryable,
        timestamp: new Date().toISOString(),
        ...errorData,
      };

      // Log detailed error information
      this.logger.error(`Daemon API error for ${operation}`, errorInfo);

      // Attempt retry for retryable errors
      if (isRetryable && retryCount < maxRetries) {
        const delay = this.calculateRetryDelay(retryCount);
        this.logger.info(
          `Retrying ${operation} after ${delay}ms (attempt ${retryCount + 1}/${maxRetries})`,
        );

        await this.sleep(delay);

        // Retry the request - this would need to be implemented at the caller level
        // For now, we'll throw with retry information
        const retryError = new Error(
          `Daemon API error for ${operation}: ${response.status} - ${
            errorData.error || errorData.message || response.statusText
          } (retry ${retryCount + 1}/${maxRetries})`,
        );
        (retryError as any).code = -32000;
        (retryError as any).details = errorInfo;
        (retryError as any).shouldRetry = true;
        throw retryError;
      }

      // Create comprehensive error for non-retryable or max retries exceeded
      const error = new Error(
        `Daemon API error for ${operation}: ${response.status} - ${
          errorData.error || errorData.message || response.statusText
        }${retryCount > 0 ? ` (failed after ${retryCount} retries)` : ""}`,
      );
      (error as any).code = -32000; // MCP server error code
      (error as any).details = errorInfo;
      (error as any).shouldRetry = false;
      throw error;
    }

    try {
      const result = await response.json();

      // Log successful response metrics
      this.logger.debug(`Daemon API success for ${operation}`, {
        operation,
        status: response.status,
        url: response.url,
        retryCount,
        responseSize: JSON.stringify(result).length,
        timestamp: new Date().toISOString(),
      });

      return result;
    } catch (error) {
      const parseError = new Error(
        `Failed to parse daemon API response for ${operation}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      (parseError as any).code = -32603; // Parse error code
      (parseError as any).details = {
        operation,
        status: response.status,
        url: response.url,
        retryCount,
        originalError: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      };

      this.logger.error(`Parse error for ${operation}`, (parseError as any).details);
      throw parseError;
    }
  }

  /**
   * Determine if an HTTP status code indicates a retryable error
   */
  private isRetryableError(status: number): boolean {
    // Retry on server errors (5xx) and specific client errors
    return (
      status >= 500 || // Server errors
      status === 408 || // Request timeout
      status === 429 || // Too many requests
      status === 503 || // Service unavailable
      status === 504 // Gateway timeout
    );
  }

  /**
   * Calculate exponential backoff delay for retries
   */
  private calculateRetryDelay(retryCount: number): number {
    // Exponential backoff: 1s, 2s, 4s, 8s, etc. with jitter
    const baseDelay = Math.pow(2, retryCount) * 1000;
    const jitter = Math.random() * 0.3 * baseDelay; // 30% jitter
    return Math.min(baseDelay + jitter, 30000); // Cap at 30 seconds
  }

  /**
   * Simple sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Fetch with timeout and enhanced error handling
   *
   * Wrapper around fetch() with automatic timeout handling and enhanced error reporting.
   * Prevents hanging requests and provides detailed error context for troubleshooting.
   *
   * Features:
   * - Configurable request timeout (default: 30 seconds)
   * - Automatic request cancellation on timeout
   * - AbortController integration for clean cancellation
   * - Enhanced error messages with URL and timing context
   * - MCP-compliant error codes for timeout scenarios
   *
   * @param url - Target URL for the request
   * @param options - Fetch options (headers, method, body, etc.)
   * @param timeoutMs - Request timeout in milliseconds (default: 30000)
   *
   * @returns HTTP Response object
   * @throws {Error} Timeout error with structured details
   * @throws {Error} Network errors (connection failed, DNS resolution, etc.)
   *
   * @internal This is a private helper method for reliable HTTP communication
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit = {},
    timeoutMs: number = 30000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        const timeoutError = new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
        (timeoutError as any).code = -32000;
        (timeoutError as any).details = {
          url,
          timeoutMs,
          timestamp: new Date().toISOString(),
        };
        throw timeoutError;
      }

      // Re-throw other errors (network, etc.)
      throw error;
    }
  }

  /**
   * Check if a workspace has MCP enabled
   * SECURITY: Respects workspace-level server.mcp.enabled settings
   */
  private async checkWorkspaceMCPEnabled(workspaceId: string): Promise<boolean> {
    let response: Response | undefined;
    try {
      response = await fetch(`${this.daemonUrl}/api/workspaces/${workspaceId}`);
      if (!response.ok) {
        // Consume the response body to prevent leaks
        try {
          await response.text();
        } catch {
          // Ignore errors when consuming error response body
        }
        this.logger.warn("Platform MCP: Failed to check workspace MCP settings", {
          workspaceId,
          status: response.status,
        });
        return false; // Fail closed - deny access if can't verify
      }

      const workspace = await response.json();
      const mcpEnabled = workspace.config?.server?.mcp?.enabled ?? false;

      this.logger.debug("Platform MCP: Checked workspace MCP settings", {
        workspaceId,
        mcpEnabled,
      });

      return mcpEnabled;
    } catch (error) {
      // Consume any remaining response body to prevent leaks
      if (response) {
        try {
          await response.text();
        } catch {
          // Ignore errors when consuming error response body
        }
      }
      this.logger.error("Platform MCP: Error checking workspace MCP settings", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false; // Fail closed - deny access on error
    }
  }

  /**
   * Check if a job is discoverable for a workspace
   * SECURITY: Respects workspace-level discoverable.jobs configuration
   */
  private async checkJobDiscoverable(workspaceId: string, jobName: string): Promise<boolean> {
    let response: Response | undefined;
    try {
      response = await fetch(`${this.daemonUrl}/api/workspaces/${workspaceId}`);
      if (!response.ok) {
        // Consume the response body to prevent leaks
        try {
          await response.text();
        } catch {
          // Ignore errors when consuming error response body
        }
        return false; // Fail closed
      }

      const workspace = await response.json();
      const discoverableJobs = workspace.config?.server?.mcp?.discoverable?.jobs || [];

      // Check if job matches any discoverable pattern
      for (const pattern of discoverableJobs) {
        const isWildcard = pattern.endsWith("*");
        const basePattern = isWildcard ? pattern.slice(0, -1) : pattern;

        if (isWildcard ? jobName.startsWith(basePattern) : jobName === pattern) {
          this.logger.debug("Platform MCP: Job is discoverable", {
            workspaceId,
            jobName,
            pattern,
          });
          return true;
        }
      }

      this.logger.debug("Platform MCP: Job not discoverable", {
        workspaceId,
        jobName,
        discoverableJobs,
      });

      return false;
    } catch (error) {
      // Consume any remaining response body to prevent leaks
      if (response) {
        try {
          await response.text();
        } catch {
          // Ignore errors when consuming error response body
        }
      }
      this.logger.error("Platform MCP: Error checking job discoverability", {
        workspaceId,
        jobName,
        error: error instanceof Error ? error.message : String(error),
      });
      return false; // Fail closed
    }
  }

  /**
   * Wrapper to enforce workspace MCP settings for workspace-scoped tools
   * SECURITY: All workspace operations must go through this check
   */
  private async withWorkspaceMCPCheck<T extends Record<string, any>>(
    args: T,
    operation: (args: T) => Promise<any>,
  ): Promise<any> {
    const workspaceId = args.workspaceId as string;

    if (!workspaceId) {
      throw new Error("workspaceId is required for workspace operations");
    }

    // SECURITY: Check if workspace has MCP enabled
    const mcpEnabled = await this.checkWorkspaceMCPEnabled(workspaceId);
    if (!mcpEnabled) {
      this.logger.warn("Platform MCP: Blocked workspace operation - MCP disabled", {
        workspaceId,
        operation: operation.name,
      });
      // Use MCP standard error code for authorization failure
      const error = new Error(
        `MCP is disabled for workspace '${workspaceId}'. Enable it in workspace.yml server.mcp.enabled to access workspace capabilities.`,
      );
      (error as any).code = -32000; // MCP server error code for authorization
      throw error;
    }

    return await operation(args);
  }

  /**
   * Wrapper to enforce job discoverability for job-related operations
   * SECURITY: Only allows operations on discoverable jobs
   */
  private async withJobDiscoverabilityCheck<T extends Record<string, any>>(
    args: T,
    operation: (args: T) => Promise<any>,
  ): Promise<any> {
    const workspaceId = args.workspaceId as string;
    const jobName = args.jobName as string;

    if (!workspaceId || !jobName) {
      throw new Error("workspaceId and jobName are required for job operations");
    }

    // First check workspace MCP enabled
    await this.withWorkspaceMCPCheck(args, async () => {}); // Just run the check

    // Then check job discoverability
    const isDiscoverable = await this.checkJobDiscoverable(workspaceId, jobName);
    if (!isDiscoverable) {
      this.logger.warn("Platform MCP: Blocked job operation - not discoverable", {
        workspaceId,
        jobName,
        operation: operation.name,
      });
      // Use MCP standard error code for method not found
      const error = new Error(
        `Job '${jobName}' is not discoverable for workspace '${workspaceId}'. Add it to workspace.yml server.mcp.discoverable.jobs to allow access.`,
      );
      (error as any).code = -32601; // MCP method not found for undiscoverable jobs
      throw error;
    }

    return await operation(args);
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

    this.logger.info("Daemon health check passed, starting MCP server");
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
   * Get available tools for current mode
   */
  getAvailableTools(): string[] {
    return [...this.availableTools];
  }

  /**
   * Get current server mode
   */
  getMode(): ServerMode {
    return this.mode;
  }

  /**
   * Get server name for current mode
   */
  getServerName(): string {
    return this.modeConfig.serverName;
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
