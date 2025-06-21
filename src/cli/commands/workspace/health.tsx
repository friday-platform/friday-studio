import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { WorkspaceCommandProps } from "./utils.ts";

export function WorkspaceHealthCommand({ args }: WorkspaceCommandProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>("");
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    const execute = async () => {
      try {
        await checkHealth(args[0]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    };

    execute();
  }, []);

  async function checkHealth(idOrName?: string) {
    const registry = getWorkspaceRegistry();

    // Find workspace
    let workspace;
    if (idOrName) {
      workspace = await registry.findById(idOrName) ||
        await registry.findByName(idOrName);
    } else {
      workspace = await registry.getCurrentWorkspace();
    }

    if (!workspace) {
      throw new Error("Workspace not found");
    }

    if (workspace.status !== "running" || !workspace.port) {
      throw new Error(`Workspace '${workspace.name}' is not running`);
    }

    // Fetch health data
    try {
      const response = await fetch(`http://localhost:${workspace.port}/api/health`);
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status} ${response.statusText}`);
      }

      const healthData = await response.json();
      setData({ workspace, healthData });
      setStatus("ready");
    } catch (err) {
      throw new Error(`Failed to connect to workspace: ${err.message}`);
    }
  }

  if (status === "loading") {
    return <Text>Checking health...</Text>;
  }

  if (status === "error") {
    return <Text color="red">Error: {error}</Text>;
  }

  // Display health data in JSON format for easy parsing
  return (
    <Box flexDirection="column">
      <Text color="green">✓ Health check successful</Text>
      <Text></Text>
      <Text>{JSON.stringify(data.healthData, null, 2)}</Text>
    </Box>
  );
}
