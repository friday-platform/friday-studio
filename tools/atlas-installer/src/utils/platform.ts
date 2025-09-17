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

// Path utilities
const PATH_SEPARATOR = IS_WINDOWS ? ";" : ":";

export function addToPath(binDir: string, existingPath?: string): string {
  const currentPath = existingPath || process.env.PATH || "";
  return `${binDir}${PATH_SEPARATOR}${currentPath}`;
}
