/**
 * Minimal agent context adapter for eval runs.
 *
 * Creates hermetic, per-test contexts without requiring workspace runtime,
 * daemon, or database. Each `createContext()` call returns an isolated
 * context with its own session ID, stream capture, and log capture.
 */

import type {
  AgentContext,
  AgentSessionData,
  AtlasTools,
  AtlasUIMessageChunk,
  StreamEmitter,
} from "@atlas/agent-sdk";
import type { LogContext, Logger } from "@atlas/logger";

/** Log level matching @atlas/logger's LogLevel. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** Captured log entry for test assertions. */
export interface LogEntry {
  level: LogLevel;
  message: string;
  context?: LogContext;
}

/** Options for `createContext()`. */
export interface CreateContextOptions {
  /** AbortSignal for test-level cancellation. */
  signal?: AbortSignal;
}

/**
 * Override of AgentContext that guarantees streamId is always set.
 * Eval contexts always generate a streamId.
 */
type EvalAgentContext = AgentContext & { session: { streamId: string } };

/** Hermetic test context returned by `createContext()`. */
export interface EvalTestContext {
  context: EvalAgentContext;
  getStreamEvents: () => AtlasUIMessageChunk[];
  getLogs: () => LogEntry[];
}

/** StreamEmitter that captures emitted events for test assertions. */
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

/** Logger that captures all log entries for test assertions. */
class CapturedLogger implements Logger {
  private logs: LogEntry[] = [];

  trace(message: string, context?: LogContext): void {
    this.logs.push({ level: "trace", message, context });
  }

  debug(message: string, context?: LogContext): void {
    this.logs.push({ level: "debug", message, context });
  }

  info(message: string, context?: LogContext): void {
    this.logs.push({ level: "info", message, context });
  }

  warn(message: string, context?: LogContext): void {
    this.logs.push({ level: "warn", message, context });
  }

  error(message: string, context?: LogContext): void {
    this.logs.push({ level: "error", message, context });
  }

  fatal(message: string, context?: LogContext): void {
    this.logs.push({ level: "fatal", message, context });
  }

  child(_context: LogContext): Logger {
    return this;
  }

  get capturedLogs(): LogEntry[] {
    return structuredClone(this.logs);
  }
}

/**
 * Creates minimal agent execution contexts for eval runs.
 *
 * Does not depend on workspace runtime, daemon, or database.
 * Each `createContext()` call returns a fresh, isolated context.
 *
 * @param tools - AtlasTools to make available in the context
 * @param env - Environment variables (e.g., API keys)
 */
export class AgentContextAdapter {
  constructor(
    private tools: AtlasTools = {},
    private env: Record<string, string> = {},
  ) {}

  /**
   * Creates a fresh, hermetic agent context for a single eval run.
   *
   * @param options - Optional configuration (e.g., AbortSignal)
   * @returns Isolated test context with capture accessors
   */
  createContext(options?: CreateContextOptions): EvalTestContext {
    const sessionId = crypto.randomUUID();
    const session: AgentSessionData = {
      sessionId,
      workspaceId: "eval-workspace",
      userId: "eval-user",
    };

    const streamEmitter = new CapturedStreamEmitter();
    const logger = new CapturedLogger();

    const evalContext: EvalAgentContext = {
      tools: this.tools,
      env: this.env,
      session: { ...session, streamId: `stream-${sessionId}` },
      stream: streamEmitter,
      logger,
      abortSignal: options?.signal,
    };

    return {
      context: evalContext,
      getStreamEvents: () => streamEmitter.capturedEvents,
      getLogs: () => logger.capturedLogs,
    };
  }
}
