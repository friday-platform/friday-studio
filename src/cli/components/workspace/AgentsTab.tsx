import { Box, Text } from "ink";
import { WorkspaceConfig } from "../../utils/workspace-loader.ts";

interface AgentsTabProps {
  config: WorkspaceConfig;
}

export const AgentsTab = ({ config }: AgentsTabProps) => {
  return (
    <Box flexDirection="column" padding={2}>
      {config.agents
        ? (
          Object.entries(config.agents).map(
            ([agentId, agent]: [string, Record<string, unknown>]) => (
              <Box key={agentId} flexDirection="column" marginBottom={2}>
                <Text bold color="cyan">
                  {agentId}
                </Text>
                <Text color="gray">Type: {agent.type || "Unknown"}</Text>
                {agent.model && <Text color="gray">Model: {agent.model}</Text>}
                {agent.purpose && <Text color="yellow">{agent.purpose}</Text>}
              </Box>
            ),
          )
        )
        : <Text color="gray">No agents configured</Text>}
    </Box>
  );
};
