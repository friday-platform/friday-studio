import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { WorkspaceEntry, WorkspaceStatus as WSStatus } from "../../core/workspace-manager.ts";
import { discoverWorkspaces } from "../modules/workspaces/discovery.ts";

export const WorkspaceList = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const loadWorkspaces = async () => {
      try {
        // Use workspace discovery (works without daemon)
        const discoveredWorkspaces = await discoverWorkspaces();

        // Convert to WorkspaceEntry format
        const workspaceEntries = discoveredWorkspaces.map((w) => ({
          id: w.id,
          name: w.name,
          path: w.path,
          configPath: `${w.path}/workspace.yml`,
          status: "stopped" as WSStatus, // Discovery doesn't know runtime status
          createdAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          metadata: {
            description: w.description,
          },
        }));

        setWorkspaces(workspaceEntries);
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };
    loadWorkspaces();
  }, []);

  if (loading) {
    return (
      <Box>
        <Text dimColor>Loading workspaces...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (!workspaces || workspaces.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No workspaces found</Text>
        <Text color="gray">Run 'atlas workspace init' to create a new workspace.</Text>
      </Box>
    );
  }

  const padRight = (str: string, width: number) => {
    return str.length >= width
      ? str.substring(0, width - 1) + "…"
      : str + " ".repeat(width - str.length);
  };

  const formatUptime = (workspace: WorkspaceEntry): string => {
    if (workspace.status !== WSStatus.RUNNING || !workspace.startedAt) {
      return "-";
    }

    const start = new Date(workspace.startedAt).getTime();
    const now = Date.now();
    const ms = now - start;

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m`;
    } else {
      return `${seconds}s`;
    }
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          Registered Workspaces ({workspaces.length} found)
        </Text>
      </Box>
      <Box>
        <Text></Text>
      </Box>

      {/* Table Header */}
      <Box>
        <Text bold color="white">
          {padRight("ID", 30)}
          {padRight("NAME", 50)}
          {padRight("STATUS", 10)}
          {padRight("PORT", 8)}
          {padRight("UPTIME", 10)}
        </Text>
      </Box>
      <Box>
        <Text color="gray">{"─".repeat(108)}</Text>
      </Box>

      {/* Table Rows */}
      {workspaces.map((workspace, i) => {
        const statusColor = workspace.status === WSStatus.RUNNING
          ? "green"
          : workspace.status === WSStatus.CRASHED
          ? "red"
          : "gray";

        const portDisplay = workspace.port ? workspace.port.toString() : "-";
        const uptimeDisplay = formatUptime(workspace);

        return (
          <Box key={i}>
            <Text>
              <Text color="blue">{padRight(workspace.id, 30)}</Text>
              <Text color="yellow">{padRight(workspace.name, 50)}</Text>
              <Text color={statusColor}>{padRight(workspace.status, 10)}</Text>
              <Text color="cyan">{padRight(portDisplay, 8)}</Text>
              <Text color="green">{padRight(uptimeDisplay, 10)}</Text>
            </Text>
          </Box>
        );
      })}

      <Box>
        <Text></Text>
      </Box>
    </Box>
  );
};
