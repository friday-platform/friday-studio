import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IS_WINDOWS } from "./platform";
import { getSystemBinaryPath } from "../constants/paths";

/**
 * Read Atlas environment variables from ~/.atlas/.env
 */
export function getAtlasEnv(): Record<string, string> {
  const atlasDir = path.join(os.homedir(), ".atlas");
  const envFile = path.join(atlasDir, ".env");

  const env: Record<string, string> = {};

  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, "utf8");
    const lines = envContent.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=");
        if (key) {
          env[key] = valueParts.join("=");
        }
      }
    }
  }

  return env;
}

/**
 * Get the Atlas binary path for the current platform
 */
export function getBinaryPath(): string {
  const atlasDir = path.join(os.homedir(), ".atlas");
  const binDir = path.join(atlasDir, "bin");
  const binaryName = IS_WINDOWS ? "atlas.exe" : "atlas";

  if (!IS_WINDOWS) {
    // On Unix systems, use the symlinked binary in system path if it exists
    const systemBinaryPath = getSystemBinaryPath();
    if (fs.existsSync(systemBinaryPath)) {
      return systemBinaryPath;
    }
  }

  return path.join(binDir, binaryName);
}
