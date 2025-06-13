/**
 * ACP (Agent Communication Protocol) Adapter
 * Implementation using openapi-fetch with generated types for maximum compatibility
 */

import { BaseRemoteAdapter, type BaseRemoteAdapterConfig } from "./base-remote-adapter.ts";
import type {
  HealthStatus,
  RemoteAgentInfo,
  RemoteExecutionEvent,
  RemoteExecutionRequest,
  RemoteExecutionResult,
  RemoteMessagePart,
} from "../types.ts";
import {
  type ACPAgent,
  type ACPClient,
  type ACPEvent,
  type ACPRun,
  type ACPRunCreateRequest,
  createACPClient,
} from "./acp/client.ts";
import { createEventSource, createSSEAbortController, parseSSEData } from "./sse-utils.ts";
import { ACPError, SSEError } from "./sse-errors.ts";

export interface ACPAdapterConfig extends BaseRemoteAdapterConfig {
  endpoint: string; // Add endpoint to config
  acp: {
    agent_name: string;
    default_mode: "sync" | "async" | "stream";
    timeout_ms: number;
    max_retries: number;
    health_check_interval: number;
  };
}

/**
 * ACP Protocol Adapter
 * Full implementation using openapi-fetch with generated types for maximum compatibility
 */
export class ACPAdapter extends BaseRemoteAdapter {
  protected override config: ACPAdapterConfig;
  private client: ACPClient;

  constructor(config: ACPAdapterConfig) {
    // Ensure connection config is set up properly for base class
    const baseConfig = {
      ...config,
      connection: {
        endpoint: config.endpoint,
        timeout: config.acp.timeout_ms,
        retries: config.acp.max_retries,
        keepAlive: true,
      },
    };

    super(baseConfig);
    this.config = config;

    // Initialize ACP client with Atlas-specific configuration
    this.client = createACPClient({
      baseUrl: config.endpoint,
      headers: this.buildHeaders(),
      fetch: super.createAuthenticatedFetch(),
    });

    this.logger.info("ACP adapter initialized", {
      endpoint: config.endpoint,
      agent_name: config.acp.agent_name,
      default_mode: config.acp.default_mode,
    });
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
    };

    // Authentication headers will be added by the authenticated fetch function
    return headers;
  }

  getProtocolName(): string {
    return "acp";
  }

  async discoverAgents(): Promise<RemoteAgentInfo[]> {
    try {
      this.logger.debug("Discovering ACP agents", { endpoint: this.config.endpoint });
      const startTime = performance.now();

      const response = await this.client.GET("/agents");

      if (response.error) {
        throw new Error(`ACP Error: ${response.error.message}`);
      }

      if (!response.data) {
        throw new Error("No data received from agents endpoint");
      }

      const agents = response.data.agents;
      const duration = performance.now() - startTime;
      this.logger.info("Successfully discovered ACP agents", {
        count: agents.length,
        duration_ms: Math.round(duration),
      });

      return agents.map(this.convertACPAgentToRemoteInfo.bind(this));
    } catch (error) {
      this.logger.error("Failed to discover ACP agents", { error: this.formatError(error) });
      throw this.convertACPError(error, "Failed to discover agents");
    }
  }

  async getAgentDetails(agentName: string): Promise<RemoteAgentInfo> {
    try {
      this.logger.debug("Getting ACP agent details", { agent_name: agentName });
      const startTime = performance.now();

      const response = await this.client.GET("/agents/{name}", {
        params: {
          path: {
            name: agentName,
          },
        },
      });

      if (response.error) {
        if (response.error.code === "not_found") {
          throw new Error(`Agent '${agentName}' not found`);
        }
        throw new Error(`ACP Error: ${response.error.message}`);
      }

      if (!response.data) {
        throw new Error("No data received from agent endpoint");
      }

      const duration = performance.now() - startTime;
      this.logger.debug("Retrieved ACP agent details", {
        agent_name: agentName,
        duration_ms: Math.round(duration),
      });

      return this.convertACPAgentToRemoteInfo(response.data);
    } catch (error) {
      this.logger.error("Failed to get ACP agent details", {
        agent_name: agentName,
        error: this.formatError(error),
      });
      throw this.convertACPError(error, `Failed to get agent details for '${agentName}'`);
    }
  }

  async executeAgent(request: RemoteExecutionRequest): Promise<RemoteExecutionResult> {
    const executionStartTime = performance.now();

    try {
      this.logger.info("Executing ACP agent", {
        agent_name: request.agentName,
        mode: request.mode,
        session_id: request.sessionId,
        has_context: !!request.context,
      });

      // Build the run request
      const runRequest: ACPRunCreateRequest = {
        agent_name: request.agentName,
        input: this.convertInputToMessages(request.input),
        mode: request.mode === "stream" ? "sync" : request.mode, // Handle streaming separately
        session_id: request.sessionId,
      };

      if (request.mode === "stream") {
        throw new Error("Use executeAgentStream for streaming mode");
      }

      const response = await this.client.POST("/runs", {
        body: runRequest,
      });

      if (response.error) {
        throw new Error(`ACP Error: ${response.error.message}`);
      }

      if (!response.data) {
        throw new Error("No data received from run endpoint");
      }

      let run = response.data as ACPRun; // Type assertion since we know this is a run response

      // For async mode, poll for completion
      if (request.mode === "async" && run.status !== "completed" && run.status !== "failed") {
        run = await this.pollForCompletion(run.run_id);
      }

      const executionTime = performance.now() - executionStartTime;

      const result: RemoteExecutionResult = {
        executionId: run.run_id,
        output: this.convertOutput(run.output),
        status: this.convertStatus(run.status),
        error: run.error?.message,
        metadata: {
          execution_time_ms: Math.round(executionTime),
          session_id: request.sessionId,
        },
      };

      this.logger.info("ACP agent execution completed", {
        agent_name: request.agentName,
        execution_id: result.executionId,
        status: result.status,
        execution_time_ms: result.metadata.execution_time_ms,
      });

      return result;
    } catch (error) {
      const executionTime = performance.now() - executionStartTime;
      this.logger.error("ACP agent execution failed", {
        agent_name: request.agentName,
        mode: request.mode,
        execution_time_ms: Math.round(executionTime),
        error: this.formatError(error),
      });

      throw this.convertACPError(error, `Remote execution failed for agent '${request.agentName}'`);
    }
  }

  async *executeAgentStream(
    request: RemoteExecutionRequest,
  ): AsyncIterableIterator<RemoteExecutionEvent> {
    const controller = createSSEAbortController(this.config.acp.timeout_ms);

    try {
      this.logger.info("Starting ACP streaming execution", {
        agent_name: request.agentName,
        session_id: request.sessionId,
      });

      // Build the run request for streaming
      const runRequest: ACPRunCreateRequest = {
        agent_name: request.agentName,
        input: this.convertInputToMessages(request.input),
        mode: "stream",
        session_id: request.sessionId,
      };

      // Build SSE URL for streaming endpoint
      const streamingUrl = new URL("/runs", this.config.endpoint);

      // Create authenticated fetch for SSE
      const authenticatedFetch = super.createAuthenticatedFetch();

      // Create the SSE event source
      const eventSource = await createEventSource({
        url: streamingUrl,
        fetch: authenticatedFetch,
        options: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "Cache-Control": "no-cache",
          },
          body: JSON.stringify(runRequest),
          signal: controller.signal,
        },
      });

      this.logger.debug("SSE connection established", {
        agent_name: request.agentName,
        url: streamingUrl.toString(),
      });

      // Process SSE events
      for await (const message of eventSource.consume()) {
        try {
          // Parse the SSE data as an ACP event
          const event = parseSSEData<ACPEvent>(message.data);

          this.logger.debug("Received ACP SSE event", {
            agent_name: request.agentName,
            event_type: event.type,
            message_id: message.id,
          });

          // Convert ACP event to Remote execution event
          const remoteEvent = this.convertACPEvent(event);
          yield remoteEvent;

          // Check if this is a terminal event
          if (this.isTerminalEvent(event)) {
            this.logger.debug("Terminal event received, ending stream", {
              agent_name: request.agentName,
              event_type: event.type,
            });
            break;
          }
        } catch (parseError) {
          this.logger.error("Failed to parse SSE event", {
            agent_name: request.agentName,
            raw_data: message.data,
            error: this.formatError(parseError),
          });

          // Yield error event but continue processing
          yield {
            type: "error",
            error: `Failed to parse SSE event: ${this.formatError(parseError)}`,
          };
        }
      }

      this.logger.info("ACP streaming execution completed", {
        agent_name: request.agentName,
      });
    } catch (error) {
      this.logger.error("ACP streaming execution failed", {
        agent_name: request.agentName,
        error: this.formatError(error),
      });

      // Handle different error types appropriately
      if (error instanceof SSEError) {
        throw new Error(`SSE connection failed: ${error.message}`);
      } else if (error instanceof ACPError) {
        throw new Error(`ACP protocol error: ${error.message}`);
      } else {
        throw this.convertACPError(
          error,
          `Streaming execution failed for agent '${request.agentName}'`,
        );
      }
    } finally {
      // Ensure the abort controller is cleaned up
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }
  }

  async cancelExecution(executionId: string): Promise<void> {
    try {
      this.logger.info("Cancelling ACP execution", { execution_id: executionId });

      const response = await this.client.POST("/runs/{run_id}/cancel", {
        params: {
          path: {
            run_id: executionId,
          },
        },
      });

      if (response.error) {
        throw new Error(`ACP Error: ${response.error.message}`);
      }

      this.logger.info("ACP execution cancelled successfully", { execution_id: executionId });
    } catch (error) {
      this.logger.error("Failed to cancel ACP execution", {
        execution_id: executionId,
        error: this.formatError(error),
      });
      throw this.convertACPError(error, `Failed to cancel execution '${executionId}'`);
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const startTime = performance.now();

      const response = await this.client.GET("/ping");

      if (response.error) {
        throw new Error(`ACP Error: ${response.error.message}`);
      }

      const latency = Math.round(performance.now() - startTime);

      return {
        status: "healthy",
        latency_ms: latency,
        last_check: new Date(),
      };
    } catch (error) {
      return {
        status: "unhealthy",
        error: this.formatError(error),
        last_check: new Date(),
      };
    }
  }

  async resumeExecution(
    executionId: string,
    resumeResponse: string | RemoteMessagePart[],
  ): Promise<RemoteExecutionResult> {
    try {
      this.logger.info("Resuming ACP execution", {
        execution_id: executionId,
        response_type: typeof resumeResponse === "string" ? "string" : "message_parts",
      });

      // Convert response to ACP format
      const awaitResume = {}; // AwaitResume is Record<string, never> according to schema

      const startTime = performance.now();

      // Use the generic POST method since resumeRun doesn't map to a specific path with params
      const resumeUrl = `${this.config.endpoint}/runs/${executionId}`;
      const authenticatedFetch = super.createAuthenticatedFetch();

      const response = await authenticatedFetch(resumeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          run_id: executionId,
          await_resume: awaitResume,
          mode: "sync",
        }),
      });

      if (!response.ok) {
        throw new Error(`ACP Resume Error: ${response.status} ${response.statusText}`);
      }

      const responseData = await response.json();

      const run = responseData;
      if (!run || typeof run !== "object") {
        throw new Error("Invalid run data received from ACP response");
      }

      // For resumed runs, we need to wait for completion
      let finalRun = run as ACPRun;
      if (
        finalRun.status !== "completed" && finalRun.status !== "failed" &&
        finalRun.status !== "cancelled"
      ) {
        // Poll for completion
        finalRun = await this.pollForCompletion(executionId);
      }

      const executionTime = Math.round(performance.now() - startTime);

      const result: RemoteExecutionResult = {
        executionId,
        output: this.convertOutput(finalRun.output),
        status: this.convertStatus(finalRun.status),
        metadata: {
          execution_time_ms: executionTime,
          session_id: this.extractSessionId(finalRun),
          agent_version: this.extractAgentVersion(finalRun),
        },
      };

      if (finalRun.error) {
        result.error = finalRun.error.message;
      }

      this.recordSuccess(executionTime);
      this.logger.info("ACP execution resumed successfully", {
        execution_id: executionId,
        status: result.status,
        execution_time_ms: executionTime,
      });

      return result;
    } catch (error) {
      this.recordFailure(error instanceof Error ? error : new Error(String(error)));
      this.logger.error("Failed to resume ACP execution", {
        execution_id: executionId,
        error: this.formatError(error),
      });
      throw this.convertACPError(error, `Failed to resume execution '${executionId}'`);
    }
  }

  // Private helper methods

  private convertInputToMessages(input: string | unknown[]): ACPRunCreateRequest["input"] {
    if (typeof input === "string") {
      return [
        {
          parts: [
            {
              content_type: "text/plain",
              content: input,
              content_encoding: "plain",
            },
          ],
          role: "user",
        },
      ];
    }

    // Convert array of RemoteMessagePart to ACP Messages
    if (Array.isArray(input)) {
      return [
        {
          parts: input.map((part: unknown) => {
            const msgPart = part as { content_type?: string; content?: string };
            return {
              content_type: msgPart.content_type || "text/plain",
              content: msgPart.content || String(part),
              content_encoding: "plain" as const,
            };
          }),
          role: "user",
        },
      ];
    }

    // Fallback: convert to string
    return [
      {
        parts: [
          {
            content_type: "application/json",
            content: JSON.stringify(input),
            content_encoding: "plain",
          },
        ],
        role: "user",
      },
    ];
  }

  private convertOutput(output: ACPRun["output"]): RemoteMessagePart[] {
    // Convert ACP output format to RemoteMessagePart[]
    return output.flatMap((message) => {
      return message.parts.map((part) => ({
        content_type: part.content_type,
        content: part.content || "",
      } as RemoteMessagePart));
    });
  }

  private convertStatus(status: string): RemoteExecutionResult["status"] {
    switch (status) {
      case "completed":
        return "completed";
      case "failed":
        return "failed";
      case "cancelled":
        return "cancelled";
      case "running":
        return "running";
      case "awaiting":
        return "awaiting";
      default:
        return "pending";
    }
  }

  private convertACPAgentToRemoteInfo(agent: ACPAgent): RemoteAgentInfo {
    return {
      name: agent.name,
      description: agent.description || undefined,
      capabilities: Array.isArray(agent.metadata?.capabilities)
        ? agent.metadata.capabilities.map((cap) =>
          typeof cap === "string" ? cap : cap.name || "unknown"
        )
        : [],
      supported_modes: ["sync", "async", "stream"], // ACP supports all modes
      metadata: agent.metadata,
    };
  }

  private convertACPEvent(event: ACPEvent): RemoteExecutionEvent {
    switch (event.type) {
      case "message.part":
        return {
          type: "content",
          content: event.part.content || "",
          contentType: event.part.content_type,
        };
      case "message.created":
        return {
          type: "metadata",
          metadata: { event_type: "message.created", message: event.message },
        };
      case "message.completed":
        return {
          type: "metadata",
          metadata: { event_type: "message.completed", message: event.message },
        };
      case "run.created":
        return {
          type: "metadata",
          metadata: { event_type: "run.created", run: event.run },
        };
      case "run.in-progress":
        return {
          type: "metadata",
          metadata: { event_type: "run.in-progress", run: event.run },
        };
      case "run.completed":
        return {
          type: "completion",
          status: "completed",
          output: this.convertOutput(event.run.output),
        };
      case "run.failed":
        return {
          type: "completion",
          status: "failed",
          error: event.run.error?.message,
        };
      case "run.cancelled":
        return {
          type: "completion",
          status: "cancelled",
          error: "Run was cancelled",
        };
      case "run.awaiting":
        return {
          type: "awaiting",
          status: "awaiting",
          metadata: {
            event_type: "run.awaiting",
            run: event.run,
            await_request: event.run.await_request,
          },
        };
      case "error":
        return {
          type: "error",
          error: event.error.message,
        };
      default:
        return {
          type: "metadata",
          metadata: { event },
        };
    }
  }

  private isTerminalEvent(event: ACPEvent): boolean {
    return event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled" ||
      event.type === "error";
  }

  private async pollForCompletion(runId: string): Promise<ACPRun> {
    const maxAttempts = 60; // 5 minutes with 5-second intervals
    let attempts = 0;

    this.logger.debug("Starting polling for ACP run completion", {
      run_id: runId,
      max_attempts: maxAttempts,
    });

    while (attempts < maxAttempts) {
      try {
        const response = await this.client.GET("/runs/{run_id}", {
          params: {
            path: {
              run_id: runId,
            },
          },
        });

        if (response.error) {
          throw new Error(`ACP Error: ${response.error.message}`);
        }

        if (!response.data) {
          throw new Error("No data received from run status endpoint");
        }

        const run = response.data;

        if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
          this.logger.debug("ACP run completed", {
            run_id: runId,
            status: run.status,
            attempts,
          });
          return run;
        }

        await new Promise((resolve) => setTimeout(resolve, 5000));
        attempts++;
      } catch (error) {
        this.logger.error("Error during polling", {
          run_id: runId,
          attempts,
          error: this.formatError(error),
        });
        throw error;
      }
    }

    throw new Error(`ACP execution timed out after ${maxAttempts * 5} seconds`);
  }

  private convertACPError(error: unknown, context: string): Error {
    if (error instanceof Error) {
      return new Error(`${context}: ${error.message}`);
    }
    return new Error(`${context}: Unknown error occurred`);
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }
    return String(error);
  }

  private convertInputToACPMessage(
    response: string | RemoteMessagePart[],
  ): ACPRunCreateRequest["input"][0] {
    if (typeof response === "string") {
      return {
        parts: [
          {
            content_type: "text/plain",
            content: response,
            content_encoding: "plain",
          },
        ],
        role: "user",
      };
    }

    // Convert RemoteMessagePart[] to ACP message
    return {
      parts: response.map((part) => ({
        content_type: part.content_type,
        content: typeof part.content === "string" ? part.content : JSON.stringify(part.content),
        content_encoding: "plain" as const,
      })),
      role: "user",
    };
  }

  private extractSessionId(run: ACPRun): string | undefined {
    return run.session_id;
  }

  private extractAgentVersion(_run: ACPRun): string | undefined {
    // ACPRun doesn't have metadata.agent_version in the schema
    return undefined;
  }
}
