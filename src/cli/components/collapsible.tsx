import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useAppContext } from "../contexts/app-context.tsx";

interface CollapsibleProps {
  children: React.ReactNode;
  defaultCollapsed?: boolean;
  totalLines?: number;
}

export const Collapsible = ({
  children,
  defaultCollapsed = true,
  totalLines,
}: CollapsibleProps) => {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const visibleLines = 10;
  const shouldCollapse = totalLines != null && totalLines > visibleLines;
  const remainingLines = totalLines ? totalLines - visibleLines : 0;
  const { isLeaderKeyActive } = useAppContext();

  useInput(
    (input) => {
      if (input === "r") {
        console.log(""); // hack to ensure the output rerenders :(
        setIsCollapsed((prev) => !prev);
      }
    },
    { isActive: isLeaderKeyActive },
  );

  // If content has 10 or fewer lines, don't apply any restrictions
  if (!shouldCollapse) {
    return <Box flexDirection="column">{children}</Box>;
  }

  // Content has more than 10 lines
  if (isCollapsed) {
    return (
      <Box flexDirection="column">
        <Box height={visibleLines} overflow="hidden">
          {children}
        </Box>
        <Box paddingTop={1}>
          <Text dimColor>
            ...+{remainingLines} rows, press ctrl+x, then r to expand
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {children}
      <Box paddingTop={1}>
        <Text dimColor>r to collapse</Text>
      </Box>
    </Box>
  );
};
