import { useState } from "react";
import { Text } from "ink";
import { WorkspaceSelection } from "./workspace-selection.tsx";
import { JobSelection } from "../../components/job-selection.tsx";
import { useAppContext } from "../../contexts/app-context.tsx";
import { handleDescribeMCP } from "./utils/mcp-utils.ts";
import { OutputEntry } from "./index.ts";

interface JobCommandProps {
  onComplete: () => void;
}

type JobFlowState = "workspace-selection" | "job-selection";

export function JobCommand({ onComplete }: JobCommandProps) {
  const {
    mcpClient,
    conversationClient,
    conversationSessionId,
    setOutputBuffer,
    setTypingState,
  } = useAppContext();

  const [flowState, setFlowState] = useState<JobFlowState>(
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
    setFlowState("job-selection");
  };

  const handleJobSelect = async (jobName: string) => {
    if (!selectedWorkspace) {
      addOutputEntry({
        id: `job-error-${Date.now()}`,
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
        itemId: jobName,
        promptName: "job_describe",
        itemType: "job",
        setOutputBuffer,
        setTypingState,
      });
    } catch (error) {
      addOutputEntry({
        id: `error-${Date.now()}`,
        component: (
          <Text color="red">
            Error fetching job details: {error instanceof Error ? error.message : String(error)}
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

    case "job-selection":
      return selectedWorkspace
        ? (
          <JobSelection
            workspaceId={selectedWorkspace}
            onEscape={onComplete}
            onJobSelect={handleJobSelect}
          />
        )
        : null;

    default:
      return null;
  }
}
