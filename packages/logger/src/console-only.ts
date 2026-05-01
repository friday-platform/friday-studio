import { BaseLogger } from "./base-logger.ts";
import type { LogContext, Logger, LogLevel } from "./types.ts";

/**
 * Lightweight console-only logger for environments where file logging is not needed.
 * Does not depend on storage package - safe for deno compile in standalone contexts.
 *
 * Use this for:
 * - Static file servers
 * - Lightweight utilities
 * - Compiled binaries where file dependencies would bloat the output
 *
 * For full logging with file persistence, use the main logger from @atlas/logger.
 */
class ConsoleOnlyLogger extends BaseLogger {
  child(context: LogContext): Logger {
    return new ConsoleOnlyLogger({ ...this.baseContext, ...context });
  }

  protected log(level: LogLevel, message: string, context?: LogContext): void {
    if (!this.shouldOutputToConsole(level)) {
      return;
    }

    const finalContext = { ...this.baseContext, ...context };
    const entry = { timestamp: new Date().toISOString(), level, message, context: finalContext };
    this.outputToConsole(level, JSON.stringify(entry));
  }
}

export const logger = new ConsoleOnlyLogger();
