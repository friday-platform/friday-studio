import { Box, Text } from "ink";
import { WorkspaceConfig } from "../../utils/workspace-loader.ts";

interface SignalsTabProps {
  config: WorkspaceConfig;
}

export const SignalsTab = ({ config }: SignalsTabProps) => {
  return (
    <Box flexDirection="column" padding={2}>
      {config.signals
        ? (
          Object.entries(config.signals).map(
            ([signalId, signal]: [string, Record<string, unknown>]) => (
              <Box key={signalId} flexDirection="column" marginBottom={2}>
                <Text bold color="magenta">
                  {signalId}
                </Text>
                <Text color="gray">
                  Provider: {signal.provider || "Unknown"}
                </Text>
                {signal.description && <Text color="yellow">{signal.description}</Text>}
              </Box>
            ),
          )
        )
        : <Text color="gray">No signals configured</Text>}
    </Box>
  );
};
