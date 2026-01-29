/**
 * Atlas Agents MCP Server
 *
 * Exposes all Atlas agents as MCP tools through single unified server.
 * Handles agent loading, MCP tool access, environment validation, and session state.
 */

import type {
  AgentExecutionResult,
  AgentMetadata,
  AgentRegistry,
  AgentServerAdapter,
  AtlasAgent,
} from "@atlas/agent-sdk";
import { type AgentSessionData, AgentSessionDataSchema } from "@atlas/agent-sdk";
import type { GlobalMCPServerPool } from "@atlas/core";
import type { Logger } from "@atlas/logger";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { createAgentContextBuilder } from "../agent-context/index.ts";
import { CancellationNotificationSchema } from "../streaming/stream-emitters.ts";
import { AgentExecutionManager } from "./agent-execution-manager.ts";
import { type AgentServerDependencies, AgentToolParamsSchema } from "./types.ts";

export class AtlasAgentsMCPServer implements AgentServerAdapter {
  #logger: Logger;
  private server: McpServer;
  private agentRegistry: AgentRegistry;
  private loadedAgents = new Map<string, AtlasAgent>();
  private executionManager: AgentExecutionManager;
  private buildAgentContext: ReturnType<typeof createAgentContextBuilder>;
  private isRunning = false;
  private sessionId: string;
  private hasActiveSSEFn?: (sessionId?: string) => boolean;

  /**
   * Format error/cancellation response for both MCP and direct contexts
   */
  private formatErrorResponse(error: unknown, agentId: string, asMcpResponse = false) {
    const isCancellation =
      error instanceof Error &&
      (error.message.includes("cancelled") || error.message.includes("aborted"));

    const payload = isCancellation
      ? ({ type: "cancelled", result: "Agent execution was cancelled" } as const)
      : ({
          type: "error",
          error: error instanceof Error ? error.message : String(error),
          agentId,
        } as const);

    if (isCancellation) {
      this.#logger.info("Agent execution cancelled", { agentId });
    } else {
      this.#logger.error("Agent execution failed", { agentId, error });
    }

    // Wrap for MCP if needed
    if (asMcpResponse) {
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    }

    return payload;
  }

  constructor(deps: AgentServerDependencies & { disableTimeouts?: boolean; sessionId: string }) {
    this.agentRegistry = deps.agentRegistry;
    this.#logger = deps.logger.child({
      component: "AtlasAgentsMCPServer",
      sessionId: deps.sessionId,
    });
    this.hasActiveSSEFn = deps.hasActiveSSE;
    this.sessionId = deps.sessionId;

    // MCP server configured for Atlas agent orchestration with SSE notification support
    this.server = new McpServer(
      { name: "atlas-agents", version: "1.0.0" },
      {
        capabilities: {
          // Advertise that we support notifications (required for SSE)
          notifications: {},
          // We also support tools and resources
          tools: {},
          resources: {},
        },
      },
    );

    this.#logger.debug("Created MCP server", {
      serverName: "atlas-agents",
      serverVersion: "1.0.0",
      hasNotificationSupport: typeof this.server.server?.notification === "function",
    });

    this.buildAgentContext = createAgentContextBuilder({
      mcpServerPool: deps.mcpServerPool,
      logger: deps.logger,
      server: this.server.server,
      // Pass through SSE check with session context
      hasActiveSSE: (sessionId?: string) => this.hasActiveSSE(sessionId),
    });

    // Initialize execution manager with enhanced features
    this.executionManager = new AgentExecutionManager(
      (agentId) => this.loadAgent(agentId),
      this.buildAgentContext,
      deps.logger.child({ component: "agent-execution-manager" }),
    );

    this.#logger.info("Agent execution manager initialized");

    // Register cancellation notification handler

    this.server.server.setNotificationHandler(CancellationNotificationSchema, (notification) => {
      const { requestId, reason } = notification.params;
      this.#logger.info("Received cancellation notification", { requestId, reason });
      this.executionManager.cancelExecution(requestId, reason);
    });
    this.#logger.info("Registered cancellation notification handler");

    this.registerAgentTools().catch((error) => {
      this.#logger.error("Failed to register agent tools", { error });
    });
  }

  /** Register a single agent as MCP tool */
  private registerSingleAgentTool(agent: AgentMetadata): void {
    const toolName = agent.id;

    // Build input schema - use agent's schema if available, fallback to string prompt
    const inputSchema = agent.inputSchema
      ? z.object({
          input: agent.inputSchema, // Structured typed input
          _sessionContext: AgentSessionDataSchema,
        })
      : AgentToolParamsSchema; // Fallback: { prompt: string, ... }

    this.server.registerTool(
      toolName,
      { title: agent.displayName, description: agent.description, inputSchema: inputSchema.shape },
      // @ts-expect-error the JSON Schema output by the MCP SDK tool definition doesn't align with the AI SDK.
      async (args, request) => {
        try {
          const agentId = agent.id;

          /**
           * MCP request _meta is untyped, but we want to ensure that requestId is either
           * a string or undefined before it's passed into the execution machine.
           */
          const requestId = z
            .string()
            .optional()
            .catch(() => undefined)
            .parse(request._meta?.requestId);

          this.#logger.debug("MCP tool handler called for agent", {
            args: JSON.stringify(args),
            agentId,
            displayName: agent.displayName,
            requestId,
          });

          // Session still comes from _sessionContext parameter - no changes!
          const session = args._sessionContext;

          this.#logger.info("Session context", {
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

          // Extract input - use structured input if schema exists, otherwise use prompt string
          const input = agent.inputSchema ? args.input : args.prompt;

          // Pass requestId directly to executeAgent - no instance variable
          const result = await this.executeAgent(agentId, input, session, requestId);

          this.#logger.debug("Agent execution result", {
            agentId,
            result: JSON.stringify(result),
            resultType: typeof result,
          });

          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          // Use helper to format error response
          return this.formatErrorResponse(error, agent.id, true);
        }
      },
    );

    this.#logger.info("Registered agent as MCP tool", {
      toolName,
      agentId: agent.id,
      displayName: agent.displayName,
      domains: agent.expertise.domains,
      capabilities: agent.expertise,
      hasStructuredInput: !!agent.inputSchema,
    });
  }

  /**
   * Register all agents from the registry as MCP tools.
   * Each agent becomes a callable MCP tool with lazy loading support.
   * Tools are registered with Zod schema validation for type safety.
   */
  private async registerAgentTools(): Promise<void> {
    const agents = await this.agentRegistry.listAgents();
    for (const agent of agents) {
      this.registerSingleAgentTool(agent);
    }
  }

  /**
   * Load agent from registry with caching and dynamic import fallback.
   * First attempts to load from the agent registry, then falls back to
   * dynamic imports for agents not in the registry. Implements lazy loading
   * to improve startup performance.
   */
  private async loadAgent(agentId: string): Promise<AtlasAgent> {
    if (!this.loadedAgents.has(agentId)) {
      this.#logger.info("Lazy loading agent", { agentId });
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
              this.#logger.info("Dynamically loaded agent", {
                agentId,
                loadTimeMs: Date.now() - startTime,
              });
              return dynamicAgent;
            }
          } catch (importErr) {
            this.#logger.error("Failed to dynamically load agent", { agentId, error: importErr });
            throw new Error(`Agent not found: ${agentId}`);
          }
        } else {
          this.loadedAgents.set(agentId, agent);
        }
        this.#logger.info("Loaded agent from registry", {
          agentId,
          loadTimeMs: Date.now() - startTime,
        });
      } catch (error) {
        this.#logger.error("Failed to load agent", { agentId, error });
        throw error;
      }
    }

    const agent = this.loadedAgents.get(agentId);
    if (!agent) {
      throw new Error("Failed to load agent after lazy loading.");
    }
    return agent;
  }

  /**
   * Register new agent dynamically at runtime.
   * Adds agent to registry, updates MCP tools, and creates expertise resources.
   * Enables hot-loading of new agents without server restart.
   */
  async registerAgent(agent: AtlasAgent): Promise<void> {
    await this.agentRegistry.registerAgent(agent);
    this.registerSingleAgentTool(agent.metadata);
  }

  /** List all registered agent metadata */
  async listAgents(): Promise<AgentMetadata[]> {
    return await this.agentRegistry.listAgents();
  }

  /** Get agent instance by ID from registry */
  async getAgent(agentId: string): Promise<AtlasAgent | undefined> {
    return await this.agentRegistry.getAgent(agentId);
  }

  /** Get agent expertise by ID from registry */
  async getAgentExpertise(agentId: string): Promise<AgentMetadata["expertise"] | undefined> {
    const agent = await this.agentRegistry.getAgent(agentId);
    return agent?.metadata.expertise;
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
    requestId?: string,
  ): Promise<AgentExecutionResult> {
    this.#logger.debug("executeAgent called", {
      agentId,
      sessionId: sessionData.sessionId,
      streamId: sessionData.streamId,
      workspaceId: sessionData.workspaceId,
      prompt: prompt,
      requestId,
    });

    // Use execution manager with session data and requestId
    const result = await this.executionManager.executeAgent(
      agentId,
      prompt,
      sessionData,
      requestId,
    );

    // Wrap successful results in structured response
    return { type: "completed", result };
  }

  /**
   * Start the MCP server.
   * Unlike traditional servers, this doesn't bind to ports as the daemon
   * handles transport layer communication via stdio/SSE.
   */
  start(): Promise<void> {
    if (this.isRunning) {
      throw new Error("Server is already running");
    }

    this.isRunning = true;
    this.#logger.info("Atlas Agents MCP server started (transport handled by daemon)");
    return Promise.resolve();
  }

  /**
   * Stop MCP server and cleanup all resources.
   * Shuts down execution manager and marks server as stopped to prevent new executions.
   */
  stop(): Promise<void> {
    if (!this.isRunning) {
      return Promise.resolve();
    }

    // Shutdown execution manager and terminate all active agent executions
    this.executionManager.shutdown();

    this.isRunning = false;
    this.#logger.info("Atlas Agents MCP server stopped");
    return Promise.resolve();
  }

  /** Get underlying MCP server instance for transport layer */
  getServer(): McpServer {
    return this.server;
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

  /**
   * Check if there's an active Server-Sent Events connection.
   * Used to determine if real-time notifications can be sent to clients.
   * Falls back to daemon's SSE tracking for session-specific connections.
   */
  private hasActiveSSE(sessionId?: string): boolean {
    // Use daemon's SSE tracking for this session
    const sid = sessionId || this.sessionId;
    if (this.hasActiveSSEFn && sid) {
      const hasSSE = this.hasActiveSSEFn(sid);
      this.#logger.info("SSE check", { sessionId: sid, hasSSE, source: "daemon" });
      return hasSSE;
    }
    return false;
  }
}
