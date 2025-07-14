import { Box, Text } from "ink";
import { WorkspaceSelection } from "./workspace-selection.tsx";
import { useAppContext } from "../../contexts/app-context.tsx";
import { getDaemonClient } from "../../utils/daemon-client.ts";
import { useResponsiveDimensions } from "../../utils/useResponsiveDimensions.ts";
import { OutputEntry } from "./index.ts";

interface WorkspacesCommandProps {
  onComplete: (selectedWorkspace?: string) => void;
}

export function WorkspacesCommand({ onComplete }: WorkspacesCommandProps) {
  const { setOutputBuffer } = useAppContext();
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  const addOutputEntry = (entry: OutputEntry) => {
    setOutputBuffer((prev) => [...prev, entry]);
  };

  const getWorkspaceById = async (workspaceId: string) => {
    try {
      const client = getDaemonClient();
      return await client.getWorkspace(workspaceId);
    } catch {
      return null;
    }
  };

  const handleWorkspaceSelect = async (workspaceId: string) => {
    // Handle special "none" case to exit workspace
    if (workspaceId === "none") {
      setSelectedWorkspace(null);

      // Add workspace exit message to output buffer
      const terminalWidth = dimensions.paddedWidth;
      const messageText = ` Exited workspace `;
      const totalDashes = Math.max(0, terminalWidth - messageText.length);
      const leftDashes = Math.floor(totalDashes / 2);
      const rightDashes = totalDashes - leftDashes;
      const formattedMessage = "─".repeat(leftDashes) + messageText + "─".repeat(rightDashes);

      addOutputEntry({
        id: `workspace-exited-${Date.now()}`,
        component: (
          <Box width={terminalWidth}>
            <Text dimColor>{formattedMessage}</Text>
          </Box>
        ),
      });
      onComplete();
      return;
    }

    try {
      const workspace = await getWorkspaceById(workspaceId);
      if (workspace) {
        // Add workspace selection message to output buffer
        const workspaceName = workspace.name;
        const terminalWidth = dimensions.paddedWidth;
        const messageText = ` Entered: ${workspaceName} `;
        const totalDashes = Math.max(0, terminalWidth - messageText.length);
        const leftDashes = Math.floor(totalDashes / 2);
        const rightDashes = totalDashes - leftDashes;
        const formattedMessage = "─".repeat(leftDashes) + messageText + "─".repeat(rightDashes);

        addOutputEntry({
          id: `workspace-selected-${Date.now()}`,
          component: (
            <Box width={terminalWidth}>
              <Text dimColor>{formattedMessage}</Text>
            </Box>
          ),
        });

        onComplete(workspace.name);
        return;
      }
    } catch (error) {
      addOutputEntry({
        id: `workspace-error-${Date.now()}`,
        component: (
          <Text color="red">
            Error selecting workspace: {error instanceof Error ? error.message : String(error)}
          </Text>
        ),
      });
    }

    onComplete();
  };

  return (
    <WorkspaceSelection
      onEscape={onComplete}
      onWorkspaceSelect={handleWorkspaceSelect}
    />
  );
}
