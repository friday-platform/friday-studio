import type {
  AgentContext,
  AgentSessionData,
  AtlasTools,
  AtlasUIMessageChunk,
  StreamEmitter,
} from "@atlas/agent-sdk";
import { AgentTelemetryCollector, type CollectedMetrics } from "./agent-telemetry-collector.ts";

/**
 * StreamEmitter implementation that captures emitted events for testing
 */
class CapturedStreamEmitter implements StreamEmitter<AtlasUIMessageChunk> {
  private events: AtlasUIMessageChunk[] = [];

  emit(event: AtlasUIMessageChunk): void {
    this.events.push(event);
  }

  end(): void {}

  error(_error: Error): void {}

  getEvents(): AtlasUIMessageChunk[] {
    return structuredClone(this.events); // Return copy to prevent mutation
  }
}

/**
 * Temporary until the entire repo is in Bun.
 */
const testLogger = {
  trace(message: string, context: Record<string, unknown>): void {
    console.log(message, JSON.stringify(context, null, 2));
  },
  debug(message: string, context: Record<string, unknown>): void {
    console.log(message, JSON.stringify(context, null, 2));
  },
  info(message: string, context: Record<string, unknown>): void {
    console.log(message, JSON.stringify(context, null, 2));
  },
  warn(message: string, context: Record<string, unknown>): void {
    console.log(message, JSON.stringify(context, null, 2));
  },
  error(message: string, context: Record<string, unknown>): void {
    console.log(message, JSON.stringify(context, null, 2));
  },
  fatal(message: string, context: Record<string, unknown>): void {
    console.log(message, JSON.stringify(context, null, 2));
  },
  child() {
    return testLogger;
  },
};

/**
 * Minimal context adapter for testing agents without full Atlas infrastructure
 */
export class AgentContextAdapter {
  private telemetryCollector: AgentTelemetryCollector | null = null;
  private streamEmitter: CapturedStreamEmitter | null = null;

  constructor(
    private tools: AtlasTools = {},
    private env: Record<string, string> = {},
    private memories?: string[],
  ) {}

  createContext(options?: { telemetry?: boolean }): AgentContext {
    const testSessionId = crypto.randomUUID();
    const session: AgentSessionData = {
      sessionId: testSessionId,
      workspaceId: "eval-workspace",
      userId: "eval-user",
      streamId: `stream-${testSessionId}`,
    };

    // Create capturing stream emitter
    this.streamEmitter = new CapturedStreamEmitter();

    const context: AgentContext = {
      tools: this.tools,
      env: this.env,
      session,
      stream: this.streamEmitter,
      logger: testLogger,
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

  enrichPrompt(prompt: string): string {
    if (!this.memories || this.memories.length === 0) return prompt;
    return `${this.memories.join("\n")}\n\n${prompt}`;
  }

  /**
   * Enable telemetry collection for this context
   */
  enableTelemetry(): AgentTelemetryCollector {
    this.telemetryCollector = new AgentTelemetryCollector();
    return this.telemetryCollector;
  }

  /**
   * Get telemetry metrics after execution
   */
  getMetrics(): CollectedMetrics | null {
    return this.telemetryCollector?.getMetrics() || null;
  }

  /**
   * Get all stream events emitted during execution
   */
  getStreamEvents(): AtlasUIMessageChunk[] {
    return this.streamEmitter?.getEvents() || [];
  }

  /**
   * Reset telemetry and stream data between test executions
   */
  reset(): void {
    this.telemetryCollector?.reset();
    this.streamEmitter = null;
  }
}
