// Browser-compatible imports for Tauri

import { invoke } from "@tauri-apps/api/core";
import type { IPCResult } from "../types";
import { fs, os, path, safeExec } from "../utils/browser-compat.js";

// Simple error message helper
const getErrorMessage = (err: unknown): string => {
  return err instanceof Error ? err.message : String(err);
};

const TASK_NAME = "Atlas Daemon";

/**
 * Install Windows service using Task Scheduler - Direct operations, no abstractions
 */
export async function installWindowsService(binaryPath: string): Promise<IPCResult> {
  try {
    // Validate binary exists
    if (!(await fs.existsSync(binaryPath))) {
      return { success: false, error: "Binary not found" };
    }

    // Clean up any existing scheduled task (daemon should already be stopped by binary installer)
    try {
      await safeExec(`schtasks /Delete /TN "${TASK_NAME}" /F`);
    } catch {}

    // Create logs directory
    const logsDir = path.join(await os.homedir(), ".atlas", "logs");
    await fs.mkdirSync(logsDir, { recursive: true });

    // Get Atlas directory for working directory (normalize to Windows backslashes)
    const atlasDir = path.join(await os.homedir(), ".atlas").replace(/\//g, "\\");

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
      <WorkingDirectory>${atlasDir}</WorkingDirectory>
    </Exec>
  </Actions>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
</Task>`;

    // Write and register the task
    const tempXml = path.join(await os.tmpdir(), "atlas-task.xml");
    await fs.writeFileSync(tempXml, taskXml);

    // Create and start the task with elevation
    const result = await new Promise<IPCResult>((resolve) => {
      const commands = [
        `schtasks /Create /TN "${TASK_NAME}" /XML "${tempXml}" /F`,
        `schtasks /Run /TN "${TASK_NAME}"`,
      ].join(" && ");

      // Execute elevated using Tauri's Windows UAC elevation
      invoke<{ stdout: string; stderr: string; status: number }>("execute_elevated_command", {
        command: commands,
      })
        .then(async (result) => {
          // Clean up XML file
          try {
            await fs.unlinkSync(tempXml);
          } catch {}

          if (result.status !== 0) {
            console.warn(`Service installation warning: ${result.stderr}`);
          }

          resolve({ success: true, message: "Atlas service installed and started successfully" });
        })
        .catch(async (error) => {
          // Clean up XML file
          try {
            await fs.unlinkSync(tempXml);
          } catch {}
          console.error(`Service installation failed: ${getErrorMessage(error)}`);
          resolve({ success: false, error: `Installation failed: ${getErrorMessage(error)}` });
        });
    });

    if (!result.success) {
      return result;
    }

    // Normalize binary path to Windows backslashes for commands
    const normalizedBinaryPath = binaryPath.replace(/\//g, "\\");

    // Install the Atlas service using the binary (no quotes - path has no spaces)
    try {
      const installResult = await safeExec(`${normalizedBinaryPath} service install --force`);
      console.info("Atlas service installed successfully:", installResult);
    } catch (error) {
      console.error(`Service installation failed: ${getErrorMessage(error)}`);
      return { success: false, error: `Service installation failed: ${getErrorMessage(error)}` };
    }

    // Start the Atlas service (hideWindow: false uses DETACHED_PROCESS for daemon spawning)
    try {
      const startResult = await safeExec(`${normalizedBinaryPath} service start`, {
        hideWindow: false,
      });
      console.info("Atlas service started successfully:", startResult);
    } catch (error) {
      console.error(`Service start failed: ${getErrorMessage(error)}`);
      return { success: false, error: `Service start failed: ${getErrorMessage(error)}` };
    }

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
      await safeExec(`"${binaryPath}" service stop`);
    } catch {}
    try {
      await safeExec("taskkill /F /IM atlas.exe");
    } catch {}

    // Delete scheduled task with elevation
    try {
      await invoke("execute_elevated_command", {
        command: `schtasks /Delete /TN "${TASK_NAME}" /F`,
      });
    } catch (error) {
      console.warn(`Failed to delete scheduled task: ${getErrorMessage(error)}`);
    }

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
      await safeExec(`${binaryPath} service stop`);
    } catch {}
    try {
      await safeExec(`schtasks /End /TN "${TASK_NAME}"`, { hideWindow: true });
    } catch {}
    try {
      await safeExec("taskkill /F /IM atlas.exe", { hideWindow: true });
    } catch {}

    return { success: true, message: "Atlas service stopped" };
  } catch (error) {
    return { success: false, error: `Stop failed: ${getErrorMessage(error)}` };
  }
}
