import { Box, Text } from "ink";
import { NewWorkspaceConfig } from "../../../core/config-loader.ts";

interface LogsTabProps {
  config: NewWorkspaceConfig;
}

export const LogsTab = ({ config: _config }: LogsTabProps) => {
  return (
    <Box flexDirection="column" padding={2}>
      <Text color="gray">No logs available</Text>
    </Box>
  );
};
