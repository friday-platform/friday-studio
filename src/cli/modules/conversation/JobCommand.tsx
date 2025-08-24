import { useState } from "react";
import { JobSelection } from "../../components/job-selection.tsx";
import { useAppContext } from "../../contexts/app-context.tsx";
import { WorkspaceSelection } from "./workspace-selection.tsx";

interface JobCommandProps {
  onComplete: () => void;
}

type JobFlowState = "workspace-selection" | "job-selection";

export function JobCommand({ onComplete }: JobCommandProps) {
  const { conversationClient, conversationSessionId } = useAppContext();

  const [flowState, setFlowState] = useState<JobFlowState>("workspace-selection");
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);

  const handleWorkspaceSelect = (workspaceId: string) => {
    setSelectedWorkspace(workspaceId);
    setFlowState("job-selection");
  };

  const handleJobSelect = (jobName: string) => {
    if (!conversationClient || !conversationSessionId) {
      onComplete();
      return;
    }

    conversationClient.sendPrompt(conversationSessionId, {
      workspaceId: selectedWorkspace,
      promptName: "job_describe",
      jobId: jobName,
    });

    onComplete();
  };

  switch (flowState) {
    case "workspace-selection":
      return <WorkspaceSelection onEscape={onComplete} onWorkspaceSelect={handleWorkspaceSelect} />;

    case "job-selection":
      return selectedWorkspace ? (
        <JobSelection
          workspaceId={selectedWorkspace}
          onEscape={onComplete}
          onJobSelect={handleJobSelect}
        />
      ) : null;

    default:
      return null;
  }
}
