/**
 * Workspace MCP Server for Atlas
 * Exposes workspace-specific capabilities like jobs, sessions, agents
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { NewWorkspaceConfig } from "../config-loader.ts";

export interface WorkspaceMCPServerDependencies {
  workspaceRuntime: {
    listJobs(): Promise<Array<{ name: string; description?: string }>>;
    triggerJob(jobName: string, payload?: any): Promise<{ sessionId: string }>;
    describeJob(jobName: string): Promise<any>;
    listSessions(): Promise<Array<{ id: string; status: string; startedAt: string }>>;
    describeSession(sessionId: string): Promise<any>;
    cancelSession(sessionId: string): Promise<void>;
    listSignals(): Promise<Array<{ name: string; description?: string }>>;
    triggerSignal(signalName: string, payload?: any): Promise<void>;
    listAgents(): Promise<Array<{ id: string; type: string; purpose?: string }>>;
    describeAgent(agentId: string): Promise<any>;
  };
  workspaceConfig: NewWorkspaceConfig;
}

export class WorkspaceMCPServer {
  private server: Server;
  private transport: StdioServerTransport;
  private dependencies: WorkspaceMCPServerDependencies;

  constructor(dependencies: WorkspaceMCPServerDependencies) {
    this.dependencies = dependencies;

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

      // Base workspace capabilities
      tools.push(
        {
          name: "workspace_jobs_list",
          description: "List all jobs in this workspace",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "workspace_jobs_trigger",
          description: "Trigger a job in this workspace",
          inputSchema: {
            type: "object",
            properties: {
              jobName: { type: "string", description: "Name of the job to trigger" },
              payload: { type: "object", description: "Optional payload for the job" },
            },
            required: ["jobName"],
          },
        },
        {
          name: "workspace_jobs_describe",
          description: "Get detailed information about a job",
          inputSchema: {
            type: "object",
            properties: {
              jobName: { type: "string", description: "Name of the job to describe" },
            },
            required: ["jobName"],
          },
        },
        {
          name: "workspace_sessions_list",
          description: "List all sessions in this workspace",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "workspace_sessions_describe",
          description: "Get detailed information about a session",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: { type: "string", description: "ID of the session to describe" },
            },
            required: ["sessionId"],
          },
        },
        {
          name: "workspace_sessions_cancel",
          description: "Cancel a running session",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: { type: "string", description: "ID of the session to cancel" },
            },
            required: ["sessionId"],
          },
        },
        {
          name: "workspace_signals_list",
          description: "List all signals in this workspace",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "workspace_agents_list",
          description: "List all agents in this workspace",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "workspace_agents_describe",
          description: "Get detailed information about an agent",
          inputSchema: {
            type: "object",
            properties: {
              agentId: { type: "string", description: "ID of the agent to describe" },
            },
            required: ["agentId"],
          },
        },
      );

      // Add discoverable jobs as direct tools
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

      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
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

          case "workspace_jobs_trigger": {
            const { jobName, payload } = args as { jobName: string; payload?: any };
            const result = await this.dependencies.workspaceRuntime.triggerJob(jobName, payload);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      success: true,
                      sessionId: result.sessionId,
                      job: jobName,
                      payload,
                      message: `Job '${jobName}' triggered successfully`,
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

          case "workspace_sessions_list": {
            const sessions = await this.dependencies.workspaceRuntime.listSessions();
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      sessions,
                      total: sessions.length,
                      workspace: this.dependencies.workspaceConfig.workspace.name,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          case "workspace_sessions_describe": {
            const { sessionId } = args as { sessionId: string };
            const session = await this.dependencies.workspaceRuntime.describeSession(sessionId);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(session, null, 2),
                },
              ],
            };
          }

          case "workspace_sessions_cancel": {
            const { sessionId } = args as { sessionId: string };
            await this.dependencies.workspaceRuntime.cancelSession(sessionId);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      success: true,
                      sessionId,
                      message: `Session '${sessionId}' cancelled successfully`,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          case "workspace_signals_list": {
            const signals = await this.dependencies.workspaceRuntime.listSignals();
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      signals,
                      total: signals.length,
                      workspace: this.dependencies.workspaceConfig.workspace.name,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          case "workspace_agents_list": {
            const agents = await this.dependencies.workspaceRuntime.listAgents();
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      agents,
                      total: agents.length,
                      workspace: this.dependencies.workspaceConfig.workspace.name,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          case "workspace_agents_describe": {
            const { agentId } = args as { agentId: string };
            const agent = await this.dependencies.workspaceRuntime.describeAgent(agentId);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(agent, null, 2),
                },
              ],
            };
          }

          default: {
            // Check if it's a discoverable job
            const discoverableJobs = this.getDiscoverableJobs();
            if (discoverableJobs.includes(name)) {
              const { payload } = args as { payload?: any };
              const result = await this.dependencies.workspaceRuntime.triggerJob(name, payload);
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        success: true,
                        sessionId: result.sessionId,
                        job: name,
                        payload,
                        message: `Job '${name}' triggered successfully`,
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }

            throw new Error(`Unknown tool: ${name}`);
          }
        }
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
   * Get available tools
   */
  getAvailableTools(): string[] {
    const baseCaps = [
      "workspace_jobs_list",
      "workspace_jobs_trigger",
      "workspace_jobs_describe",
      "workspace_sessions_list",
      "workspace_sessions_describe",
      "workspace_sessions_cancel",
      "workspace_signals_list",
      "workspace_agents_list",
      "workspace_agents_describe",
    ];

    const discoverableJobs = this.getDiscoverableJobs();

    return [...baseCaps, ...discoverableJobs];
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
