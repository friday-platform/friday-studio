import { useState } from "react";
import { SignalSelection } from "../../components/signal-selection.tsx";
import { SignalTriggerInput } from "../../components/signal-trigger-input.tsx";
import { useAppContext } from "../../contexts/app-context.tsx";
import { WorkspaceSelection } from "./workspace-selection.tsx";

interface SignalCommandProps {
  onComplete: () => void;
}

type SignalFlowState = "workspace-selection" | "signal-selection" | "trigger-input";

export function SignalCommand({ onComplete }: SignalCommandProps) {
  const { conversationClient, conversationSessionId } = useAppContext();

  const [flowState, setFlowState] = useState<SignalFlowState>("workspace-selection");
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const [selectedSignal, setSelectedSignal] = useState<string | null>(null);

  const handleWorkspaceSelect = (workspaceId: string) => {
    setSelectedWorkspace(workspaceId);
    setFlowState("signal-selection");
  };

  const handleSignalSelect = (signalId: string) => {
    setSelectedSignal(signalId);
    setFlowState("trigger-input");
  };

  const handleTriggerSubmit = (input: string) => {
    if (!conversationClient || !conversationSessionId) {
      return;
    }

    conversationClient.sendPrompt(conversationSessionId, {
      workspaceId: selectedWorkspace,
      promptName: "signal_trigger",
      signalId: selectedSignal,
      payload: input,
    });

    onComplete();
  };

  switch (flowState) {
    case "workspace-selection":
      return <WorkspaceSelection onEscape={onComplete} onWorkspaceSelect={handleWorkspaceSelect} />;

    case "signal-selection":
      return selectedWorkspace ? (
        <SignalSelection
          workspaceId={selectedWorkspace}
          onEscape={onComplete}
          onSignalSelect={handleSignalSelect}
        />
      ) : null;

    case "trigger-input":
      return selectedSignal ? (
        <SignalTriggerInput
          signalId={selectedSignal}
          onEscape={onComplete}
          onSubmit={handleTriggerSubmit}
        />
      ) : null;

    default:
      return null;
  }
}
