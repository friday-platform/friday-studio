import type { LogEntry } from "@atlas/logger";
import { join } from "@std/path";

export interface LogFilters {
  level?: string;
  since?: Date;
  context?: Record<string, string>;
}

export interface ReadOptions {
  tail?: number;
  filters?: LogFilters;
}

export interface FollowOptions extends ReadOptions {
  onLog: (entry: LogEntry) => void;
  pollInterval?: number;
}

export class WorkspaceLogReader {
  private logPath: string;
  private fileHandle?: Deno.FsFile;
  private followAbort?: AbortController;

  constructor(workspaceId: string) {
    const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || Deno.cwd();
    this.logPath = join(homeDir, ".atlas", "logs", "workspaces", `${workspaceId}.log`);
  }

  async read(options: ReadOptions = {}): Promise<LogEntry[]> {
    const { tail = 100, filters } = options;

    try {
      const fileInfo = await Deno.stat(this.logPath);

      // TODO: Performance improvement opportunity for large files (>5MB)
      // Could implement reverse reading from end of file for better performance
      if (fileInfo.size > 5 * 1024 * 1024) {
        console.warn(
          `Warning: Log file is large (${(fileInfo.size / 1024 / 1024).toFixed(
            1,
          )}MB), this may be slow`,
        );
      }

      const content = await Deno.readTextFile(this.logPath);
      const lines = content.trim().split("\n").filter(Boolean);

      // Parse log entries
      const entries: LogEntry[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as LogEntry;
          if (this.matchesFilters(entry, filters)) {
            entries.push(entry);
          }
        } catch {
          // Skip malformed lines
        }
      }

      // Return last N entries
      return entries.slice(-tail);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }
  }

  async follow(options: FollowOptions): Promise<void> {
    const { tail = 100, filters, onLog, pollInterval = 1000 } = options;

    // First, read existing logs
    const initial = await this.read({ tail, filters });
    for (const entry of initial) {
      onLog(entry);
    }

    // Check if file exists, if not return early
    try {
      await Deno.stat(this.logPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // No log file yet, just return
        return;
      }
      throw error;
    }

    // Open file for watching
    this.fileHandle = await Deno.open(this.logPath, { read: true });
    const decoder = new TextDecoder();
    let buffer = "";
    let position = (await this.fileHandle.stat()).size;

    this.followAbort = new AbortController();

    // Poll for new content
    const pollLoop = async () => {
      while (!this.followAbort?.signal.aborted) {
        try {
          // Check if file still exists
          try {
            await Deno.stat(this.logPath);
          } catch {
            // File was deleted, exit gracefully
            console.log("Log file was deleted, stopping log follow");
            break;
          }

          const stat = await this.fileHandle!.stat();
          if (stat.size > position) {
            // Read new content
            const newContent = new Uint8Array(stat.size - position);
            await this.fileHandle!.seek(position, Deno.SeekMode.Start);
            const bytesRead = await this.fileHandle!.read(newContent);

            if (bytesRead) {
              position += bytesRead;
              buffer += decoder.decode(newContent.subarray(0, bytesRead));

              // Process complete lines
              const lines = buffer.split("\n");
              buffer = lines.pop() || ""; // Keep incomplete line in buffer

              for (const line of lines) {
                if (line.trim()) {
                  try {
                    const entry = JSON.parse(line) as LogEntry;
                    if (this.matchesFilters(entry, filters)) {
                      onLog(entry);
                    }
                  } catch {
                    // Skip malformed lines
                  }
                }
              }
            }
          }
        } catch (error) {
          if (!this.followAbort?.signal.aborted) {
            console.error("Error reading log file:", error);
          }
          break;
        }

        // Wait before next poll
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    };

    await pollLoop();
  }

  stop(): void {
    if (this.followAbort) {
      this.followAbort.abort();
    }
    if (this.fileHandle) {
      try {
        this.fileHandle.close();
      } catch {
        // Ignore errors on close
      }
    }
  }

  private matchesFilters(entry: LogEntry, filters?: LogFilters): boolean {
    if (!filters) return true;

    // Level filter - show logs at or above the specified level
    if (filters.level) {
      const levels = ["error", "warn", "info", "debug", "trace"];
      const entryLevel = levels.indexOf(entry.level);
      const filterLevel = levels.indexOf(filters.level);
      if (entryLevel === -1 || filterLevel === -1) return false;
      // Higher index means less severe, so exclude if entry level is less severe than filter
      if (entryLevel > filterLevel) return false;
    }

    // Time filter
    if (filters.since && new Date(entry.timestamp) < filters.since) {
      return false;
    }

    // Context filters
    if (filters.context) {
      // If we're filtering by context but the entry has no context, exclude it
      if (!entry.context) return false;

      // Check each required context field
      for (const [key, value] of Object.entries(filters.context)) {
        if (entry.context[key] !== value) return false;
      }
    }

    return true;
  }
}

// Helper functions
export function parseDuration(duration: string): Date {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}. Use format like: 5m, 2h, 1d`);
  }

  const [, amount, unit] = match;
  const value = parseInt(amount || "0", 10);
  const now = new Date();

  switch (unit) {
    case "s":
      now.setSeconds(now.getSeconds() - value);
      break;
    case "m":
      now.setMinutes(now.getMinutes() - value);
      break;
    case "h":
      now.setHours(now.getHours() - value);
      break;
    case "d":
      now.setDate(now.getDate() - value);
      break;
  }

  return now;
}

export function parseContextFilters(filters?: string[]): Record<string, string> | undefined {
  if (!filters || filters.length === 0) return undefined;

  const result: Record<string, string> = {};
  for (const filter of filters) {
    const [key, value] = filter.split("=");
    if (key && value) {
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function formatLog(
  entry: LogEntry,
  flags: { timestamps?: boolean; json?: boolean },
): string {
  if (flags.json) {
    return JSON.stringify(entry);
  }

  const parts: string[] = [];

  // Match the color coding from the logger
  const colors = {
    error: "\x1b[31m", // red
    warn: "\x1b[33m", // yellow
    info: "\x1b[36m", // cyan
    debug: "\x1b[90m", // gray
    trace: "\x1b[35m", // magenta
  };
  const reset = "\x1b[0m";
  const color = colors[entry.level as keyof typeof colors] || reset;

  if (flags.timestamps) {
    parts.push(entry.timestamp);
  }

  parts.push(`${color}${entry.level.toUpperCase()}${reset}`);

  if (entry.context) {
    const contextParts: string[] = [];
    if (entry.context.workerType) contextParts.push(entry.context.workerType);
    if (entry.context.workerId) {
      contextParts.push(entry.context.workerId.slice(0, 8));
    }
    if (entry.context.sessionId) {
      contextParts.push(entry.context.sessionId.slice(0, 8));
    }
    if (entry.context.supervisorId) {
      contextParts.push(entry.context.supervisorId.slice(0, 8));
    }
    if (entry.context.agentName) contextParts.push(entry.context.agentName);

    if (contextParts.length > 0) {
      parts.push(`[${contextParts.join(":")}]`);
    }
  }

  parts.push(entry.message);

  return parts.join(" ");
}
