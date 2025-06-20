import { Box, Text } from "ink";
import { WorkspaceConfig } from "../../utils/workspace-loader.ts";

interface LogsTabProps {
  config: WorkspaceConfig;
}

export const LogsTab = ({ config: _config }: LogsTabProps) => {
  return (
    <Box flexDirection="column" padding={2}>
      <Text color="gray">No logs available</Text>
    </Box>
  );
};
