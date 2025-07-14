import { useState } from "react";
import { Box, Text } from "ink";

import { WorkspaceSelection } from "./workspace-selection.tsx";
import { SignalSelection } from "../../components/signal-selection.tsx";
import { SignalActionSelection } from "../../components/signal-action-selection.tsx";
import { SignalTriggerInput } from "../../components/signal-trigger-input.tsx";
import { useAppContext } from "../../contexts/app-context.tsx";
import { triggerSignalSimple } from "../signals/trigger.ts";
import { handleDescribeMCP } from "./utils/mcp-utils.ts";
import { OutputEntry } from "./index.ts";

interface SignalCommandProps {
  onComplete: () => void;
}

type SignalFlowState =
  | "workspace-selection"
  | "signal-selection"
  | "action-selection"
  | "trigger-input";

export function SignalCommand({ onComplete }: SignalCommandProps) {
  const {
    mcpClient,
    conversationClient,
    conversationSessionId,
    setOutputBuffer,
    setIsTyping,
  } = useAppContext();

  const [flowState, setFlowState] = useState<SignalFlowState>(
    "workspace-selection",
  );
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(
    null,
  );
  const [selectedSignal, setSelectedSignal] = useState<string | null>(null);

  const addOutputEntry = (entry: OutputEntry) => {
    setOutputBuffer((prev) => [...prev, entry]);
  };

  const handleWorkspaceSelect = (workspaceId: string) => {
    setSelectedWorkspace(workspaceId);
    setFlowState("signal-selection");
  };

  const handleSignalSelect = (signalId: string) => {
    setSelectedSignal(signalId);
    setFlowState("action-selection");
  };

  const handleActionSelect = async (action: string) => {
    if (!selectedWorkspace || !selectedSignal) {
      addOutputEntry({
        id: `signal-error-${Date.now()}`,
        component: <Text color="red">Error: No workspace or signal selected</Text>,
      });
      onComplete();
      return;
    }

    if (action === "describe") {
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
          itemId: selectedSignal,
          promptName: "signal_describe",
          itemType: "signal",
          setOutputBuffer,
          setIsTyping,
        });
      } catch (error) {
        addOutputEntry({
          id: `error-${Date.now()}`,
          component: (
            <Text color="red">
              Error fetching signal details:{" "}
              {error instanceof Error ? error.message : String(error)}
            </Text>
          ),
        });
      }

      onComplete();
    } else if (action === "trigger") {
      setFlowState("trigger-input");
    }
  };

  const handleTriggerSubmit = async (input: string) => {
    if (!selectedWorkspace || !selectedSignal) {
      addOutputEntry({
        id: `signal-trigger-error-${Date.now()}`,
        component: <Text color="red">Error: No workspace or signal selected</Text>,
      });
      onComplete();
      return;
    }

    // Add loading indicator
    addOutputEntry({
      id: `signal-trigger-loading-${Date.now()}`,
      component: (
        <Box flexDirection="column">
          <Text color="cyan">Triggering signal...</Text>
          <Text dimColor>Workspace: {selectedWorkspace}</Text>
          <Text dimColor>Signal: {selectedSignal}</Text>
          <Text dimColor>Payload: {input || "(empty)"}</Text>
        </Box>
      ),
    });

    try {
      const result = await triggerSignalSimple(
        selectedWorkspace,
        selectedSignal,
        input.trim() || undefined,
      );

      // Remove loading entry and add result
      setOutputBuffer((prev) => prev.slice(0, -1));

      if (result.success) {
        addOutputEntry({
          id: `signal-trigger-success-${Date.now()}`,
          component: (
            <Box flexDirection="column">
              <Text color="green">Signal triggered successfully!</Text>
              <Text dimColor>
                Workspace: {result.workspaceName || selectedWorkspace}
              </Text>
              <Text dimColor>Signal: {selectedSignal}</Text>
              {result.sessionId && <Text dimColor>Session ID: {result.sessionId}</Text>}
              {result.status && <Text dimColor>Status: {result.status}</Text>}
              <Text dimColor>Duration: {result.duration.toFixed(2)}ms</Text>
            </Box>
          ),
        });
      } else {
        addOutputEntry({
          id: `signal-trigger-error-${Date.now()}`,
          component: (
            <Box flexDirection="column">
              <Text color="red">Signal trigger failed</Text>
              <Text dimColor>Workspace: {selectedWorkspace}</Text>
              <Text dimColor>Signal: {selectedSignal}</Text>
              <Text color="red">Error: {result.error}</Text>
              <Text dimColor>Duration: {result.duration.toFixed(2)}ms</Text>
            </Box>
          ),
        });
      }
    } catch (error) {
      // Remove loading entry and add error
      setOutputBuffer((prev) => prev.slice(0, -1));

      addOutputEntry({
        id: `signal-trigger-exception-${Date.now()}`,
        component: (
          <Box flexDirection="column">
            <Text color="red">Unexpected error during signal trigger</Text>
            <Text dimColor>Workspace: {selectedWorkspace}</Text>
            <Text dimColor>Signal: {selectedSignal}</Text>
            <Text color="red">
              Error: {error instanceof Error ? error.message : String(error)}
            </Text>
          </Box>
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

    case "signal-selection":
      return selectedWorkspace
        ? (
          <SignalSelection
            workspaceId={selectedWorkspace}
            onEscape={onComplete}
            onSignalSelect={handleSignalSelect}
          />
        )
        : null;

    case "action-selection":
      return selectedSignal
        ? (
          <SignalActionSelection
            signalId={selectedSignal}
            onEscape={onComplete}
            onActionSelect={handleActionSelect}
          />
        )
        : null;

    case "trigger-input":
      return selectedSignal
        ? (
          <SignalTriggerInput
            signalId={selectedSignal}
            onEscape={onComplete}
            onSubmit={handleTriggerSubmit}
          />
        )
        : null;

    default:
      return null;
  }
}
