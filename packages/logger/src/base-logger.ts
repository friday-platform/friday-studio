import process from "node:process";
import type { LogContext, Logger, LogLevel } from "./types.ts";

/** Ordered from most verbose to least verbose */
const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

/** Max byte size for a single console output line (32KB — well under the 64KB Linux pipe buffer) */
const MAX_CONSOLE_BYTES = 32_768;

/**
 * Resolve the minimum log level from ATLAS_LOG_LEVEL env var.
 * Cached after first access — avoids re-parsing on every log call
 * while allowing the env var to be set after module load (e.g. tests).
 * Defaults to "debug" to preserve current behavior for local dev.
 */
let cachedMinLogLevel: number | undefined;

function getMinLogLevel(): number {
  if (cachedMinLogLevel !== undefined) {
    return cachedMinLogLevel;
  }
  const raw = process.env.ATLAS_LOG_LEVEL;
  if (raw && raw in LOG_LEVEL_ORDER) {
    cachedMinLogLevel = LOG_LEVEL_ORDER[raw as LogLevel];
  } else {
    cachedMinLogLevel = LOG_LEVEL_ORDER.debug;
  }
  return cachedMinLogLevel;
}

/**
 * Reset the cached log level so the next call re-reads ATLAS_LOG_LEVEL.
 * Exported for tests only — production code should never call this.
 */
export function resetLogLevelCache(): void {
  cachedMinLogLevel = undefined;
}

/**
 * Base logger class with shared implementation for all logger types.
 * Implements common log level methods and console output routing.
 */
export abstract class BaseLogger implements Logger {
  protected baseContext: LogContext;

  constructor(context: LogContext = {}) {
    this.baseContext = context;
  }

  trace(message: string, context?: LogContext): void {
    this.log("trace", message, context);
  }

  debug(message: string, context?: LogContext): void {
    this.log("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log("warn", message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log("error", message, context);
  }

  fatal(message: string, context?: LogContext): void {
    this.log("fatal", message, context);
  }

  abstract child(context: LogContext): Logger;
  protected abstract log(level: LogLevel, message: string, context?: LogContext): void;

  /**
   * Whether the given level meets the minimum configured via ATLAS_LOG_LEVEL.
   * Console output is suppressed for levels below the threshold.
   */
  protected shouldOutputToConsole(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= getMinLogLevel();
  }

  /**
   * Output formatted log message to appropriate console method based on level.
   *
   * Wrapped in try/catch to prevent pipe buffer EAGAIN errors from crashing
   * the process in Docker when stdout backs up.
   * See: https://github.com/denoland/deno/issues/33069
   */
  protected outputToConsole(level: LogLevel, output: string): void {
    const safe =
      output.length > MAX_CONSOLE_BYTES
        ? `${output.slice(0, MAX_CONSOLE_BYTES)}... [truncated, ${output.length} bytes]`
        : output;
    try {
      switch (level) {
        case "error":
        case "fatal":
          console.error(safe);
          break;
        case "warn":
          console.warn(safe);
          break;
        case "info":
          console.info(safe);
          break;
        case "debug":
        case "trace":
          console.debug(safe);
          break;
      }
    } catch (err: unknown) {
      // EAGAIN / WouldBlock — pipe buffer full in Docker; drop the log line
      if (err instanceof Error && err.message.includes("os error 11")) {
        return;
      }
      throw err;
    }
  }
}
