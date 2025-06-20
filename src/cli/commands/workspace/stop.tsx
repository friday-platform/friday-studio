import { Box, Text, useApp } from "ink";
import { useEffect, useState } from "react";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { WorkspaceProcessManager } from "../../../core/workspace-process-manager.ts";
import { WorkspaceCommandProps } from "./utils.ts";

interface StopState {
  status: "loading" | "stopping" | "success" | "error";
  message: string;
  workspaceName?: string;
}

export function WorkspaceStopCommand({ args, flags }: WorkspaceCommandProps) {
  const [state, setState] = useState<StopState>({
    status: "loading",
    message: "Preparing to stop workspace...",
  });
  const { exit } = useApp();

  useEffect(() => {
    const stopWorkspace = async () => {
      try {
        const workspaceIdOrName = args[0];
        if (!workspaceIdOrName) {
          throw new Error("Workspace ID or name required");
        }

        const registry = getWorkspaceRegistry();
        await registry.initialize();

        // Find workspace by ID or name
        const workspace = await registry.findById(workspaceIdOrName) ||
          await registry.findByName(workspaceIdOrName);

        if (!workspace) {
          throw new Error(`Workspace '${workspaceIdOrName}' not found`);
        }

        setState({
          status: "stopping",
          message: `Stopping workspace '${workspace.name}'...`,
          workspaceName: workspace.name,
        });

        const processManager = new WorkspaceProcessManager();
        await processManager.stop(workspace.id, flags.force === true);

        setState({
          status: "success",
          message: `Workspace '${workspace.name}' stopped successfully`,
          workspaceName: workspace.name,
        });

        // Exit after a brief delay to show success message
        setTimeout(() => exit(), 500);
      } catch (error) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        setTimeout(() => exit(), 500);
      }
    };

    stopWorkspace();
  }, [args, flags, exit]);

  return (
    <Box flexDirection="column">
      {state.status === "loading" && <Text color="yellow">{state.message}</Text>}
      {state.status === "stopping" && <Text color="yellow">{state.message}</Text>}
      {state.status === "success" && <Text color="green">✓ {state.message}</Text>}
      {state.status === "error" && <Text color="red">Error: {state.message}</Text>}
    </Box>
  );
}
