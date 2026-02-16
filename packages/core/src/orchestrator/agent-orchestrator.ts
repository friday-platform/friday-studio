/**
 * Routes agent execution to MCP services (distributed).
 *
 * Session lifecycle: Each user session gets its own MCP client with SSE streaming.
 * Sessions auto-cleanup after 30min inactivity.
 */

import {
  type AgentExecutionError,
  type AgentMetadata,
  type AgentResult,
  AgentResultSchema,
  type AtlasUIMessageChunk,
} from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { AgentToolParams } from "../agent-server/types.ts";
import { createErrorCause, getErrorDisplayMessage } from "../errors.ts";
import type { GlobalMCPServerPool } from "../mcp-server-pool.ts";
import {
  type CancellationNotification,
  StreamContentNotificationSchema,
} from "../streaming/stream-emitters.ts";

// TODO(structured-output): Replace with proper agent result schema once agents produce structured output
const MCPToolResultSchema = z.object({
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
    ]),
  ),
});

/** Context passed to agent execution - identifies the session and enables streaming. */
export interface AgentExecutionContext {
  sessionId: string;
  workspaceId: string;
  userId?: string;
  /** Required for SSE streaming alongside onStreamEvent callback */
  streamId?: string;
  datetime?: {
    timezone: string;
    timestamp: string;
    localDate: string;
    localTime: string;
    timezoneOffset: string;
  };
  previousResults?: AgentResult[];
  additionalContext?: unknown;
  reasoning?: string;
  /** Stream events callback - requires streamId to be set */
  onStreamEvent?: (event: AtlasUIMessageChunk) => void;
  abortSignal?: AbortSignal;
  /** Agent-specific configuration from workspace.yml */
  config?: Record<string, unknown>;
}

export interface AgentOrchestratorConfig {
  /** URL of the atlas-agents MCP server (StreamableHTTP endpoint) */
  agentsServerUrl: string;
  headers?: Record<string, string>;
  /** Default: 300000ms (5min) */
  requestTimeoutMs?: number;
  /** Required for wrapped agents to have tool access */
  mcpServerPool?: GlobalMCPServerPool;
  /** Required for wrapped agents to have tool access */
  daemonUrl?: string;
}

const MCPExecutionResultSchema = z.object({
  type: z.literal("completed"),
  result: z.unknown(), // Agent-specific result
});

type MCPExecutionResult = z.infer<typeof MCPExecutionResultSchema>;

export interface IAgentOrchestrator {
  initialize(): void;
  discoverAgents(): Promise<AgentMetadata[]>;
  executeAgent(
    agentId: string,
    prompt: string,
    context: AgentExecutionContext,
  ): Promise<AgentResult>;
  shutdown(): Promise<void>;
}

interface MCPSessionSetup {
  client: Client;
  transport: StreamableHTTPClientTransport;
  lastActivity: number;
  workspaceId?: string;
}

export class AgentOrchestrator implements IAgentOrchestrator {
  private mcpSessions = new Map<string, MCPSessionSetup>();
  private config: Required<Omit<AgentOrchestratorConfig, "mcpServerPool" | "daemonUrl">> &
    Pick<AgentOrchestratorConfig, "mcpServerPool" | "daemonUrl">;
  private logger: Logger;
  private sessionCleanupInterval?: number;
  /** Keyed by `${sessionId}:${agentId}` - handles multi-workspace scenarios */
  private activeStreamHandlers = new Map<string, (event: AtlasUIMessageChunk) => void>();
  private activeMCPRequests = new Map<string, { requestId: string; sessionId: string }>();
  /** Prevents premature workspace shutdown while agents are running */
  private activeAgentExecutions = new Map<
    string,
    { agentId: string; sessionId: string; startTime: number }
  >();

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
  }

  /** Queries MCP server for agent:// resources. */
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
                domains: meta.expertise.domains?.length ? meta.expertise.domains : ["general"],
                examples: meta.expertise.examples ?? [],
              }
            : { domains: ["general"], examples: [] };
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

  /** Used by daemon to prevent workspace shutdown while agents are running. */
  hasActiveExecutions(): boolean {
    return this.activeAgentExecutions.size > 0;
  }

  getActiveExecutions(): Array<{ agentId: string; sessionId: string; durationMs: number }> {
    const now = Date.now();
    return Array.from(this.activeAgentExecutions.values()).map((exec) => ({
      agentId: exec.agentId,
      sessionId: exec.sessionId,
      durationMs: now - exec.startTime,
    }));
  }

  /** Unwraps MCP response format: { content: [{ type: "text", text: JSON }] } */
  private parseAgentResponse(toolResult: unknown): MCPExecutionResult {
    const validatedResult = MCPToolResultSchema.parse(toolResult);

    if (!validatedResult.content?.[0] || validatedResult.content[0].type !== "text") {
      throw new Error("Invalid MCP response: expected text content");
    }

    const textContent = validatedResult.content[0].text;

    try {
      const parsed = JSON.parse(textContent);

      // @ts-expect-error `agents-should-produce-structured-output` - untyped until agents produce structured output
      if (parsed.type === "error") {
        // @ts-expect-error `agents-should-produce-structured-output`
        throw new Error(`Agent ${parsed.agentId || "unknown"} failed: ${parsed.error}`);
      }
      // @ts-expect-error `agents-should-produce-structured-output`
      if (parsed.type === "cancelled") {
        // @ts-expect-error `agents-should-produce-structured-output`
        return { type: "completed", result: parsed.result || "Cancelled by user" };
      }

      return MCPExecutionResultSchema.parse(parsed);
    } catch (error) {
      // Legacy format from before structured cancellation was added
      if (textContent.includes("No output generated. Check the stream for errors.")) {
        return { type: "completed", result: "Canceled by user" };
      }

      this.logger.error("Failed to parse MCP response as JSON", {
        component: "AgentOrchestrator",
        textContent: textContent.substring(0, 500),
        textLength: textContent.length,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof z.ZodError) {
        throw new Error(`Invalid agent execution result: ${error.message}`);
      }
      // Re-throw formatted agent errors we created above
      if (
        error instanceof Error &&
        error.message.includes("Agent") &&
        error.message.includes("failed:")
      ) {
        throw error;
      }
      throw new Error(
        `Invalid JSON in MCP response: ${error instanceof Error ? error.message : String(error)}. Response text: ${textContent.substring(0, 200)}`,
      );
    }
  }

  /** Starts 5-minute cleanup interval for inactive sessions. */
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

  getStreamHandlerKey(sessionId: string, agentId: string): string {
    return `${sessionId}:${agentId}`;
  }

  /**
   * Routes to wrapped agent (in-process) or MCP agent based on registration.
   * Streaming requires both streamId and onStreamEvent in context.
   */
  async executeAgent(
    agentId: string,
    prompt: string,
    context: AgentExecutionContext,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const logger = this.logger.child({ agentId, sessionId: context.sessionId });

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

    if (context.onStreamEvent) {
      const handlerKey = this.getStreamHandlerKey(context.sessionId, agentId);
      this.activeStreamHandlers.set(handlerKey, context.onStreamEvent);
      logger.debug("Registered handler for SSE stream", { handlerKey });
    } else {
      logger.debug("No stream callback provided");
    }

    try {
      if (!context.workspaceId) {
        logger.error("Missing workspaceId in agent execution context", { agentId });
        return {
          ok: false as const,
          agentId,
          timestamp: new Date().toISOString(),
          input: prompt,
          error: { reason: "Missing workspaceId in agent execution context" },
          durationMs: Date.now() - startTime,
        };
      }

      const mcpSetup = await this.getOrCreateSessionClient(context.sessionId, context.workspaceId);

      logger.debug("Executing agent via MCP", {
        agentId,
        sessionId: context.sessionId,
        prompt: prompt,
        hasStreamCallback: !!context.onStreamEvent,
      });

      const requestId = crypto.randomUUID();
      this.activeMCPRequests.set(`${context.sessionId}:${agentId}`, {
        requestId,
        sessionId: context.sessionId,
      });

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
          datetime: context.datetime,
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

      const mcpResponse = this.parseAgentResponse(toolResult);
      const envelope = AgentResultSchema.parse(mcpResponse.result);

      this.logger.info(`Agent ${agentId} execution completed`, {
        ok: envelope.ok,
        durationMs: envelope.durationMs,
      });

      return envelope;
    } catch (error) {
      const errorCause = createErrorCause(error);
      const errorMessage = stringifyError(error);

      this.logger.error("Agent execution failed", {
        agentId,
        error: errorMessage,
        errorCause,
        duration: Date.now() - startTime,
      });

      const userFriendlyError = getErrorDisplayMessage(errorCause) || errorMessage;

      return {
        agentId,
        timestamp: new Date().toISOString(),
        input: prompt,
        ok: false,
        error: { reason: userFriendlyError },
        durationMs: Date.now() - startTime,
      } satisfies AgentExecutionError<string>;
    } finally {
      // Must cleanup here to avoid race with late-arriving notifications after finish
      if (context.onStreamEvent) {
        const handlerKey = this.getStreamHandlerKey(context.sessionId, agentId);
        this.activeStreamHandlers.delete(handlerKey);
        logger.debug("Cleaned up stream handler", { handlerKey });
      }

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

  /** Each session gets its own MCP client with StreamableHTTP transport. */
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

      // Forward streaming notifications from MCP agents to the session's stream handler
      client.setNotificationHandler(StreamContentNotificationSchema, (notification) => {
        const { toolName: agentId, sessionId, event } = notification.params;
        // uiMessageChunkSchema isn't exported by Vercel AI SDK - see https://github.com/vercel/ai/issues/8100
        const evt: AtlasUIMessageChunk = event as AtlasUIMessageChunk;
        const handlerKey = this.getStreamHandlerKey(sessionId, agentId);
        const handler = this.activeStreamHandlers.get(handlerKey);
        if (handler) {
          handler(evt);
        }
      });

      const mcpSessionId = transport.sessionId;

      setup = { client, transport, lastActivity: Date.now(), workspaceId };

      this.mcpSessions.set(sessionId, setup);

      // MCP server may assign different session ID - store under both keys
      if (mcpSessionId && mcpSessionId !== sessionId) {
        this.logger.info("MCP session ID differs from orchestrator session ID", {
          orchestratorSessionId: sessionId,
          mcpSessionId,
        });
        this.mcpSessions.set(mcpSessionId, setup);
      }

      // Verify connection is healthy
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

  /** Cleans up sessions inactive for >30 minutes. */
  private async cleanupInactiveSessions(): Promise<void> {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000;

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

  async shutdown(): Promise<void> {
    this.logger.info("Shutting down agent orchestrator");

    if (this.sessionCleanupInterval) {
      clearInterval(this.sessionCleanupInterval);
      this.sessionCleanupInterval = undefined;
    }

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
