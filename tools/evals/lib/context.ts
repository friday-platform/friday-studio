import type {
  AgentContext,
  AgentMetrics,
  AgentSessionData,
  AtlasTools,
  StreamEmitter,
  TelemetrySpan,
} from "@atlas/agent-sdk";
import { AgentTelemetryCollector } from "@atlas/agent-sdk";

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

    // No-op stream
    const stream: StreamEmitter = { emit: () => {}, end: () => {}, error: () => {} };

    const context: AgentContext = {
      tools: this.tools,
      env: this.env,
      session,
      stream,
      logger: testLogger,
    };

    // Add telemetry if enabled
    if (options?.telemetry && this.telemetryCollector) {
      context.telemetry = {
        isEnabled: true,
        tracer: this.telemetryCollector,
        recordInputs: true,
        recordOutputs: true,
        metadata: { evalMode: true, testContext: true },
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
  getMetrics(): AgentMetrics | null {
    return this.telemetryCollector?.getMetrics() || null;
  }

  /**
   * Get full execution trace
   */
  getTrace(): TelemetrySpan[] | null {
    return this.telemetryCollector?.getExecutionTrace() || null;
  }
}
