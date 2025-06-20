import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import {
  WorkspaceEntry,
  WorkspaceStatus as WSStatus,
} from "../../../core/workspace-registry-types.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { WorkspaceCommandProps } from "./utils.ts";

export function WorkspaceListCommand({}: WorkspaceCommandProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<string>("");
  const [data, setData] = useState<{ registeredWorkspaces: WorkspaceEntry[] }>({
    registeredWorkspaces: [],
  });

  useEffect(() => {
    const execute = async () => {
      try {
        await handleList();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    };

    execute();
  }, []);

  async function handleList() {
    // Get workspaces from registry
    const registry = getWorkspaceRegistry();
    const registeredWorkspaces = await registry.listAll();

    setData({ registeredWorkspaces });
    setStatus("ready");
  }

  if (status === "loading") {
    return <Text>Loading...</Text>;
  }

  if (status === "error") {
    return <Text color="red">Error: {error}</Text>;
  }

  return <WorkspaceList registeredWorkspaces={data.registeredWorkspaces} />;
}

// Shared component for rendering workspace list
export function WorkspaceList({
  registeredWorkspaces,
}: {
  registeredWorkspaces: WorkspaceEntry[];
}) {
  const hasRegistered = registeredWorkspaces && registeredWorkspaces.length > 0;

  if (!hasRegistered) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="yellow">No workspaces found</Text>
        </Box>
        <Box>
          <Text color="gray">
            No registered workspaces found. Run 'atlas workspace init' to create a new workspace.
          </Text>
        </Box>
      </Box>
    );
  }

  const padRight = (str: string, width: number) => {
    return str.length >= width
      ? str.substring(0, width - 1) + "…"
      : str + " ".repeat(width - str.length);
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          Registered Workspaces ({registeredWorkspaces.length} found)
        </Text>
      </Box>
      <Box>
        <Text></Text>
      </Box>

      {/* Table Header */}
      <Box>
        <Text bold color="white">
          {padRight("REGISTRY ID", 20)}
          {padRight("NAME", 25)}
          {padRight("STATUS", 10)}
          {padRight("PATH", 40)}
        </Text>
      </Box>
      <Box>
        <Text color="gray">
          {"─".repeat(20)}
          {"─".repeat(25)}
          {"─".repeat(10)}
          {"─".repeat(40)}
        </Text>
      </Box>

      {/* Table Rows */}
      {registeredWorkspaces.map((workspace, i) => {
        const statusColor = workspace.status === WSStatus.RUNNING
          ? "green"
          : workspace.status === WSStatus.CRASHED
          ? "red"
          : "gray";

        return (
          <Box key={i}>
            <Text>
              <Text color="blue">{padRight(workspace.id, 20)}</Text>
              <Text color="yellow">{padRight(workspace.name, 25)}</Text>
              <Text color={statusColor}>{padRight(workspace.status, 10)}</Text>
              <Text color="gray">{padRight(workspace.path, 40)}</Text>
            </Text>
          </Box>
        );
      })}

      <Box>
        <Text></Text>
      </Box>
    </Box>
  );
}
