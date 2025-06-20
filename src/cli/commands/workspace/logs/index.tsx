import { Box, Text, useApp } from "ink";
import { useEffect, useState } from "react";
import { getWorkspaceRegistry } from "../../../../core/workspace-registry.ts";
import { formatLog, parseContextFilters, parseDuration, WorkspaceLogReader } from "./log-reader.ts";
import type { LogEntry } from "../../../../utils/logger.ts";
import { runWorkspaceLogs } from "./logs-direct.ts";

interface WorkspaceLogsCommandProps {
  args: string[];
  flags: {
    follow?: boolean;
    tail?: number;
    since?: string;
    timestamps?: boolean;
    json?: boolean;
    level?: string;
    context?: string[];
  };
}

export function WorkspaceLogsCommand({
  args,
  flags,
}: WorkspaceLogsCommandProps) {
  // If not in a TTY or if following logs, use direct implementation
  if (!Deno.stdin.isTerminal() || flags.follow) {
    // Run directly without React/Ink
    runWorkspaceLogs(args, flags)
      .then(() => {
        Deno.exit(0);
      })
      .catch(() => {
        Deno.exit(1);
      });

    // Return minimal component while direct implementation runs
    return <Text>Loading logs...</Text>;
  }
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const { exit } = useApp();

  useEffect(() => {
    let logReader: WorkspaceLogReader | null = null;
    let mounted = true;

    (async () => {
      try {
        const workspaceIdOrName = args[0];
        const registry = getWorkspaceRegistry();

        let workspaceId: string;

        if (!workspaceIdOrName) {
          // Try to get current workspace
          const workspace = await registry.getCurrentWorkspace();
          if (!workspace) {
            throw new Error(
              "No workspace specified and not in a workspace directory",
            );
          }
          workspaceId = workspace.id;
        } else {
          // Find workspace by ID or name
          const workspace = (await registry.findById(workspaceIdOrName)) ||
            (await registry.findByName(workspaceIdOrName));
          if (!workspace) {
            throw new Error(`Workspace '${workspaceIdOrName}' not found`);
          }
          workspaceId = workspace.id;
        }

        logReader = new WorkspaceLogReader(workspaceId);

        // Apply filters
        const filters = {
          level: flags.level,
          since: flags.since ? parseDuration(flags.since) : undefined,
          context: parseContextFilters(flags.context),
        };

        if (flags.follow) {
          setStreaming(true);
          // Stream logs with tail
          await logReader.follow({
            tail: flags.tail || 100,
            filters,
            onLog: (log: LogEntry) => {
              if (!mounted) return;
              const formatted = formatLog(log, {
                timestamps: flags.timestamps !== false,
                json: flags.json || false,
              });
              // In follow mode, print directly to console
              console.log(formatted);
            },
          });
        } else {
          // Read logs once
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

          // For non-follow mode, exit after displaying logs
          if (!flags.follow) {
            setTimeout(() => {
              if (mounted) {
                setIsExiting(true);
                exit();
              }
            }, 100);
          }
        }
      } catch (err) {
        if (mounted) {
          setError((err as Error).message);
          setTimeout(() => {
            setIsExiting(true);
            exit();
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
  }, []);

  if (isExiting) {
    return null;
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  if (flags.follow && streaming) {
    return (
      <Box flexDirection="column">
        <Text color="gray">Following logs... (Press Ctrl+C to stop)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {logs.map((log, i) => <Text key={i}>{log}</Text>)}
      {streaming && logs.length === 0 && <Text color="gray">Waiting for logs...</Text>}
    </Box>
  );
}
