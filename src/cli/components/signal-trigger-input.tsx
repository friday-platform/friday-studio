import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";
import { TextInput } from "../modules/input/text-input.tsx";

interface SignalTriggerInputProps {
  signalId: string;
  onEscape: () => void;
  onSubmit: (input: string) => void;
}

export const SignalTriggerInput = ({
  signalId,
  onEscape,
  onSubmit,
}: SignalTriggerInputProps) => {
  const [inputKey] = useState(0);
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  // Handle escape key
  useInput((_input, key) => {
    if (key.escape) {
      onEscape();
      return;
    }
  });

  const handleSubmit = (input: string) => {
    onSubmit(input.trim());
  };

  return (
    <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Trigger Signal: {signalId}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>Enter signal payload (JSON format recommended):</Text>
      </Box>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>→&nbsp;</Text>
        <TextInput
          key={inputKey}
          suggestions={[]}
          placeholder="Enter signal payload..."
          onChange={() => {}} // Not needed for this use case
          onSubmit={handleSubmit}
          enableAttachments={false}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press Escape to cancel, Enter to trigger signal</Text>
      </Box>
    </Box>
  );
};
