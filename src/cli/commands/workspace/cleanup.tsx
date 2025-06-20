import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { WorkspaceCommandProps } from "./utils.ts";

export function WorkspaceCleanupCommand({ args, flags }: WorkspaceCommandProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>("");
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    const execute = async () => {
      try {
        await handleCleanup();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    };

    execute();
  }, []);

  async function handleCleanup() {
    const registry = getWorkspaceRegistry();

    // Clean up non-existent workspaces
    const cleaned = await registry.cleanup();

    setData({
      cleaned,
    });
    setStatus("ready");
  }

  if (status === "loading") {
    return <Text>Loading...</Text>;
  }

  if (status === "error") {
    return <Text color="red">Error: {error}</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text color="green">✓ Registry cleanup complete</Text>
      {data.cleaned > 0
        ? (
          <Text>
            Removed {data.cleaned} non-existent workspace(s) from registry
          </Text>
        )
        : <Text>No stale entries found</Text>}
    </Box>
  );
}
