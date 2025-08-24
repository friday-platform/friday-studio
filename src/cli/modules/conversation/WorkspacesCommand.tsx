import { getDaemonClient } from "../../utils/daemon-client.ts";
import { WorkspaceSelection } from "./workspace-selection.tsx";

interface WorkspacesCommandProps {
  onComplete: (selectedWorkspace?: string) => void;
}

export function WorkspacesCommand({ onComplete }: WorkspacesCommandProps) {
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
      // Add workspace exit message to output buffer
      // const terminalWidth = dimensions.paddedWidth;
      // const messageText = ` Exited workspace `;
      // const totalDashes = Math.max(0, terminalWidth - messageText.length);
      // const leftDashes = Math.floor(totalDashes / 2);
      // const rightDashes = totalDashes - leftDashes;
      // const formattedMessage =
      //   "─".repeat(leftDashes) + messageText + "─".repeat(rightDashes);

      // addOutputEntry({
      //   id: `workspace-exited-${Date.now()}`,
      //   component: (
      //     <Box width={terminalWidth}>
      //       <Text dimColor>{formattedMessage}</Text>
      //     </Box>
      //   ),
      // });
      onComplete();
      return;
    }

    try {
      const workspace = await getWorkspaceById(workspaceId);
      if (workspace) {
        // Add workspace selection message to output buffer
        // const workspaceName = workspace.name;
        // const terminalWidth = dimensions.paddedWidth;
        // const messageText = ` Entered: ${workspaceName} `;
        // const totalDashes = Math.max(0, terminalWidth - messageText.length);
        // const leftDashes = Math.floor(totalDashes / 2);
        // const rightDashes = totalDashes - leftDashes;
        // const formattedMessage =
        //   "─".repeat(leftDashes) + messageText + "─".repeat(rightDashes);

        // @TODO update when workspace command is back
        // addOutputEntry({
        //   id: `workspace-selected-${Date.now()}`,
        //   component: (
        //     <Box width={terminalWidth}>
        //       <Text dimColor>{formattedMessage}</Text>
        //     </Box>
        //   ),
        // });

        onComplete(workspace.name);
        return;
      }
    } catch (error) {
      console.error(error);
    }

    onComplete();
  };

  return <WorkspaceSelection onEscape={onComplete} onWorkspaceSelect={handleWorkspaceSelect} />;
}
