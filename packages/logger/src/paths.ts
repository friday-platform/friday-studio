import { join } from "node:path";
import process from "node:process";
import { getFridayHome, isSystemService } from "@atlas/utils/paths.server";

/**
 * Returns Atlas logs directory: /var/log/atlas (system) or ~/.atlas/logs (user)
 */
export function getAtlasLogsDir(): string {
  const logsDir = process.env.FRIDAY_LOGS_DIR;
  if (logsDir) {
    return logsDir;
  }

  if (isSystemService() && process.platform !== "win32") {
    return "/var/log/atlas";
  }

  return join(getFridayHome(), "logs");
}
