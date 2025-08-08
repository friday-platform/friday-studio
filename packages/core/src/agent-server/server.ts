/**
 * Atlas Agents MCP Server
 *
 * Exposes all Atlas agents as MCP tools through single unified server.
 * Handles agent loading, MCP tool access, environment validation, and session state.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  AgentExecutionResult,
  AgentExpertise,
  AgentMetadata,
  AgentRegistry,
  AgentServerAdapter,
  AtlasAgent,
} from "@atlas/agent-sdk";
import { type AgentSessionData, AwaitingSupervisorDecision } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { ApprovalQueueManager } from "./approval-queue-manager.ts";
import { type AgentServerDependencies, AgentToolParamsSchema } from "./types.ts";
import { AgentExecutionManager } from "./agent-execution-manager.ts";
import { createAgentContextBuilder } from "../agent-context/index.ts";
import { GlobalMCPServerPool } from "@atlas/core";

export class AtlasAgentsMCPServer implements AgentServerAdapter {
  private server: McpServer;
  private agentRegistry: AgentRegistry;
  private loadedAgents = new Map<string, AtlasAgent>();
  private approvalQueue: ApprovalQueueManager;
  private executionManager: AgentExecutionManager;
  private buildAgentContext: ReturnType<typeof createAgentContextBuilder>;
  private logger: Logger;
  private isRunning = false;
  private sessionId: string;
  private hasActiveSSEFn?: (sessionId?: string) => boolean;

  constructor(deps: AgentServerDependencies & { disableTimeouts?: boolean; sessionId: string }) {
    this.agentRegistry = deps.agentRegistry;
    this.logger = deps.logger;
    this.hasActiveSSEFn = deps.hasActiveSSE;
    this.sessionId = deps.sessionId;

    // Standard MCP server with notification capabilities
    this.server = new McpServer({
      name: "atlas-agents",
      version: "1.0.0",
    }, {
      capabilities: {
        // Advertise that we support notifications (required for SSE)
        notifications: {},
        // We also support tools and resources
        tools: {},
        resources: {},
      },
    });

    this.logger.debug("[AtlasAgentsMCPServer] Created MCP server", {
      serverName: "atlas-agents",
      serverVersion: "1.0.0",
      hasNotificationSupport: typeof this.server.server?.notification === "function",
    });

    // Initialize approval queue for suspended executions
    this.approvalQueue = new ApprovalQueueManager(
      deps.logger.child({ component: "approval-queue-manager" }),
    );

    // Initialize context builder factory
    this.logger.info("[AtlasAgentsMCPServer] Checking server.server in constructor", {
      hasServerServer: !!this.server.server,
      serverServerType: this.server.server?.constructor?.name,
      serverServerKeys: this.server.server ? Object.keys(this.server.server) : [],
      hasNotificationOnServerServer: typeof this.server.server?.notification === "function",
    });

    this.buildAgentContext = createAgentContextBuilder({
      daemonUrl: deps.daemonUrl,
      mcpServerPool: deps.mcpServerPool,
      logger: deps.logger,
      server: this.server.server,
      // Pass through SSE check with session context
      hasActiveSSE: (sessionId?: string) => this.hasActiveSSE(sessionId),
    });

    // TODO: Initialize with actual CoALA memory when available
    const sessionMemory = null; // Stub for CoALA integration

    // Initialize execution manager with enhanced features
    this.executionManager = new AgentExecutionManager(
      (agentId) => this.loadAgent(agentId),
      this.buildAgentContext,
      sessionMemory,
      this.approvalQueue,
      deps.logger.child({ component: "agent-execution-manager" }),
    );

    this.logger.info("Agent execution manager initialized with memory integration support");

    this.registerAgentTools().catch((error) => {
      this.logger.error("Failed to register agent tools", { error });
    });
    this.registerAgentResources();
  }

  /** Register all agents as MCP tools with lazy loading */
  private async registerAgentTools(): Promise<void> {
    const agents = await this.agentRegistry.listAgents();

    for (const agent of agents) {
      // Key change: registerTool instead of addTool
      const toolName = agent.id;
      this.server.registerTool(
        toolName,
        {
          title: agent.displayName,
          description: this.formatAgentDescription(agent),
          inputSchema: AgentToolParamsSchema.shape, // 'inputSchema' expects ZodRawShape
        },
        // Handler receives args directly, no toolContext
        async (args) => {
          const agentId = agent.id;

          this.logger.debug(`MCP tool handler called for agent: ${agentId}`, {
            args: JSON.stringify(args),
            agentId,
            displayName: agent.displayName,
          });

          // Approval flow remains the same
          if (args._approvalId && args._approvalDecision) {
            const result = await this.resumeWithApproval(
              args._approvalId,
              args._approvalDecision,
            );
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
          }

          // Session still comes from _sessionContext parameter - no changes!
          const session = args._sessionContext;

          this.logger.info(`[AtlasAgentsMCPServer] Session context:`, {
            hasSession: !!session,
            orchestratorSessionId: session?.sessionId,
            serverSessionId: this.sessionId,
            streamId: session?.streamId,
            workspaceId: session?.workspaceId,
            agentId,
          });

          if (!session) {
            throw new Error("No session data available - authentication required");
          }

          // Keep the original orchestrator session ID for notifications
          const sessionWithStream = {
            ...session,
            sessionId: session.sessionId, // Keep original for notification routing
            streamId: session.streamId,
          };

          const result = await this.executeAgent(
            agentId,
            args.prompt,
            sessionWithStream,
          );

          this.logger.debug(`Agent execution result for ${agentId}:`, {
            result: JSON.stringify(result),
            resultType: typeof result,
          });

          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
      );

      this.logger.info(`Registered agent as MCP tool: ${toolName} (${agent.displayName})`, {
        toolName,
        agentId: agent.id,
        displayName: agent.displayName,
        domains: agent.expertise.domains,
        capabilities: agent.expertise.capabilities.length,
      });
    }
  }

  /** Format agent metadata as JSON for MCP tool descriptions */
  private formatAgentDescription(meta: AgentMetadata): string {
    return JSON.stringify({
      text: meta.description,
      expertise: meta.expertise,
      examples: meta.expertise.examples,
    });
  }

  /** Load and cache agent from registry - now supports dynamic imports */
  private async loadAgent(agentId: string): Promise<AtlasAgent> {
    if (!this.loadedAgents.has(agentId)) {
      this.logger.info(`Lazy loading agent: ${agentId}`);
      const startTime = Date.now();

      try {
        // First check if it's in the registry
        const agent = await this.agentRegistry.getAgent(agentId);
        if (!agent) {
          // Try dynamic import for agents not in registry
          // This enables true lazy loading of agent code
          try {
            const agentModule = await import(`./agents/${agentId}/index.js`);
            const dynamicAgent = agentModule.default || agentModule.agent;
            if (dynamicAgent) {
              this.loadedAgents.set(agentId, dynamicAgent);
              this.logger.info(
                `Dynamically loaded agent ${agentId} in ${Date.now() - startTime}ms`,
              );
              return dynamicAgent;
            }
          } catch (importErr) {
            this.logger.error(`Failed to dynamically load agent ${agentId}:`, { error: importErr });
            throw new Error(`Agent not found: ${agentId}`);
          }
        } else {
          this.loadedAgents.set(agentId, agent);
        }
        this.logger.info(`Loaded agent ${agentId} from registry in ${Date.now() - startTime}ms`);
      } catch (error) {
        this.logger.error(`Failed to load agent ${agentId}:`, { error });
        throw error;
      }
    }
    return this.loadedAgents.get(agentId)!;
  }

  /** Register MCP resources for agent discovery */
  private registerAgentResources(): void {
    this.server.registerResource(
      "agents/list",
      "agent://atlas/agents/list",
      {
        title: "Agent List",
        description: "List of all agents",
        mimeType: "application/json",
      },
      async (uri) => ({
        contents: [{
          uri: uri.href,
          text: JSON.stringify(
            await this.agentRegistry.listAgents().then((agents) =>
              agents.map((agent) => ({
                id: agent.id,
                displayName: agent.displayName,
                description: agent.description,
                expertise: agent.expertise,
                metadata: agent.metadata,
              }))
            ),
            null,
            2,
          ),
        }],
      }),
    );

    this.registerAgentExpertiseResources().catch((error) => {
      this.logger.error("Failed to register expertise resources", { error });
    });
  }

  /** Create expertise resource for each agent */
  private async registerAgentExpertiseResources(): Promise<void> {
    const agents = await this.agentRegistry.listAgents();
    for (const agent of agents) {
      const agentId = agent.id;
      this.server.registerResource(
        `agents/${agentId}/expertise`,
        `agent://${agentId}/expertise`,
        {
          title: `${agent.displayName} Expertise`,
          description: `Expertise information for ${agent.displayName}`,
          mimeType: "application/json",
        },
        (uri) => ({
          contents: [{
            uri: uri.href,
            text: JSON.stringify(
              {
                domains: agent.expertise.domains,
                capabilities: agent.expertise.capabilities,
                examples: agent.expertise.examples,
              },
              null,
              2,
            ),
          }],
        }),
      );
    }
  }

  /** Register new agent dynamically */
  async registerAgent(agent: AtlasAgent): Promise<void> {
    await this.agentRegistry.registerAgent(agent);
    await this.registerAgentTools();
    const agentId = agent.metadata.id;
    this.server.registerResource(
      `agents/${agentId}/expertise`,
      `agent://${agentId}/expertise`,
      {
        title: `${agent.metadata.displayName} Expertise`,
        description: `Expertise information for ${agent.metadata.displayName}`,
        mimeType: "application/json",
      },
      (uri) => ({
        contents: [{
          uri: uri.href,
          text: JSON.stringify(
            {
              domains: agent.metadata.expertise.domains,
              capabilities: agent.metadata.expertise.capabilities,
              examples: agent.metadata.expertise.examples,
            },
            null,
            2,
          ),
        }],
      }),
    );
  }

  /**
   * Remove agent from cache.
   * @FIXME: once FastMCP supports dynamic tool removal, we should unload it here.
   */
  unregisterAgent(agentId: string): void {
    this.loadedAgents.delete(agentId);
    this.executionManager.unloadAgent(agentId);
  }

  /** List all agent metadata */
  async listAgents(): Promise<AgentMetadata[]> {
    return await this.agentRegistry.listAgents();
  }

  /** Get agent by ID */
  async getAgent(agentId: string): Promise<AtlasAgent | undefined> {
    return await this.agentRegistry.getAgent(agentId);
  }

  /**
   * Execute agent with natural language prompt
   *
   * Core execution flow:
   * 1. Load agent from registry (cached)
   * 2. Build MCP context (workspace + agent servers)
   * 3. Validate environment variables
   * 4. Execute agent with full context
   * 5. Handle supervisor approval if needed
   * 6. Cleanup MCP connections
   *
   * @param agentId Agent to execute
   * @param prompt Natural language request
   * @param sessionData Atlas session info from headers
   * @returns Agent's response
   */
  async executeAgent(
    agentId: string,
    prompt: string,
    sessionData: AgentSessionData,
  ): Promise<AgentExecutionResult> {
    this.logger.debug(`[AtlasAgentsMCPServer] executeAgent called`, {
      agentId,
      sessionId: sessionData.sessionId,
      streamId: (sessionData as AgentSessionData & { streamId?: string }).streamId,
      workspaceId: sessionData.workspaceId,
      prompt: prompt.substring(0, 50) + "...",
    });

    try {
      // Use execution manager with session data
      const result = await this.executionManager.executeAgent(
        agentId,
        prompt,
        sessionData,
      );

      // Wrap successful results in structured response
      return {
        type: "completed",
        result,
      };
    } catch (error) {
      if (error instanceof AwaitingSupervisorDecision) {
        // Convert exception to structured response for MCP transport
        // The execution manager already handles suspension
        return {
          type: "awaiting_approval",
          approvalId: error.approvalId,
          agentId: error.agentId,
          sessionId: error.sessionId,
          request: error.request,
        };
      }

      this.logger.error(`Agent execution failed: ${agentId}`, { error });
      throw error;
    }
  }

  /** Get agent expertise by ID */
  async getAgentExpertise(agentId: string): Promise<AgentExpertise | undefined> {
    const agent = await this.agentRegistry.getAgent(agentId);
    return agent?.metadata.expertise;
  }

  /** Handle approval responses */
  private async resumeWithApproval(
    approvalId: string,
    decision: unknown,
  ): Promise<AgentExecutionResult> {
    // Validate decision format
    const decisionObj = decision as {
      approved?: boolean;
      reason?: string;
      modifiedAction?: unknown;
      conditions?: unknown;
    };
    const approvalDecision = {
      approved: Boolean(decisionObj?.approved),
      reason: decisionObj?.reason,
      modifiedAction: decisionObj?.modifiedAction,
      conditions: decisionObj?.conditions,
    };

    try {
      const result = await this.executionManager.resumeAgentWithApproval(
        approvalId,
        approvalDecision,
      );

      if (!result) {
        throw new Error(`No suspended agent found for approval ID: ${approvalId}`);
      }

      // Wrap successful results in structured response
      return {
        type: "completed",
        result,
      };
    } catch (error) {
      if (error instanceof AwaitingSupervisorDecision) {
        // Another approval needed - return structured response
        return {
          type: "awaiting_approval",
          approvalId: error.approvalId,
          agentId: error.agentId,
          sessionId: error.sessionId,
          request: error.request,
        };
      }
      this.logger.error(`Failed to resume agent with approval:`, { approvalId, error });
      throw error;
    }
  }

  /** Start MCP server (no HTTP server needed - handled by daemon) */
  start(): Promise<void> {
    if (this.isRunning) {
      throw new Error("Server is already running");
    }

    this.isRunning = true;
    this.logger.info("Atlas Agents MCP server started (transport handled by daemon)");
    return Promise.resolve();
  }

  /** Stop MCP server and cleanup */
  stop(): Promise<void> {
    if (!this.isRunning) {
      return Promise.resolve();
    }

    // Cleanup execution manager and all active agent executions
    this.executionManager.shutdown();

    // Cleanup approval queue
    this.approvalQueue.clearAll();

    this.isRunning = false;
    this.logger.info("Atlas Agents MCP server stopped");
    return Promise.resolve();
  }

  /** Get MCP server instance */
  getServer(): McpServer {
    return this.server;
  }

  /** Get approval queue instance */
  getApprovalQueue(): ApprovalQueueManager {
    return this.approvalQueue;
  }

  /**
   * Create a new instance of AtlasAgentsMCPServer for a specific session
   * @param config Configuration for the server instance
   * @returns New AtlasAgentsMCPServer instance
   */
  static create(config: {
    daemonUrl: string;
    logger: Logger;
    agentRegistry: AgentRegistry;
    mcpServerPool: GlobalMCPServerPool;
    sessionId: string;
    hasActiveSSE?: (sessionId?: string) => boolean;
  }): AtlasAgentsMCPServer {
    return new AtlasAgentsMCPServer({
      ...config,
      logger: config.logger.child({ sessionId: config.sessionId }),
    });
  }

  /** Check if we have an active SSE connection */
  private hasActiveSSE(sessionId?: string): boolean {
    // Use daemon's SSE tracking for this session
    const sid = sessionId || this.sessionId;
    if (this.hasActiveSSEFn && sid) {
      const hasSSE = this.hasActiveSSEFn(sid);
      this.logger.info("[AtlasAgentsMCPServer] SSE check", {
        sessionId: sid,
        hasSSE,
        source: "daemon",
      });
      return hasSSE;
    }
    return false;
  }
}
