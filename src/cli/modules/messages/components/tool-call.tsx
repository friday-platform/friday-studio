import { Box, Text } from "ink";
import { getNormalizedToolName } from "../utils.ts";

export function ToolCall({ metadata }: { metadata?: Record<string, unknown> }) {
  if (!metadata || !metadata.toolName || typeof metadata.toolName !== "string") {
    return null;
  }

  return (
    <Box flexShrink={0}>
      <Text dimColor bold>
        ⊣ {getNormalizedToolName(metadata.toolName)} ⊢
      </Text>
    </Box>
  );
}
