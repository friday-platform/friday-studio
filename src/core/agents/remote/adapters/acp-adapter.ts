/**
 * ACP (Agent Communication Protocol) Adapter
 * Implementation using the official acp-sdk for reliable protocol compliance
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
import { ACPError, Agent, Client, Event, HTTPError, Run } from "acp-sdk";

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
 * Full implementation using official acp-sdk for type safety and reliability
 */
export class ACPAdapter extends BaseRemoteAdapter {
  protected override config: ACPAdapterConfig;
  private client: Client;

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
    this.client = new Client({
      baseUrl: config.endpoint,
      fetch: super.createAuthenticatedFetch(),
    });

    this.logger.info("ACP adapter initialized", {
      endpoint: config.endpoint,
      agent_name: config.acp.agent_name,
      default_mode: config.acp.default_mode,
    });
  }

  getProtocolName(): string {
    return "acp";
  }

  async discoverAgents(): Promise<RemoteAgentInfo[]> {
    try {
      this.logger.debug("Discovering ACP agents", { endpoint: this.config.endpoint });
      const startTime = performance.now();

      const agents = await this.client.agents();

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

      const agent = await this.client.agent(agentName);

      const duration = performance.now() - startTime;
      this.logger.debug("Retrieved ACP agent details", {
        agent_name: agentName,
        duration_ms: Math.round(duration),
      });

      return this.convertACPAgentToRemoteInfo(agent);
    } catch (error) {
      if (error instanceof ACPError && error.code === "not_found") {
        throw new Error(`Agent '${agentName}' not found`);
      }
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

      let run: Run;

      switch (request.mode) {
        case "sync":
          run = await this.client.runSync(request.agentName, this.convertInput(request.input));
          break;
        case "async":
          run = await this.client.runAsync(request.agentName, this.convertInput(request.input));
          // Poll for completion
          run = await this.pollForCompletion(run.run_id);
          break;
        default:
          throw new Error("Use executeAgentStream for streaming mode");
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
          // Note: ACP SDK may not have these metadata fields yet
          // agent_version: run.metadata?.agent_version,
          // tokens_used: run.metadata?.tokens_used,
          // model_used: run.metadata?.model_used,
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

      for await (
        const event of this.client.runStream(request.agentName, this.convertInput(request.input))
      ) {
        yield this.convertACPEvent(event);
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
      await this.client.runCancel(executionId);
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
      await this.client.ping();
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

  // Use base class authentication by setting up connection config properly

  private convertInput(input: string | unknown[]): string {
    if (typeof input === "string") {
      return input;
    }
    // For now, convert array input to string - ACP SDK expects string input
    // TODO: Support structured input when ACP SDK supports it
    return JSON.stringify(input);
  }

  private convertOutput(output: unknown[]): RemoteMessagePart[] {
    // Convert ACP output format to RemoteMessagePart[]
    return output.flatMap((message) => {
      const msg = message as { parts?: unknown[] };
      return (msg.parts || []).map((part) => ({
        content_type: "text/plain",
        content: String(part),
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

  private convertACPAgentToRemoteInfo(agent: Agent): RemoteAgentInfo {
    return {
      name: agent.name,
      description: agent.description || undefined,
      // version: agent.version, // May not exist in ACP SDK yet
      capabilities:
        agent.metadata?.capabilities?.map((cap) =>
          typeof cap === "string" ? cap : cap.name || "unknown"
        ) || [],
      supported_modes: ["sync", "async", "stream"], // ACP supports all modes
      // input_schema: agent.input_schema, // May not exist yet
      // output_schema: agent.output_schema, // May not exist yet
      metadata: agent.metadata,
    };
  }

  private convertACPEvent(event: Event): RemoteExecutionEvent {
    switch (event.type) {
      case "message.part":
        return {
          type: "content",
          content: event.part?.content || "",
          contentType: event.part?.content_type || "text/plain",
        };
      case "run.completed":
        return {
          type: "completion",
          status: "completed",
          output: this.convertOutput(event.run.output || []),
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
          error: event.error?.message || "Unknown error",
        };
      default:
        return {
          type: "metadata",
          metadata: { event },
        };
    }
  }

  private async pollForCompletion(runId: string): Promise<Run> {
    const maxAttempts = 60; // 5 minutes with 5-second intervals
    let attempts = 0;

    this.logger.debug("Starting polling for ACP run completion", {
      run_id: runId,
      max_attempts: maxAttempts,
    });

    while (attempts < maxAttempts) {
      try {
        const run = await this.client.runStatus(runId);

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
    if (error instanceof ACPError) {
      return new Error(`${context}: ${error.message} (code: ${error.code})`);
    }
    if (error instanceof HTTPError) {
      // Check if error has status property
      const statusPart = "status" in error ? ` ${(error as { status: number }).status}` : "";
      return new Error(`${context}: HTTP${statusPart} - ${error.message}`);
    }
    if (error instanceof Error) {
      return new Error(`${context}: ${error.message}`);
    }
    return new Error(`${context}: Unknown error occurred`);
  }

  private formatError(error: unknown): string {
    if (error instanceof ACPError) {
      return `ACPError(${error.code}): ${error.message}`;
    }
    if (error instanceof HTTPError) {
      const statusPart = "status" in error ? `(${(error as { status: number }).status})` : "";
      return `HTTPError${statusPart}: ${error.message}`;
    }
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }
    return String(error);
  }
}
