/**
 * Platform detection utilities for installer
 * Minimal implementation for Node.js environment
 */

// Platform detection constants (internal use)
const IS_MAC = process.platform === "darwin";

// Exported platform detection
export const IS_WINDOWS = process.platform === "win32";

// Convenience functions
export const isWindows = () => IS_WINDOWS;
export const isMac = () => IS_MAC;
