import { Box, Text } from "ink";
import { NewWorkspaceConfig } from "../../../core/config-loader.ts";

interface SessionsTabProps {
  config: NewWorkspaceConfig;
}

export const SessionsTab = ({ config: _config }: SessionsTabProps) => {
  return (
    <Box flexDirection="column" padding={2}>
      <Text color="gray">No active sessions</Text>
    </Box>
  );
};
