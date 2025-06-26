import { useEffect, useState } from "react";
import { useStdout } from "ink";
import process from "node:process";

export interface ResponsiveDimensions {
  width: number;
  height: number;
  terminalWidth: number;
  terminalHeight: number;
  actualTerminalHeight: number;
  paddedWidth: number;
  paddedHeight: number;
}

export interface ResponsiveDimensionsOptions {
  minHeight?: number;
  padding?: number;
}

/**
 * Hook that provides responsive terminal dimensions with automatic updates on resize
 * @param options - Configuration options for responsive dimensions
 * @returns Object containing responsive dimensions
 */
export const useResponsiveDimensions = (
  options: ResponsiveDimensionsOptions = {},
): ResponsiveDimensions => {
  const { minHeight = 24, padding = 0 } = options;
  const { stdout } = useStdout();
  const [, setForceUpdate] = useState(0);

  // Calculate responsive dimensions based on terminal size
  const terminalWidth = stdout.columns || 80;
  const actualTerminalHeight = stdout.rows || 24;
  const terminalHeight = Math.max(minHeight, actualTerminalHeight);

  // Calculate dimensions with padding
  const paddedWidth = Math.max(0, terminalWidth - (padding * 2));
  const paddedHeight = Math.max(0, terminalHeight - (padding * 2));

  // Listen for terminal resize events
  useEffect(() => {
    const handleResize = () => {
      setForceUpdate((prev) => prev + 1);
    };

    // Listen to both resize events for better compatibility
    process.stdout.on("resize", handleResize);
    process.on("SIGWINCH", handleResize);

    return () => {
      process.stdout.off("resize", handleResize);
      process.off("SIGWINCH", handleResize);
    };
  }, []);

  return {
    width: terminalWidth,
    height: terminalHeight,
    terminalWidth,
    terminalHeight,
    actualTerminalHeight,
    paddedWidth,
    paddedHeight,
  };
};
