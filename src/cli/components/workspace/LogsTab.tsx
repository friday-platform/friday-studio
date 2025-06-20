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
  const [activeToolbarItem, setActiveToolbarItem] = useState(0); // 0: levels, 1: pause/play, 2: clear
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
    // Navigate between toolbar items
    if (key.leftArrow || inputChar === "h") {
      setActiveToolbarItem((prev) => Math.max(0, prev - 1));
    } else if (key.rightArrow || inputChar === "l") {
      setActiveToolbarItem((prev) => Math.min(2, prev + 1));
    } else if (inputChar === " ") {
      // Handle space key based on active toolbar item
      if (activeToolbarItem === 0) {
        // Toggle through log levels
        const levels = ["all", "info", "warning", "error"];
        const currentIndex = levels.indexOf(selectedLevel);
        const nextIndex = (currentIndex + 1) % levels.length;
        setSelectedLevel(levels[nextIndex]);
      } else if (activeToolbarItem === 1) {
        // Toggle pause/play
        setIsPaused(!isPaused);
      } else if (activeToolbarItem === 2) {
        // Clear logs
        setLogs([]);
        setScrollOffset(0);
      }
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
          <Box 
            flexDirection="row" 
            gap={1}
            borderStyle={activeToolbarItem === 0 ? "round" : undefined}
            paddingX={activeToolbarItem === 0 ? 1 : 0}
          >
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
          <Box
            borderStyle={activeToolbarItem === 1 ? "round" : undefined}
            paddingX={activeToolbarItem === 1 ? 1 : 0}
          >
            <Text dimColor>
              {isPaused ? "▶" : "⏸"} {isPaused ? "Play" : "Pause"}
            </Text>
          </Box>

          {/* Clear Button */}
          <Box
            borderStyle={activeToolbarItem === 2 ? "round" : undefined}
            paddingX={activeToolbarItem === 2 ? 1 : 0}
          >
            <Text dimColor>Clear</Text>
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
