import { useEffect, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { NewWorkspaceConfig } from "../../../core/config-loader.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { formatLog, WorkspaceLogReader } from "../../commands/workspace/logs/log-reader.ts";
import type { LogEntry } from "../../../utils/logger.ts";

interface LogsTabProps {
  config: NewWorkspaceConfig;
}

export const LogsTab = ({ config }: LogsTabProps) => {
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [scrollOffset, setScrollOffset] = useState(0);
  const [selectedLevel, setSelectedLevel] = useState<string>("all");
  const [isPaused, setIsPaused] = useState(false);
  const { stdout } = useStdout();

  // Get terminal height to calculate visible rows
  const terminalHeight = stdout?.rows || 24;
  const availableRows = terminalHeight - 6; // Account for toolbar, footer and padding

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        setLoading(true);
        const registry = getWorkspaceRegistry();

        // Find workspace by name
        const workspace = await registry.findByName(config.workspace.name);
        if (!workspace) {
          throw new Error(`Workspace '${config.workspace.name}' not found`);
        }

        const logReader = new WorkspaceLogReader(workspace.id);

        // Read logs without following (static view for TUI)
        const entries = await logReader.read({
          tail: 200, // Get more logs for scrolling
          filters: {
            // No filters for now - show all logs
          },
        });

        if (entries.length === 0) {
          setLogs(["No logs found for this workspace"]);
        } else {
          const formattedLogs = entries.map((log: LogEntry) =>
            formatLog(log, {
              timestamps: true,
              json: false,
            })
          );
          setLogs(formattedLogs);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    fetchLogs();

    // Refresh logs every 10 seconds (only if not paused)
    if (!isPaused) {
      const interval = setInterval(fetchLogs, 10000);
      return () => clearInterval(interval);
    }
  }, [config.workspace.name, isPaused]);

  // Handle scrolling when logs exceed available height
  useEffect(() => {
    if (logs.length > availableRows) {
      // Auto-scroll to bottom when new logs arrive
      setScrollOffset(-(logs.length - availableRows));
    } else {
      setScrollOffset(0);
    }
  }, [logs.length, availableRows]);

  // Handle toolbar interactions
  useInput((inputChar, key) => {
    if (inputChar === "c") {
      // Clear logs
      setLogs([]);
      setScrollOffset(0);
    } else if (inputChar === " ") {
      // Toggle pause/play
      setIsPaused(!isPaused);
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text>Loading workspace logs...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%" width="100%">
      {/* Toolbar */}
      <Box paddingX={2} paddingY={1} flexShrink={0} borderBottom borderColor="gray" borderDimColor>
        <Box flexDirection="row" gap={2}>
          {/* Log Level Segment Controller */}
          <Box flexDirection="row" gap={1}>
            <Text dimColor>Level:</Text>
            {["all", "info", "warning", "error"].map((level) => (
              <Box key={level}>
                <Text
                  bold={selectedLevel === level}
                  dimColor={selectedLevel !== level}
                >
                  [{level}]
                </Text>
              </Box>
            ))}
          </Box>

          {/* Spacer */}
          <Box flexGrow={1} />

          {/* Pause/Play Toggle */}
          <Box>
            <Text dimColor>
              {isPaused ? "▶" : "⏸"} {isPaused ? "Play" : "Pause"} (space)
            </Text>
          </Box>

          {/* Clear Button */}
          <Box>
            <Text dimColor>🗑 Clear (c)</Text>
          </Box>
        </Box>
      </Box>

      {/* Scrollable logs container */}
      <Box flexGrow={1} overflow="hidden">
        <Box
          flexDirection="column"
          flexGrow={1}
          marginTop={scrollOffset}
        >
          {logs.map((log, index) => (
            <Box key={index} flexShrink={0}>
              <Text>{log}</Text>
            </Box>
          ))}
        </Box>
      </Box>

      {/* Footer with scroll info */}
      {logs.length > availableRows && (
        <Box paddingX={2} paddingY={1} flexShrink={0}>
          <Text dimColor>
            Showing {Math.min(logs.length, availableRows)} of {logs.length} log entries
            {scrollOffset < 0 && ` (scrolled to bottom)`}
          </Text>
        </Box>
      )}
    </Box>
  );
};
