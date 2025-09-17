import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeExec } from "../utils/process";
import { CONFIG } from "../config";
import { type IPCResult } from "../types";

const TASK_NAME = "Atlas Daemon";

/**
 * Install Windows service using Task Scheduler - Direct operations, no abstractions
 */
export async function installWindowsService(
  binaryPath: string,
  atlasEnv: Record<string, string>,
): Promise<IPCResult> {
  try {
    // Validate binary exists
    if (!fs.existsSync(binaryPath)) {
      return { success: false, error: "Binary not found" };
    }

    const env = { ...process.env, ...atlasEnv };

    // Stop any existing service
    try {
      await safeExec(`"${binaryPath}" daemon stop`, { env, timeout: CONFIG.process.stopTimeout });
    } catch {}
    try {
      await safeExec("taskkill /F /IM atlas.exe", { windowsHide: true });
    } catch {}
    try {
      await safeExec(`schtasks /Delete /TN "${TASK_NAME}" /F`, { windowsHide: true });
    } catch {}

    // Create logs directory
    const logsDir = path.join(os.homedir(), ".atlas", "logs");
    fs.mkdirSync(logsDir, { recursive: true });

    // Create scheduled task XML
    const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions>
    <Exec>
      <Command>${binaryPath}</Command>
      <Arguments>daemon start</Arguments>
    </Exec>
  </Actions>
  <Principals>
    <Principal>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
</Task>`;

    // Write and register the task
    const tempXml = path.join(os.tmpdir(), "atlas-task.xml");
    fs.writeFileSync(tempXml, taskXml, "utf16le");

    try {
      await safeExec(`schtasks /Create /TN "${TASK_NAME}" /XML "${tempXml}" /F`, {
        windowsHide: true,
      });
      fs.unlinkSync(tempXml);
    } catch (error) {
      fs.unlinkSync(tempXml);
      throw error;
    }

    // Start the service
    try {
      await safeExec(`schtasks /Run /TN "${TASK_NAME}"`, { windowsHide: true });
    } catch {}

    // Create Start Menu shortcut
    await createStartMenuShortcut(binaryPath);

    return { success: true, message: "Atlas service installed successfully" };
  } catch (error: any) {
    return { success: false, error: `Installation failed: ${error.message || error}` };
  }
}

/**
 * Uninstall Windows service
 */
export async function uninstallWindowsService(
  binaryPath: string,
  atlasEnv: Record<string, string>,
): Promise<IPCResult> {
  try {
    const env = { ...process.env, ...atlasEnv };

    // Stop daemon
    try {
      await safeExec(`"${binaryPath}" daemon stop`, { env, timeout: CONFIG.process.stopTimeout });
    } catch {}
    try {
      await safeExec("taskkill /F /IM atlas.exe", { windowsHide: true });
    } catch {}

    // Delete scheduled task
    try {
      await safeExec(`schtasks /Delete /TN "${TASK_NAME}" /F`, { windowsHide: true });
    } catch {}

    // Remove Start Menu shortcut
    const shortcutPath = path.join(
      os.homedir(),
      "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Atlas.lnk",
    );
    if (fs.existsSync(shortcutPath)) {
      fs.unlinkSync(shortcutPath);
    }

    return { success: true, message: "Atlas service uninstalled" };
  } catch (error: any) {
    return { success: false, error: `Uninstall failed: ${error.message || error}` };
  }
}

/**
 * Stop Windows service
 */
export async function stopWindowsService(
  binaryPath: string,
  atlasEnv: Record<string, string>,
): Promise<IPCResult> {
  try {
    const env = { ...process.env, ...atlasEnv };

    try {
      await safeExec(`"${binaryPath}" daemon stop`, { env, timeout: CONFIG.process.stopTimeout });
    } catch {}
    try {
      await safeExec(`schtasks /End /TN "${TASK_NAME}"`, { windowsHide: true });
    } catch {}
    try {
      await safeExec("taskkill /F /IM atlas.exe", { windowsHide: true });
    } catch {}

    return { success: true, message: "Atlas service stopped" };
  } catch (error: any) {
    return { success: false, error: `Stop failed: ${error.message || error}` };
  }
}

/**
 * Create Start Menu shortcut
 */
export async function createStartMenuShortcut(binaryPath: string): Promise<void> {
  const shortcutDir = path.join(
    os.homedir(),
    "AppData/Roaming/Microsoft/Windows/Start Menu/Programs",
  );

  if (!fs.existsSync(shortcutDir)) {
    fs.mkdirSync(shortcutDir, { recursive: true });
  }

  // Simple PowerShell command to create shortcut
  const ps1 = `$WshShell = New-Object -comObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("${shortcutDir}\\Atlas.lnk")
$Shortcut.TargetPath = "${binaryPath}"
$Shortcut.Save()`;

  try {
    await safeExec(`powershell -Command "${ps1.replace(/"/g, '`"')}"`, { windowsHide: true });
  } catch {
    // Shortcut creation is non-critical
  }
}
