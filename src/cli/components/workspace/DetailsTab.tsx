import { Box, Text } from "ink";
import { NewWorkspaceConfig } from "../../../core/config-loader.ts";

interface DetailsTabProps {
  config: NewWorkspaceConfig;
  workspaceSlug: string;
}

export const DetailsTab = ({ config, workspaceSlug }: DetailsTabProps) => {
  return (
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
  );
};
