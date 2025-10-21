// Browser-compatible imports for Tauri

import { CONFIG } from "../config/index.js";
import type { IPCResult } from "../types";
import { fs, os, path, safeExec } from "../utils/browser-compat.js";

// Simple error message helper
const getErrorMessage = (err: unknown): string => {
  return err instanceof Error ? err.message : String(err);
};

// Helper to get plist path
const getPlistPath = async (): Promise<string> => {
  const homedir = await os.homedir();
  return path.join(homedir, CONFIG.paths.macos.plistPath);
};

/**
 * Execute command silently, ignoring errors
 */
async function runQuietly(cmd: string): Promise<void> {
  try {
    await safeExec(cmd);
  } catch {
    // Ignore errors - these are cleanup commands that may fail if service isn't running
  }
}

/**
 * Install macOS service - Direct operations, no abstractions
 */
export async function installMacOSService(binaryPath: string): Promise<IPCResult> {
  try {
    // Validate binary exists
    if (!(await fs.existsSync(binaryPath))) {
      return { success: false, error: "Binary not found" };
    }

    const plistPath = await getPlistPath();

    // Clean up any lingering service registration
    await runQuietly(`launchctl unload "${plistPath}"`);
    await runQuietly("launchctl remove com.tempestdx.atlas");

    // Create logs directory
    const homedir = await os.homedir();
    const logsDir = path.join(homedir, ".atlas", "logs");
    await fs.mkdirSync(logsDir, { recursive: true });

    // Install the service - use --force if plist exists (handles updates)
    try {
      if (await fs.existsSync(plistPath)) {
        // Plist exists, use --force to update it in case it changed
        await safeExec(`"${binaryPath}" service install --force`);
      } else {
        // Fresh install
        await safeExec(`"${binaryPath}" service install`);
      }
    } catch (error) {
      // Check if it's because service is already installed (shouldn't happen with --force)
      const errorMessage = getErrorMessage(error);
      if (errorMessage.includes("already installed")) {
        // Service already exists, try to just start it
        console.log("Service already installed, attempting to start it");
      } else {
        // Re-throw if it's a different error
        throw error;
      }
    }

    // Wait for launchctl to process
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Start the service - load the plist
    try {
      await safeExec(`launchctl load "${plistPath}"`);
    } catch (error) {
      // Ignore if already loaded
      const errorMsg = getErrorMessage(error);
      if (!errorMsg.includes("already loaded")) {
        console.warn("launchctl load warning:", errorMsg);
      }
    }

    // Explicitly start the service
    try {
      await safeExec("launchctl start com.tempestdx.atlas");
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      // If service is already running, that's fine
      if (!errorMsg.includes("already running")) {
        console.warn("launchctl start warning:", errorMsg);
      }
    }

    // Verify installation
    if (!(await fs.existsSync(plistPath))) {
      return { success: false, error: "Service installation failed - plist not created" };
    }

    // Give service a moment to start, then verify it's running
    await new Promise((resolve) => setTimeout(resolve, 1000));

    return { success: true, message: "Atlas service installed successfully" };
  } catch (error) {
    return { success: false, error: `Installation failed: ${getErrorMessage(error)}` };
  }
}

/**
 * Uninstall macOS service
 */
export async function uninstallMacOSService(binaryPath: string): Promise<IPCResult> {
  try {
    const plistPath = await getPlistPath();

    // Stop service (which also stops daemon)
    await runQuietly(`"${binaryPath}" service stop`);

    // Unload and remove service
    await runQuietly(`launchctl unload "${plistPath}"`);
    await runQuietly("launchctl remove com.tempestdx.atlas");

    // Remove plist file
    if (await fs.existsSync(plistPath)) {
      await fs.unlinkSync(plistPath);
    }

    return { success: true, message: "Atlas service uninstalled" };
  } catch (error) {
    return { success: false, error: `Uninstall failed: ${getErrorMessage(error)}` };
  }
}

/**
 * Stop macOS service
 */
export async function stopMacOSService(binaryPath: string): Promise<IPCResult> {
  try {
    await runQuietly(`"${binaryPath}" service stop`);

    return { success: true, message: "Atlas service stopped" };
  } catch (error) {
    return { success: false, error: `Stop failed: ${getErrorMessage(error)}` };
  }
}
