import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { BinaryCheckResult } from "../types";

/**
 * Check if Atlas binary exists and return its path
 */
export async function checkAtlasBinaryHandler(): Promise<BinaryCheckResult> {
  try {
    const atlasDir = path.join(os.homedir(), ".atlas");
    const binDir = path.join(atlasDir, "bin");
    const binaryName = process.platform === "win32" ? "atlas.exe" : "atlas";
    const binaryPath = path.join(binDir, binaryName);

    if (fs.existsSync(binaryPath)) {
      // Check if it's executable
      try {
        fs.accessSync(binaryPath, fs.constants.X_OK);
        return { exists: true, path: binaryPath };
      } catch {
        return { exists: true, path: binaryPath, error: "Binary exists but is not executable" };
      }
    }

    // Also check system path
    const systemBinaryPath = process.platform === "win32" ? null : "/usr/local/bin/atlas";

    if (systemBinaryPath && fs.existsSync(systemBinaryPath)) {
      try {
        fs.accessSync(systemBinaryPath, fs.constants.X_OK);
        return { exists: true, path: systemBinaryPath };
      } catch {
        return {
          exists: true,
          path: systemBinaryPath,
          error: "System binary exists but is not executable",
        };
      }
    }

    return { exists: false, error: "Atlas binary not found" };
  } catch (error) {
    return { exists: false, error: error instanceof Error ? error.message : String(error) };
  }
}
