import { useState } from "react";
import { Text } from "ink";
import { WorkspaceSelection } from "./workspace-selection.tsx";
import { AgentSelection } from "../../components/agent-selection.tsx";
import { useAppContext } from "../../contexts/app-context.tsx";
import { handleDescribeMCP } from "./utils/mcp-utils.ts";
import { OutputEntry } from "./index.ts";

interface AgentCommandProps {
  onComplete: () => void;
}

type AgentFlowState = "workspace-selection" | "agent-selection";

export function AgentCommand({ onComplete }: AgentCommandProps) {
  const {
    mcpClient,
    conversationClient,
    conversationSessionId,
    setOutputBuffer,
    setIsTyping,
  } = useAppContext();

  const [flowState, setFlowState] = useState<AgentFlowState>(
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
    setFlowState("agent-selection");
  };

  const handleAgentSelect = async (agentId: string) => {
    if (!selectedWorkspace) {
      addOutputEntry({
        id: `agent-error-${Date.now()}`,
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
        itemId: agentId,
        promptName: "agent_describe",
        itemType: "agent",
        setOutputBuffer,
        setIsTyping,
      });
    } catch (error) {
      addOutputEntry({
        id: `error-${Date.now()}`,
        component: (
          <Text color="red">
            Error fetching agent details: {error instanceof Error ? error.message : String(error)}
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

    case "agent-selection":
      return selectedWorkspace
        ? (
          <AgentSelection
            workspaceId={selectedWorkspace}
            onEscape={onComplete}
            onAgentSelect={handleAgentSelect}
          />
        )
        : null;

    default:
      return null;
  }
}
