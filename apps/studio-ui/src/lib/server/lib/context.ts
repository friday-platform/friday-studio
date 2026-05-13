/**
 * Playground context adapter for hermetic agent execution.
 *
 * Ported from eval framework's AgentContextAdapter (tools/evals/lib/context.ts)
 * with callback-based streaming instead of capture-then-read, so events pipe
 * to SSE in real-time.
 */

import type {
  AgentContext,
  AgentSessionData,
  AtlasTools,
  AtlasUIMessageChunk,
  StreamEmitter,
} from "@atlas/agent-sdk";
import type { PlatformModels } from "@atlas/llm";
import type { LogContext, Logger } from "@atlas/logger";

/** Options for creating a playground agent context. */
export interface PlaygroundContextOpts {
  env?: Record<string, string>;
  tools?: AtlasTools;
  onStream?: (chunk: AtlasUIMessageChunk) => void;
  onLog?: (entry: { level: string; message: string; context?: unknown }) => void;
  abortSignal?: AbortSignal;
  platformModels?: PlatformModels;
}

/**
 * Stub `PlatformModels` used when the playground creates a context without
 * a real resolver. Throws on access so any accidental platform-resolver call
 * surfaces loudly instead of silently returning undefined.
 */
const stubPlatformModels: PlatformModels = {
  get(role) {
    throw new Error(
      `Playground context has no PlatformModels configured — got request for '${role}'. Pass one via PlaygroundContextOpts.platformModels.`,
    );
  },
};

/**
 * StreamEmitter that fires a callback on each emitted chunk.
 * Used for real-time SSE piping during agent execution.
 */
class CallbackStreamEmitter implements StreamEmitter<AtlasUIMessageChunk> {
  constructor(private onStream: (chunk: AtlasUIMessageChunk) => void) {}

  emit(event: AtlasUIMessageChunk): void {
    this.onStream(event);
  }

  end(): void {}

  error(_error: Error): void {}
}

/**
 * Logger that fires a callback for each log entry.
 * Falls back to no-op when no callback is provided.
 */
class CallbackLogger implements Logger {
  constructor(
    private onLog?: (entry: { level: string; message: string; context?: unknown }) => void,
  ) {}

  trace(message: string, context?: LogContext): void {
    this.onLog?.({ level: "trace", message, context });
  }

  debug(message: string, context?: LogContext): void {
    this.onLog?.({ level: "debug", message, context });
  }

  info(message: string, context?: LogContext): void {
    this.onLog?.({ level: "info", message, context });
  }

  warn(message: string, context?: LogContext): void {
    this.onLog?.({ level: "warn", message, context });
  }

  error(message: string, context?: LogContext): void {
    this.onLog?.({ level: "error", message, context });
  }

  fatal(message: string, context?: LogContext): void {
    this.onLog?.({ level: "fatal", message, context });
  }

  child(_context: LogContext): Logger {
    return this;
  }
}

/**
 * Creates hermetic agent execution contexts for the playground.
 *
 * No database, no daemon, no workspace runtime — same isolation
 * guarantees as the eval framework but with real-time event callbacks
 * instead of capture-then-read.
 */
export class PlaygroundContextAdapter {
  /**
   * Creates a fresh, hermetic agent context for a single playground execution.
   *
   * @param opts - Execution options (env, tools, callbacks, abort signal)
   * @returns Object containing the AgentContext ready for agent.execute()
   */
  createContext(opts: PlaygroundContextOpts): { context: AgentContext } {
    const sessionId = crypto.randomUUID();
    const session: AgentSessionData = {
      sessionId,
      workspaceId: "playground",
      userId: "playground-user",
    };

    const stream = opts.onStream ? new CallbackStreamEmitter(opts.onStream) : undefined;
    const logger = new CallbackLogger(opts.onLog);

    const context: AgentContext = {
      tools: opts.tools ?? {},
      env: opts.env ?? {},
      session,
      stream,
      logger,
      abortSignal: opts.abortSignal,
      platformModels: opts.platformModels ?? stubPlatformModels,
    };

    return { context };
  }
}
