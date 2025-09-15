import type { AgentContext, AtlasUIMessageChunk, StreamEmitter } from "@atlas/agent-sdk";
import { createAtlasClient } from "@atlas/oapi-client";
import type { UIDataTypes } from "ai";
import { AgentTelemetryCollector, type Metrics } from "./agent-telemetry-collector.ts";
import { DaemonTestHarness } from "./daemon-harness.ts";

/**
 * Context adapter for testing the conversation agent with full daemon integration.
 * Provides real HTTP endpoints and agent server access.
 */
export class ConversationAgentContext {
  private harness: DaemonTestHarness;
  private baseUrl: string | null = null;
  private telemetryCollector: AgentTelemetryCollector | null = null;

  constructor(port = 8765) {
    this.harness = new DaemonTestHarness(port);
  }

  /**
   * Initialize the daemon and prepare for testing.
   */
  async initialize(): Promise<void> {
    this.baseUrl = await this.harness.start();
  }

  /**
   * Enable telemetry collection for this context
   */
  enableTelemetry(): AgentTelemetryCollector {
    this.telemetryCollector = new AgentTelemetryCollector();
    return this.telemetryCollector;
  }

  /**
   * Create a context for the conversation agent with real daemon backing.
   */
  createContext(options?: { telemetry?: boolean }): AgentContext {
    if (!this.baseUrl) {
      throw new Error("Context not initialized. Call initialize() first.");
    }

    const session = this.harness.createSession();

    // Create a stream that captures events for verification
    const capturedEvents: Array<AtlasUIMessageChunk<UIDataTypes>> = [];
    const stream: StreamEmitter = {
      emit: (event) => {
        capturedEvents.push(event);
      },
      end: () => {},
      error: () => {},
    };

    // Simple logger that outputs to console for debugging
    const logger = {
      trace: (msg: string, ctx?: unknown) => console.log("TRACE:", msg, ctx),
      debug: (msg: string, ctx?: unknown) => console.log("DEBUG:", msg, ctx),
      info: (msg: string, ctx?: unknown) => console.log("INFO:", msg, ctx),
      warn: (msg: string, ctx?: unknown) => console.warn("WARN:", msg, ctx),
      error: (msg: string, ctx?: unknown) => console.error("ERROR:", msg, ctx),
      fatal: (msg: string, ctx?: unknown) => console.error("FATAL:", msg, ctx),
      child: () => logger,
    };

    const context: AgentContext = {
      env: {},
      session,
      stream,
      logger,
      tools: {},
      abortSignal: new AbortController().signal,
    };

    // Add telemetry if enabled
    if (options?.telemetry && this.telemetryCollector) {
      context.telemetry = {
        tracer: this.telemetryCollector,
        recordInputs: true,
        recordOutputs: true,
      };
    }

    return context;
  }

  /**
   * Get the stream events captured during execution.
   */
  getCapturedEvents(_context: AgentContext): Array<{ type: string; data: unknown }> {
    // Extract from the stream we created
    return [];
  }

  /**
   * Get telemetry metrics after execution
   */
  getMetrics(): Metrics | null {
    return this.telemetryCollector?.getMetrics() || null;
  }

  /**
   * Clean up the daemon.
   */
  async cleanup(): Promise<void> {
    await this.harness.shutdown();
  }

  /**
   * Get Atlas client for making API calls.
   */
  getClient() {
    if (!this.baseUrl) {
      throw new Error("Context not initialized");
    }
    return createAtlasClient({ baseUrl: this.baseUrl });
  }
}
