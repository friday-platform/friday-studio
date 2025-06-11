import { ensureDir } from "https://deno.land/std@0.208.0/fs/mod.ts";
import { join } from "https://deno.land/std@0.208.0/path/mod.ts";

export interface LogContext {
  workspaceId?: string;
  sessionId?: string;
  agentId?: string;
  workerId?: string;
  workerType?: string;
  [key: string]: any;
}

export class AtlasLogger {
  private static instance: AtlasLogger;
  private logDir: string;
  private globalLogPath: string;
  private fileWriter?: Deno.FsFile;
  private workspaceWriters: Map<string, Deno.FsFile> = new Map();

  private constructor() {
    // Set up .atlas directory in home or current directory
    const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") ||
      Deno.cwd();
    this.logDir = join(homeDir, ".atlas", "logs");
    this.globalLogPath = join(this.logDir, "global.log");
  }

  static getInstance(): AtlasLogger {
    if (!AtlasLogger.instance) {
      AtlasLogger.instance = new AtlasLogger();
    }
    return AtlasLogger.instance;
  }

  async initialize(): Promise<void> {
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
  }

  private async writeLog(target: string, entry: any): Promise<void> {
    const line = JSON.stringify(entry) + "\n";
    const encoder = new TextEncoder();
    const data = encoder.encode(line);

    if (target === "global" && this.fileWriter) {
      await this.fileWriter.write(data);
    } else if (target.startsWith("workspace:")) {
      const workspaceId = target.split(":")[1];
      let writer = this.workspaceWriters.get(workspaceId);

      if (!writer) {
        const workspacePath = join(
          this.logDir,
          "workspaces",
          `${workspaceId}.log`,
        );
        writer = await Deno.open(workspacePath, {
          create: true,
          write: true,
          append: true,
        });
        this.workspaceWriters.set(workspaceId, writer);
      }

      await writer.write(data);
    }
  }

  private formatMessage(
    level: string,
    message: string,
    context?: LogContext,
  ): any {
    const entry: any = {
      timestamp: new Date().toISOString(),
      level,
      message,
      pid: Deno.pid,
    };

    if (context) {
      entry.context = context;
    }

    // Add OpenTelemetry trace context if available
    const traceId = (globalThis as any).otelTraceId;
    const spanId = (globalThis as any).otelSpanId;
    if (traceId) entry.traceId = traceId;
    if (spanId) entry.spanId = spanId;

    return entry;
  }

  private async log(
    level: string,
    message: string,
    context?: LogContext,
  ): Promise<void> {
    const entry = this.formatMessage(level, message, context);

    // Console output with color coding
    const color = {
      error: "\x1b[31m", // red
      warn: "\x1b[33m", // yellow
      info: "\x1b[36m", // cyan
      debug: "\x1b[90m", // gray
      trace: "\x1b[35m", // magenta
    }[level] || "\x1b[0m";

    const reset = "\x1b[0m";
    const prefix = context
      ? `[${context.workerType || "atlas"}${
        context.workerId ? ":" + context.workerId.slice(0, 8) : ""
      }${context.agentName ? ":" + context.agentName : ""}]`
      : "[atlas]";

    console.log(
      `${color}${entry.timestamp} ${level.toUpperCase()} ${prefix}${reset} ${message}`,
    );

    // File output only if initialized
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

  async readLogs(
    target: string = "global",
    lines: number = 100,
  ): Promise<string[]> {
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

  async close(): Promise<void> {
    if (this.fileWriter) {
      this.fileWriter.close();
    }

    for (const writer of this.workspaceWriters.values()) {
      writer.close();
    }
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

// Global logger instance
export const logger = AtlasLogger.getInstance();

// Initialize logger on import (only in main thread)
// @ts-ignore - WorkerGlobalScope may not be defined in all environments
if (
  typeof WorkerGlobalScope === "undefined" ||
  !(self instanceof WorkerGlobalScope)
) {
  await logger.initialize();
}
