import { Box, useStdout } from "ink";
import { ReactNode } from "react";

interface SidebarWrapperProps {
  isActive: boolean;
  children: ReactNode;
}

export const SidebarWrapper = ({ isActive, children }: SidebarWrapperProps) => {
  const { stdout } = useStdout();
  const terminalWidth = stdout.columns;
  const sidebarWidth = Math.max(
    Math.min(Math.floor(terminalWidth * 0.25), 40),
    24
  );

  return (
    <Box
      marginLeft={1}
      borderStyle={isActive ? "round" : undefined}
      borderColor="gray"
      borderDimColor
      padding={isActive ? 0 : 1}
      flexShrink={0}
      width={sidebarWidth}
    >
      <Box flexDirection="column" paddingX={1} paddingY={1} flexShrink={0}>
        <Box flexDirection="column">{children}</Box>
      </Box>
    </Box>
  );
};
