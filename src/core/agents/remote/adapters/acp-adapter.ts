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

      // For streaming, we need to handle Server-Sent Events
      // This is a simplified implementation - in practice, you'd want to use
      // a proper SSE client or implement SSE parsing
      const response = await this.client.POST("/runs", {
        body: runRequest,
        headers: {
          "Accept": "text/event-stream",
        },
      });

      if (response.error) {
        throw new Error(`ACP Error: ${response.error.message}`);
      }

      // Note: For now, fall back to sync execution and yield the final result
      // A full streaming implementation would parse SSE events from the response
      if (response.data) {
        const run = response.data as ACPRun; // Type assertion since we know this is a run response
        yield {
          type: "completion",
          status: this.convertStatus(run.status),
          output: this.convertOutput(run.output),
        };
      }

      this.logger.debug("ACP streaming execution completed", {
        agent_name: request.agentName,
      });
    } catch (error) {
      this.logger.error("ACP streaming execution failed", {
        agent_name: request.agentName,
        error: this.formatError(error),
      });
      throw this.convertACPError(
        error,
        `Streaming execution failed for agent '${request.agentName}'`,
      );
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
}
