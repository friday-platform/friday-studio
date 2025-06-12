/**
 * Remote Agent implementation for Atlas
 * Integrates external agents via standardized protocols (ACP, A2A, custom)
 */

import type { AtlasMemoryConfig } from "../../memory-config.ts";
import type { RemoteAgentConfig } from "../../session-supervisor.ts";
import { BaseAgent } from "../base-agent.ts";
import { RemoteAdapterFactory } from "./adapter-factory.ts";
import { BaseRemoteAdapter } from "./adapters/base-remote-adapter.ts";
import type {
  HealthStatus,
  RemoteAgentInfo,
  RemoteExecutionRequest,
  RemoteExecutionResult,
  RemoteMessagePart,
} from "./types.ts";
import { RemoteAgentError, RemoteConnectionError } from "./types.ts";

/**
 * Remote agent metadata for Atlas integration
 */
export interface RemoteAgentMetadata {
  id: string;
  type: "remote";
  config: RemoteAgentConfig;
  memoryConfig?: AtlasMemoryConfig;
}

/**
 * Remote Agent class that extends BaseAgent
 * Provides Atlas-native interface for external agents
 */
export class RemoteAgent extends BaseAgent {
  private adapter!: BaseRemoteAdapter; // Will be initialized in initialize()
  private config: RemoteAgentConfig;
  private agentInfo: RemoteAgentInfo | null = null;
  private isInitialized = false;

  constructor(metadata: RemoteAgentMetadata) {
    super(metadata.memoryConfig, metadata.id);
    this.config = metadata.config;

    // Validate configuration
    RemoteAdapterFactory.validateConfig(this.config);

    this.log("Remote agent created", {
      protocol: this.config.protocol,
      endpoint: this.config.endpoint,
    });
  }

  // BaseAgent abstract methods implementation
  name(): string {
    return this.agentInfo?.name || this.config.acp?.agent_name || `remote-${this.id.slice(0, 8)}`;
  }

  nickname(): string {
    return `${this.name()}-remote`;
  }

  version(): string {
    return this.agentInfo?.version || "unknown";
  }

  provider(): string {
    return `remote-${this.config.protocol}`;
  }

  purpose(): string {
    return this.config.purpose || this.agentInfo?.description || "Remote agent execution";
  }

  controls(): object {
    return {
      protocol: this.config.protocol,
      endpoint: this.config.endpoint,
      supported_modes: this.agentInfo?.supported_modes || ["sync"],
      capabilities: this.agentInfo?.capabilities || [],
    };
  }

  /**
   * Initialize the remote agent adapter and verify connection
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      this.log("Initializing remote agent adapter");

      // Create protocol-specific adapter
      this.adapter = await RemoteAdapterFactory.createAdapter(
        this.config.protocol,
        this.config,
      );

      // Verify connection and get agent info
      await this.verifyConnection();

      this.isInitialized = true;
      this.log("Remote agent initialized successfully", {
        agent_name: this.name(),
        version: this.version(),
        capabilities: this.agentInfo?.capabilities?.length || 0,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log("Failed to initialize remote agent", { error: errorMessage });
      throw new RemoteConnectionError(`Failed to initialize remote agent: ${errorMessage}`);
    }
  }

  /**
   * Verify connection to remote agent and cache agent info
   */
  async verifyConnection(): Promise<void> {
    if (!this.adapter) {
      throw new Error("Adapter not initialized");
    }

    try {
      // Health check
      const health = await this.adapter.healthCheck();
      if (health.status === "unhealthy") {
        throw new Error(`Remote agent unhealthy: ${health.error}`);
      }

      // Get agent details if agent name is specified
      const agentName = this.getAgentName();
      if (agentName) {
        this.agentInfo = await this.adapter.getAgentDetails(agentName);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new RemoteConnectionError(`Connection verification failed: ${errorMessage}`);
    }
  }

  /**
   * Standard invoke implementation for remote agents
   */
  override async invoke(message: string): Promise<string> {
    await this.ensureInitialized();

    try {
      const request = this.buildExecutionRequest(message, "sync");
      const result = await this.adapter.executeAgent(request);

      if (result.status === "failed") {
        throw new RemoteAgentError(
          result.error || "Remote execution failed",
          "EXECUTION_FAILED",
        );
      }

      const response = this.extractTextFromResult(result);

      // Remember this interaction
      this.rememberTask(
        `remote_invoke_${performance.now()}`,
        {
          type: "remote_invoke",
          message: message.substring(0, 200),
          mode: "sync",
          duration: result.metadata.execution_time_ms,
        },
        {
          response: response.substring(0, 500),
          status: result.status,
          tokens_used: result.metadata.tokens_used,
        },
        result.status === "completed",
      );

      return response;
    } catch (error) {
      this.handleInvokeError(error, message);
      throw error;
    }
  }

  /**
   * Streaming invoke implementation for remote agents
   */
  override async *invokeStream(message: string): AsyncIterableIterator<string> {
    await this.ensureInitialized();

    try {
      const request = this.buildExecutionRequest(message, "stream");
      let fullResponse = "";
      const startTime = performance.now();

      for await (const event of this.adapter.executeAgentStream(request)) {
        if (event.type === "content" && event.content) {
          fullResponse += event.content;
          yield event.content;
        } else if (event.type === "completion") {
          if (event.status === "failed") {
            throw new RemoteAgentError(
              event.error || "Remote streaming failed",
              "STREAMING_FAILED",
            );
          }
          break;
        } else if (event.type === "error") {
          throw new RemoteAgentError(
            event.error || "Remote streaming error",
            "STREAMING_ERROR",
          );
        }
      }

      // Remember this streaming interaction
      const duration = performance.now() - startTime;
      this.rememberTask(
        `remote_stream_${performance.now()}`,
        {
          type: "remote_stream",
          message: message.substring(0, 200),
          mode: "stream",
          duration,
        },
        {
          response: fullResponse.substring(0, 500),
          response_length: fullResponse.length,
        },
        true,
      );
    } catch (error) {
      this.handleInvokeError(error, message);
      throw error;
    }
  }

  /**
   * Get health status of remote agent
   */
  async getHealthStatus(): Promise<HealthStatus> {
    if (!this.adapter) {
      return {
        status: "unhealthy",
        error: "Adapter not initialized",
      };
    }

    try {
      return await this.adapter.healthCheck();
    } catch (error) {
      return {
        status: "unhealthy",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get remote agent information
   */
  getAgentInfo(): RemoteAgentInfo | null {
    return this.agentInfo;
  }

  /**
   * Get adapter metrics
   */
  getMetrics() {
    return this.adapter?.getMetrics() || null;
  }

  /**
   * Get circuit breaker state
   */
  getCircuitBreakerState() {
    return this.adapter?.getCircuitBreakerState() || null;
  }

  /**
   * Dispose of remote agent resources
   */
  dispose(): void {
    if (this.adapter) {
      this.adapter.dispose();
    }
    this.log("Remote agent disposed");
  }

  // Private helper methods

  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }

  private getAgentName(): string {
    return this.config.acp?.agent_name ||
      this.config.a2a?.agent_name ||
      this.config.custom?.agent_name ||
      "";
  }

  private buildExecutionRequest(
    message: string,
    mode: "sync" | "async" | "stream",
  ): RemoteExecutionRequest {
    const agentName = this.getAgentName();

    // Convert message to appropriate format
    const input: RemoteMessagePart[] = [{
      content_type: "text/plain",
      content: message,
    }];

    return {
      agentName,
      input,
      mode,
      sessionId: this.id,
      timeout: this.config.timeout,
      context: {
        agent_id: this.id,
        agent_purpose: this.purpose(),
        timestamp: new Date().toISOString(),
      },
    };
  }

  private extractTextFromResult(result: RemoteExecutionResult): string {
    if (!result.output || result.output.length === 0) {
      return "";
    }

    // Extract text content from message parts
    return result.output
      .filter((part) => part.content_type === "text/plain")
      .map((part) => String(part.content))
      .join("\n");
  }

  private handleInvokeError(error: unknown, message: string): void {
    const errorMessage = error instanceof Error ? error.message : String(error);

    this.log("Remote agent invoke error", {
      error: errorMessage,
      message: message.substring(0, 100),
    });

    // Remember the error for learning
    this.rememberTask(
      `remote_error_${performance.now()}`,
      {
        type: "remote_error",
        message: message.substring(0, 200),
        error_type: error instanceof Error ? error.constructor.name : "UnknownError",
      },
      {
        error: errorMessage,
      },
      false,
    );
  }

  protected override getDefaultModel(): string {
    // Remote agents don't use models in the traditional sense
    // Return agent name or protocol as identifier
    return this.name() || this.config.protocol;
  }
}
