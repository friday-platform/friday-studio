/**
 * Minimal agent context adapter for eval runs.
 *
 * Creates hermetic, per-test contexts without requiring workspace runtime,
 * daemon, or database. Each `createContext()` call returns an isolated
 * context with its own session ID, stream capture, and log capture.
 */

import process from "node:process";
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

/** Ordered from most verbose to least verbose — matches base-logger.ts. */
const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

/**
 * Minimum log level for live stderr output during eval runs.
 * Defaults to "info" (eval output is meant for humans watching a run).
 * Respects ATLAS_LOG_LEVEL if set explicitly.
 * Set EVAL_QUIET=1 to silence live stderr output entirely.
 */
function getLiveStderrMinLevel(): number {
  if (process.env.EVAL_QUIET === "1") return Number.POSITIVE_INFINITY;
  const raw = process.env.ATLAS_LOG_LEVEL;
  if (raw && raw in LOG_LEVEL_ORDER) return LOG_LEVEL_ORDER[raw as LogLevel];
  return LOG_LEVEL_ORDER.info;
}

/**
 * Writes a one-line log to stderr for live eval feedback.
 * Never throws — stderr pipe errors are swallowed.
 */
function writeLiveStderr(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // EAGAIN / closed pipe — drop the line, don't crash the eval run.
  }
}

/** Truncates a value for one-line stderr output. */
function shortContext(context: LogContext | undefined): string {
  if (!context) return "";
  try {
    const json = JSON.stringify(context);
    if (json.length <= 200) return ` ${json}`;
    return ` ${json.slice(0, 197)}...`;
  } catch {
    return "";
  }
}

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

/**
 * StreamEmitter that captures emitted events for test assertions AND prints
 * `data-tool-progress` events to stderr for live eval feedback.
 *
 * Progress events are the agent's human-facing "what am I doing right now"
 * signal — printing them keeps the user informed without dumping the full
 * captured stream.
 */
class CapturedStreamEmitter implements StreamEmitter<AtlasUIMessageChunk> {
  private events: AtlasUIMessageChunk[] = [];

  emit(event: AtlasUIMessageChunk): void {
    this.events.push(event);
    // Live feedback: surface tool-progress events on stderr.
    if (event.type === "data-tool-progress" && getLiveStderrMinLevel() <= LOG_LEVEL_ORDER.info) {
      const data = (event as { data?: { toolName?: string; content?: string } }).data;
      const tool = data?.toolName ?? "agent";
      const content = data?.content ?? "";
      writeLiveStderr(`[progress:${tool}] ${content}`);
    }
  }

  end(): void {}

  error(_error: Error): void {}

  get capturedEvents(): AtlasUIMessageChunk[] {
    return structuredClone(this.events);
  }
}

/**
 * Logger that captures all log entries for test assertions AND mirrors them
 * to stderr at info+ for live eval feedback.
 *
 * Silence the live output with `EVAL_QUIET=1` or raise the floor with
 * `ATLAS_LOG_LEVEL=warn`.
 */
class CapturedLogger implements Logger {
  private logs: LogEntry[] = [];

  constructor(private readonly scope: string = "eval") {}

  private record(level: LogLevel, message: string, context?: LogContext): void {
    this.logs.push({ level, message, context });
    if (LOG_LEVEL_ORDER[level] >= getLiveStderrMinLevel()) {
      writeLiveStderr(`[${this.scope}] ${level} ${message}${shortContext(context)}`);
    }
  }

  trace(message: string, context?: LogContext): void {
    this.record("trace", message, context);
  }

  debug(message: string, context?: LogContext): void {
    this.record("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.record("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.record("warn", message, context);
  }

  error(message: string, context?: LogContext): void {
    this.record("error", message, context);
  }

  fatal(message: string, context?: LogContext): void {
    this.record("fatal", message, context);
  }

  child(_context: LogContext): Logger {
    // Share the same captured-log array + stderr mirror — child loggers
    // inherit scope. Context data from `.child()` is intentionally not
    // prepended to the live stderr line to keep output terse.
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
