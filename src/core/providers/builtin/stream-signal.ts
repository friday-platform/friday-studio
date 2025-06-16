/**
 * Stream Signal Provider for Atlas
 * Enables real-time event streaming from external sources via SSE
 */

import {
  HealthStatus,
  IProviderSignal,
  ISignalProvider,
  ProviderState,
  ProviderStatus,
  ProviderType,
} from "../types.ts";
import {
  createEventSource,
  createRetryableSSEStream,
  EventSourceMessage,
  parseSSEData,
} from "../../agents/remote/adapters/sse-utils.ts";
import { AtlasScope } from "../../scope.ts";

export interface StreamSignalConfig {
  source: string;
  endpoint: string;
  timeout_ms?: number;
  retry_config?: {
    max_retries: number;
    retry_delay_ms: number;
  };
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

  private state: ProviderState = {
    status: ProviderStatus.NOT_CONFIGURED,
  };

  async setup(): Promise<void> {
    this.state.status = ProviderStatus.READY;
  }

  async teardown(): Promise<void> {
    this.state.status = ProviderStatus.DISABLED;
  }

  getState(): ProviderState {
    return this.state;
  }

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
  private eventSource?: ReturnType<typeof createEventSource>;
  private signalProcessor?: (signalId: string, payload: any) => Promise<void>;
  private signalId?: string;
  private abortController?: AbortController;
  private isConnected = false;

  constructor(private providerId: string, private config: StreamSignalConfig) {
    super(`${providerId}-stream-signal`);
  }

  async initialize(
    context: { id: string; processSignal: (signalId: string, payload: any) => Promise<void> },
  ): Promise<void> {
    this.signalId = context.id; // This should be 'k8s-events', not 'stream'
    this.signalProcessor = context.processSignal;
    await this.startEventStream();
  }

  private async startEventStream(): Promise<void> {
    this.abortController = new AbortController();
    const sseEndpoint = `${this.config.endpoint}/events/stream`;

    try {
      const retryConfig = this.config.retry_config || {
        max_retries: 5,
        retry_delay_ms: 1000,
      };

      const stream = createRetryableSSEStream(
        {
          url: sseEndpoint,
          fetch: globalThis.fetch,
          options: {
            headers: { "Accept": "text/event-stream" },
            signal: this.abortController.signal,
          },
        },
        {
          maxRetries: retryConfig.max_retries,
          retryDelayMs: retryConfig.retry_delay_ms,
          timeoutMs: this.config.timeout_ms || 30000,
        },
      );

      this.isConnected = true;
      console.log(`Stream signal connected to ${sseEndpoint}`);

      // Process SSE events from monitor agent
      for await (const message of stream) {
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
        console.error("SSE stream error:", error);
        this.isConnected = false;
        throw error;
      }
    }
  }

  private async processStreamEvent(event: StreamEvent): Promise<void> {
    if (!this.signalProcessor) {
      console.log("No signal processor available for event processing");
      return;
    }

    // Extract event identifier for logging (generic approach)
    const eventId = event.event?.reason || event.type || event.kind || 'unknown';
    const eventSource = event.source || 'unknown';

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

  private shouldProcessEvent(event: StreamEvent): boolean {
    // Default: process all events (workspace configuration can handle filtering)
    // Individual implementations can override this for source-specific filtering
    return true;
  }

  async teardown(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.isConnected = false;
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }
}
