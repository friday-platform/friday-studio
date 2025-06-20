import { Box, Text } from "ink";
import { WorkspaceConfig } from "../../utils/workspace-loader.ts";

interface SessionsTabProps {
  config: WorkspaceConfig;
}

export const SessionsTab = ({ config: _config }: SessionsTabProps) => {
  return (
    <Box flexDirection="column" padding={2}>
      <Text color="gray">No active sessions</Text>
    </Box>
  );
};
