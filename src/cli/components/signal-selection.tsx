import { Box, Text, useInput, useStdout } from "ink";
import { Select } from "./select/index.ts";
import { useEffect, useState } from "react";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";
import { checkDaemonRunning } from "../utils/daemon-client.ts";
import { getAtlasClient } from "@atlas/client";

interface SignalSelectionProps {
  workspaceId: string;
  onEscape: () => void;
  onSignalSelect: (signalId: string) => void;
}

interface SignalEntry {
  id: string;
  name: string;
  description?: string;
}

export const SignalSelection = ({
  workspaceId,
  onEscape,
  onSignalSelect,
}: SignalSelectionProps) => {
  const [signals, setSignals] = useState<SignalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  useEffect(() => {
    const loadSignals = async () => {
      try {
        if (await checkDaemonRunning()) {
          const client = getAtlasClient();
          const signalList = await client.listSignals(workspaceId);

          const signals = Object.entries(signalList).map(([name, signal]) => ({
            id: name,
            name: name,
            description: signal.description || undefined,
          }));

          setSignals(signals);
        } else {
          setSignals([]);
          setError(
            "Daemon not running. Use 'atlas daemon start' to enable signal management.",
          );
        }
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };
    loadSignals();
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
          <Text dimColor>Loading signals...</Text>
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

  if (!signals || signals.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <Text color="yellow">No signals found</Text>
        </Box>
      </Box>
    );
  }

  // Create options for Select component
  const options = signals.map((signal) => ({
    label: signal.description ? `${signal.name} - ${signal.description}` : signal.name,
    value: signal.id,
  }));

  const handleSelect = (value: string) => {
    onSignalSelect(value);
  };

  return (
    <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Select
          options={options}
          onChange={handleSelect}
          visibleOptionCount={8}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press Escape to go back</Text>
      </Box>
    </Box>
  );
};
