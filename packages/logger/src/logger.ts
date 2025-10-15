import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { DetailedError } from "hono/client";
import { getAtlasLogsDir } from "./paths.ts";
import type { LogContext, LogEntry, Logger, LogLevel } from "./types.ts";
import { FileWriteCoordinator } from "../../storage/src/memory/file-write-coordinator.ts";

/**
 * Atlas logger that writes JSON to disk files and human-readable output to console
 */
class AtlasLoggerV2 implements Logger {
  private baseContext: LogContext;

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

  child(context: LogContext): Logger {
    return new AtlasLoggerV2({ ...this.baseContext, ...context });
  }

  private async log(level: LogLevel, message: string, context?: LogContext): Promise<void> {
    if (Deno.env.get("DENO_TESTING") === "true") {
      return;
    }

    const finalContext = { ...this.baseContext, ...context };

    // Create log entry once for potential reuse
    const entry = this.formatLogEntry(level, message, finalContext);

    // Determine output format based on TTY status and environment variable
    // ATLAS_LOG_FORMAT can be "json" (force JSON) or "pretty" (force human-readable)
    const forceFormat = Deno.env.get("ATLAS_LOG_FORMAT");
    const isJson =
      forceFormat === "json" || (forceFormat !== "pretty" && !Deno.stdout.isTerminal());

    const consoleOutput = isJson
      ? JSON.stringify(entry)
      : this.formatConsoleOutput(level, message, finalContext);

    switch (level) {
      case "error":
      case "fatal":
        console.error(consoleOutput);
        break;
      case "warn":
        console.warn(consoleOutput);
        break;
      case "info":
        console.info(consoleOutput);
        break;
      case "debug":
      case "trace":
        console.debug(consoleOutput);
        break;
    }

    // Write to file (ignore failures)
    try {
      const jsonLine = JSON.stringify(entry);
      await this.writeToFile(jsonLine, finalContext.workspaceId);
    } catch {
      // Continue if file writing fails
    }
  }

  private formatLogEntry(level: LogLevel, message: string, context: LogContext): LogEntry {
    // Process context to serialize Error objects
    const processedContext = { ...context };
    if (processedContext.error !== undefined) {
      processedContext.error = this.serializeError(processedContext.error);
    }

    return { timestamp: new Date().toISOString(), level, message, context: processedContext };
  }

  private serializeError(error: unknown): unknown {
    if (error instanceof Error) {
      const serialized: Record<string, unknown> = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };

      // Handle Error.cause recursively (ES2022 feature)
      const cause = error.cause;
      if (cause !== undefined) {
        serialized.cause = this.serializeError(cause);
      }

      // Handle Hono DetailedError properties explicitly
      if (error.name === "DetailedError" && error instanceof DetailedError) {
        if (error.detail !== undefined) {
          serialized.detail = error.detail;
        }
        if (error.code !== undefined) {
          serialized.code = error.code;
        }
        if (error.log !== undefined) {
          serialized.log = error.log;
        }
        if (error.statusCode !== undefined) {
          serialized.statusCode = error.statusCode;
        }
      }

      // Capture additional enumerable properties (like 'code' for system errors)
      for (const key of Object.getOwnPropertyNames(error)) {
        if (
          !["name", "message", "stack", "cause", "detail", "code", "log", "statusCode"].includes(
            key,
          )
        ) {
          try {
            const descriptor = Object.getOwnPropertyDescriptor(error, key);
            if (descriptor?.value !== undefined) {
              // @ts-expect-error we're accessing any non-canonical error properties.
              serialized[key] = error[key];
            }
          } catch {
            // Skip inaccessible properties
          }
        }
      }

      return serialized;
    }

    return error; // Not an Error, return as-is
  }

  private formatConsoleOutput(level: LogLevel, message: string, context: LogContext): string {
    const now = new Date();
    // Use local timezone for TTY console output
    const timestamp = this.formatLocalTime(now); // HH:MM:SS.mmm in local timezone
    const component = this.getComponentName(context);

    // Process context to serialize Error objects for console output
    const processedContext = { ...context };
    if (processedContext.error !== undefined) {
      processedContext.error = this.serializeError(processedContext.error);
    }

    const contextStr =
      Object.keys(processedContext).length > 0
        ? ` ${JSON.stringify(processedContext, null, 0)}`
        : "";

    // Color coding for console output
    const shouldColorize = this.shouldColorizeOutput();
    if (!shouldColorize) {
      return `[${timestamp}] ${level.toUpperCase()} (${component}): ${message}${contextStr}`;
    }

    const colors = {
      fatal: "\x1b[1;31m", // bold red
      error: "\x1b[31m", // red
      warn: "\x1b[33m", // yellow
      info: "\x1b[36m", // cyan
      debug: "\x1b[90m", // bright black/gray
      trace: "\x1b[35m", // magenta
    } as const;

    const reset = "\x1b[0m";
    const color = colors[level] || "";
    const componentColor = "\x1b[2m"; // dim

    return `${color}[${timestamp}] ${level.toUpperCase()}${reset} ${componentColor}(${component})${reset}: ${message}${contextStr}`;
  }

  private formatLocalTime(date: Date): string {
    // Format as HH:MM:SS.mmm in local timezone for TTY output
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");
    const seconds = date.getSeconds().toString().padStart(2, "0");
    const milliseconds = date.getMilliseconds().toString().padStart(3, "0");
    return `${hours}:${minutes}:${seconds}.${milliseconds}`;
  }

  private shouldColorizeOutput(): boolean {
    // Force colors if FORCE_COLOR is set
    if (Deno.env.get("FORCE_COLOR")) {
      return true;
    }

    // Don't colorize if NO_COLOR environment variable is set
    if (Deno.env.get("NO_COLOR")) {
      return false;
    }

    // Don't colorize if DENO_TESTING is true
    if (Deno.env.get("DENO_TESTING") === "true") {
      return false;
    }

    // Check if we're in a TTY (only available in some Deno versions)
    return Deno.stdout.isTerminal();
  }

  private getComponentName(context: LogContext): string {
    const parts = ["∆"];
    if (context.workspaceId) parts.push(context.workspaceId);
    if (context.agentId) parts.push(context.agentId);
    return parts.join(":");
  }

  private async writeToFile(jsonLine: string, workspaceId?: string): Promise<void> {
    const logPath = workspaceId
      ? join(getAtlasLogsDir(), "workspaces", `${workspaceId}.log`)
      : join(getAtlasLogsDir(), "global.log");

    await ensureDir(dirname(logPath));

    // Use FileWriteCoordinator to prevent concurrent file access and FD leaks
    const coordinator = FileWriteCoordinator.getInstance();
    await coordinator.executeWrite(logPath, async () => {
      await Deno.writeTextFile(logPath, `${jsonLine}\n`, { append: true });
    });
  }
}

/**
 * Creates a new logger with optional default context
 */
export function createLogger(context: LogContext = {}): Logger {
  return new AtlasLoggerV2(context);
}

/**
 * Default logger instance
 */
export const logger = createLogger();

/**
 * Singleton pattern for backward compatibility
 * @deprecated migrate to `logger`.
 *
 * ```ts
 * // OLD
 * import { AtlasLogger } from "../src/utils/logger.ts";
 * const logger = AtlasLogger.getInstance();
 * await logger.info("Message", { context });
 *
 * // NEW
 * import { logger } from "@atlas/logger";
 * logger.info("Message", { context });
 * ```
 */
export const AtlasLogger = {
  getInstance: () => logger,
  resetInstance: () => {}, // no-op
};
