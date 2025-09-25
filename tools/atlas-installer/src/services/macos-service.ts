import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG } from "../config";
import type { IPCResult } from "../types";
import { safeExec } from "../utils/process";

const PLIST_PATH = path.join(os.homedir(), "Library/LaunchAgents/com.tempestdx.atlas.plist");

/**
 * Execute command silently, ignoring errors
 */
async function runQuietly(cmd: string, options?: unknown): Promise<void> {
  try {
    await safeExec(cmd, options);
  } catch {
    // Ignore errors - these are cleanup commands that may fail if service isn't running
  }
}

/**
 * Install macOS service - Direct operations, no abstractions
 */
export async function installMacOSService(
  binaryPath: string,
  atlasEnv: Record<string, string>,
): Promise<IPCResult> {
  try {
    // Validate binary exists
    if (!fs.existsSync(binaryPath)) {
      return { success: false, error: "Binary not found" };
    }

    const env = { ...process.env, ...atlasEnv };

    // Clean up any lingering service registration (daemon should already be stopped by binary installer)
    await runQuietly(`launchctl unload "${PLIST_PATH}"`);
    await runQuietly("launchctl remove com.tempestdx.atlas");

    // Create logs directory
    const logsDir = path.join(os.homedir(), ".atlas", "logs");
    fs.mkdirSync(logsDir, { recursive: true });

    // Install the service - use --force if plist exists (handles updates)
    try {
      if (fs.existsSync(PLIST_PATH)) {
        // Plist exists, use --force to update it in case it changed
        await safeExec(`"${binaryPath}" service install --force`, {
          env,
          timeout: CONFIG.process.installTimeout,
        });
      } else {
        // Fresh install
        await safeExec(`"${binaryPath}" service install`, {
          env,
          timeout: CONFIG.process.installTimeout,
        });
      }
    } catch (error) {
      // Check if it's because service is already installed (shouldn't happen with --force)
      if (error.message?.includes("already installed")) {
        // Service already exists, try to just start it
        console.log("Service already installed, attempting to start it");
      } else {
        // Re-throw if it's a different error
        throw error;
      }
    }

    // Wait for launchctl to process
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Start the service
    await runQuietly(`launchctl load "${PLIST_PATH}"`);
    await runQuietly("launchctl start com.tempestdx.atlas");

    // Verify installation
    if (!fs.existsSync(PLIST_PATH)) {
      return { success: false, error: "Service installation failed - plist not created" };
    }

    return { success: true, message: "Atlas service installed successfully" };
  } catch (error) {
    return { success: false, error: `Installation failed: ${error.message || error}` };
  }
}

/**
 * Uninstall macOS service
 */
export async function uninstallMacOSService(
  binaryPath: string,
  atlasEnv: Record<string, string>,
): Promise<IPCResult> {
  try {
    const env = { ...process.env, ...atlasEnv };

    // Stop service (which also stops daemon)
    await runQuietly(`"${binaryPath}" service stop`, { env, timeout: CONFIG.process.stopTimeout });

    // Unload and remove service
    await runQuietly(`launchctl unload "${PLIST_PATH}"`);
    await runQuietly("launchctl remove com.tempestdx.atlas");

    // Remove plist file
    if (fs.existsSync(PLIST_PATH)) {
      fs.unlinkSync(PLIST_PATH);
    }

    return { success: true, message: "Atlas service uninstalled" };
  } catch (error) {
    return { success: false, error: `Uninstall failed: ${error.message || error}` };
  }
}

/**
 * Stop macOS service
 */
export async function stopMacOSService(
  binaryPath: string,
  atlasEnv: Record<string, string>,
): Promise<IPCResult> {
  try {
    const env = { ...process.env, ...atlasEnv };

    await runQuietly(`"${binaryPath}" service stop`, { env, timeout: CONFIG.process.stopTimeout });

    return { success: true, message: "Atlas service stopped" };
  } catch (error) {
    return { success: false, error: `Stop failed: ${error.message || error}` };
  }
}
