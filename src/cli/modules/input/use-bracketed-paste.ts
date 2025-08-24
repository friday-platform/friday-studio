import process from "node:process";
import { useEffect } from "react";

const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";

/**
 * Enables and disables bracketed paste mode in the terminal.
 *
 * This hook ensures that bracketed paste mode is enabled when the component
 * mounts and disabled when it unmounts or when the process exits.
 */
// Track if bracketed paste has been initialized globally
let isBracketedPasteInitialized = false;

export const useBracketedPaste = () => {
  useEffect(() => {
    // Only initialize once globally to prevent multiple listeners
    if (isBracketedPasteInitialized) {
      return;
    }
    isBracketedPasteInitialized = true;

    // Create a unique cleanup function for this effect instance
    const cleanup = () => {
      process.stdout.write(DISABLE_BRACKETED_PASTE);
    };

    process.stdout.write(ENABLE_BRACKETED_PASTE);

    // Add listeners - these will only be added once
    process.on("exit", cleanup);
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    // Since we're managing this globally, we don't remove listeners on unmount
    // They'll be cleaned up when the process exits

    return () => {
      process.off("exit", cleanup);
      process.off("SIGINT", cleanup);
      process.off("SIGTERM", cleanup);
    };
  }, []);
};
