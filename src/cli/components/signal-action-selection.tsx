import { Box, Text, useInput } from "ink";
import { Select } from "@inkjs/ui";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";

interface SignalActionSelectionProps {
  signalId: string;
  onEscape: () => void;
  onActionSelect: (action: string) => void;
}

const SIGNAL_ACTIONS = [
  { label: "Describe - Show signal details and documentation", value: "describe" },
  { label: "Trigger - Send signal with custom input", value: "trigger" },
];

export const SignalActionSelection = ({
  signalId,
  onEscape,
  onActionSelect,
}: SignalActionSelectionProps) => {
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  // Handle escape key
  useInput((_input, key) => {
    if (key.escape) {
      onEscape();
      return;
    }
  });

  const handleSelect = (value: string) => {
    onActionSelect(value);
  };

  return (
    <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Signal: {signalId}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>Choose an action:</Text>
      </Box>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Select options={SIGNAL_ACTIONS} onChange={handleSelect} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press Escape to go back</Text>
      </Box>
    </Box>
  );
};
