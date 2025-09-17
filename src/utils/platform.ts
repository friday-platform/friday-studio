import type { Platform } from "../services/types.ts";

/**
 * Detect the current platform
 */
export function detectPlatform(): Platform {
  switch (Deno.build.os) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "windows":
      return "windows";
    default:
      return "unknown";
  }
}

/**
 * Check if current platform supports services
 */
export function isPlatformSupported(): boolean {
  const platform = detectPlatform();
  return platform !== "unknown";
}

/**
 * Get platform-specific service name for Atlas
 */
export function getDefaultServiceName(): string {
  const platform = detectPlatform();

  switch (platform) {
    case "macos":
      return "com.tempestdx.atlas";
    case "linux":
      return "atlas";
    case "windows":
      return "atlas";
    default:
      return "atlas";
  }
}

/**
 * Get system-wide binary installation path
 */
export function getSystemBinaryPath(): string {
  const platform = detectPlatform();

  switch (platform) {
    case "macos":
      return "/usr/local/bin/atlas";
    case "linux":
      return "/usr/local/bin/atlas";
    case "windows": {
      const userProfile = Deno.env.get("USERPROFILE") || "";
      return `${userProfile}\\AppData\\Local\\Atlas\\atlas.exe`;
    }
    default:
      return "/usr/local/bin/atlas";
  }
}

/**
 * Get platform-specific paths
 */
export function getPlatformPaths() {
  const platform = detectPlatform();
  const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";

  switch (platform) {
    case "macos":
      return {
        serviceDir: `${homeDir}/Library/LaunchAgents`,
        configDir: `${homeDir}/.atlas`,
        logDir: `${homeDir}/.atlas/logs`,
        binaryPath: getSystemBinaryPath(),
      };
    case "linux":
      return {
        serviceDir: `${homeDir}/.config/systemd/user`,
        configDir: `${homeDir}/.atlas`,
        logDir: `${homeDir}/.atlas/logs`,
        binaryPath: getSystemBinaryPath(),
      };
    case "windows": {
      return {
        serviceDir: "", // Windows services don't use file-based configs like launchd/systemd
        configDir: `${homeDir}\\.atlas`,
        logDir: `${homeDir}\\.atlas\\logs`,
        binaryPath: getSystemBinaryPath(),
      };
    }
    default:
      return {
        serviceDir: "",
        configDir: `${homeDir}/.atlas`,
        logDir: `${homeDir}/.atlas/logs`,
        binaryPath: getSystemBinaryPath(),
      };
  }
}

/**
 * Check if running as compiled binary
 */
function isCompiledBinary(): boolean {
  const execPath = Deno.execPath();
  return (
    execPath.endsWith("atlas-test") || execPath.endsWith("atlas") || execPath.endsWith("atlas.exe")
  );
}

/**
 * Get the Atlas binary path for the current environment
 */
export function getAtlasBinaryPath(): string {
  if (isCompiledBinary()) {
    return Deno.execPath();
  }

  // For development, use the platform-specific installed binary path
  return getPlatformPaths().binaryPath;
}
