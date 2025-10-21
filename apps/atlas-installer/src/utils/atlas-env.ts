import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSystemBinaryPath } from "../constants/paths";
import { IS_WINDOWS } from "./platform";

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
