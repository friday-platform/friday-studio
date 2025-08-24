import { useState } from "react";
import { AgentSelection } from "../../components/agent-selection.tsx";
import { useAppContext } from "../../contexts/app-context.tsx";
import { WorkspaceSelection } from "./workspace-selection.tsx";

interface AgentCommandProps {
  onComplete: () => void;
}

type AgentFlowState = "workspace-selection" | "agent-selection";

export function AgentCommand({ onComplete }: AgentCommandProps) {
  const { conversationClient, conversationSessionId } = useAppContext();

  const [flowState, setFlowState] = useState<AgentFlowState>("workspace-selection");
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);

  const handleWorkspaceSelect = (workspaceId: string) => {
    setSelectedWorkspace(workspaceId);
    setFlowState("agent-selection");
  };

  const handleAgentSelect = (agentId: string) => {
    if (!conversationClient || !conversationSessionId) {
      onComplete();
      return;
    }

    conversationClient.sendPrompt(conversationSessionId, {
      workspaceId: selectedWorkspace,
      promptName: "agent_describe",
      agentId: agentId,
    });

    onComplete();
  };

  switch (flowState) {
    case "workspace-selection":
      return <WorkspaceSelection onEscape={onComplete} onWorkspaceSelect={handleWorkspaceSelect} />;

    case "agent-selection":
      return selectedWorkspace ? (
        <AgentSelection
          workspaceId={selectedWorkspace}
          onEscape={onComplete}
          onAgentSelect={handleAgentSelect}
        />
      ) : null;

    default:
      return null;
  }
}
