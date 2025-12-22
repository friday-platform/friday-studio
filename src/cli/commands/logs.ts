import { join } from "node:path";
import process from "node:process";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { exists } from "@std/fs";
import type { YargsInstance } from "../utils/yargs.ts";

export const command = "logs";
export const desc = "Query Atlas logs";
export const aliases = ["log"];

interface LogsArgs {
  since?: string;
  level?: string;
  human?: boolean;
}

export function builder(y: YargsInstance) {
  return y
    .option("since", { type: "string", describe: "Time filter (30s, 5m, 1h)" })
    .option("level", { type: "string", describe: "Filter by level (debug,info,warn,error)" })
    .option("human", { type: "boolean", describe: "Human-readable output", default: false });
}

/** Log entry from ~/.atlas/logs/*.log files (JSON lines) */
interface LogEntry {
  timestamp: string; // ISO 8601: "2025-12-19T20:44:24.029Z"
  level: string; // lowercase: "debug", "info", "warn", "error"
  message: string;
  context: Record<string, unknown>; // can be empty {}
}

async function readLogFile(path: string): Promise<LogEntry[]> {
  if (!(await exists(path))) return [];
  const content = await Deno.readTextFile(path);
  const entries: LogEntry[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

async function readAllLogs(): Promise<LogEntry[]> {
  const logsDir = join(getAtlasHome(), "logs");

  // Defensive: handle missing logs directory (fresh install)
  if (!(await exists(logsDir))) {
    return [];
  }

  const entries: LogEntry[] = [];

  // Global log
  entries.push(...(await readLogFile(join(logsDir, "global.log"))));

  // Workspace logs
  const wsDir = join(logsDir, "workspaces");
  if (await exists(wsDir)) {
    for await (const f of Deno.readDir(wsDir)) {
      if (f.isFile && f.name.endsWith(".log")) {
        entries.push(...(await readLogFile(join(wsDir, f.name))));
      }
    }
  }

  return entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(s|m|h)$/);
  if (!match) {
    console.error(`Invalid duration: ${duration}. Use: 30s, 5m, 1h`);
    process.exit(1);
  }
  const val = match.at(1);
  if (!val) {
    throw new Error("Missing duration value");
  }
  const value = parseInt(val, 10);
  const unit = match.at(2);

  if (unit === "s") return value * 1000;
  if (unit === "m") return value * 60000;
  if (unit === "h") return value * 3600000;

  // Unreachable due to regex validation
  throw new Error(`Invalid unit: ${unit}`);
}

function formatHuman(entry: LogEntry): string {
  // Time: HH:MM:SS.mmm
  const time = new Date(entry.timestamp).toISOString().slice(11, 23);
  // Level: padded to 5 chars
  const level = entry.level.toUpperCase().padEnd(5);
  // Workspace prefix if present
  const ws = entry.context.workspaceId ? `[${entry.context.workspaceId}] ` : "";

  let out = `${time} ${level} ${ws}${entry.message}`;

  // Show remaining context on next line
  const ctx = { ...entry.context };
  delete ctx.workspaceId;
  if (Object.keys(ctx).length > 0) {
    out += `\n  ${JSON.stringify(ctx)}`;
  }
  return out;
}

export const handler = async (argv: LogsArgs): Promise<void> => {
  let entries = await readAllLogs();

  // Time filter
  if (argv.since) {
    const cutoff = Date.now() - parseDuration(argv.since);
    entries = entries.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
  }

  // Level filter
  if (argv.level) {
    const levels = argv.level.split(",").map((l) => l.trim().toLowerCase());
    entries = entries.filter((e) => levels.includes(e.level.toLowerCase()));
  }

  // Output
  if (argv.human) {
    for (const entry of entries) {
      console.log(formatHuman(entry));
    }
  } else {
    for (const entry of entries) {
      console.log(JSON.stringify(entry));
    }
  }
  process.exit(0);
};
