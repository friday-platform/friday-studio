import { useEffect, useState } from "react";
import { Box, useInput, useStdout } from "ink";
import process from "node:process";

interface ResponsiveContainerProps {
  children: React.ReactNode;
  minHeight: number;
  onAnyKey?: () => void;
}

export const ResponsiveContainer = ({
  children,
  minHeight,
  onAnyKey,
}: ResponsiveContainerProps) => {
  const { stdout } = useStdout();
  const [, setForceUpdate] = useState(0);

  // Calculate responsive dimensions based on terminal size
  const terminalWidth = stdout.columns || 80;
  const actualTerminalHeight = stdout.rows || 24;
  const terminalHeight = Math.max(minHeight, actualTerminalHeight);

  // Listen for terminal resize events
  useEffect(() => {
    const handleResize = () => {
      setForceUpdate((prev) => prev + 1);
    };

    // Try both approaches
    process.stdout.on("resize", handleResize);
    process.on("SIGWINCH", handleResize);

    return () => {
      process.stdout.off("resize", handleResize);
      process.off("SIGWINCH", handleResize);
    };
  }, []);

  // Optional global key handler
  useInput((_inputChar, _key) => {
    if (onAnyKey) {
      onAnyKey();
    }
  });

  return (
    <Box
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      width={terminalWidth}
      height={terminalHeight}
      padding={1}
    >
      {children}
    </Box>
  );
};
