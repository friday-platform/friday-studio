/**
 * Stream Signal Provider for Atlas
 * Enables real-time event streaming from external sources via SSE
 */

import {
  createRetryableSSEStream,
  parseSSEData,
} from "../../../../src/core/agents/remote/adapters/sse-utils.ts";
import { AtlasScope } from "../../../../src/core/scope.ts";
import {
  type HealthStatus,
  type IProviderSignal,
  type ISignalProvider,
  type ProviderState,
  ProviderStatus,
  ProviderType,
} from "./types.ts";

export interface StreamSignalConfig {
  source: string;
  endpoint: string;
  timeout_ms?: number;
  retry_config?: { max_retries: number; retry_delay_ms: number };
}

export interface StreamEvent {
  source: string;
  timestamp: string;
  [key: string]: any; // Allow any additional fields for flexibility
}

export class StreamSignalProvider implements ISignalProvider {
  readonly type = ProviderType.SIGNAL;
  readonly id = "stream";
  readonly name = "Stream Signal Provider";
  readonly version = "1.0.0";

  private state: ProviderState = { status: ProviderStatus.NOT_CONFIGURED };

  setup(): void {
    this.state.status = ProviderStatus.READY;
  }

  teardown(): void {
    this.state.status = ProviderStatus.DISABLED;
  }

  getState(): ProviderState {
    return this.state;
  }

  // deno-lint-ignore require-await
  async checkHealth(): Promise<HealthStatus> {
    return {
      healthy: this.state.status === ProviderStatus.READY,
      message: `Stream provider is ${this.state.status}`,
      lastCheck: new Date(),
    };
  }

  createSignal(config: StreamSignalConfig): IProviderSignal {
    return new StreamProviderSignal(this.id, config);
  }
}

class StreamProviderSignal implements IProviderSignal {
  readonly id: string;
  readonly providerId: string;
  readonly config: StreamSignalConfig;

  constructor(providerId: string, config: StreamSignalConfig) {
    this.id = `${providerId}-${config.source}`;
    this.providerId = providerId;
    this.config = config;
  }

  validate(): boolean {
    return !!(this.config.source && this.config.endpoint);
  }

  toRuntimeSignal(): StreamRuntimeSignal {
    return new StreamRuntimeSignal(this.providerId, this.config);
  }
}

class StreamRuntimeSignal extends AtlasScope {
  private signalProcessor?: (signalId: string, payload: any) => Promise<void>;
  private signalId?: string;
  private abortController?: AbortController;
  private isConnected = false;

  constructor(
    private providerId: string,
    private config: StreamSignalConfig,
  ) {
    super(`${providerId}-stream-signal`);
  }

  async initialize(context: {
    id: string;
    processSignal: (signalId: string, payload: any) => Promise<void>;
  }): Promise<void> {
    this.signalId = context.id; // Signal ID provided by the workspace configuration
    this.signalProcessor = context.processSignal;
    await this.startEventStream();
  }

  private async startEventStream(): Promise<void> {
    this.abortController = new AbortController();
    const sseEndpoint = `${this.config.endpoint}/events/stream`;

    try {
      const retryConfig = this.config.retry_config || { max_retries: 5, retry_delay_ms: 1000 };

      const stream = createRetryableSSEStream(
        {
          url: sseEndpoint,
          fetch: globalThis.fetch,
          options: {
            headers: { Accept: "text/event-stream" },
            signal: this.abortController.signal,
          },
        },
        {
          maxRetries: retryConfig.max_retries,
          retryDelayMs: retryConfig.retry_delay_ms,
          timeoutMs: this.config.timeout_ms || 30000,
        },
      );

      // Only log success after we successfully start consuming the stream
      let connectionLogged = false;

      // Process SSE events from monitor agent
      for await (const message of stream) {
        // Log success on first successful message
        if (!connectionLogged) {
          this.isConnected = true;
          console.log(`✅ Stream signal '${this.signalId}' connected to ${sseEndpoint}`);
          connectionLogged = true;
        }
        if (message.data && this.signalProcessor) {
          try {
            const data = parseSSEData<any>(message.data);

            // Handle keepalive messages
            if (data.type === "keepalive") {
              console.log(`Stream signal keepalive received from ${data.source || "unknown"}`);
              continue;
            }

            // Process actual stream events
            const event = data as StreamEvent;
            await this.processStreamEvent(event);
          } catch (error) {
            console.error("Failed to parse SSE event:", error);
          }
        }
      }
    } catch (error) {
      if (!this.abortController.signal.aborted) {
        this.isConnected = false;

        // Create user-friendly error message based on error type
        const friendlyMessage = this.createFriendlyErrorMessage(error, sseEndpoint);
        console.error(friendlyMessage);

        // Create a new error with the friendly message but preserve the original error
        const enhancedError = new Error(friendlyMessage);
        enhancedError.cause = error;
        throw enhancedError;
      }
    }
  }

  private createFriendlyErrorMessage(error: unknown, endpoint: string): string {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const url = new URL(endpoint);

    // Connection refused errors
    if (errorMessage.includes("Connection refused") || errorMessage.includes("ECONNREFUSED")) {
      return `❌ Stream signal connection failed: Unable to connect to ${url.host}
   └── The server at ${endpoint} appears to be offline or unreachable
   └── Please verify the server is running and the endpoint is correct`;
    }

    // Network timeout errors
    if (errorMessage.includes("timeout") || errorMessage.includes("ETIMEDOUT")) {
      return `❌ Stream signal connection failed: Connection timeout to ${url.host}
   └── The server at ${endpoint} is not responding within the timeout period
   └── Check your network connection and server status`;
    }

    // DNS resolution errors
    if (errorMessage.includes("ENOTFOUND") || errorMessage.includes("getaddrinfo")) {
      return `❌ Stream signal connection failed: Cannot resolve hostname ${url.host}
   └── DNS lookup failed for ${endpoint}
   └── Verify the hostname is correct and accessible`;
    }

    // HTTP response errors
    if (errorMessage.includes("Non-200 status code")) {
      const statusMatch = errorMessage.match(/\((\d+)\)/);
      const statusCode = statusMatch ? statusMatch[1] : "unknown";
      return `❌ Stream signal connection failed: Server returned HTTP ${statusCode}
   └── The server at ${endpoint} rejected the connection
   └── Check if the endpoint path is correct and the server is configured properly`;
    }

    // Invalid content type
    if (errorMessage.includes("Invalid content type")) {
      return `❌ Stream signal connection failed: Invalid response from ${url.host}
   └── Expected Server-Sent Events stream but got different content type
   └── Verify the endpoint ${endpoint} serves SSE streams`;
    }

    // Generic connection errors
    if (errorMessage.includes("error sending request")) {
      return `❌ Stream signal connection failed: Network error connecting to ${url.host}
   └── Failed to establish connection to ${endpoint}
   └── Check if the server is running and network connectivity is available`;
    }

    // Fallback for unknown errors
    return `❌ Stream signal connection failed: ${errorMessage}
   └── Endpoint: ${endpoint}
   └── Check server status and configuration`;
  }

  private async processStreamEvent(event: StreamEvent): Promise<void> {
    if (!this.signalProcessor) {
      console.log("No signal processor available for event processing");
      return;
    }

    // Extract event identifier for logging (generic approach)
    const eventId = event.event?.reason || event.type || event.kind || "unknown";
    const eventSource = event.source || "unknown";

    console.log(`Processing stream event: ${eventId} from source: ${eventSource}`);

    // Apply configurable filtering (workspace can define filtering in configuration)
    if (!this.shouldProcessEvent(event)) {
      console.log(`Event filtered out by configuration`);
      return;
    }

    console.log(`Event passed filter, triggering signal processing for: ${eventId}`);

    try {
      // Use the same signal processing logic as HTTP signals
      await this.signalProcessor(this.signalId!, {
        source: eventSource,
        event: event,
        timestamp: new Date().toISOString(),
      });
      console.log(`Successfully processed stream event: ${eventId}`);
    } catch (error) {
      console.error(`Failed to process stream event: ${eventId}`, error);
    }
  }

  private shouldProcessEvent(_event: StreamEvent): boolean {
    // Default: process all events (workspace configuration can handle filtering)
    // Individual implementations can override this for source-specific filtering
    return true;
  }

  teardown(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.isConnected = false;
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }
}
