import { useEffect, useState } from "react";
import { Box, Spacer, Text, useApp, useInput, useStdout } from "ink";
import { useTabNavigation } from "./tabs.tsx";
import { getWorkspaceManager } from "../../core/workspace-manager.ts";
import { WorkspaceConfig } from "@atlas/config";
import { AgentsTab, DetailsTab, LogsTab, SessionsTab, SignalsTab } from "./workspace/index.ts";

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
  const { stdout } = useStdout();
  const terminalWidth = stdout.columns;

  const { activeTab, previousTab, nextTab } = useTabNavigation({
    tabCount: tabLabels.length,
    initialTab: 0,
  });

  useEffect(() => {
    const loadConfig = async () => {
      setLoading(true);
      const registry = getWorkspaceManager();
      const workspaceConfig = await registry.getWorkspaceConfigBySlug(
        workspaceSlug,
      );
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

      if (lastEscapeTime && now - lastEscapeTime <= 750) {
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
        flexShrink={0}
        paddingBottom={1}
      >
        <Text bold>&nbsp;{config.workspace.name}</Text>

        <Spacer />

        <Box flexDirection="row">
          {tabLabels.map((label, index) => (
            <Box key={index}>
              <Text
                backgroundColor={index === activeTab ? "" : "#353637"}
                bold={index === activeTab}
                color="#ffffff"
              >
                &nbsp;{label}&nbsp;
              </Text>
            </Box>
          ))}
        </Box>
      </Box>

      {/* Tab Content */}
      <Box flexDirection="column" flexGrow={1} width="100%">
        {activeTab === 0 && <DetailsTab config={config} workspaceSlug={workspaceSlug} />}

        {activeTab === 1 && <AgentsTab config={config} />}

        {activeTab === 2 && <SessionsTab config={config} />}

        {activeTab === 3 && <LogsTab config={config} />}

        {activeTab === 4 && <SignalsTab config={config} />}
      </Box>
    </Box>
  );
};
