import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as sudo from "@vscode/sudo-prompt";
import { CONFIG } from "../config";
import type { IPCResult } from "../types";
import { getErrorMessage } from "../utils/errors";
import { createLogger } from "../utils/logger";
import { safeExec } from "../utils/process";
import { createStartMenuShortcut, removeStartMenuShortcut } from "../utils/windows-shortcuts";

const logger = createLogger("WindowsService");

const TASK_NAME = "Atlas Daemon";

/**
 * Install Windows service using Task Scheduler - Direct operations, no abstractions
 */
export async function installWindowsService(binaryPath: string): Promise<IPCResult> {
  try {
    // Validate binary exists
    if (!fs.existsSync(binaryPath)) {
      return { success: false, error: "Binary not found" };
    }

    // Clean up any existing scheduled task (daemon should already be stopped by binary installer)
    try {
      await safeExec(`schtasks /Delete /TN "${TASK_NAME}" /F`, { windowsHide: true });
    } catch {}

    // Create logs directory
    const logsDir = path.join(os.homedir(), ".atlas", "logs");
    fs.mkdirSync(logsDir, { recursive: true });

    // Create scheduled task XML (no encoding declaration to avoid Windows issues)
    const taskXml = `<?xml version="1.0"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${binaryPath}</Command>
      <Arguments>service start</Arguments>
    </Exec>
  </Actions>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
</Task>`;

    // Write and register the task (UTF-16LE for Windows compatibility)
    const tempXml = path.join(os.tmpdir(), "atlas-task.xml");
    // Write as UTF-16LE which Windows Task Scheduler prefers
    const buffer = Buffer.from(`\ufeff${taskXml}`, "utf16le");
    fs.writeFileSync(tempXml, buffer);

    // Create and start the task with elevation
    const result = await new Promise<IPCResult>((resolve) => {
      const commands = [
        `schtasks /Create /TN "${TASK_NAME}" /XML "${tempXml}" /F`,
        `schtasks /Run /TN "${TASK_NAME}"`,
      ].join(" && ");

      sudo.exec(commands, { name: "Atlas Installer" }, (error?: Error) => {
        // Clean up XML file
        try {
          fs.unlinkSync(tempXml);
        } catch {}

        if (error) {
          if (error?.message?.includes("cancelled")) {
            resolve({
              success: false,
              error: "Administrator privileges required. Installation cancelled.",
            });
            return;
          }
          logger.warn(`Service installation completed with warning: ${error?.message}`);
        }

        resolve({ success: true, message: "Atlas service installed and started successfully" });
      });
    });

    if (!result.success) {
      return result;
    }

    // Install the Atlas service using the binary
    try {
      await safeExec(`"${binaryPath}" service install`, { timeout: CONFIG.process.installTimeout });
      logger.info("Atlas service installed successfully");
    } catch (error) {
      logger.warn(`Service installation warning: ${getErrorMessage(error)}`);
      // Continue even if this fails, as the scheduled task is already created
    }

    // Start the Atlas service
    try {
      await safeExec(`"${binaryPath}" service start`, { timeout: CONFIG.process.installTimeout });
      logger.info("Atlas service started successfully");
    } catch (error) {
      logger.warn(`Service start warning: ${getErrorMessage(error)}`);
      // Continue even if this fails
    }

    // Create Start Menu shortcut
    await createStartMenuShortcut();

    return { success: true, message: "Atlas service installed successfully" };
  } catch (error) {
    return { success: false, error: `Installation failed: ${getErrorMessage(error)}` };
  }
}

/**
 * Uninstall Windows service
 */
export async function uninstallWindowsService(binaryPath: string): Promise<IPCResult> {
  try {
    // Stop service (which also stops daemon)
    try {
      await safeExec(`"${binaryPath}" service stop`, { timeout: CONFIG.process.stopTimeout });
    } catch {}
    try {
      await safeExec("taskkill /F /IM atlas.exe", { windowsHide: true });
    } catch {}

    // Delete scheduled task with elevation
    await new Promise<void>((resolve) => {
      sudo.exec(
        `schtasks /Delete /TN "${TASK_NAME}" /F`,
        { name: "Atlas Installer" },
        (error?: Error) => {
          if (error) {
            logger.warn(`Failed to delete scheduled task: ${error?.message}`);
          }
          resolve();
        },
      );
    });

    // Remove Start Menu shortcut
    removeStartMenuShortcut();

    return { success: true, message: "Atlas service uninstalled" };
  } catch (error) {
    return { success: false, error: `Uninstall failed: ${getErrorMessage(error)}` };
  }
}

/**
 * Stop Windows service
 */
export async function stopWindowsService(binaryPath: string): Promise<IPCResult> {
  try {
    try {
      await safeExec(`"${binaryPath}" service stop`, { timeout: CONFIG.process.stopTimeout });
    } catch {}
    try {
      await safeExec(`schtasks /End /TN "${TASK_NAME}"`, { windowsHide: true });
    } catch {}
    try {
      await safeExec("taskkill /F /IM atlas.exe", { windowsHide: true });
    } catch {}

    return { success: true, message: "Atlas service stopped" };
  } catch (error) {
    return { success: false, error: `Stop failed: ${getErrorMessage(error)}` };
  }
}
