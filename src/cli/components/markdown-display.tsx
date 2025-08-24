import { Box, Text } from "ink";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";
import { Collapsible } from "./collapsible.tsx";

interface MarkdownDisplayProps {
  markdown: string;
  totalLines?: number;
  showCollapsible?: boolean;
}

export const MarkdownDisplay = ({
  markdown,
  totalLines,
  showCollapsible = false,
}: MarkdownDisplayProps) => {
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  return showCollapsible ? (
    <Collapsible totalLines={totalLines}>
      <Text>{markdown}</Text>
    </Collapsible>
  ) : (
    <Box flexShrink={0} width={dimensions.paddedWidth}>
      <Text>{markdown}</Text>
    </Box>
  );
};
