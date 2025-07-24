import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { getAtlasLogsDir } from "./paths.ts";

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  pid: number;
  context?: LogContext;
  traceId?: string;
  spanId?: string;
}

export interface LogContext {
  workspaceId?: string;
  sessionId?: string;
  agentId?: string;
  workerId?: string;
  workerType?: string;
  supervisorId?: string;
  agentName?: string;
  [key: string]: unknown;
}

export class AtlasLogger {
  private static instance: AtlasLogger;
  private logDir: string;
  private globalLogPath: string;
  private fileWriter?: Deno.FsFile;
  private workspaceWriters: Map<string, Deno.FsFile> = new Map();
  private workspaceIdToRegistryId: Map<string, string> = new Map();
  private initPromise?: Promise<void>;
  private isInitialized = false;
  private isDetached = false;
  private detachedFileHandle?: Deno.FsFile;
  private pendingOperations: Set<Promise<void>> = new Set();
  private isClosing = false;
  private resourceTracker: Map<string, { openedAt: number; path: string }> = new Map();
  private lastCleanup = Date.now();
  private readonly CLEANUP_INTERVAL = 60000; // 1 minute
  private readonly MAX_WORKSPACE_AGE = 300000; // 5 minutes

  private constructor() {
    // Paths will be set during initialization
    this.logDir = "";
    this.globalLogPath = "";
  }

  static getInstance(): AtlasLogger {
    if (!AtlasLogger.instance) {
      AtlasLogger.instance = new AtlasLogger();
    }
    return AtlasLogger.instance;
  }

  /**
   * Reset the singleton instance - used for testing
   */
  static async resetInstance(): Promise<void> {
    if (AtlasLogger.instance) {
      await AtlasLogger.instance.close();
      // Reset the instance to undefined to force a new instance creation
      // @ts-ignore: Intentionally setting to undefined for test cleanup
      AtlasLogger.instance = undefined;
    }
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Skip file initialization during tests
    if (Deno.env.get("DENO_TESTING") === "true") {
      this.isInitialized = true;
      return;
    }

    // If initialization is already in progress, wait for it
    if (this.initPromise) return this.initPromise;

    // Start initialization
    this.initPromise = (async () => {
      try {
        // Set up paths using centralized path utility
        this.logDir = getAtlasLogsDir();
        this.globalLogPath = join(this.logDir, "global.log");

        // Ensure log directories exist
        await ensureDir(this.logDir);
        await ensureDir(join(this.logDir, "workspaces"));

        // Open global log file with proper error handling
        let fileHandle: Deno.FsFile | undefined;
        try {
          fileHandle = await Deno.open(this.globalLogPath, {
            create: true,
            write: true,
            append: true,
          });
          this.fileWriter = fileHandle;
          this.trackResource("global", fileHandle, this.globalLogPath);

          // Write initialization message
          await this.writeLog("global", {
            level: "info",
            message: "Atlas logging initialized",
            timestamp: new Date().toISOString(),
            pid: Deno.pid,
          });

          this.isInitialized = true;
        } catch (error) {
          // If we opened the file but failed to write, close it
          if (fileHandle) {
            try {
              fileHandle.close();
            } catch {
              // Ignore close errors
            }
            this.fileWriter = undefined;
          }
          throw error;
        }
      } catch (error) {
        // Reset state on initialization failure
        this.isInitialized = false;
        this.initPromise = undefined;
        throw error;
      }
    })();

    await this.initPromise;
  }

  /**
   * Initialize logger for detached mode
   * In detached mode, all logs go to a specific file and console output is disabled
   */
  async initializeDetached(logFile: string): Promise<void> {
    this.isDetached = true;

    let fileHandle: Deno.FsFile | undefined;
    try {
      // Ensure directory exists
      await ensureDir(join(logFile, ".."));

      // Open the specific log file
      fileHandle = await Deno.open(logFile, {
        create: true,
        write: true,
        append: true,
      });
      this.detachedFileHandle = fileHandle;
      this.trackResource("detached", fileHandle, logFile);

      // Write startup message
      const entry: LogEntry = {
        level: "info",
        message: "Workspace starting in detached mode",
        timestamp: new Date().toISOString(),
        pid: Deno.pid,
        context: {
          workspaceId: Deno.env.get("ATLAS_WORKSPACE_ID"),
          workspaceName: Deno.env.get("ATLAS_WORKSPACE_NAME"),
          mode: "detached",
        },
      };

      const line = JSON.stringify(entry) + "\n";
      await this.detachedFileHandle.write(new TextEncoder().encode(line));

      this.isInitialized = true;
    } catch (error) {
      // Clean up file handle if initialization fails
      if (fileHandle) {
        try {
          fileHandle.close();
        } catch {
          // Ignore close errors
        }
        this.detachedFileHandle = undefined;
      }
      this.isDetached = false;
      throw error;
    }
  }

  private async writeLog(target: string, entry: LogEntry): Promise<void> {
    // Skip file operations during tests
    if (Deno.env.get("DENO_TESTING") === "true") {
      return;
    }

    // Don't start new operations if we're closing
    if (this.isClosing) {
      return;
    }

    // Perform periodic cleanup of old workspace writers
    if (Date.now() - this.lastCleanup > this.CLEANUP_INTERVAL) {
      this.cleanupOldWorkspaceWriters();
    }

    const line = JSON.stringify(entry) + "\n";
    const encoder = new TextEncoder();
    const data = encoder.encode(line);

    try {
      // In detached mode, write to the detached file handle
      if (this.isDetached && this.detachedFileHandle) {
        await this.detachedFileHandle.write(data);
        return;
      }

      if (target === "global" && this.fileWriter) {
        await this.fileWriter.write(data);
      } else if (target.startsWith("workspace:")) {
        const workspaceId = target.split(":")[1];
        if (!workspaceId) {
          throw new Error(`Invalid workspace target: ${target}`);
        }
        // Use registry ID if we have a mapping, otherwise use the workspace ID
        const logId = this.workspaceIdToRegistryId.get(workspaceId) || workspaceId;
        let writer = this.workspaceWriters.get(logId);

        if (!writer) {
          const workspacePath = join(
            this.logDir,
            "workspaces",
            `${logId}.log`,
          );

          let fileHandle: Deno.FsFile | undefined;
          try {
            fileHandle = await Deno.open(workspacePath, {
              create: true,
              write: true,
              append: true,
            });
            writer = fileHandle;
            this.workspaceWriters.set(logId, writer);
            this.trackResource(`workspace:${logId}`, writer, workspacePath);
          } catch (error) {
            // If opening fails, close the handle if it was created
            if (fileHandle) {
              try {
                fileHandle.close();
              } catch {
                // Ignore close errors
              }
            }
            throw error;
          }
        }

        await writer.write(data);
      }
    } catch (error) {
      // Log to console as fallback when file operations fail
      console.error(`Failed to write log to ${target}:`, error);
    }
  }

  private formatMessage(
    level: string,
    message: string,
    context?: LogContext,
  ): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      pid: Deno.pid,
    };

    if (context) {
      entry.context = context;
    }

    // Add OpenTelemetry trace context if available
    const global = globalThis as Record<string, unknown>;
    const traceId = global.otelTraceId;
    const spanId = global.otelSpanId;
    if (typeof traceId === "string") entry.traceId = traceId;
    if (typeof spanId === "string") entry.spanId = spanId;

    return entry;
  }

  private async log(
    level: string,
    message: string,
    context?: LogContext,
  ): Promise<void> {
    // Skip all logging during tests to prevent leaks
    if (Deno.env.get("DENO_TESTING") === "true") {
      return;
    }

    const entry = this.formatMessage(level, message, context);

    // Skip console output in detached mode
    if (!this.isDetached) {
      const prefix = context
        ? `[${context.workerType || "atlas"}${
          context.workerId ? ":" + context.workerId.slice(0, 8) : ""
        }${context.sessionId ? ":" + context.sessionId.slice(0, 8) : ""}${
          context.supervisorId ? ":" + context.supervisorId.slice(0, 8) : ""
        }${context.agentName ? ":" + context.agentName : ""}]`
        : "[atlas]";

      // Check if colors should be disabled
      const shouldDisableColor = Deno.env.get("NO_COLOR") !== undefined ||
        Deno.env.get("ATLAS_NO_COLOR") !== undefined;

      if (shouldDisableColor) {
        // Plain text output without colors
        console.log(`${entry.timestamp} ${level.toUpperCase()} ${prefix} ${message}`);
      } else {
        // Console output with color coding
        const color = {
          error: "\x1b[31m", // red
          warn: "\x1b[33m", // yellow
          info: "\x1b[36m", // cyan
          debug: "\x1b[90m", // gray
          trace: "\x1b[35m", // magenta
        }[level] || "\x1b[0m";

        const reset = "\x1b[0m";
        const contextString = context ? ` ${JSON.stringify(context)}` : "";
        console.log(
          `${color}${entry.timestamp} ${level.toUpperCase()} ${prefix}${reset} ${message}${contextString}`,
        );
      }
    }

    // In detached mode, write directly without normal initialization
    if (this.isDetached) {
      if (this.detachedFileHandle) {
        await this.writeLog("detached", entry);
      }
      return;
    }

    // Normal mode - ensure logger is initialized before file operations
    await this.initialize();

    // File output (now always available after initialization)
    if (this.fileWriter) {
      const target = context?.workspaceId ? `workspace:${context.workspaceId}` : "global";
      const operation = this.writeLog(target, entry);

      // Track this operation to ensure it completes before closing
      this.pendingOperations.add(operation);
      operation.finally(() => {
        this.pendingOperations.delete(operation);
      });

      await operation;
    }
  }

  async error(message: string, context?: LogContext): Promise<void> {
    await this.log("error", message, context);
  }

  async warn(message: string, context?: LogContext): Promise<void> {
    await this.log("warn", message, context);
  }

  async info(message: string, context?: LogContext): Promise<void> {
    await this.log("info", message, context);
  }

  async debug(message: string, context?: LogContext): Promise<void> {
    await this.log("debug", message, context);
  }

  async trace(message: string, context?: LogContext): Promise<void> {
    await this.log("trace", message, context);
  }

  createChildLogger(defaultContext: LogContext): ChildLogger {
    return new ChildLogger(this, defaultContext);
  }

  /**
   * Register a mapping from workspace UUID to registry ID for log file naming
   */
  registerWorkspaceMapping(workspaceId: string, registryId: string): void {
    this.workspaceIdToRegistryId.set(workspaceId, registryId);
  }

  async readLogs(
    target: string = "global",
    lines: number = 100,
  ): Promise<string[]> {
    // Ensure logger is initialized before reading logs
    await this.initialize();

    const logPath = target === "global"
      ? this.globalLogPath
      : join(this.logDir, "workspaces", `${target}.log`);

    try {
      // Use readTextFile which handles file operations internally
      const content = await Deno.readTextFile(logPath);
      const allLines = content.trim().split("\n");
      return allLines.slice(-lines);
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    // Set closing flag to prevent new operations
    this.isClosing = true;

    // Wait for all pending operations to complete
    if (this.pendingOperations.size > 0) {
      await Promise.all(Array.from(this.pendingOperations));
    }

    // Now close all file handles
    if (this.fileWriter) {
      try {
        this.fileWriter.close();
      } catch {
        // Ignore errors if file is already closed
      }
      this.fileWriter = undefined;
      this.untrackResource("global");
    }

    if (this.detachedFileHandle) {
      try {
        this.detachedFileHandle.close();
      } catch {
        // Ignore errors if file is already closed
      }
      this.detachedFileHandle = undefined;
      this.untrackResource("detached");
    }

    for (const [id, writer] of this.workspaceWriters.entries()) {
      try {
        writer.close();
      } catch {
        // Ignore errors if file is already closed
      }
      this.untrackResource(`workspace:${id}`);
    }
    this.workspaceWriters.clear();

    // Reset initialization state
    this.isInitialized = false;
    this.initPromise = undefined;
    this.isDetached = false;
    this.isClosing = false;
    this.pendingOperations.clear();
    this.resourceTracker.clear();
  }

  /**
   * Track a file resource for debugging and cleanup
   */
  private trackResource(id: string, _handle: Deno.FsFile, path: string): void {
    this.resourceTracker.set(id, {
      openedAt: Date.now(),
      path,
    });
  }

  /**
   * Untrack a file resource
   */
  private untrackResource(id: string): void {
    this.resourceTracker.delete(id);
  }

  /**
   * Clean up old workspace writers that haven't been used recently
   */
  private cleanupOldWorkspaceWriters(): void {
    this.lastCleanup = Date.now();
    const now = Date.now();
    const toRemove: string[] = [];

    // Find workspace writers that are older than MAX_WORKSPACE_AGE
    for (const [id, info] of this.resourceTracker.entries()) {
      if (id.startsWith("workspace:") && (now - info.openedAt) > this.MAX_WORKSPACE_AGE) {
        toRemove.push(id.replace("workspace:", ""));
      }
    }

    // Close and remove old workspace writers
    for (const logId of toRemove) {
      const writer = this.workspaceWriters.get(logId);
      if (writer) {
        try {
          writer.close();
        } catch {
          // Ignore close errors
        }
        this.workspaceWriters.delete(logId);
        this.untrackResource(`workspace:${logId}`);
      }
    }
  }

  /**
   * Get current resource usage for debugging
   */
  getResourceUsage(): { id: string; path: string; ageMs: number }[] {
    const now = Date.now();
    return Array.from(this.resourceTracker.entries()).map(([id, info]) => ({
      id,
      path: info.path,
      ageMs: now - info.openedAt,
    }));
  }
}

// Child logger for components with default context
export class ChildLogger {
  constructor(
    private parent: AtlasLogger,
    private defaultContext: LogContext,
  ) {}

  async error(message: string, additionalContext?: LogContext): Promise<void> {
    await this.parent.error(message, {
      ...this.defaultContext,
      ...additionalContext,
    });
  }

  async warn(message: string, additionalContext?: LogContext): Promise<void> {
    await this.parent.warn(message, {
      ...this.defaultContext,
      ...additionalContext,
    });
  }

  async info(message: string, additionalContext?: LogContext): Promise<void> {
    await this.parent.info(message, {
      ...this.defaultContext,
      ...additionalContext,
    });
  }

  async debug(message: string, additionalContext?: LogContext): Promise<void> {
    await this.parent.debug(message, {
      ...this.defaultContext,
      ...additionalContext,
    });
  }

  async trace(message: string, additionalContext?: LogContext): Promise<void> {
    await this.parent.trace(message, {
      ...this.defaultContext,
      ...additionalContext,
    });
  }
}

// Global logger instance - lazy initialization on first use
export const logger = AtlasLogger.getInstance();
