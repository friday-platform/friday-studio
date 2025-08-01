import { useState } from "react";
import { WorkspaceSelection } from "./workspace-selection.tsx";
import { SessionSelection } from "../../components/session-selection.tsx";
import { useAppContext } from "../../contexts/app-context.tsx";

interface SessionCommandProps {
  onComplete: () => void;
}

type SessionFlowState = "workspace-selection" | "session-selection";

export function SessionCommand({ onComplete }: SessionCommandProps) {
  const { conversationClient, conversationSessionId } = useAppContext();

  const [flowState, setFlowState] = useState<SessionFlowState>(
    "workspace-selection",
  );
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(
    null,
  );

  const handleWorkspaceSelect = (workspaceId: string) => {
    setSelectedWorkspace(workspaceId);
    setFlowState("session-selection");
  };

  const handleSessionSelect = (sessionId: string) => {
    if (!conversationClient || !conversationSessionId) {
      onComplete();
      return;
    }

    conversationClient.sendPrompt(conversationSessionId, {
      workspaceId: selectedWorkspace,
      promptName: "session_describe",
      sessionId,
    });

    onComplete();
  };

  switch (flowState) {
    case "workspace-selection":
      return (
        <WorkspaceSelection
          onEscape={onComplete}
          onWorkspaceSelect={handleWorkspaceSelect}
        />
      );

    case "session-selection":
      return selectedWorkspace
        ? (
          <SessionSelection
            workspaceId={selectedWorkspace}
            onEscape={onComplete}
            onSessionSelect={handleSessionSelect}
          />
        )
        : null;

    default:
      return null;
  }
}
