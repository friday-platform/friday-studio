import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import {
  WorkspaceEntry,
  WorkspaceStatus as WSStatus,
} from "../../../core/workspace-registry-types.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { WorkspaceCommandProps } from "./utils.ts";

export function WorkspaceRemoveCommand({ args, flags }: WorkspaceCommandProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>("");
  const [data, setData] = useState<
    {
      workspace: WorkspaceEntry;
      force: boolean;
    } | null
  >(null);

  useEffect(() => {
    const execute = async () => {
      try {
        const idOrName = args[0];
        const force = flags.force === true;
        await handleRemove(idOrName, force);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    };

    execute();
  }, []);

  async function handleRemove(idOrName?: string, force = false) {
    const registry = getWorkspaceRegistry();

    if (!idOrName) {
      throw new Error(
        "Workspace ID or name is required. Usage: atlas workspace remove <id|name> [--force]",
      );
    }

    // Find the workspace
    const workspace = (await registry.findById(idOrName)) ||
      (await registry.findByName(idOrName));

    if (!workspace) {
      throw new Error(
        `Workspace '${idOrName}' not found. Use 'atlas workspace list' to see registered workspaces.`,
      );
    }

    // Check if it's running
    if (workspace.status === WSStatus.RUNNING && !force) {
      throw new Error(
        `Cannot remove running workspace '${workspace.name}' (${workspace.id}). ` +
          `Stop it first with 'atlas workspace stop ${workspace.id}' or use --force flag.`,
      );
    }

    // If running and force flag is set, attempt to stop it first
    if (workspace.status === WSStatus.RUNNING && force) {
      // In future, we would stop the process here
      // For now, just update status
      await registry.updateStatus(workspace.id, WSStatus.STOPPED);
    }

    // Remove from registry
    await registry.unregister(workspace.id);

    setData({
      workspace,
      force,
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
      <Text color="green">✓ Workspace removed from registry</Text>
      <Text>Name: {data.workspace.name}</Text>
      <Text>ID: {data.workspace.id}</Text>
      <Text>Path: {data.workspace.path}</Text>
    </Box>
  );
}
