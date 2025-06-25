/**
 * Workspace MCP Server for Atlas
 * Exposes workspace-specific capabilities like jobs, sessions, agents
 */

import { McpServer } from "@modelcontextprotocol/server-stdio";
import { z } from "zod/v4";
import type { NewWorkspaceConfig } from "../config-loader.ts";

// Workspace capability schemas
const JobTriggerSchema = z.object({
  jobName: z.string(),
  payload: z.record(z.string(), z.any()).optional(),
});

const JobDescribeSchema = z.object({
  jobName: z.string(),
});

const SessionDescribeSchema = z.object({
  sessionId: z.string(),
});

const SessionCancelSchema = z.object({
  sessionId: z.string(),
});

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
  private server: McpServer;
  private dependencies: WorkspaceMCPServerDependencies;

  constructor(dependencies: WorkspaceMCPServerDependencies) {
    this.dependencies = dependencies;
    this.server = new McpServer(
      `atlas-workspace-${dependencies.workspaceConfig.workspace.id}`,
      "1.0.0",
    );
    this.setupTools();
  }

  private setupTools(): void {
    // Jobs capabilities
    this.server.registerTool(
      "workspace.jobs.list",
      {
        description: "List all jobs in this workspace",
        inputSchema: z.object({}),
      },
      async () => {
        const jobs = await this.dependencies.workspaceRuntime.listJobs();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                jobs,
                total: jobs.length,
                workspace: this.dependencies.workspaceConfig.workspace.name,
              }, null, 2),
            },
          ],
        };
      },
    );

    this.server.registerTool(
      "workspace.jobs.trigger",
      {
        description: "Trigger a job in this workspace",
        inputSchema: JobTriggerSchema,
      },
      async ({ jobName, payload }) => {
        const result = await this.dependencies.workspaceRuntime.triggerJob(jobName, payload);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                sessionId: result.sessionId,
                job: jobName,
                payload,
                message: `Job '${jobName}' triggered successfully`,
              }, null, 2),
            },
          ],
        };
      },
    );

    this.server.registerTool(
      "workspace.jobs.describe",
      {
        description: "Get detailed information about a job",
        inputSchema: JobDescribeSchema,
      },
      async ({ jobName }) => {
        const job = await this.dependencies.workspaceRuntime.describeJob(jobName);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(job, null, 2),
            },
          ],
        };
      },
    );

    // Sessions capabilities
    this.server.registerTool(
      "workspace.sessions.list",
      {
        description: "List all sessions in this workspace",
        inputSchema: z.object({}),
      },
      async () => {
        const sessions = await this.dependencies.workspaceRuntime.listSessions();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                sessions,
                total: sessions.length,
                workspace: this.dependencies.workspaceConfig.workspace.name,
              }, null, 2),
            },
          ],
        };
      },
    );

    this.server.registerTool(
      "workspace.sessions.describe",
      {
        description: "Get detailed information about a session",
        inputSchema: SessionDescribeSchema,
      },
      async ({ sessionId }) => {
        const session = await this.dependencies.workspaceRuntime.describeSession(sessionId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(session, null, 2),
            },
          ],
        };
      },
    );

    this.server.registerTool(
      "workspace.sessions.cancel",
      {
        description: "Cancel a running session",
        inputSchema: SessionCancelSchema,
      },
      async ({ sessionId }) => {
        await this.dependencies.workspaceRuntime.cancelSession(sessionId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                sessionId,
                message: `Session '${sessionId}' cancelled successfully`,
              }, null, 2),
            },
          ],
        };
      },
    );

    // Signals capabilities
    this.server.registerTool(
      "workspace.signals.list",
      {
        description: "List all signals in this workspace",
        inputSchema: z.object({}),
      },
      async () => {
        const signals = await this.dependencies.workspaceRuntime.listSignals();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                signals,
                total: signals.length,
                workspace: this.dependencies.workspaceConfig.workspace.name,
              }, null, 2),
            },
          ],
        };
      },
    );

    // Agents capabilities
    this.server.registerTool(
      "workspace.agents.list",
      {
        description: "List all agents in this workspace",
        inputSchema: z.object({}),
      },
      async () => {
        const agents = await this.dependencies.workspaceRuntime.listAgents();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                agents,
                total: agents.length,
                workspace: this.dependencies.workspaceConfig.workspace.name,
              }, null, 2),
            },
          ],
        };
      },
    );

    this.server.registerTool(
      "workspace.agents.describe",
      {
        description: "Get detailed information about an agent",
        inputSchema: z.object({
          agentId: z.string(),
        }),
      },
      async ({ agentId }) => {
        const agent = await this.dependencies.workspaceRuntime.describeAgent(agentId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(agent, null, 2),
            },
          ],
        };
      },
    );

    // Discoverable workspace jobs (based on server config)
    const discoverableJobs = this.getDiscoverableJobs();
    for (const jobName of discoverableJobs) {
      const jobSpec = this.dependencies.workspaceConfig.jobs?.[jobName];
      if (jobSpec) {
        this.server.registerTool(
          `${jobName}`,
          {
            description: jobSpec.description || `Execute workspace job: ${jobName}`,
            inputSchema: z.object({
              payload: z.record(z.string(), z.any()).optional(),
            }),
          },
          async ({ payload }) => {
            const result = await this.dependencies.workspaceRuntime.triggerJob(jobName, payload);
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: true,
                    sessionId: result.sessionId,
                    job: jobName,
                    payload,
                    message: `Job '${jobName}' triggered successfully`,
                  }, null, 2),
                },
              ],
            };
          },
        );
      }
    }
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
    const baseCaps = [
      "workspace.jobs.list",
      "workspace.jobs.trigger",
      "workspace.jobs.describe",
      "workspace.sessions.list",
      "workspace.sessions.describe",
      "workspace.sessions.cancel",
      "workspace.signals.list",
      "workspace.agents.list",
      "workspace.agents.describe",
    ];

    const discoverableJobs = this.getDiscoverableJobs();
    
    return [...baseCaps, ...discoverableJobs];
  }

  /**
   * Create workspace MCP server configuration for clients
   */
  static createClientConfig(
    atlasUrl: string = "http://localhost:8080",
    workspaceId: string,
  ): any {
    return {
      [`atlas-workspace-${workspaceId}`]: {
        command: "atlas-mcp-client",
        args: ["--target", `${atlasUrl}/workspace/${workspaceId}`],
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