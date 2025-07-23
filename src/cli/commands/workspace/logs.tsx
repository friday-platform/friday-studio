import { Box, render, Text } from "ink";
import { useEffect, useState } from "react";
import { getWorkspaceManager } from "@atlas/workspace";
import { YargsInstance } from "../../utils/yargs.ts";
import {
  formatLog,
  parseContextFilters,
  parseDuration,
  WorkspaceLogReader,
} from "../../utils/log-reader.ts";

interface LogsArgs {
  workspace?: string;
  follow?: boolean;
  tail?: number;
  since?: string;
  timestamps?: boolean;
  json?: boolean;
  level?: string;
  context?: string[];
}

export const command = "logs [workspace]";
export const desc = "View workspace logs";
export const aliases = ["log"];

export function builder(y: YargsInstance) {
  return y
    .positional("workspace", {
      type: "string",
      describe: "Workspace ID or name (defaults to current workspace)",
    })
    .option("follow", {
      alias: "f",
      type: "boolean",
      describe: "Follow log output (like tail -f)",
      default: false,
    })
    .option("tail", {
      alias: "n",
      type: "number",
      describe: "Number of lines to show from the end of the logs",
      default: 100,
    })
    .option("since", {
      type: "string",
      describe: "Show logs since duration (e.g., 5m, 2h, 1d)",
    })
    .option("timestamps", {
      alias: "t",
      type: "boolean",
      describe: "Show timestamps",
      default: true,
    })
    .option("json", {
      type: "boolean",
      describe: "Output logs as JSON",
      default: false,
    })
    .option("level", {
      alias: "l",
      type: "string",
      describe: "Minimum log level to show",
      choices: ["error", "warn", "info", "debug", "trace"],
    })
    .option("context", {
      alias: "c",
      type: "array",
      describe: "Filter by context (e.g., workerType=agent sessionId=abc123)",
      string: true,
    })
    .example("$0 workspace logs", "View logs for current workspace")
    .example("$0 workspace logs my-workspace", "View logs for specific workspace")
    .example("$0 workspace logs -f", "Follow logs in real-time")
    .example("$0 workspace logs --tail 50", "Show last 50 log entries")
    .example("$0 workspace logs --since 5m", "Show logs from last 5 minutes")
    .example("$0 workspace logs --level error", "Show only error logs and above")
    .example("$0 workspace logs -c workerType=agent", "Filter logs by context");
}

export const handler = async (argv: LogsArgs): Promise<void> => {
  try {
    const registry = await getWorkspaceManager();
    await registry.initialize();

    // Resolve workspace ID
    let workspaceId: string;
    if (!argv.workspace) {
      // Try to get current workspace
      const workspace = await registry.find({ path: Deno.cwd() });
      if (!workspace) {
        throw new Error("No workspace specified and not in a workspace directory");
      }
      workspaceId = workspace.id;
    } else {
      // Find workspace by ID or name
      const workspace = await registry.find({ id: argv.workspace }) ||
        await registry.find({ name: argv.workspace });
      if (!workspace) {
        throw new Error(`Workspace '${argv.workspace}' not found`);
      }
      workspaceId = workspace.id;
    }

    // For non-TTY or follow mode, use direct output
    if (!Deno.stdin.isTerminal() || argv.follow) {
      await runDirectLogs(workspaceId, argv);
    } else {
      // Use Ink for interactive display
      render(<LogsDisplay workspaceId={workspaceId} flags={argv} />);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  }
};

// Direct log output for non-TTY or follow mode
async function runDirectLogs(workspaceId: string, flags: LogsArgs): Promise<void> {
  const logReader = new WorkspaceLogReader(workspaceId);

  // Apply filters
  const filters = {
    level: flags.level,
    since: flags.since ? parseDuration(flags.since) : undefined,
    context: parseContextFilters(flags.context),
  };

  if (flags.follow) {
    console.log("\x1b[90mFollowing logs... (Press Ctrl+C to stop)\x1b[0m");

    // Set up graceful shutdown
    const abortController = new AbortController();

    Deno.addSignalListener("SIGINT", () => {
      console.log("\n\x1b[90mStopping log follow...\x1b[0m");
      abortController.abort();
      logReader.stop();
      Deno.exit(0);
    });

    // Stream logs with tail
    await logReader.follow({
      tail: flags.tail || 100,
      filters,
      onLog: (log) => {
        const formatted = formatLog(log, {
          timestamps: flags.timestamps !== false,
          json: flags.json || false,
        });
        console.log(formatted);
      },
    });
  } else {
    // Read logs once
    const entries = await logReader.read({
      tail: flags.tail || 100,
      filters,
    });

    if (entries.length === 0) {
      console.log("\x1b[90mNo logs found for this workspace\x1b[0m");
    } else {
      for (const log of entries) {
        const formatted = formatLog(log, {
          timestamps: flags.timestamps !== false,
          json: flags.json || false,
        });
        console.log(formatted);
      }
    }
  }
  Deno.exit(0);
}

// Ink component for interactive log display
function LogsDisplay({ workspaceId, flags }: { workspaceId: string; flags: LogsArgs }) {
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let logReader: WorkspaceLogReader | null = null;
    let mounted = true;

    (async () => {
      try {
        logReader = new WorkspaceLogReader(workspaceId);

        // Apply filters
        const filters = {
          level: flags.level,
          since: flags.since ? parseDuration(flags.since) : undefined,
          context: parseContextFilters(flags.context),
        };

        // Read logs once (follow mode is handled by direct output)
        const entries = await logReader.read({
          tail: flags.tail || 100,
          filters,
        });

        if (!mounted) return;

        if (entries.length === 0) {
          setLogs(["No logs found for this workspace"]);
        } else {
          setLogs(
            entries.map((log) =>
              formatLog(log, {
                timestamps: flags.timestamps !== false,
                json: flags.json || false,
              })
            ),
          );
        }
        setLoading(false);

        // Exit after displaying logs
        setTimeout(() => {
          if (mounted) {
            Deno.exit(0);
          }
        }, 100);
      } catch (err) {
        if (mounted) {
          setError((err as Error).message);
          setLoading(false);
          setTimeout(() => {
            Deno.exit(1);
          }, 100);
        }
      }
    })();

    // Cleanup function
    return () => {
      mounted = false;
      if (logReader) {
        logReader.stop();
      }
    };
  }, [workspaceId, flags]);

  if (error) {
    return (
      <Box>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (loading) {
    return (
      <Box>
        <Text color="gray">Loading logs...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {logs.map((log, i) => <Text key={i}>{log}</Text>)}
    </Box>
  );
}
