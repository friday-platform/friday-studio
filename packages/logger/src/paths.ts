import { getAtlasHome, isSystemService } from "@atlas/utils";
import { join } from "@std/path";

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
