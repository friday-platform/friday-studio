import { IS_WINDOWS } from "../utils/platform";

/**
 * Get system-wide binary installation path for the current platform
 */
export function getSystemBinaryPath(): string {
  if (IS_WINDOWS) {
    // Note: Windows currently installs to user directory, not system-wide
    // This is kept for future system-wide installation support
    const userProfile = process.env.USERPROFILE || "";
    return `${userProfile}\\AppData\\Local\\Atlas\\atlas.exe`;
  }
  // Unix systems (macOS, Linux)
  return "/usr/local/bin/atlas";
}
