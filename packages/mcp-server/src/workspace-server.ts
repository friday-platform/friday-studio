/**
 * Workspace MCP Server for Atlas
 * Exposes ONLY workspace-specific job execution capabilities
 * Security: Does NOT expose platform-level session management or agent introspection
 */

import type { WorkspaceConfig } from "@atlas/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Logger interface for dependency injection
interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

export interface WorkspaceMCPServerDependencies {
  workspaceRuntime: {
    // SECURITY: Only expose safe, workspace-scoped job operations
    listJobs(): Promise<Array<{ name: string; description?: string }>>;
    triggerJob(jobName: string, payload?: unknown): Promise<{ sessionId: string }>;
    describeJob(jobName: string): Promise<unknown>;
    // REMOVED: session management, signal triggering, agent introspection
    // These are platform-level capabilities that workspace MCP should not expose
  };
  workspaceConfig: WorkspaceConfig;
  logger: Logger;
}

export class WorkspaceMCPServer {
  private server: Server;
  private transport: StdioServerTransport;
  private dependencies: WorkspaceMCPServerDependencies;
  private logger: Logger;

  constructor(dependencies: WorkspaceMCPServerDependencies) {
    this.dependencies = dependencies;
    this.logger = dependencies.logger;

    // Create server
    this.server = new Server(
      { name: `atlas-workspace-${dependencies.workspaceConfig.workspace.id}`, version: "1.0.0" },
      { capabilities: { tools: {}, prompts: {} } },
    );

    // Create stdio transport
    this.transport = new StdioServerTransport();

    this.setupRequestHandlers();
  }

  private setupRequestHandlers(): void {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, () => {
      const tools = [];
      const serverConfig = this.dependencies.workspaceConfig.server?.mcp;

      // Only expose capabilities if MCP is enabled
      if (!serverConfig?.enabled) {
        this.logger.warn("MCP server disabled in configuration", {
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
              description:
                "Discover all automated tasks (jobs) available in this workspace. Jobs are reusable workflows that can perform operations like builds, deployments, data processing, or custom automation within this workspace environment.",
              inputSchema: { type: "object", properties: {} },
            });
            break;
          case "workspace_jobs_describe":
            tools.push({
              name: "workspace_jobs_describe",
              description:
                "Examine a specific job's configuration, capabilities, expected inputs, and execution requirements. Use this to understand how to properly trigger a job or what it will accomplish.",
              inputSchema: {
                type: "object",
                properties: {
                  jobName: {
                    type: "string",
                    description:
                      "Name of the specific job to examine (obtain from workspace_jobs_list)",
                  },
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
            description:
              jobSpec?.description ||
              `Execute the '${jobName}' workflow in this workspace. This job will run its configured agents in the defined execution strategy (sequential/parallel), with each agent receiving appropriate input sources (signal payload, previous results, or filesystem context) and using their assigned MCP tools to complete their specialized tasks.`,
            inputSchema: {
              type: "object",
              properties: {
                payload: {
                  type: "object",
                  description:
                    "Optional input data/configuration to pass to the job execution (structure depends on job requirements)",
                  additionalProperties: true,
                },
              },
            },
          });
        }
      }

      this.logger.info("WorkspaceMCPServer tools exposed", {
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
              const { jobName } = args;
              const job = await this.dependencies.workspaceRuntime.describeJob(jobName);
              return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
            }

            default:
              throw new Error(`Capability ${name} is not implemented`);
          }
        }

        // Check if it's a discoverable job
        const discoverableJobs = this.getDiscoverableJobs();
        if (discoverableJobs.includes(name)) {
          const { payload } = args;

          const result = await this.dependencies.workspaceRuntime.triggerJob(name, payload);

          this.logger.info("WorkspaceMCPServer job triggered", {
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
        this.logger.warn("WorkspaceMCPServer unauthorized tool call", {
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
  ): unknown {
    return {
      [`atlas-workspace-${workspaceId}`]: {
        command,
        args,
        env: { ATLAS_WORKSPACE_ID: workspaceId },
      },
    };
  }
}
