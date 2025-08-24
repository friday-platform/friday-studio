import type { WorkspaceSignalConfig } from "@atlas/config";
import { Box, Text } from "ink";

// Component that renders the signal list
export function SignalListComponent({
  signalEntries,
  workspaceName,
}: {
  signalEntries: Array<[string, WorkspaceSignalConfig]>;
  workspaceName: string;
}) {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Signals in workspace: {workspaceName}
      </Text>
      <Text color="gray">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
      {signalEntries.length === 0 ? (
        <Text color="gray">No signals configured</Text>
      ) : (
        <>
          <Box>
            <Box width={20}>
              <Text bold color="cyan">
                SIGNAL
              </Text>
            </Box>
            <Box width={15}>
              <Text bold color="cyan">
                PROVIDER
              </Text>
            </Box>
            <Box width={50}>
              <Text bold color="cyan">
                DESCRIPTION
              </Text>
            </Box>
          </Box>
          <Text>
            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          </Text>
          {signalEntries.map(([id, signal]) => (
            <Box key={id}>
              <Box width={20}>
                <Text>{id}</Text>
              </Box>
              <Box width={15}>
                <Text>{signal.provider}</Text>
              </Box>
              <Box width={50}>
                <Text>{signal.description || "-"}</Text>
              </Box>
            </Box>
          ))}
        </>
      )}
    </Box>
  );
}
