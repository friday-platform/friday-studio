import { join } from "node:path";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { Box, Text } from "ink";

interface Agent {
  name: string;
  type: string;
  model: string;
  status: string;
  purpose: string;
}

// Component that renders the agent list
export function AgentListComponent({
  agents,
  workspaceName,
  source,
}: {
  agents: Agent[];
  workspaceName: string;
  source?: "user" | "workspace";
}) {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {source === "user"
          ? `User agents (${join(getAtlasHome(), "agents")})`
          : `Agents in workspace: ${workspaceName}`}
      </Text>
      <Text color="gray">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
      {agents.length === 0 ? (
        <Text color="gray">No agents configured</Text>
      ) : (
        <>
          <Box>
            <Box width={25}>
              <Text bold color="cyan">
                AGENT
              </Text>
            </Box>
            <Box width={10}>
              <Text bold color="cyan">
                TYPE
              </Text>
            </Box>
            <Box width={30}>
              <Text bold color="cyan">
                MODEL
              </Text>
            </Box>
            <Box width={10}>
              <Text bold color="cyan">
                STATUS
              </Text>
            </Box>
            <Box width={45}>
              <Text bold color="cyan">
                PURPOSE
              </Text>
            </Box>
          </Box>
          <Text>
            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          </Text>
          {agents.map((agent) => (
            <Box key={agent.name}>
              <Box width={25}>
                <Text>{agent.name}</Text>
              </Box>
              <Box width={10}>
                <Text>{agent.type}</Text>
              </Box>
              <Box width={30}>
                <Text>{agent.model}</Text>
              </Box>
              <Box width={10}>
                <Text color="green">{agent.status}</Text>
              </Box>
              <Box width={45}>
                <Text>{agent.purpose}</Text>
              </Box>
            </Box>
          ))}
        </>
      )}
    </Box>
  );
}
