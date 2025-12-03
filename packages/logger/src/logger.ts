import fs from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import {
  captureException,
  captureMessage,
  isInitialized as isSentryInitialized,
} from "@atlas/sentry";
import { DetailedError } from "hono/client";
import { FileWriteCoordinator } from "../../storage/src/memory/file-write-coordinator.ts";
import { BaseLogger } from "./base-logger.ts";
import { getAtlasLogsDir } from "./paths.ts";
import type { LogContext, LogEntry, Logger, LogLevel } from "./types.ts";

/**
 * Atlas logger that writes JSON to disk files and human-readable output to console
 */
class AtlasLoggerV2 extends BaseLogger {
  child(context: LogContext): Logger {
    return new AtlasLoggerV2({ ...this.baseContext, ...context });
  }

  protected async log(level: LogLevel, message: string, context?: LogContext): Promise<void> {
    if (process.env.DENO_TESTING === "true") {
      return;
    }

    const finalContext = { ...this.baseContext, ...context };

    // Create log entry once for potential reuse
    const entry = this.formatLogEntry(level, message, finalContext);

    const consoleOutput = this.shouldUseJsonFormat()
      ? JSON.stringify(entry)
      : this.formatConsoleOutput(level, message, finalContext);

    this.outputToConsole(level, consoleOutput);

    // Write to file (ignore failures)
    try {
      const jsonLine = JSON.stringify(entry);
      await this.writeToFile(jsonLine, finalContext.workspaceId);
    } catch {
      // Continue if file writing fails
    }

    // Send errors to Sentry
    if ((level === "error" || level === "fatal") && isSentryInitialized()) {
      try {
        const error = finalContext.error;
        if (error instanceof Error) {
          captureException(error, finalContext);
        } else {
          captureMessage(message, level, finalContext);
        }
      } catch {
        // Ignore Sentry failures
      }
    }
  }

  private formatLogEntry(level: LogLevel, message: string, context: LogContext): LogEntry {
    // Process context to serialize Error objects
    const processedContext = { ...context };
    let stackTrace: string | undefined;

    if (processedContext.error !== undefined) {
      // Extract stack trace for Cloud Error Reporting (needs top-level stack_trace field)
      if (processedContext.error instanceof Error && processedContext.error.stack) {
        stackTrace = processedContext.error.stack;
      }
      processedContext.error = this.serializeError(processedContext.error);
    }

    // Add stack_trace at root level for Google Cloud Error Reporting auto-detection
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: processedContext,
      stack_trace: stackTrace,
    };

    return entry;
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
    if (process.env.FORCE_COLOR) {
      return true;
    }

    // Don't colorize if NO_COLOR environment variable is set
    if (process.env.NO_COLOR) {
      return false;
    }

    // Don't colorize if DENO_TESTING is true
    if (process.env.DENO_TESTING === "true") {
      return false;
    }

    // Check if we're in a TTY
    return process.stdout.isTTY ?? false;
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

    await fs.promises.mkdir(dirname(logPath), { recursive: true });

    // Use FileWriteCoordinator to prevent concurrent file access and FD leaks
    const coordinator = FileWriteCoordinator.getInstance();
    await coordinator.executeWrite(logPath, async () => {
      await fs.promises.appendFile(logPath, `${jsonLine}\n`);
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
