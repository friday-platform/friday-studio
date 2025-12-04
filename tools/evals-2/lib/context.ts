import type {
  AgentContext,
  AgentSessionData,
  AtlasTools,
  AtlasUIMessageChunk,
  StreamEmitter,
} from "@atlas/agent-sdk";

export interface LogEntry {
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  message: string;
  context: Record<string, unknown>;
}

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

  get capturedEvents(): AtlasUIMessageChunk[] {
    return structuredClone(this.events);
  }
}

/**
 * Logger that captures all log entries for testing
 */
class CapturedLogger {
  private logs: LogEntry[] = [];

  trace(message: string, context: Record<string, unknown>): void {
    this.logs.push({ level: "trace", message, context });
    console.log(message, JSON.stringify(context, null, 2));
  }

  debug(message: string, context: Record<string, unknown>): void {
    this.logs.push({ level: "debug", message, context });
    console.log(message, JSON.stringify(context, null, 2));
  }

  info(message: string, context: Record<string, unknown>): void {
    this.logs.push({ level: "info", message, context });
    console.log(message, JSON.stringify(context, null, 2));
  }

  warn(message: string, context: Record<string, unknown>): void {
    this.logs.push({ level: "warn", message, context });
    console.log(message, JSON.stringify(context, null, 2));
  }

  error(message: string, context: Record<string, unknown>): void {
    this.logs.push({ level: "error", message, context });
    console.log(message, JSON.stringify(context, null, 2));
  }

  fatal(message: string, context: Record<string, unknown>): void {
    this.logs.push({ level: "fatal", message, context });
    console.log(message, JSON.stringify(context, null, 2));
  }

  child() {
    return this;
  }

  get capturedLogs(): LogEntry[] {
    return structuredClone(this.logs);
  }
}

/**
 * We're overriding StreamID here because it will always be provided in the test harness.
 */
type EvalAgentContext = AgentContext & { session: { streamId: string } };

/**
 * Hermetic test context returned by createContext - captures are scoped to this instance
 */
export interface EvalTestContext {
  context: EvalAgentContext;
  getStreamEvents: () => AtlasUIMessageChunk[];
  getLogs: () => LogEntry[];
}

/**
 * Minimal context adapter for testing agents without full Atlas infrastructure
 */
export class AgentContextAdapter {
  constructor(
    private tools: AtlasTools = {},
    private env: Record<string, string> = {},
  ) {}

  createContext(): EvalTestContext {
    const testSessionId = crypto.randomUUID();
    const session: AgentSessionData = {
      sessionId: testSessionId,
      workspaceId: "eval-workspace",
      userId: "eval-user",
    };

    const streamEmitter = new CapturedStreamEmitter();
    const logger = new CapturedLogger();

    const context: AgentContext = {
      tools: this.tools,
      env: this.env,
      session,
      stream: streamEmitter,
      logger,
    };

    // Manually appending the Stream ID is required here. See EvalAgentContext.
    const evalContext: EvalAgentContext = {
      ...context,
      session: { ...session, streamId: `stream-${testSessionId}` },
    };

    return {
      context: evalContext,
      getStreamEvents: () => streamEmitter.capturedEvents,
      getLogs: () => logger.capturedLogs,
    };
  }
}
