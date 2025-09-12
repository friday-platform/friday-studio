/**
 * Agent Orchestrator coordinates agent execution in the Atlas system.
 *
 * In Atlas architecture:
 * - Agents are distributed services that perform specific tasks
 * - This orchestrator connects to them via MCP (Model Context Protocol)
 * - Handles approval flows when agents need human intervention
 * - Supports both MCP-based agents and wrapped LLM agents
 */

import type { ToolResult } from "@atlas/agent-sdk";
import {
  type AgentContext,
  type AgentMetadata,
  type AgentResult,
  ApprovalRequestSchema,
  type AtlasAgent,
  type AtlasUIMessageChunk,
  AwaitingSupervisorDecision,
  type StreamEmitter,
} from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { CoALAMemoryManager, CoALAMemoryType, type IMemoryScope } from "@atlas/memory";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolCall } from "../../../../src/core/services/hallucination-detector.ts";
import {
  isTransientError,
  withExponentialBackoff,
} from "../../../../src/utils/exponential-backoff.ts";
import { createAgentContextBuilder } from "../agent-context/index.ts";
import type { WrappedAgentResult } from "../agent-conversion/from-llm.ts";
import type { AgentToolParams } from "../agent-server/types.ts";
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

export interface ApprovalDecision {
  approved: boolean;
  reason: string;
  modifiedRequest?: unknown;
}

interface PendingApproval {
  approvalId: string;
  agentId: string;
  originalRequest: unknown;
  sessionContext: AgentExecutionContext;
  timestamp: number;
}

export interface AgentOrchestratorConfig {
  /** URL of the atlas-agents MCP server */
  agentsServerUrl: string;
  /** Headers to include in MCP requests */
  headers?: Record<string, string>;
  /** Timeout for MCP requests in milliseconds */
  requestTimeoutMs?: number;
  /** Approval timeout in milliseconds */
  approvalTimeout: number;
  /** Optional pre-provisioned MCP client pool */
  mcpServerPool?: GlobalMCPServerPool;
  /** Optional daemon URL for MCP agents */
  daemonUrl?: string;
}

const CompletedAgentResultSchema = z.object({
  type: z.literal("completed"),
  result: z.unknown(), // Agent-specific result
});

const AwaitingApprovalResultSchema = z.object({
  type: z.literal("awaiting_approval"),
  approvalId: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  request: z.unknown(),
});

const AgentExecutionResultSchema = z.discriminatedUnion("type", [
  CompletedAgentResultSchema,
  AwaitingApprovalResultSchema,
]);

const ApprovalDecisionSchema = z.object({
  approved: z.boolean(),
  reason: z.string().optional(),
  modifiedRequest: z.unknown().optional(),
  conditions: z.array(z.string()).optional(),
});

export type CompletedAgentResult = z.infer<typeof CompletedAgentResultSchema>;
export type AwaitingApprovalResult = z.infer<typeof AwaitingApprovalResultSchema>;
export type AgentExecutionResult = z.infer<typeof AgentExecutionResultSchema>;
export type ValidatedApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

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

  /** Continue suspended agent after approval */
  resumeWithApproval(approvalId: string, decision: ApprovalDecision): Promise<AgentResult>;

  /** Clean up connections */
  shutdown(): Promise<void>;
}

interface MCPSessionSetup {
  client: Client;
  transport: StreamableHTTPClientTransport;
  lastActivity: number;
}

/**
 * Orchestrates agent execution across Atlas distributed system.
 *
 * Atlas Architecture:
 * - MCP agents: Run as separate services, communicate via Model Context Protocol
 * - Wrapped agents: Run in-process for lightweight tasks
 * - Session-based: Each user session gets isolated MCP connection
 * - Approval flow: Agents can request human approval before dangerous actions
 */
export class AgentOrchestrator implements IAgentOrchestrator {
  private mcpSessions = new Map<string, MCPSessionSetup>(); // Per-session MCP clients
  private pendingApprovals = new Map<string, PendingApproval>();
  private config: Required<Omit<AgentOrchestratorConfig, "mcpServerPool" | "daemonUrl">> &
    Pick<AgentOrchestratorConfig, "mcpServerPool" | "daemonUrl">;
  private logger: Logger;
  private approvalCleanupInterval?: number;
  private sessionCleanupInterval?: number;
  private wrappedAgents = new Map<string, AtlasAgent<WrappedAgentResult>>(); // LLM agents that bypass MCP
  // Track active stream handlers by sessionId:agentId to handle multi-workspace scenarios
  private activeStreamHandlers = new Map<string, (event: AtlasUIMessageChunk) => void>();
  private buildAgentContext?: ReturnType<typeof createAgentContextBuilder>;
  // Cache CoALA session memories per workspaceId:sessionId
  private sessionMemories = new Map<string, CoALAMemoryManager>();
  // Track active MCP requests for cancellation
  private activeMCPRequests = new Map<string, { requestId: string; sessionId: string }>();

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
      approvalTimeout: config.approvalTimeout || 300000, // 5 minutes
      // Store new config fields
      mcpServerPool: config.mcpServerPool,
      daemonUrl: config.daemonUrl,
    };

    // Initialize context builder if we have the required dependencies
    if (config.mcpServerPool && config.daemonUrl) {
      this.buildAgentContext = createAgentContextBuilder({
        daemonUrl: config.daemonUrl,
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
    try {
      // Create a default session to query for agents
      const discoverySessionId = `discovery-${Date.now()}`;
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
      this.logger.error("Failed to discover agents", { error });

      // If MCP discovery fails, check for wrapped agents
      const wrappedAgents: AgentMetadata[] = [];
      for (const [agentId, agent] of this.wrappedAgents.entries()) {
        wrappedAgents.push({
          id: agentId,
          version: agent.metadata.version,
          description: agent.metadata.description,
          expertise: {
            domains: agent.metadata.expertise.domains,
            capabilities: agent.metadata.expertise.capabilities,
            examples: agent.metadata.expertise.examples || [],
          },
          displayName: agent.metadata.displayName,
          metadata: agent.metadata.metadata,
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
    }
  }

  /**
   * Register an LLM agent that runs in-process instead of via MCP.
   * Used for lightweight agents that don't need service isolation.
   */
  registerWrappedAgent(agentId: string, agent: AtlasAgent<WrappedAgentResult>): void {
    this.wrappedAgents.set(agentId, agent);
    this.logger.debug("Registered wrapped agent for direct execution", {
      agentId,
      agentName: agent.metadata.displayName,
      expertise: agent.metadata.expertise.domains,
    });
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

      return AgentExecutionResultSchema.parse(parsed);
    } catch (error) {
      //
      if (textContent.includes("No output generated. Check the stream for errors.")) {
        return { type: "completed", result: "Canceled by user" };
      }
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid agent execution result: ${error.message}`);
      }
      throw new Error(
        `Invalid JSON in MCP response: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Starts cleanup intervals for session and approval management.
   * MCP connections are created per-session on demand.
   */
  initialize(): void {
    try {
      this.logger.info("Initializing agent orchestrator", {
        serverUrl: this.config.agentsServerUrl,
      });

      this.startApprovalCleanup();

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
      const mcpSetup = await this.getOrCreateSessionClient(context.sessionId);

      logger.debug("🌭🌭🌭🌭🌭🌭🌭🌭🌭 Executing agent via MCP", {
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

      if (executionResult.type === "awaiting_approval") {
        this.pendingApprovals.set(executionResult.approvalId, {
          approvalId: executionResult.approvalId,
          agentId,
          originalRequest: { prompt, context },
          sessionContext: context,
          timestamp: Date.now(),
        });

        throw new AwaitingSupervisorDecision(
          executionResult.approvalId,
          ApprovalRequestSchema.parse(executionResult.request),
          executionResult.sessionId,
          executionResult.agentId,
        );
      }

      const output =
        executionResult.type === "completed" ? executionResult.result : executionResult;

      // Pass through tool metadata from the completed result payload
      let mappedCalls: ToolCall[] | undefined;
      let mappedResults: ToolResult[] | undefined;
      if (
        typeof output === "object" &&
        output !== null &&
        "toolCalls" in output &&
        "toolResults" in output
      ) {
        // @FIXME: tool calls should be parsed.
        // `agents-should-produce-structured-output`
        mappedCalls = output.toolCalls;
        // @FIXME: tool results should be parsed.
        // `agents-should-produce-structured-output`
        mappedResults = output.toolResults;
      }

      this.logger.info(`Agent ${agentId} execution completed with result:`, {
        executionResultType: executionResult.type,
        output: JSON.stringify(output),
        duration: Date.now() - startTime,
      });

      // Create a brief summary of the task instead of storing the entire prompt
      const taskSummary = prompt.length > 100 ? `${prompt.substring(0, 97)}...` : prompt;

      return {
        agentId,
        task: taskSummary,
        input: context,
        output,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        toolCalls: mappedCalls && mappedCalls.length > 0 ? mappedCalls : undefined,
        toolResults: mappedResults && mappedResults.length > 0 ? mappedResults : undefined,
      };
    } catch (error) {
      if (error instanceof AwaitingSupervisorDecision) {
        this.pendingApprovals.set(error.approvalId, {
          approvalId: error.approvalId,
          agentId,
          originalRequest: { prompt, context },
          sessionContext: context,
          timestamp: Date.now(),
        });

        throw error;
      }

      this.logger.error("Agent execution failed", {
        agentId,
        error,
        duration: Date.now() - startTime,
      });

      // Create a brief summary of the task instead of storing the entire prompt
      const taskSummary = prompt.length > 100 ? `${prompt.substring(0, 97)}...` : prompt;

      return {
        agentId,
        task: taskSummary,
        input: context,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        toolCalls: undefined,
        toolResults: undefined,
      };
    }
  }

  /**
   * Continue a suspended agent after supervisor approval.
   * Part of Atlas's human-in-the-loop safety system.
   */
  async resumeWithApproval(approvalId: string, decision: ApprovalDecision): Promise<AgentResult> {
    const validatedDecision = ApprovalDecisionSchema.parse(decision);
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      throw new Error(`No pending approval found for ID: ${approvalId}`);
    }

    this.pendingApprovals.delete(approvalId);

    const startTime = Date.now();

    try {
      const mcpSetup = await this.getOrCreateSessionClient(pending.sessionContext.sessionId);

      const resumeArgs: Partial<AgentToolParams> = {
        _approvalId: approvalId,
        _approvalDecision: validatedDecision,
        _sessionContext: {
          sessionId: pending.sessionContext.sessionId,
          workspaceId: pending.sessionContext.workspaceId,
          userId: pending.sessionContext.userId,
        },
      };

      const toolResult = await mcpSetup.client.callTool(
        { name: pending.agentId, arguments: resumeArgs },
        CallToolResultSchema,
      );

      const executionResult = this.parseAgentResponse(toolResult);

      if (executionResult.type === "awaiting_approval") {
        this.pendingApprovals.set(executionResult.approvalId, {
          approvalId: executionResult.approvalId,
          agentId: executionResult.agentId,
          originalRequest: { prompt: "Resume with approval", context: validatedDecision },
          sessionContext: pending.sessionContext,
          timestamp: Date.now(),
        });

        throw new AwaitingSupervisorDecision(
          executionResult.approvalId,
          ApprovalRequestSchema.parse(executionResult.request),
          executionResult.sessionId,
          executionResult.agentId,
        );
      }

      const output =
        executionResult.type === "completed" ? executionResult.result : executionResult;

      let mappedCalls: ToolCall[] | undefined;
      let mappedResults: ToolResult[] | undefined;
      if (typeof output === "object" && output !== null) {
        const rec = output;
        mappedCalls = rec.toolCalls;
        mappedResults = rec.toolResults;
      }

      return {
        agentId: pending.agentId,
        task: "Resume with approval",
        input: validatedDecision,
        output,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        toolCalls: mappedCalls && mappedCalls.length > 0 ? mappedCalls : undefined,
        toolResults: mappedResults && mappedResults.length > 0 ? mappedResults : undefined,
      };
    } catch (error) {
      if (error instanceof AwaitingSupervisorDecision) {
        throw error;
      }

      this.logger.error("Failed to resume with approval", {
        approvalId,
        agentId: pending.agentId,
        error,
      });

      return {
        agentId: pending.agentId,
        task: "Resume with approval",
        input: decision,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Execute in-process LLM agents without MCP overhead.
   */
  private async executeWrappedAgent(
    agent: AtlasAgent<WrappedAgentResult>,
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
            error: error instanceof Error ? error.message : String(error),
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

      const result = await withExponentialBackoff(() => agent.execute(finalPrompt, agentContext), {
        maxRetries: 10,
        isRetryable: isTransientError,
        onRetry: (attempt, delay, error) => {
          logger.warn("Retrying wrapped agent execution due to transient LLM error", {
            agentId,
            attempt,
            delay,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });

      // Safely persist episodic memory for wrapped-agent execution
      try {
        const eventKey = `epi:${Date.now()}:${agentId}`;
        sessionMemory.rememberWithMetadata(
          eventKey,
          {
            agentId,
            task: prompt.length > 100 ? `${prompt.substring(0, 97)}...` : prompt,
            output: JSON.stringify(result),
            duration: (Date.now() - startTime).toString(),
          },
          {
            memoryType: CoALAMemoryType.EPISODIC,
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

      // Create a brief summary of the task instead of storing the entire prompt
      const taskSummary = prompt.length > 100 ? `${prompt.substring(0, 97)}...` : prompt;

      return {
        agentId,
        task: taskSummary,
        input: context,
        output: result,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        toolCalls: result.toolCalls,
        toolResults: result.toolResults,
      };
    } catch (error) {
      this.logger.error("Wrapped agent execution failed", { error });

      // Create a brief summary of the task instead of storing the entire prompt
      const taskSummary = prompt.length > 100 ? `${prompt.substring(0, 97)}...` : prompt;

      return {
        agentId,
        task: taskSummary,
        input: context,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        toolCalls: undefined,
        toolResults: undefined,
      };
    }
  }

  /**
   * Remove expired pending approvals.
   */
  private startApprovalCleanup(): void {
    this.approvalCleanupInterval = setInterval(
      () => {
        const now = Date.now();
        const timeout = this.config.approvalTimeout;

        for (const [approvalId, pending] of this.pendingApprovals.entries()) {
          if (now - pending.timestamp > timeout) {
            this.logger.warn("Approval timed out", {
              approvalId,
              agentId: pending.agentId,
              age: now - pending.timestamp,
            });
            this.pendingApprovals.delete(approvalId);
          }
        }
      },
      Deno.env.get("DENO_ENV") === "test" ? 5000 : 60000,
    ); // 5s for tests, 1min for prod
  }

  /**
   * Get or create an MCP client for a specific session.
   * Each session gets its own transport and SSE connection.
   */
  private async getOrCreateSessionClient(sessionId: string): Promise<MCPSessionSetup> {
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

      setup = { client, transport, lastActivity: Date.now() };

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

    if (this.approvalCleanupInterval) {
      clearInterval(this.approvalCleanupInterval);
      this.approvalCleanupInterval = undefined;
    }

    if (this.sessionCleanupInterval) {
      clearInterval(this.sessionCleanupInterval);
      this.sessionCleanupInterval = undefined;
    }

    this.pendingApprovals.clear();

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
