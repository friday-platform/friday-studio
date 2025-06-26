import { Box, Text, useInput } from "ink";
import { Select } from "@inkjs/ui";
import { useEffect, useState } from "react";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";
import { checkDaemonRunning, getDaemonClient } from "../utils/daemon-client.ts";
import { loadWorkspaceConfigNoCwd } from "../modules/workspaces/resolver.ts";
import { processAgentsFromConfig } from "../modules/agents/processor.ts";

interface AgentSelectionProps {
  workspaceId: string;
  onEscape: () => void;
  onAgentSelect: (agentId: string) => void;
}

interface AgentEntry {
  id: string;
  name: string;
  type?: string;
  purpose?: string;
}

export const AgentSelection = ({
  workspaceId,
  onEscape,
  onAgentSelect,
}: AgentSelectionProps) => {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  useEffect(() => {
    const loadAgents = async () => {
      try {
        if (await checkDaemonRunning()) {
          const client = getDaemonClient();
          const workspace = await client.getWorkspace(workspaceId);
          if (!workspace) {
            throw new Error(`Workspace ${workspaceId} not found`);
          }

          const config = await loadWorkspaceConfigNoCwd(workspace.path);
          const agentList = processAgentsFromConfig(config);

          const agents = agentList.map((agent: any) => ({
            id: agent.id,
            name: agent.name || agent.id,
            type: agent.type,
            purpose: agent.purpose,
          }));

          setAgents(agents);
        } else {
          setAgents([]);
          setError("Daemon not running. Use 'atlas daemon start' to enable agent management.");
        }
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };
    loadAgents();
  }, [workspaceId]);

  // Handle escape key
  useInput((_input, key) => {
    if (key.escape) {
      onEscape();
      return;
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <Text dimColor>Loading agents...</Text>
        </Box>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      </Box>
    );
  }

  if (!agents || agents.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <Text color="yellow">No agents found</Text>
        </Box>
      </Box>
    );
  }

  // Create options for Select component
  const options = agents.map((agent) => ({
    label: agent.type ? `${agent.name} (${agent.type})` : agent.name,
    value: agent.id,
  }));

  const handleSelect = (value: string) => {
    onAgentSelect(value);
  };

  return (
    <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Select options={options} onChange={handleSelect} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press Escape to go back</Text>
      </Box>
    </Box>
  );
};
