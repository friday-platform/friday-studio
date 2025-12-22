/**
 * Agent Orchestrator coordinates agent execution in the Atlas system.
 *
 * In Atlas architecture:
 * - Agents are distributed services that perform specific tasks
 * - This orchestrator connects to them via MCP (Model Context Protocol)
 * - Supports both MCP-based agents and wrapped LLM agents
 */

import type {
  AgentContext,
  AgentMetadata,
  AgentResult,
  AtlasAgent,
  AtlasUIMessageChunk,
  StreamEmitter,
  ToolCall,
  ToolResult,
} from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { CoALAMemoryManager, type IMemoryScope } from "@atlas/memory";
import { stringifyError } from "@atlas/utils";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { retry } from "@std/async";
import { z } from "zod";
import { createAgentContextBuilder } from "../agent-context/index.ts";
import type { WrappedAgentResult } from "../agent-conversion/from-llm.ts";
import type { AgentToolParams } from "../agent-server/types.ts";
import { createErrorCause, getErrorDisplayMessage } from "../errors.ts";
import type { GlobalMCPServerPool } from "../mcp-server-pool.ts";
import {
  CallbackStreamEmitter,
  type CancellationNotification,
  StreamContentNotificationSchema,
} from "../streaming/stream-emitters.ts";

// FIXME: this is wrong.
const MCPToolResultSchema = z.object({
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
    ]),
  ),
});

export interface AgentExecutionContext {
  sessionId: string;
  workspaceId: string;
  userId?: string;
  streamId?: string; // For HTTP streaming
  previousResults?: AgentResult[];
  additionalContext?: unknown;
  reasoning?: string;
  agentTools?: string[]; // Agent-specific tools to filter from workspace tools
  onStreamEvent?: (event: AtlasUIMessageChunk) => void; // NEW: Callback for stream events
  /** Optional pre-provisioned session memory. If not provided, orchestrator creates one. */
  memoryManager?: CoALAMemoryManager;
  /** Optional abort signal for cancelling the execution */
  abortSignal?: AbortSignal;
}

export interface AgentOrchestratorConfig {
  /** URL of the atlas-agents MCP server */
  agentsServerUrl: string;
  /** Headers to include in MCP requests */
  headers?: Record<string, string>;
  /** Timeout for MCP requests in milliseconds */
  requestTimeoutMs?: number;
  /** Optional pre-provisioned MCP client pool */
  mcpServerPool?: GlobalMCPServerPool;
  /** Optional daemon URL for MCP agents */
  daemonUrl?: string;
}

const AgentExecutionResultSchema = z.object({
  type: z.literal("completed"),
  result: z.unknown(), // Agent-specific result
});

type AgentExecutionResult = z.infer<typeof AgentExecutionResultSchema>;

/**
 * Orchestrator interface for executing Atlas agents.
 * Handles both MCP-based distributed agents and in-process wrapped agents.
 */
export interface IAgentOrchestrator {
  /** Initialize the orchestrator */
  initialize(): void;

  /** Discover available agents via MCP */
  discoverAgents(): Promise<AgentMetadata[]>;

  /** Run an agent with a task */
  executeAgent(
    agentId: string,
    prompt: string,
    context: AgentExecutionContext,
  ): Promise<AgentResult>;

  /** Clean up connections */
  shutdown(): Promise<void>;
}

interface MCPSessionSetup {
  client: Client;
  transport: StreamableHTTPClientTransport;
  lastActivity: number;
  workspaceId?: string;
}

/**
 * Orchestrates agent execution across Atlas distributed system.
 *
 * Atlas Architecture:
 * - MCP agents: Run as separate services, communicate via Model Context Protocol
 * - Wrapped agents: Run in-process for lightweight tasks
 * - Session-based: Each user session gets isolated MCP connection
 */
export class AgentOrchestrator implements IAgentOrchestrator {
  private mcpSessions = new Map<string, MCPSessionSetup>(); // Per-session MCP clients
  private config: Required<Omit<AgentOrchestratorConfig, "mcpServerPool" | "daemonUrl">> &
    Pick<AgentOrchestratorConfig, "mcpServerPool" | "daemonUrl">;
  private logger: Logger;
  private sessionCleanupInterval?: number;
  private wrappedAgents = new Map<string, AtlasAgent<string, WrappedAgentResult>>(); // LLM agents that bypass MCP
  // Track active stream handlers by sessionId:agentId to handle multi-workspace scenarios
  private activeStreamHandlers = new Map<string, (event: AtlasUIMessageChunk) => void>();
  private buildAgentContext?: ReturnType<typeof createAgentContextBuilder>;
  // Cache CoALA session memories per workspaceId:sessionId
  private sessionMemories = new Map<string, CoALAMemoryManager>();
  // Track active MCP requests for cancellation
  private activeMCPRequests = new Map<string, { requestId: string; sessionId: string }>();
  // Track active agent executions to prevent premature workspace shutdown
  private activeAgentExecutions = new Map<
    string,
    { agentId: string; sessionId: string; startTime: number }
  >();

  // (No ad-hoc resource parsing; we read the typed agents list resource instead)

  /**
   * @param config Connection settings for atlas-agents MCP server
   * @param logger Logger instance for debugging and monitoring
   */
  constructor(config: AgentOrchestratorConfig, logger: Logger) {
    this.logger = logger;
    this.config = {
      agentsServerUrl: config.agentsServerUrl,
      headers: config.headers || {},
      requestTimeoutMs: config.requestTimeoutMs || 300000,
      // Store new config fields
      mcpServerPool: config.mcpServerPool,
      daemonUrl: config.daemonUrl,
    };

    // Initialize context builder if we have the required dependencies
    if (config.mcpServerPool && config.daemonUrl) {
      this.buildAgentContext = createAgentContextBuilder({
        mcpServerPool: config.mcpServerPool,
        logger: this.logger,
        // No server needed for wrapped agents (no MCP notification support)
        hasActiveSSE: () => false,
      });

      this.logger.info("Initialized agent context builder for wrapped agents", {
        component: "AgentOrchestrator",
        hasMcpServerPool: true,
        daemonUrl: config.daemonUrl,
      });
    } else {
      this.logger.warn(
        "No MCP server pool or daemon URL provided - wrapped agents will have no tool access",
        {
          component: "AgentOrchestrator",
          hasMcpServerPool: !!config.mcpServerPool,
          hasDaemonUrl: !!config.daemonUrl,
          mcpServerPoolType: config.mcpServerPool ? typeof config.mcpServerPool : "undefined",
          daemonUrlValue: config.daemonUrl || "undefined",
        },
      );
    }
  }

  /**
   * Discover available agents by querying the agent server via MCP.
   * Returns metadata about all registered agents.
   */
  async discoverAgents(): Promise<AgentMetadata[]> {
    const discoverySessionId = `discovery-${Date.now()}`;

    try {
      const mcpSetup = await this.getOrCreateSessionClient(discoverySessionId);

      // Query MCP server for available resources (agents register as resources)
      const resources = await mcpSetup.client.listResources();

      const agents: AgentMetadata[] = [];

      // Parse agent metadata from MCP resources (KISS)
      for (const resource of resources.resources) {
        if (!resource.uri.startsWith("agent://")) continue;
        try {
          const agentId = resource.uri.replace("agent://", "");
          const meta = resource.metadata as
            | { expertise?: { domains?: string[]; capabilities?: string[]; examples?: string[] } }
            | undefined;
          const expertise = meta?.expertise
            ? {
                domains: meta.expertise.domains ?? [],
                capabilities: meta.expertise.capabilities ?? [],
                examples: meta.expertise.examples ?? [],
              }
            : { domains: [], capabilities: [], examples: [] };
          const agentMetadata: AgentMetadata = {
            id: agentId,
            version: "0.0.0",
            description: resource.description || "",
            expertise,
            displayName: resource.name,
          };
          agents.push(agentMetadata);
        } catch (parseError) {
          this.logger.warn("Failed to parse agent metadata from resource", {
            resource,
            error: parseError,
          });
        }
      }

      this.logger.debug("Discovered agents via MCP", { agentCount: agents.length });
      return agents;
    } catch (error) {
      const errorCause = createErrorCause(error);
      this.logger.error("Failed to discover agents", { error: error, errorCause });

      // If MCP discovery fails, check for wrapped agents
      const wrappedAgents: AgentMetadata[] = [];
      for (const [agentId, agent] of this.wrappedAgents.entries()) {
        wrappedAgents.push({
          id: agentId,
          version: agent.metadata.version,
          description: agent.metadata.description,
          expertise: {
            domains: agent.metadata.expertise.domains,
            examples: agent.metadata.expertise.examples || [],
          },
          displayName: agent.metadata.displayName,
        });
      }

      if (wrappedAgents.length > 0) {
        this.logger.debug("Returning wrapped agents as fallback", {
          wrappedAgentCount: wrappedAgents.length,
        });
        return wrappedAgents;
      }

      // Return empty array if no agents can be discovered
      return [];
    } finally {
      // Clean up discovery session immediately after use
      const setup = this.mcpSessions.get(discoverySessionId);
      if (setup) {
        try {
          await setup.transport.close();
          this.mcpSessions.delete(discoverySessionId);
          this.logger.debug("Cleaned up discovery session", { discoverySessionId });
        } catch (closeError) {
          this.logger.warn("Failed to close discovery session transport", {
            discoverySessionId,
            error: closeError,
          });
        }
      }
    }
  }

  /**
   * Register an LLM agent that runs in-process instead of via MCP.
   * Used for lightweight agents that don't need service isolation.
   */
  registerWrappedAgent(agentId: string, agent: AtlasAgent<string, WrappedAgentResult>): void {
    this.wrappedAgents.set(agentId, agent);
    this.logger.debug("Registered wrapped agent for direct execution", {
      agentId,
      agentName: agent.metadata.displayName,
      expertise: agent.metadata.expertise.domains,
    });
  }

  /**
   * Check if there are any active agent executions.
   * Used by the daemon to prevent premature workspace shutdown.
   */
  hasActiveExecutions(): boolean {
    return this.activeAgentExecutions.size > 0;
  }

  /**
   * Get count and details of active agent executions.
   * Used for debugging and monitoring.
   */
  getActiveExecutions(): Array<{ agentId: string; sessionId: string; durationMs: number }> {
    const now = Date.now();
    return Array.from(this.activeAgentExecutions.values()).map((exec) => ({
      agentId: exec.agentId,
      sessionId: exec.sessionId,
      durationMs: now - exec.startTime,
    }));
  }

  /**
   * Extract tool metadata from agent output, removing it from the output object
   * to prevent double-counting in token calculations.
   */
  private extractToolMetadata(output: unknown): {
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
    outputWithoutTools: unknown;
  } {
    let outputWithoutTools = output;
    let toolCalls: ToolCall[] | undefined;
    let toolResults: ToolResult[] | undefined;

    if (
      typeof output === "object" &&
      output !== null &&
      "toolCalls" in output &&
      "toolResults" in output
    ) {
      const extracted = output as {
        toolCalls: ToolCall[];
        toolResults: ToolResult[];
        [key: string]: unknown;
      };
      ({ toolCalls, toolResults, ...outputWithoutTools } = extracted);
    }

    return { toolCalls, toolResults, outputWithoutTools };
  }

  /**
   * Truncate text to a maximum length with ellipsis
   */
  private truncateTask(text: string, maxLength = 100): string {
    return text.length > maxLength ? `${text.substring(0, maxLength - 3)}...` : text;
  }

  /**
   * Extract agent response from MCP format.
   * MCP wraps responses as: { content: [{ type: "text", text: JSON }] }
   */
  private parseAgentResponse(toolResult: unknown): AgentExecutionResult {
    const validatedResult = MCPToolResultSchema.parse(toolResult);

    if (!validatedResult.content?.[0] || validatedResult.content[0].type !== "text") {
      throw new Error("Invalid MCP response: expected text content");
    }

    const textContent = validatedResult.content[0].text;

    try {
      const parsed = JSON.parse(textContent);

      // Handle error/cancellation responses from agent server
      // @ts-expect-error `agents-should-produce-structured-output`
      if (parsed.type === "error") {
        // @ts-expect-error `agents-should-produce-structured-output`
        throw new Error(`Agent ${parsed.agentId || "unknown"} failed: ${parsed.error}`);
      }

      // @ts-expect-error `agents-should-produce-structured-output`
      if (parsed.type === "cancelled") {
        // @ts-expect-error `agents-should-produce-structured-output`
        return { type: "completed", result: parsed.result || "Cancelled by user" };
      }

      return AgentExecutionResultSchema.parse(parsed);
    } catch (error) {
      // Legacy cancellation message format
      if (textContent.includes("No output generated. Check the stream for errors.")) {
        return { type: "completed", result: "Canceled by user" };
      }

      // Log the full response text for debugging (truncated in error message)
      this.logger.error("Failed to parse MCP response as JSON", {
        component: "AgentOrchestrator",
        textContent: textContent.substring(0, 500), // Log first 500 chars
        textLength: textContent.length,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      // Re-throw agent errors and validation errors with context
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid agent execution result: ${error.message}`);
      }
      if (
        error instanceof Error &&
        error.message.includes("Agent") &&
        error.message.includes("failed:")
      ) {
        throw error; // Re-throw our formatted agent errors
      }
      throw new Error(
        `Invalid JSON in MCP response: ${error instanceof Error ? error.message : String(error)}. Response text: ${textContent.substring(0, 200)}`,
      );
    }
  }

  /**
   * Starts cleanup intervals for session management.
   * MCP connections are created per-session on demand.
   */
  initialize(): void {
    try {
      this.logger.info("Initializing agent orchestrator", {
        serverUrl: this.config.agentsServerUrl,
      });

      // Start session cleanup interval
      this.sessionCleanupInterval = setInterval(() => {
        this.cleanupInactiveSessions().catch((error) => {
          this.logger.error("Error during session cleanup", { error });
        });
      }, 300000); // Every 5 minutes
    } catch (error) {
      this.logger.error("Failed to initialize agent orchestrator", { error });
      throw error;
    }
  }

  /**
   * Creates unique key for stream handlers.
   * Handles multi-workspace scenarios where same agent runs in different sessions.
   */
  getStreamHandlerKey(sessionId: string, agentId: string): string {
    return `${sessionId}:${agentId}`;
  }

  /**
   * Get or create a CoALAMemoryManager for a given session within a workspace.
   */
  private getOrCreateSessionMemory(sessionId: string, workspaceId: string): CoALAMemoryManager {
    const key = `${workspaceId}:${sessionId}`;
    const existing = this.sessionMemories.get(key);
    if (existing) return existing;

    // Create a properly typed scope for CoALAMemoryManager
    const scope: IMemoryScope = { id: sessionId, workspaceId };
    const memory = new CoALAMemoryManager(scope);
    this.sessionMemories.set(key, memory);
    return memory;
  }

  /**
   * Execute an agent task. Routes to wrapped agents (in-process)
   * or MCP agents (separate services) based on registration.
   */
  async executeAgent(
    agentId: string,
    prompt: string,
    context: AgentExecutionContext,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const logger = this.logger.child({ agentId, sessionId: context.sessionId });

    // Track this execution to prevent premature workspace shutdown
    const executionKey = `${context.sessionId}:${agentId}`;
    this.activeAgentExecutions.set(executionKey, {
      agentId,
      sessionId: context.sessionId,
      startTime,
    });
    logger.debug("Started tracking agent execution", {
      executionKey,
      activeExecutionsCount: this.activeAgentExecutions.size,
    });

    // Set up real-time event streaming if requested
    // Only register handler if both callback and streamId are provided
    if (context.onStreamEvent && context.streamId) {
      const handlerKey = this.getStreamHandlerKey(context.sessionId, agentId);
      this.activeStreamHandlers.set(handlerKey, context.onStreamEvent);
      logger.debug("Registered handler for SSE stream", { handlerKey });
    } else {
      logger.debug("No stream callback provided or missing streamId");
    }

    try {
      const wrappedAgent = this.wrappedAgents.get(agentId);
      if (wrappedAgent) {
        return await this.executeWrappedAgent(
          wrappedAgent,
          agentId,
          prompt,
          context,
          startTime,
          logger,
        );
      }
      const mcpSetup = await this.getOrCreateSessionClient(context.sessionId, context.workspaceId);

      logger.debug("Executing agent via MCP", {
        agentId,
        sessionId: context.sessionId,
        prompt: prompt,
        hasStreamCallback: !!context.onStreamEvent,
      });

      // Generate request ID for tracking
      const requestId = crypto.randomUUID();

      // Store for cancellation
      this.activeMCPRequests.set(`${context.sessionId}:${agentId}`, {
        requestId,
        sessionId: context.sessionId,
      });

      // Handle abort signal
      if (context.abortSignal) {
        context.abortSignal.addEventListener("abort", async () => {
          const notification: CancellationNotification = {
            method: "notifications/cancelled",
            params: { requestId, reason: "Session cancelled by user" },
          };
          try {
            await mcpSetup.client.notification(notification);
          } catch (error) {
            logger.warn("Failed to send cancellation notification", { error, requestId });
          }
        });
      }

      const toolCallArgs: AgentToolParams = {
        prompt: prompt,
        context: {
          previousResults: context.previousResults,
          additionalInfo: context.additionalContext,
          reasoning: context.reasoning,
        },
        _sessionContext: {
          sessionId: context.sessionId,
          workspaceId: context.workspaceId,
          userId: context.userId,
          streamId: context.streamId,
        },
      };

      let toolResult: unknown;
      try {
        toolResult = await mcpSetup.client.callTool(
          { name: agentId, arguments: toolCallArgs, _meta: { requestId } },
          undefined,
          { timeout: 1_200_000 },
        );
      } finally {
        this.activeMCPRequests.delete(`${context.sessionId}:${agentId}`);
      }

      const executionResult = this.parseAgentResponse(toolResult);

      const output =
        executionResult.type === "completed" ? executionResult.result : executionResult;

      const { toolCalls, toolResults, outputWithoutTools } = this.extractToolMetadata(output);

      this.logger.info(`Agent ${agentId} execution completed with result:`, {
        executionResultType: executionResult.type,
        output: JSON.stringify(outputWithoutTools),
        duration: Date.now() - startTime,
      });

      return {
        agentId,
        task: this.truncateTask(prompt),
        input: context,
        output: outputWithoutTools,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        toolResults: toolResults && toolResults.length > 0 ? toolResults : undefined,
      };
    } catch (error) {
      const errorCause = createErrorCause(error);
      const errorMessage = stringifyError(error);

      this.logger.error("Agent execution failed", {
        agentId,
        error: errorMessage,
        errorCause,
        duration: Date.now() - startTime,
      });

      // Provide user-friendly error messages based on error type
      const userFriendlyError = getErrorDisplayMessage(errorCause) || errorMessage;

      return {
        agentId,
        task: this.truncateTask(prompt),
        input: context,
        output: null,
        error: userFriendlyError,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        toolCalls: undefined,
        toolResults: undefined,
      };
    } finally {
      // Always clean up execution tracking, whether success or failure
      const executionKey = `${context.sessionId}:${agentId}`;
      const wasTracking = this.activeAgentExecutions.delete(executionKey);
      if (wasTracking) {
        logger.debug("Stopped tracking agent execution", {
          executionKey,
          activeExecutionsCount: this.activeAgentExecutions.size,
          duration: Date.now() - startTime,
        });
      }
    }
  }

  /**
   * Execute in-process LLM agents without MCP overhead.
   */
  private async executeWrappedAgent(
    agent: AtlasAgent<string, WrappedAgentResult>,
    agentId: string,
    prompt: string,
    context: AgentExecutionContext,
    startTime: number,
    logger: Logger,
  ): Promise<AgentResult> {
    try {
      // Only enable streaming if both streamId and callback are provided
      let streamEmitter: StreamEmitter | undefined;
      if (context.onStreamEvent && context.streamId) {
        streamEmitter = new CallbackStreamEmitter(
          context.onStreamEvent,
          () => {},
          (error) => logger.error("Agent stream error", { agentId, error }),
        );
      }

      let agentContext: AgentContext;
      let finalPrompt = prompt;

      // Resolve session memory (caller-provided or orchestrator-managed)
      const sessionMemory =
        context.memoryManager ??
        this.getOrCreateSessionMemory(context.sessionId, context.workspaceId);

      if (this.buildAgentContext) {
        // Use the context builder to get proper tools and enriched prompt
        try {
          const { context: builtContext, enrichedPrompt } = await this.buildAgentContext(
            agent,
            {
              sessionId: context.sessionId,
              workspaceId: context.workspaceId,
              userId: context.userId,
              streamId: context.streamId,
            },
            sessionMemory,
            prompt,
            {
              stream: streamEmitter, // Override with our stream emitter
              abortSignal: context.abortSignal, // Pass abort signal
            },
            context.previousResults, // Pass previous results for context enrichment
          );

          agentContext = builtContext;
          finalPrompt = enrichedPrompt;

          logger.info("Built context for wrapped agent with MCP tools", {
            agentId,
            toolCount: Object.keys(agentContext.tools).length,
            toolNames: Object.keys(agentContext.tools),
            hasEnrichedPrompt: enrichedPrompt !== prompt,
          });
        } catch (error) {
          logger.error("Failed to build context for wrapped agent, falling back to empty tools", {
            agentId,
            error: error,
          });

          // Fallback to minimal context on error
          agentContext = {
            logger: logger.child({ agentId, sessionId: context.sessionId }),
            tools: {},
            session: {
              sessionId: context.sessionId,
              workspaceId: context.workspaceId,
              userId: context.userId,
            },
            stream: streamEmitter,
            env: {},
            abortSignal: context.abortSignal,
          };
        }
      } else {
        // No context builder available - use minimal context
        logger.warn(
          "No context builder available for wrapped agent - agent will run without tool access",
          {
            component: "AgentOrchestrator",
            workspaceId: context.workspaceId,
            agentId,
            sessionId: context.sessionId,
            hasContextBuilder: false,
            hasMcpServerPool: !!this.config.mcpServerPool,
            hasDaemonUrl: !!this.config.daemonUrl,
          },
        );

        agentContext = {
          logger: logger.child({ agentId, sessionId: context.sessionId }),
          tools: {}, // Empty tools - no MCP access
          session: {
            sessionId: context.sessionId,
            workspaceId: context.workspaceId,
            userId: context.userId,
          },
          stream: streamEmitter,
          env: {},
          abortSignal: context.abortSignal,
        };
      }

      let result: WrappedAgentResult;
      try {
        result = await retry(() => agent.execute(finalPrompt, agentContext), {
          maxAttempts: 11, // 1 initial + 10 retries
          minTimeout: 1000,
          maxTimeout: 30000,
          multiplier: 2,
          jitter: 1, // Full jitter to prevent thundering herd
        });
      } catch (error) {
        // Unwrap RetryError to get the original error
        if (error && typeof error === "object" && "cause" in error) {
          throw error.cause;
        }
        throw error;
      }

      // Safely persist episodic memory for wrapped-agent execution
      try {
        const eventKey = `epi:${Date.now()}:${agentId}`;
        sessionMemory.rememberWithMetadata(
          eventKey,
          {
            agentId,
            task: this.truncateTask(prompt),
            output: JSON.stringify(result),
            duration: (Date.now() - startTime).toString(),
          },
          {
            memoryType: "episodic",
            tags: ["agent-execution", agentId],
            relevanceScore: 0.5,
            confidence: 0.9,
          },
        );
      } catch (memErr) {
        logger.debug("Failed to persist episodic memory for wrapped agent", {
          error: memErr instanceof Error ? memErr.message : String(memErr),
        });
      }

      const { toolCalls, toolResults, outputWithoutTools } = this.extractToolMetadata(result);

      return {
        agentId,
        task: this.truncateTask(prompt),
        input: context,
        output: outputWithoutTools,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        toolCalls,
        toolResults,
        artifactRefs: result.artifactRefs,
      };
    } catch (error) {
      this.logger.error("Wrapped agent execution failed", { error });

      return {
        agentId,
        task: this.truncateTask(prompt),
        input: context,
        output: null,
        error: stringifyError(error),
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        toolCalls: undefined,
        toolResults: undefined,
      };
    }
  }

  /**
   * Get or create an MCP client for a specific session.
   * Each session gets its own transport and SSE connection.
   */
  private async getOrCreateSessionClient(
    sessionId: string,
    workspaceId?: string,
  ): Promise<MCPSessionSetup> {
    let setup = this.mcpSessions.get(sessionId);

    if (!setup) {
      this.logger.info("Creating new MCP client for session", { sessionId });

      const client = new Client({ name: "atlas-agent-orchestrator", version: "1.0.0" });

      const transport = new StreamableHTTPClientTransport(new URL(this.config.agentsServerUrl), {
        requestInit: { headers: { ...this.config.headers, "mcp-session-id": sessionId } },
      });

      await client.connect(transport);

      /**
       * Handles streaming notifications from Agents and passes them up to the session supervisor.
       * @see packages/core/src/streaming/stream-emitters.ts - MCPStreamEmitter
       */
      client.setNotificationHandler(StreamContentNotificationSchema, (notification) => {
        const { toolName: agentId, sessionId, event } = notification.params;
        // @ts-expect-error right now, uiMessageChunkSchema isn't exported by the Vercel AI SDK.
        // The chunk is emitted from the MCPStreamEmitter so we'll have to line those up by hand.
        // @see https://github.com/vercel/ai/issues/8100
        const evt: AtlasUIMessageChunk = event;
        const handlerKey = this.getStreamHandlerKey(sessionId, agentId);
        const handler = this.activeStreamHandlers.get(handlerKey);
        if (handler) {
          handler(evt);

          if (evt.type === "finish") {
            this.activeStreamHandlers.delete(handlerKey);
          }
        } else {
          this.logger.error("No handler found for SSE Stream", { handlerKey });
        }
      });

      const mcpSessionId = transport.sessionId;

      setup = { client, transport, lastActivity: Date.now(), workspaceId };

      this.mcpSessions.set(sessionId, setup);

      // Handle MCP session ID mapping if different
      if (mcpSessionId && mcpSessionId !== sessionId) {
        this.logger.info("MCP session ID differs from orchestrator session ID", {
          orchestratorSessionId: sessionId,
          mcpSessionId,
        });
        this.mcpSessions.set(mcpSessionId, setup);
      }

      // Verify MCP connection works
      try {
        await client.listTools();
      } catch (error) {
        this.logger.error("Failed to verify MCP connection", { error });
        throw error;
      }

      this.logger.info("MCP client created for session", { totalSessions: this.mcpSessions.size });
    } else {
      setup.lastActivity = Date.now();
    }

    return setup;
  }

  /**
   * Clean up inactive sessions.
   * Sessions are considered inactive after 30 minutes.
   */
  private async cleanupInactiveSessions(): Promise<void> {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes

    for (const [sessionId, setup] of this.mcpSessions.entries()) {
      if (now - setup.lastActivity > maxAge) {
        this.logger.info("Cleaning up inactive session", { sessionId });

        try {
          await setup.transport.close();
        } catch (error) {
          this.logger.error("Error closing transport for session", { sessionId, error });
        }

        this.mcpSessions.delete(sessionId);

        // Clean up session memory if workspaceId exists
        if (setup.workspaceId) {
          const memoryKey = `${setup.workspaceId}:${sessionId}`;
          const memory = this.sessionMemories.get(memoryKey);
          if (memory) {
            try {
              await memory.dispose();
              this.sessionMemories.delete(memoryKey);
              this.logger.debug("Cleaned up session memory", { memoryKey });
            } catch (error) {
              this.logger.error("Error disposing session memory", { memoryKey, error });
            }
          }
        }

        // Clean up stream handlers for this session
        for (const key of this.activeStreamHandlers.keys()) {
          if (key.startsWith(`${sessionId}:`)) {
            this.activeStreamHandlers.delete(key);
          }
        }
      }
    }
  }

  /**
   * Clean up all connections and pending operations.
   */
  async shutdown(): Promise<void> {
    this.logger.info("Shutting down agent orchestrator");

    if (this.sessionCleanupInterval) {
      clearInterval(this.sessionCleanupInterval);
      this.sessionCleanupInterval = undefined;
    }

    // Dispose session memories
    for (const memory of this.sessionMemories.values()) {
      try {
        await memory.dispose();
      } catch (error) {
        this.logger.error("Error disposing session memory", { error });
      }
    }
    this.sessionMemories.clear();

    for (const [sessionId, setup] of this.mcpSessions.entries()) {
      try {
        await setup.transport.close();
        this.logger.info("Closed MCP transport for session", { sessionId });
      } catch (error) {
        this.logger.error("Error closing MCP transport for session", { sessionId, error });
      }
    }

    this.mcpSessions.clear();
    this.activeStreamHandlers.clear();
  }
}
