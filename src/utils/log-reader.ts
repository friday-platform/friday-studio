#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env

import { logger } from "./logger.ts";
import { join } from "https://deno.land/std@0.208.0/path/mod.ts";

async function readLogs(
  target: string = "global",
  lines: number = 50,
  follow: boolean = false,
) {
  const logs = await logger.readLogs(target, lines);

  if (!follow) {
    // Just print the logs and exit
    for (const log of logs) {
      try {
        const entry = JSON.parse(log);
        const level: string = entry.level || "info";
        const colorMap: Record<string, string> = {
          error: "\x1b[31m",
          warn: "\x1b[33m",
          info: "\x1b[36m",
          debug: "\x1b[90m",
          trace: "\x1b[35m",
        };
        const color = colorMap[level] || "\x1b[0m";

        const reset = "\x1b[0m";
        const prefix = entry.context
          ? `[${entry.context.workerType || "main"}${
            entry.context.workerId ? ":" + entry.context.workerId.slice(0, 8) : ""
          }]`
          : "[main]";

        console.log(
          `${color}${entry.timestamp} ${level.toUpperCase()} ${prefix}${reset} ${entry.message}`,
        );

        if (entry.context && Object.keys(entry.context).length > 2) {
          console.log(`  Context:`, entry.context);
        }
      } catch {
        // If not JSON, print as-is
        console.log(log);
      }
    }
  } else {
    // TODO: Implement follow mode with file watching
    console.log("Follow mode not yet implemented");
  }
}

// CLI interface
if (import.meta.main) {
  const args = Deno.args;

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Atlas Log Reader

Usage:
  log-reader [options] [target]

Options:
  -n, --lines <number>  Number of lines to show (default: 50)
  -f, --follow         Follow log output (like tail -f)
  -h, --help          Show this help

Target:
  global              Read global logs (default)
  <workspace-id>      Read logs for specific workspace

Examples:
  log-reader                    # Show last 50 lines of global log
  log-reader -n 100            # Show last 100 lines
  log-reader workspace-123     # Show logs for workspace-123
  log-reader -f                # Follow global logs (not yet implemented)
`);
    Deno.exit(0);
  }

  let target = "global";
  let lines = 50;
  let follow = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-n" || args[i] === "--lines") {
      lines = parseInt(args[i + 1]) || 50;
      i++;
    } else if (args[i] === "-f" || args[i] === "--follow") {
      follow = true;
    } else if (!args[i].startsWith("-")) {
      target = args[i];
    }
  }

  await readLogs(target, lines, follow);
}

export { readLogs };
