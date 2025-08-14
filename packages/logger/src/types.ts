/**
 * Logger interface
 */
export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  fatal(message: string, context?: LogContext): void;

  // Creates new logger with merged context
  child(context: LogContext): Logger;
}

/**
 * Standard OTEL log levels
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Context attached to log entries
 */
export interface LogContext {
  // Atlas identifiers
  workspaceId?: string;
  sessionId?: string;
  agentId?: string;
  workerType?: string;
  agentName?: string;
  supervisorId?: string;
  workerId?: string;

  // for error logging
  error?: unknown;

  // Additional context
  [key: string]: unknown;
}

/**
 * Log entry written to files as JSON
 */
export interface LogEntry {
  timestamp: string; // ISO 8601 format
  level: LogLevel;
  message: string;
  context: LogContext;
}
