import { ensureDir } from "@std/fs";
import { join } from "@std/path";

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
  static resetInstance(): void {
    if (AtlasLogger.instance) {
      AtlasLogger.instance.close();
      AtlasLogger.instance = undefined as any;
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
      // Set up paths now that we have permission to access env
      const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") ||
        Deno.cwd();
      this.logDir = join(homeDir, ".atlas", "logs");
      this.globalLogPath = join(this.logDir, "global.log");

      // Ensure log directories exist
      await ensureDir(this.logDir);
      await ensureDir(join(this.logDir, "workspaces"));

      // Open global log file
      this.fileWriter = await Deno.open(this.globalLogPath, {
        create: true,
        write: true,
        append: true,
      });

      // Write initialization message
      await this.writeLog("global", {
        level: "info",
        message: "Atlas logging initialized",
        timestamp: new Date().toISOString(),
        pid: Deno.pid,
      });

      this.isInitialized = true;
    })();

    await this.initPromise;
  }

  /**
   * Initialize logger for detached mode
   * In detached mode, all logs go to a specific file and console output is disabled
   */
  async initializeDetached(logFile: string): Promise<void> {
    this.isDetached = true;

    // Ensure directory exists
    await ensureDir(join(logFile, ".."));

    // Open the specific log file
    this.detachedFileHandle = await Deno.open(logFile, {
      create: true,
      write: true,
      append: true,
    });

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
  }

  private async writeLog(target: string, entry: LogEntry): Promise<void> {
    // Skip file operations during tests
    if (Deno.env.get("DENO_TESTING") === "true") {
      return;
    }

    const line = JSON.stringify(entry) + "\n";
    const encoder = new TextEncoder();
    const data = encoder.encode(line);

    // In detached mode, write to the detached file handle
    if (this.isDetached && this.detachedFileHandle) {
      await this.detachedFileHandle.write(data);
      return;
    }

    if (target === "global" && this.fileWriter) {
      await this.fileWriter.write(data);
    } else if (target.startsWith("workspace:")) {
      const workspaceId = target.split(":")[1];
      // Use registry ID if we have a mapping, otherwise use the workspace ID
      const logId = this.workspaceIdToRegistryId.get(workspaceId) || workspaceId;
      let writer = this.workspaceWriters.get(logId);

      if (!writer) {
        const workspacePath = join(
          this.logDir,
          "workspaces",
          `${logId}.log`,
        );
        writer = await Deno.open(workspacePath, {
          create: true,
          write: true,
          append: true,
        });
        this.workspaceWriters.set(logId, writer);
      }

      await writer.write(data);
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
        console.log(
          `${color}${entry.timestamp} ${level.toUpperCase()} ${prefix}${reset} ${message}`,
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
      await this.writeLog(target, entry);
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
      const content = await Deno.readTextFile(logPath);
      const allLines = content.trim().split("\n");
      return allLines.slice(-lines);
    } catch {
      return [];
    }
  }

  close(): void {
    if (this.fileWriter) {
      try {
        this.fileWriter.close();
      } catch {
        // Ignore errors if file is already closed
      }
      this.fileWriter = undefined;
    }

    if (this.detachedFileHandle) {
      try {
        this.detachedFileHandle.close();
      } catch {
        // Ignore errors if file is already closed
      }
      this.detachedFileHandle = undefined;
    }

    for (const writer of this.workspaceWriters.values()) {
      try {
        writer.close();
      } catch {
        // Ignore errors if file is already closed
      }
    }
    this.workspaceWriters.clear();

    // Reset initialization state
    this.isInitialized = false;
    this.initPromise = undefined;
    this.isDetached = false;
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
