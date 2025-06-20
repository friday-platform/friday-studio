import { Box, Text, useApp } from "ink";
import { useEffect, useState } from "react";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { WorkspaceProcessManager } from "../../../core/workspace-process-manager.ts";
import { WorkspaceCommandProps } from "./utils.ts";

interface RestartState {
  status: "loading" | "stopping" | "starting" | "success" | "error";
  message: string;
  workspaceName?: string;
  pid?: number;
  port?: number;
}

export function WorkspaceRestartCommand({ args, flags }: WorkspaceCommandProps) {
  const [state, setState] = useState<RestartState>({
    status: "loading",
    message: "Preparing to restart workspace...",
  });
  const { exit } = useApp();

  useEffect(() => {
    const restartWorkspace = async () => {
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

        // First restart the process
        setState({
          status: "starting",
          message: `Restarting workspace '${workspace.name}'...`,
          workspaceName: workspace.name,
        });

        const pid = await processManager.restart(workspace.id);

        // Get updated workspace info
        const updatedWorkspace = await registry.findById(workspace.id);

        // Wait for it to be ready
        if (updatedWorkspace && await processManager.waitForReady(workspace.id)) {
          setState({
            status: "success",
            message: `Workspace '${workspace.name}' restarted successfully`,
            workspaceName: workspace.name,
            pid,
            port: updatedWorkspace.port,
          });
        } else {
          throw new Error("Workspace failed to restart");
        }

        // Exit after a brief delay to show success message
        setTimeout(() => exit(), 1000);
      } catch (error) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        setTimeout(() => exit(), 500);
      }
    };

    restartWorkspace();
  }, [args, flags, exit]);

  return (
    <Box flexDirection="column">
      {state.status === "loading" && <Text color="yellow">{state.message}</Text>}
      {state.status === "stopping" && <Text color="yellow">{state.message}</Text>}
      {state.status === "starting" && <Text color="yellow">{state.message}</Text>}
      {state.status === "success" && (
        <Box flexDirection="column">
          <Text color="green">✓ {state.message}</Text>
          {state.pid && <Text>PID: {state.pid}</Text>}
          {state.port && <Text>Port: {state.port}</Text>}
        </Box>
      )}
      {state.status === "error" && <Text color="red">Error: {state.message}</Text>}
    </Box>
  );
}
