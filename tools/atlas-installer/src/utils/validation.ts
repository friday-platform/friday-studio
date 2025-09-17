import * as fs from "node:fs";
import type { IPCResult } from "../types";

/**
 * Validates that a binary exists and is executable
 */
export function validateBinary(binaryPath: string | undefined): IPCResult | null {
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    return { success: false, error: `Binary not found: ${binaryPath || "no path"}` };
  }

  try {
    fs.accessSync(binaryPath, fs.constants.X_OK);
    return null; // Binary is valid
  } catch {
    return { success: false, error: `Binary not executable: ${binaryPath}` };
  }
}
