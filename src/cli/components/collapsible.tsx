import { Box, Text } from "ink";
import { useAppContext } from "../contexts/app-context.tsx";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";

interface CollapsibleProps {
  children: React.ReactNode;
  totalLines?: number;
}

const visibleLines = 10;

export const Collapsible = ({ children, totalLines }: CollapsibleProps) => {
  const { isCollapsed } = useAppContext();
  const shouldCollapse = totalLines != null && totalLines > visibleLines;
  const remainingLines = totalLines ? totalLines - visibleLines : 0;
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  // If content has 10 or fewer lines, don't apply any restrictions
  if (!shouldCollapse) {
    return <Box flexDirection="column">{children}</Box>;
  }

  // Content has more than 10 lines
  if (isCollapsed) {
    return (
      <Box flexDirection="column" width={dimensions.paddedWidth} height={10}>
        <Box height={visibleLines} overflow="hidden" width={dimensions.paddedWidth}>
          {children}
        </Box>
        <Box paddingTop={1} width={dimensions.paddedWidth}>
          <Text dimColor>...+{remainingLines} rows, press ctrl+r to expand</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={dimensions.paddedWidth}>
      {children}
      <Box paddingTop={1} width={dimensions.paddedWidth}>
        <Text dimColor>ctrl+r to collapse</Text>
      </Box>
    </Box>
  );
};
