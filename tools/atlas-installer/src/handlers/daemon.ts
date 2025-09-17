import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import type { IPCResult, DaemonStatusResult } from "../types";
import { createLogger } from "../utils/logger";
import { getErrorMessage } from "../utils/errors";
import { isWindows, addToPath } from "../utils/platform";
import { validateBinary } from "../utils/validation";
import { DaemonAction } from "../constants/actions";
import { CONFIG } from "../config";
import {
  killProcess,
  safeExec,
  waitForProcessToStart,
  waitForProcessToStop,
} from "../utils/process";
import { getAtlasEnv, getBinaryPath } from "../utils/atlas-env";

const logger = createLogger("DaemonHandler");

/**
 * Get daemon environment variables
 */
function getDaemonEnv(binaryPath: string): Record<string, string> {
  return {
    ...process.env,
    ...getAtlasEnv(),
    PATH: addToPath(path.dirname(binaryPath), process.env.PATH),
    HOME: os.homedir(),
  };
}

/**
 * Get process name for current platform
 */
function getProcessName(): string {
  return isWindows() ? "atlas.exe" : "atlas";
}

/**
 * Check Atlas daemon status
 */
export async function checkAtlasDaemonStatus(_event: unknown): Promise<DaemonStatusResult> {
  try {
    const binaryPath = getBinaryPath();

    // Check if binary exists
    if (!fs.existsSync(binaryPath)) {
      return { success: true, running: false, message: "Atlas binary not found" };
    }

    // Get environment
    const env = getDaemonEnv(binaryPath);

    // Try to run status command
    try {
      const output = await safeExec(`"${binaryPath}" daemon status --json`, {
        encoding: "utf8",
        env,
        timeout: CONFIG.process.statusCheckTimeout,
      });

      // Parse JSON output if available
      try {
        const status = JSON.parse(output);
        return { success: true, running: true, info: status, message: "Atlas daemon is running" };
      } catch {
        // Status command succeeded but output isn't JSON
        return { success: true, running: true, message: "Atlas daemon is running" };
      }
    } catch (err) {
      // Status command failed - daemon not running
      return { success: true, running: false, message: "Atlas daemon is not running" };
    }
  } catch (err) {
    const message = getErrorMessage(err);
    logger.error("Failed to check daemon status", err);
    return { success: false, error: `Failed to check daemon status: ${message}`, running: false };
  }
}

/**
 * Start Atlas daemon
 */
async function startDaemon(): Promise<IPCResult> {
  const binaryPath = getBinaryPath();

  // Validate binary
  const validationError = validateBinary(binaryPath);
  if (validationError) {
    return validationError;
  }

  // Check if already running
  const status = await checkAtlasDaemonStatus(null);
  if (status.running) {
    return { success: true, message: "Atlas daemon is already running" };
  }

  // Get environment
  const atlasDir = path.join(os.homedir(), ".atlas");
  const env = getDaemonEnv(binaryPath);

  // Create log directory
  const logDir = path.join(atlasDir, "logs");
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logFile = path.join(logDir, "daemon.log");
  const logStream = fs.createWriteStream(logFile, { flags: "a" });

  logger.info("Starting Atlas daemon...");

  // Spawn daemon process
  const daemonProcess = spawn(binaryPath, ["daemon", "start", "--daemon"], {
    detached: true,
    stdio: ["ignore", logStream, logStream],
    env,
    cwd: os.homedir(),
  });

  daemonProcess.on("error", (err) => {
    logger.error("Failed to spawn daemon", err);
  });

  // Let the parent process exit
  daemonProcess.unref();

  // Wait a moment for daemon to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Check if daemon started
  const started = await waitForProcessToStart(getProcessName(), {
    timeout: CONFIG.process.startTimeout,
  });

  if (!started) {
    // Check if process was killed immediately
    if (daemonProcess.killed) {
      return { success: false, error: "Daemon process was killed immediately after start" };
    }
    return { success: false, error: "Daemon failed to start within timeout" };
  }

  logger.info("Atlas daemon started successfully");
  return { success: true, message: "Atlas daemon started successfully" };
}

/**
 * Stop Atlas daemon
 */
async function stopDaemon(): Promise<IPCResult> {
  const binaryPath = getBinaryPath();

  // Check if running
  const status = await checkAtlasDaemonStatus(null);
  if (!status.running) {
    return { success: true, message: "Atlas daemon is not running" };
  }

  logger.info("Stopping Atlas daemon...");

  // Get environment
  const env = getDaemonEnv(binaryPath);

  // Try graceful stop
  try {
    await safeExec(`"${binaryPath}" daemon stop`, {
      encoding: "utf8",
      env,
      timeout: CONFIG.process.stopTimeout,
    });
  } catch {
    logger.warn("Graceful stop failed, will force kill");
  }

  // Wait for process to stop
  const stopped = await waitForProcessToStop(getProcessName(), {
    timeout: CONFIG.process.stopTimeout,
  });

  if (!stopped) {
    // Force kill
    await killProcess(getProcessName());
  }

  logger.info("Atlas daemon stopped");
  return { success: true, message: "Atlas daemon stopped successfully" };
}

/**
 * Restart Atlas daemon
 */
async function restartDaemon(): Promise<IPCResult> {
  logger.info("Restarting Atlas daemon...");

  // Stop daemon
  const stopResult = await stopDaemon();
  if (!stopResult.success) {
    return stopResult;
  }

  // Wait a moment
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Start daemon
  const startResult = await startDaemon();
  if (!startResult.success) {
    return startResult;
  }

  return { success: true, message: "Atlas daemon restarted successfully" };
}

/**
 * Manage Atlas daemon (start/stop/restart)
 */
export async function manageAtlasDaemon(_event: unknown, action: DaemonAction): Promise<IPCResult> {
  try {
    switch (action) {
      case DaemonAction.START:
        return await startDaemon();

      case DaemonAction.STOP:
        return await stopDaemon();

      case DaemonAction.RESTART:
        return await restartDaemon();

      default: {
        const _exhaustive: never = action;
        return { success: false, error: `Unknown daemon action: ${_exhaustive}` };
      }
    }
  } catch (err) {
    const message = getErrorMessage(err);
    logger.error(`Failed to ${action} daemon`, err);
    return { success: false, error: `Failed to ${action} daemon: ${message}` };
  }
}
