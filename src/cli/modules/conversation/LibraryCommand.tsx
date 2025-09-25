import { useAppContext } from "../../contexts/app-context.tsx";
import { getDaemonClient } from "../../utils/daemon-client.ts";
import { WorkspaceSelection } from "./workspace-selection.tsx";

interface LibraryCommandProps {
  onComplete: () => void;
}

export function LibraryCommand({ onComplete }: LibraryCommandProps) {
  const { conversationClient, conversationSessionId } = useAppContext();

  const getWorkspaceById = async (workspaceId: string) => {
    try {
      const client = getDaemonClient();
      return await client.getWorkspace(workspaceId);
    } catch {
      return null;
    }
  };

  const handleWorkspaceSelect = async (workspaceId: string) => {
    if (!conversationClient || !conversationSessionId) {
      onComplete();
      return;
    }

    try {
      const workspace = await getWorkspaceById(workspaceId);

      if (!workspace) {
        throw new Error(`Workspace ${workspaceId} not found`);
      }

      conversationClient.sendPrompt(conversationSessionId, {
        workspaceId: workspace.id,
        promptName: "library_list",
      });
    } catch (error) {
      console.error(error);
    }

    onComplete();
  };

  return <WorkspaceSelection onEscape={onComplete} onWorkspaceSelect={handleWorkspaceSelect} />;
}
