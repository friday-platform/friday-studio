import process from "node:process";
import type { LogContext, Logger, LogLevel } from "./types.ts";

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
   * Output formatted log message to appropriate console method based on level
   */
  protected outputToConsole(level: LogLevel, output: string): void {
    switch (level) {
      case "error":
      case "fatal":
        console.error(output);
        break;
      case "warn":
        console.warn(output);
        break;
      case "info":
        console.info(output);
        break;
      case "debug":
      case "trace":
        console.debug(output);
        break;
    }
  }

  /**
   * Determine if output should be JSON based on ATLAS_LOG_FORMAT env var and TTY status
   */
  protected shouldUseJsonFormat(): boolean {
    const forceFormat = process.env.ATLAS_LOG_FORMAT;
    return forceFormat === "json" || (forceFormat !== "pretty" && !process.stdout.isTTY);
  }
}
