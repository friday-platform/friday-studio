import React from "react";
import { Box, Text } from "ink";

export interface AvailableWorkspace {
  name: string;
  path: string;
  description?: string;
}

interface SplashScreenProps {
  availableWorkspaces: AvailableWorkspace[];
  workspacesLoading: boolean;
  selectedWorkspaceIndex: number;
  onWorkspaceSelect: (workspace: AvailableWorkspace) => void;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({
  availableWorkspaces,
  workspacesLoading,
  selectedWorkspaceIndex,
  onWorkspaceSelect,
}: SplashScreenProps) => (
  <Box
    flexDirection="column"
    justifyContent="center"
    height="100%"
    width="100%"
    paddingX={4}
    backgroundColor="bgBlue"
  >
    <Box flexDirection="row" gap={4}>
      {/* Left Column */}
      <Box flexDirection="column" width="70%">
        <Box flexDirection="column" marginBottom={3}>
          <Box>
            <Text color="yellow" bold>
              Welcome to Atlas TUI
            </Text>
          </Box>
          <Box>
            <Text color="gray">
              Transform software delivery through human/AI collaboration
            </Text>
          </Box>
        </Box>

        <Box flexDirection="column" marginBottom={3}>
          <Box>
            <Text color="red" bold>
              No workspace.yml found in current directory
            </Text>
          </Box>
          <Box>
            <Text color="white">
              You need to create a workspace to get started
            </Text>
          </Box>
        </Box>

        <Box flexDirection="column">
          <Box>
            <Text bold color="green">
              Quick Start Options:
            </Text>
          </Box>
          <Box flexDirection="column" marginTop={1} gap={1}>
            <Box>
              <Text>
                <Text color="cyan">/init</Text> - Initialize a new workspace in this directory
              </Text>
            </Box>
            <Box>
              <Text>
                <Text color="cyan">reload</Text> - Reload TUI after creating workspace.yml
              </Text>
            </Box>
          </Box>
        </Box>
      </Box>

      {/* Right Column */}
      <Box flexDirection="column" width="30%">
        {workspacesLoading && (
          <Box flexDirection="column">
            <Box>
              <Text color="cyan">Scanning for workspaces...</Text>
            </Box>
          </Box>
        )}

        {!workspacesLoading && availableWorkspaces.length > 0 && (
          <Box flexDirection="column">
            <Box>
              <Text bold color="blue">
                Available Workspaces:
              </Text>
            </Box>
            <Box>
              <Text color="gray" dimColor>
                (Found {availableWorkspaces.length} workspaces)
              </Text>
            </Box>
            <Box flexDirection="column" marginTop={1} gap={1}>
              {availableWorkspaces.map(
                (workspace: AvailableWorkspace, index: number) => {
                  const isSelected = index === selectedWorkspaceIndex;
                  return (
                    <Box key={index} flexDirection="column" marginBottom={1}>
                      <Box>
                        <Text
                          color={isSelected ? "black" : "yellow"}
                          bold
                          backgroundColor={isSelected ? "white" : undefined}
                        >
                          {isSelected ? "▶ " : ""}
                          {workspace.name}
                          {isSelected ? " [ENTER to load]" : ""}
                        </Text>
                      </Box>
                      {workspace.description && (
                        <Box>
                          <Text
                            color={isSelected ? "black" : "gray"}
                            backgroundColor={isSelected ? "white" : undefined}
                          >
                            {workspace.description}
                          </Text>
                        </Box>
                      )}
                    </Box>
                  );
                },
              )}
            </Box>
            {availableWorkspaces.length > 0 && (
              <Box marginTop={1}>
                <Text color="gray" dimColor>
                  Use j/k or arrow keys to navigate, Enter to load workspace
                </Text>
              </Box>
            )}
          </Box>
        )}

        {!workspacesLoading && availableWorkspaces.length === 0 && (
          <Box flexDirection="column">
            <Box>
              <Text color="gray" dimColor>
                No workspaces found
              </Text>
            </Box>
          </Box>
        )}
      </Box>
    </Box>

    <Box marginTop={4} alignSelf="center">
      <Text color="gray" dimColor>
        Press Ctrl+C to exit | Tab to navigate | Type / to start commands
      </Text>
    </Box>
  </Box>
);
