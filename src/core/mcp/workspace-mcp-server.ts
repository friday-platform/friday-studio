/**
 * Workspace MCP Server for Atlas
 * Exposes ONLY workspace-specific job execution capabilities
 * Security: Does NOT expose platform-level session management or agent introspection
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { WorkspaceConfig } from "@atlas/config";
import { logger } from "../../utils/logger.ts";

// Rate limiting state
interface RateLimitState {
  requestCounts: Map<string, { count: number; resetTime: number }>; // key -> {count, resetTime}
  activeSessions: Set<string>;
}

// Rate limit error
class RateLimitError extends Error {
  constructor(message: string, public retryAfter?: number) {
    super(message);
    this.name = "RateLimitError";
    (this as any).code = -32000; // MCP server error code
  }
}

export interface WorkspaceMCPServerDependencies {
  workspaceRuntime: {
    // SECURITY: Only expose safe, workspace-scoped job operations
    listJobs(): Promise<Array<{ name: string; description?: string }>>;
    triggerJob(jobName: string, payload?: any): Promise<{ sessionId: string }>;
    describeJob(jobName: string): Promise<any>;
    // REMOVED: session management, signal triggering, agent introspection
    // These are platform-level capabilities that workspace MCP should not expose
  };
  workspaceConfig: WorkspaceConfig;
}

export class WorkspaceMCPServer {
  private server: Server;
  private transport: StdioServerTransport;
  private dependencies: WorkspaceMCPServerDependencies;
  private rateLimitState: RateLimitState;

  constructor(dependencies: WorkspaceMCPServerDependencies) {
    this.dependencies = dependencies;

    // Initialize rate limiting state
    this.rateLimitState = {
      requestCounts: new Map(),
      activeSessions: new Set(),
    };

    // Create server
    this.server = new Server(
      {
        name: `atlas-workspace-${dependencies.workspaceConfig.workspace.id}`,
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    // Create stdio transport
    this.transport = new StdioServerTransport();

    this.setupRequestHandlers();
  }

  private setupRequestHandlers(): void {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = [];
      const serverConfig = this.dependencies.workspaceConfig.server?.mcp;

      // Only expose capabilities if MCP is enabled
      if (!serverConfig?.enabled) {
        logger.warn("MCP server disabled in configuration", {
          workspaceId: this.dependencies.workspaceConfig.workspace.id,
        });
        return { tools: [] };
      }

      // Filter capabilities based on discoverable configuration
      const discoverableCapabilities = serverConfig.discoverable?.capabilities || [];
      const allowedCapabilities = this.filterAllowedCapabilities(discoverableCapabilities);

      // Only add allowed capabilities
      for (const capability of allowedCapabilities) {
        switch (capability) {
          case "workspace_jobs_list":
            tools.push({
              name: "workspace_jobs_list",
              description: "List all jobs in this workspace",
              inputSchema: {
                type: "object",
                properties: {},
              },
            });
            break;
          case "workspace_jobs_describe":
            tools.push({
              name: "workspace_jobs_describe",
              description: "Get detailed information about a job",
              inputSchema: {
                type: "object",
                properties: {
                  jobName: { type: "string", description: "Name of the job to describe" },
                },
                required: ["jobName"],
              },
            });
            break;
            // NOTE: workspace_jobs_trigger is handled separately through discoverable jobs
        }
      }

      // Add discoverable jobs as direct execution tools
      const discoverableJobs = this.getDiscoverableJobs();
      for (const jobName of discoverableJobs) {
        const jobSpec = this.dependencies.workspaceConfig.jobs?.[jobName];
        if (jobSpec) {
          tools.push({
            name: jobName,
            description: (jobSpec as any)?.description || `Execute workspace job: ${jobName}`,
            inputSchema: {
              type: "object",
              properties: {
                payload: {
                  type: "object",
                  description: "Optional payload for the job",
                  additionalProperties: true,
                },
              },
            },
          });
        }
      }

      logger.info("WorkspaceMCPServer tools exposed", {
        workspaceId: this.dependencies.workspaceConfig.workspace.id,
        capabilityCount: allowedCapabilities.length,
        jobCount: discoverableJobs.length,
        totalTools: tools.length,
        capabilities: allowedCapabilities,
        jobs: discoverableJobs,
      });

      return { tools };
    });

    // Handle tool calls - SECURITY: Only handle allowed capabilities and discoverable jobs
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const serverConfig = this.dependencies.workspaceConfig.server?.mcp;

      // Security check: MCP must be enabled
      if (!serverConfig?.enabled) {
        throw new Error("MCP server is disabled for this workspace");
      }

      // Rate limiting check - prevents abuse
      try {
        this.checkRateLimit(); // TODO: Extract actual client ID from request context
      } catch (error) {
        if (error instanceof RateLimitError) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: true,
                    type: "rate_limit_exceeded",
                    message: error.message,
                    retryAfter: error.retryAfter,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
        throw error;
      }

      try {
        // Check if it's an allowed capability
        const discoverableCapabilities = serverConfig.discoverable?.capabilities || [];
        const allowedCapabilities = this.filterAllowedCapabilities(discoverableCapabilities);

        if (allowedCapabilities.includes(name)) {
          switch (name) {
            case "workspace_jobs_list": {
              const jobs = await this.dependencies.workspaceRuntime.listJobs();
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        jobs,
                        total: jobs.length,
                        workspace: this.dependencies.workspaceConfig.workspace.name,
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }

            case "workspace_jobs_describe": {
              const { jobName } = args as { jobName: string };
              const job = await this.dependencies.workspaceRuntime.describeJob(jobName);
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(job, null, 2),
                  },
                ],
              };
            }

            default:
              throw new Error(`Capability ${name} is not implemented`);
          }
        }

        // Check if it's a discoverable job
        const discoverableJobs = this.getDiscoverableJobs();
        if (discoverableJobs.includes(name)) {
          const { payload } = args as { payload?: any };

          // Check concurrent session limit before triggering job
          this.checkRateLimit(); // Additional check for session limit

          const result = await this.dependencies.workspaceRuntime.triggerJob(name, payload);

          // Track session for concurrent session limiting
          this.trackSessionStart(result.sessionId);

          logger.info("WorkspaceMCPServer job triggered", {
            workspaceId: this.dependencies.workspaceConfig.workspace.id,
            jobName: name,
            sessionId: result.sessionId,
            hasPayload: !!payload,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    sessionId: result.sessionId,
                    job: name,
                    workspace: this.dependencies.workspaceConfig.workspace.name,
                    message: `Job '${name}' triggered successfully`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // Security: Explicitly reject unknown tools
        logger.warn("WorkspaceMCPServer unauthorized tool call", {
          workspaceId: this.dependencies.workspaceConfig.workspace.id,
          toolName: name,
          allowedCapabilities,
          discoverableJobs,
        });

        throw new Error(`Tool '${name}' is not available in this workspace's MCP configuration`);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: true,
                  message: error instanceof Error ? error.message : String(error),
                  tool: name,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    });
  }

  private getDiscoverableJobs(): string[] {
    const serverConfig = this.dependencies.workspaceConfig.server;
    const discoverableJobs = serverConfig?.mcp?.discoverable?.jobs || [];
    const availableJobs = Object.keys(this.dependencies.workspaceConfig.jobs || {});

    const matchingJobs: string[] = [];

    for (const pattern of discoverableJobs) {
      if (pattern.includes("*")) {
        // Handle glob patterns
        const regex = new RegExp(pattern.replace(/\*/g, ".*"));
        for (const job of availableJobs) {
          if (regex.test(job)) {
            matchingJobs.push(job);
          }
        }
      } else {
        // Exact match
        if (availableJobs.includes(pattern)) {
          matchingJobs.push(pattern);
        }
      }
    }

    return [...new Set(matchingJobs)]; // Remove duplicates
  }

  /**
   * Filter allowed workspace capabilities based on discoverable configuration
   * SECURITY: Only allows safe, workspace-scoped capabilities
   */
  private filterAllowedCapabilities(discoverableCapabilities: string[]): string[] {
    // Define the secure subset of workspace capabilities that can be exposed
    const safeWorkspaceCapabilities = [
      "workspace_jobs_list",
      "workspace_jobs_describe",
      // NOTE: workspace_jobs_trigger is handled separately through discoverable jobs
      // SECURITY: Removed session management, signal triggering, and agent introspection
    ];

    const allowedCapabilities: string[] = [];

    for (const pattern of discoverableCapabilities) {
      const isWildcard = pattern.endsWith("*");
      const basePattern = isWildcard ? pattern.slice(0, -1) : pattern;

      // Find matching safe capabilities
      const matchingCapabilities = safeWorkspaceCapabilities.filter((cap) => {
        return isWildcard ? cap.startsWith(basePattern) : cap === pattern;
      });

      allowedCapabilities.push(...matchingCapabilities);
    }

    return [...new Set(allowedCapabilities)]; // Remove duplicates
  }

  /**
   * Check and enforce rate limits
   * SECURITY: Prevents abuse of workspace MCP server
   */
  private checkRateLimit(clientId: string = "default"): void {
    const serverConfig = this.dependencies.workspaceConfig.server?.mcp;
    const rateLimits = serverConfig?.rate_limits;

    if (!rateLimits) {
      return; // No rate limits configured
    }

    const now = Date.now();
    const hourInMs = 60 * 60 * 1000;

    // Check requests per hour limit
    if (rateLimits.requests_per_hour) {
      const clientState = this.rateLimitState.requestCounts.get(clientId);
      const resetTime = Math.floor(now / hourInMs) * hourInMs + hourInMs; // Next hour boundary

      if (!clientState || clientState.resetTime <= now) {
        // Reset or initialize counter
        this.rateLimitState.requestCounts.set(clientId, {
          count: 1,
          resetTime,
        });
      } else {
        // Increment counter and check limit
        clientState.count++;
        if (clientState.count > rateLimits.requests_per_hour) {
          const retryAfter = Math.ceil((resetTime - now) / 1000); // seconds until reset

          logger.warn("WorkspaceMCPServer rate limit exceeded", {
            workspaceId: this.dependencies.workspaceConfig.workspace.id,
            clientId,
            requestCount: clientState.count,
            limit: rateLimits.requests_per_hour,
            retryAfter,
          });

          throw new RateLimitError(
            `Rate limit exceeded: ${clientState.count}/${rateLimits.requests_per_hour} requests per hour`,
            retryAfter,
          );
        }
      }
    }

    // Check concurrent sessions limit
    if (
      rateLimits.concurrent_sessions &&
      this.rateLimitState.activeSessions.size >= rateLimits.concurrent_sessions
    ) {
      logger.warn("WorkspaceMCPServer concurrent session limit exceeded", {
        workspaceId: this.dependencies.workspaceConfig.workspace.id,
        activeSessions: this.rateLimitState.activeSessions.size,
        limit: rateLimits.concurrent_sessions,
      });

      throw new RateLimitError(
        `Concurrent session limit exceeded: ${this.rateLimitState.activeSessions.size}/${rateLimits.concurrent_sessions} active sessions`,
      );
    }
  }

  /**
   * Track session start for concurrent session limiting
   */
  private trackSessionStart(sessionId: string): void {
    const serverConfig = this.dependencies.workspaceConfig.server?.mcp;
    const rateLimits = serverConfig?.rate_limits;

    if (rateLimits?.concurrent_sessions) {
      this.rateLimitState.activeSessions.add(sessionId);

      logger.debug("WorkspaceMCPServer session started", {
        workspaceId: this.dependencies.workspaceConfig.workspace.id,
        sessionId,
        activeSessions: this.rateLimitState.activeSessions.size,
        limit: rateLimits.concurrent_sessions,
      });
    }
  }

  /**
   * Track session end for concurrent session limiting
   */
  private trackSessionEnd(sessionId: string): void {
    const serverConfig = this.dependencies.workspaceConfig.server?.mcp;
    const rateLimits = serverConfig?.rate_limits;

    if (rateLimits?.concurrent_sessions) {
      this.rateLimitState.activeSessions.delete(sessionId);

      logger.debug("WorkspaceMCPServer session ended", {
        workspaceId: this.dependencies.workspaceConfig.workspace.id,
        sessionId,
        activeSessions: this.rateLimitState.activeSessions.size,
      });
    }
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    await this.server.connect(this.transport);
  }

  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    await this.transport.close();
  }

  /**
   * Get server instance for testing
   */
  getServer(): Server {
    return this.server;
  }

  /**
   * Get available tools - SECURITY: Only returns tools that are actually exposed
   */
  getAvailableTools(): string[] {
    const serverConfig = this.dependencies.workspaceConfig.server?.mcp;

    if (!serverConfig?.enabled) {
      return []; // MCP disabled, no tools available
    }

    // Get filtered capabilities based on configuration
    const discoverableCapabilities = serverConfig.discoverable?.capabilities || [];
    const allowedCapabilities = this.filterAllowedCapabilities(discoverableCapabilities);

    // Get discoverable jobs
    const discoverableJobs = this.getDiscoverableJobs();

    return [...allowedCapabilities, ...discoverableJobs];
  }

  /**
   * Create workspace MCP server configuration for clients
   */
  static createClientConfig(
    workspaceId: string,
    command: string = "atlas",
    args: string[] = ["workspace", "serve", "--mcp"],
  ): any {
    return {
      [`atlas-workspace-${workspaceId}`]: {
        command,
        args,
        env: {
          ATLAS_WORKSPACE_ID: workspaceId,
        },
      },
    };
  }
}
