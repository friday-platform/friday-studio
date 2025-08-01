import { join } from "@std/path";

/**
 * Detects if running as system service (root, ATLAS_SYSTEM_MODE=true, or 'atlas' user)
 */
function isSystemService(): boolean {
  if (Deno.build.os === "windows") {
    return false;
  }

  const uid = Deno.uid();
  if (uid === 0) {
    return true;
  }

  if (Deno.env.get("ATLAS_SYSTEM_MODE") === "true") {
    return true;
  }

  try {
    // @ts-ignore - userInfo is available in some Deno versions
    const userInfo = Deno.userInfo?.();
    if (userInfo?.username === "atlas") {
      return true;
    }
  } catch {
    // Ignore errors
  }

  return false;
}

/**
 * Returns Atlas home directory: /var/lib/atlas (system) or ~/.atlas (user)
 */
export function getAtlasHome(): string {
  const atlasHome = Deno.env.get("ATLAS_HOME");
  if (atlasHome) {
    return atlasHome;
  }

  if (isSystemService() && Deno.build.os !== "windows") {
    return "/var/lib/atlas";
  }

  // Handle compiled binaries running from ~/.atlas/
  const cwd = Deno.cwd();
  const sep = Deno.build.os === "windows" ? "\\" : "/";
  if (cwd.endsWith(".atlas") || cwd.includes(`.atlas${sep}`)) {
    const parts = cwd.split(sep);
    const atlasIndex = parts.lastIndexOf(".atlas");
    if (atlasIndex > 0) {
      return parts.slice(0, atlasIndex + 1).join(sep);
    }
  }

  const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  if (!homeDir) {
    throw new Error("Unable to determine home directory");
  }

  return join(homeDir, ".atlas");
}

/**
 * Returns Atlas logs directory: /var/log/atlas (system) or ~/.atlas/logs (user)
 */
export function getAtlasLogsDir(): string {
  const logsDir = Deno.env.get("ATLAS_LOGS_DIR");
  if (logsDir) {
    return logsDir;
  }

  if (isSystemService() && Deno.build.os !== "windows") {
    return "/var/log/atlas";
  }

  return join(getAtlasHome(), "logs");
}
