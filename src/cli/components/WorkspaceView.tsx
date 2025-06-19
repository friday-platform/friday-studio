import { useEffect, useState } from "react";
import { Box, Spacer, Text, useApp, useInput } from "ink";
import { useTabNavigation } from "./tabs.tsx";
import {
  loadWorkspaceConfig,
  WorkspaceConfig,
} from "../utils/workspace-loader.ts";

interface WorkspaceViewProps {
  workspaceSlug: string;
  onBack: () => void;
}

export const WorkspaceView = ({
  workspaceSlug,
  onBack,
}: WorkspaceViewProps) => {
  const { exit } = useApp();
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastEscapeTime, setLastEscapeTime] = useState<number | null>(null);
  const tabLabels = ["Details", "Agents", "Sessions", "Logs", "Signals"];

  const { activeTab, previousTab, nextTab } = useTabNavigation({
    tabCount: tabLabels.length,
    initialTab: 0,
  });

  useEffect(() => {
    const loadConfig = async () => {
      setLoading(true);
      const workspaceConfig = await loadWorkspaceConfig(workspaceSlug);
      setConfig(workspaceConfig);
      setLoading(false);
    };

    loadConfig();
  }, [workspaceSlug]);

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      exit();
      return;
    }

    if (key.escape) {
      const now = Date.now();
      
      if (lastEscapeTime && (now - lastEscapeTime) <= 750) {
        // Double escape within 750ms - trigger onBack
        onBack();
        return;
      }
      
      // First escape or too much time passed - just record the time
      setLastEscapeTime(now);
      return;
    }

    if (key.leftArrow && key.meta && key.shift) {
      previousTab();
    } else if (key.rightArrow && key.meta && key.shift) {
      nextTab();
    }
  });

  if (loading) {
    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        height="100%"
        width="100%"
      >
        <Text>Loading workspace configuration...</Text>
      </Box>
    );
  }

  if (!config) {
    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        height="100%"
        width="100%"
      >
        <Text color="red">Failed to load workspace configuration</Text>
        <Text color="gray">Press Escape twice to go back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%" width="100%">
      {/* Title and Tabs Row */}
      <Box
        flexDirection="row"
        alignItems="center"
        paddingX={2}
        paddingY={1}
        borderStyle="single"
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderColor="gray"
        borderDimColor
      >
        <Text bold>{config.workspace.name}</Text>
        <Spacer />
        <Box flexDirection="row" gap={3}>
          {tabLabels.map((label, index) => (
            <Box key={index}>
              <Text
                bold={index === activeTab}
                color={index === activeTab ? "blue" : ""}
                dimColor={index !== activeTab}
              >
                {label}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>

      {/* Border separator */}
      <Box borderBottom borderColor="gray" />

      {/* Tab Content */}
      <Box flexDirection="column" flexGrow={1} width="100%">
        {activeTab === 0 && (
          <Box flexDirection="column" padding={2}>
            <Box marginBottom={2}>
              <Text color="gray">Workspace ID: {config.workspace.id}</Text>
            </Box>
            <Box marginBottom={2}>
              <Text color="gray">Slug: {workspaceSlug}</Text>
            </Box>
            <Box marginTop={4}>
              <Text color="gray">Press Escape twice to go back</Text>
              <Text color="gray">Use Alt+← → to navigate tabs</Text>
            </Box>
          </Box>
        )}

        {activeTab === 1 && (
          <Box flexDirection="column" padding={2}>
            {config.agents ? (
              Object.entries(config.agents).map(
                ([agentId, agent]: [string, Record<string, unknown>]) => (
                  <Box key={agentId} flexDirection="column" marginBottom={2}>
                    <Text bold color="cyan">
                      {agentId}
                    </Text>
                    <Text color="gray">Type: {agent.type || "Unknown"}</Text>
                    {agent.model && (
                      <Text color="gray">Model: {agent.model}</Text>
                    )}
                    {agent.purpose && (
                      <Text color="yellow">{agent.purpose}</Text>
                    )}
                  </Box>
                )
              )
            ) : (
              <Text color="gray">No agents configured</Text>
            )}
          </Box>
        )}

        {activeTab === 2 && (
          <Box flexDirection="column" padding={2}>
            <Text color="gray">No active sessions</Text>
          </Box>
        )}

        {activeTab === 3 && (
          <Box flexDirection="column" padding={2}>
            <Text color="gray">No logs available</Text>
          </Box>
        )}

        {activeTab === 4 && (
          <Box flexDirection="column" padding={2}>
            {config.signals ? (
              Object.entries(config.signals).map(
                ([signalId, signal]: [string, Record<string, unknown>]) => (
                  <Box key={signalId} flexDirection="column" marginBottom={2}>
                    <Text bold color="magenta">
                      {signalId}
                    </Text>
                    <Text color="gray">
                      Provider: {signal.provider || "Unknown"}
                    </Text>
                    {signal.description && (
                      <Text color="yellow">{signal.description}</Text>
                    )}
                  </Box>
                )
              )
            ) : (
              <Text color="gray">No signals configured</Text>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
};
