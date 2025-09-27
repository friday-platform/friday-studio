import { client, parseResult } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import type { WorkspaceEntry } from "@atlas/workspace";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { Select } from "../../components/select/index.ts";
import { useResponsiveDimensions } from "../../utils/useResponsiveDimensions.ts";

interface WorkspaceSelectionProps {
  onEscape: () => void;
  onWorkspaceSelect: (workspaceId: string) => void;
}

export const WorkspaceSelection = ({ onEscape, onWorkspaceSelect }: WorkspaceSelectionProps) => {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  useEffect(() => {
    const loadWorkspaces = async () => {
      const workspaceList = await parseResult(client.workspace.index.$get());
      if (workspaceList.ok) {
        // Convert daemon API format to WorkspaceEntry format for compatibility
        const compatibleWorkspaces = workspaceList.data.map((w) => ({
          id: w.id,
          name: w.name,
          path: w.path,
          configPath: `${w.path}/workspace.yml`, // Standard workspace config path
          status: w.status,
          createdAt: w.createdAt,
          lastSeen: w.lastSeen,
        }));
        setWorkspaces(compatibleWorkspaces);
        setError("");
      } else {
        setError(stringifyError(workspaceList.error));
      }

      setLoading(false);
    };
    loadWorkspaces();
  }, []);

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
          <Text dimColor>Loading workspaces...</Text>
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

  if (!workspaces || workspaces.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <Text color="yellow">No workspaces found</Text>
        </Box>
      </Box>
    );
  }

  // Create options for Select component
  const options = [
    // Add "none" option first
    { label: "(none)", value: "none" },
    // Then add all workspaces
    ...workspaces.map((workspace) => ({
      label: `${workspace.name} (${workspace.id})`,
      value: workspace.id,
    })),
  ];

  const handleSelect = (value: string) => {
    onWorkspaceSelect(value);
  };

  return (
    <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Select options={options} onChange={handleSelect} visibleOptionCount={8} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press Escape to go back</Text>
      </Box>
    </Box>
  );
};
