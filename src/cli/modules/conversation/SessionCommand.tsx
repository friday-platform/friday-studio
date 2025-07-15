import { useState } from "react";
import { Text } from "ink";
import { WorkspaceSelection } from "./workspace-selection.tsx";
import { SessionSelection } from "../../components/session-selection.tsx";
import { useAppContext } from "../../contexts/app-context.tsx";
import { handleDescribeMCP } from "./utils/mcp-utils.ts";
import { OutputEntry } from "./index.ts";

interface SessionCommandProps {
  onComplete: () => void;
}

type SessionFlowState = "workspace-selection" | "session-selection";

export function SessionCommand({ onComplete }: SessionCommandProps) {
  const {
    mcpClient,
    conversationClient,
    conversationSessionId,
    setOutputBuffer,
    setTypingState,
  } = useAppContext();

  const [flowState, setFlowState] = useState<SessionFlowState>(
    "workspace-selection",
  );
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(
    null,
  );

  const addOutputEntry = (entry: OutputEntry) => {
    setOutputBuffer((prev) => [...prev, entry]);
  };

  const handleWorkspaceSelect = (workspaceId: string) => {
    setSelectedWorkspace(workspaceId);
    setFlowState("session-selection");
  };

  const handleSessionSelect = async (sessionId: string) => {
    if (!selectedWorkspace) {
      addOutputEntry({
        id: `session-error-${Date.now()}`,
        component: <Text color="red">Error: No workspace selected</Text>,
      });
      onComplete();
      return;
    }

    if (!mcpClient) {
      addOutputEntry({
        id: `mcp-error-${Date.now()}`,
        component: <Text color="red">MCP client not initialized</Text>,
      });
      onComplete();
      return;
    }

    if (!conversationClient || !conversationSessionId) {
      addOutputEntry({
        id: `conversation-error-${Date.now()}`,
        component: <Text color="red">Conversation system not initialized</Text>,
      });
      onComplete();
      return;
    }

    try {
      await handleDescribeMCP({
        mcpClient,
        conversationClient,
        conversationSessionId,
        workspaceId: selectedWorkspace,
        itemId: sessionId,
        promptName: "session_describe",
        itemType: "session",
        setOutputBuffer,
        setTypingState,
      });
    } catch (error) {
      addOutputEntry({
        id: `error-${Date.now()}`,
        component: (
          <Text color="red">
            Error fetching session details: {error instanceof Error ? error.message : String(error)}
          </Text>
        ),
      });
    }

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
