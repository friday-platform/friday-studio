import { PlatformServiceManager, ServiceConfig, ServiceStatus } from "../types.ts";
import {
  getAtlasBinaryPath,
  getDefaultServiceName,
  getPlatformPaths,
} from "../../utils/platform.ts";

/**
 * Windows service manager for Atlas
 * Uses vanilla Windows tooling (sc command and batch scripts) to manage services
 */
export class WindowsService implements PlatformServiceManager {
  private serviceName: string;
  private paths: ReturnType<typeof getPlatformPaths>;

  constructor() {
    this.serviceName = getDefaultServiceName();
    this.paths = getPlatformPaths();
  }

  async install(config: ServiceConfig): Promise<void> {
    const binaryPath = getAtlasBinaryPath();
    const homeDir = Deno.env.get("USERPROFILE") || "C:\\Users\\Default";

    // Create log directory
    await Deno.mkdir(this.paths.logDir, { recursive: true });

    // For Windows, we'll use the Startup folder approach (no admin required)
    const startupFolder =
      `${homeDir}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup`;
    const startupBatch = `${startupFolder}\\Atlas.bat`;

    // Create batch file content that starts service in background
    const batchContent = `@echo off
rem Atlas Service Auto-Start
cd /d "${homeDir}"
rem Start Atlas service (which manages the daemon in background)
"${binaryPath}" service install --port ${config.port}
"${binaryPath}" service start
exit
`;

    // Write to startup folder
    try {
      await Deno.mkdir(startupFolder, { recursive: true });
      await Deno.writeTextFile(startupBatch, batchContent);
      console.log(`Atlas startup configured successfully`);
      console.log(`Auto-start: ${startupBatch}`);
    } catch (error) {
      console.warn(`Could not create startup entry: ${error}`);
    }
  }

  async uninstall(): Promise<void> {
    const homeDir = Deno.env.get("USERPROFILE") || "C:\\Users\\Default";

    // Stop service if running
    try {
      await this.stop(true);
    } catch {
      // Service might not be running, continue with uninstall
    }

    // Remove startup folder entry
    const startupBatch =
      `${homeDir}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Atlas.bat`;
    try {
      await Deno.remove(startupBatch);
      console.log("Atlas startup entries removed successfully");
    } catch {
      // File might not exist
    }
  }

  async start(): Promise<void> {
    // Check if daemon is already running first
    try {
      const status = await this.getStatus();
      if (status.running) {
        return; // Daemon is already running, no need to start
      }
    } catch {
      // Continue with start if status check fails
    }

    // Start Atlas daemon in background using Windows-specific approach
    const binaryPath = getAtlasBinaryPath();

    // On Windows, we need to use 'start' command to run in background
    // since --detached flag doesn't work properly
    const cmd = new Deno.Command("cmd", {
      args: [
        "/c",
        "start",
        "/B",
        "",
        binaryPath,
        "daemon",
        "start",
        "--port",
        "8080",
      ],
      stdout: "piped",
      stderr: "piped",
      cwd: Deno.env.get("USERPROFILE") || "C:\\Users\\Default",
    });

    const result = await cmd.output();
    if (!result.success) {
      const error = new TextDecoder().decode(result.stderr);
      const stdout = new TextDecoder().decode(result.stdout);
      // If the start command fails, try direct execution as fallback
      const fallbackCmd = new Deno.Command(binaryPath, {
        args: ["daemon", "start", "--port", "8080"],
        stdout: "piped",
        stderr: "piped",
        stdin: "null",
      });

      // Spawn and detach
      fallbackCmd.spawn();

      // Give it a moment to start
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check if it started
      const status = await this.getStatus();
      if (!status.running) {
        throw new Error(`Failed to start Atlas daemon: ${error} ${stdout}`);
      }
    }
  }

  async stop(force = false): Promise<void> {
    // First check if process is actually running
    const status = await this.getStatus();
    if (!status.running) {
      // No process to stop
      return;
    }

    // Try graceful shutdown first
    try {
      const atlasPath = getAtlasBinaryPath();
      const stopCmd = new Deno.Command(atlasPath, {
        args: ["daemon", "stop"],
        stdout: "piped",
        stderr: "piped",
      });
      await stopCmd.output();

      // Give it a moment to shut down gracefully
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch {
      // If graceful shutdown fails, continue to force kill
    }

    // Force kill Atlas processes if still running or if force flag is set
    if (force || (await this.getStatus()).running) {
      try {
        const killCmd = new Deno.Command("taskkill", {
          args: ["/F", "/IM", "atlas.exe"],
          stdout: "piped",
          stderr: "piped",
        });
        const result = await killCmd.output();
        // Check if the kill was successful
        if (!result.success) {
          const error = new TextDecoder().decode(result.stderr);
          // Only throw if it's not a "process not found" error
          if (!error.includes("not found") && !error.includes("No tasks")) {
            throw new Error(`Failed to stop process: ${error}`);
          }
        }
      } catch (error) {
        // Re-throw if it's not a "process not found" error
        if (
          error instanceof Error &&
          !error.message.includes("not found") &&
          !error.message.includes("No tasks")
        ) {
          throw error;
        }
      }
    }
  }

  async getStatus(): Promise<ServiceStatus> {
    // Check if Atlas daemon is running by checking process
    let running = false;
    let pid: number | undefined;
    let port: number | undefined;

    // Get PID using Windows tasklist
    try {
      const pidCmd = new Deno.Command("tasklist", {
        args: ["/FI", "IMAGENAME eq atlas.exe", "/FO", "CSV", "/NH"],
        stdout: "piped",
        stderr: "piped",
      });
      const pidResult = await pidCmd.output();
      if (pidResult.success) {
        const pidOutput = new TextDecoder().decode(pidResult.stdout).trim();
        // Check if the output indicates no tasks found
        if (pidOutput.includes("INFO: No tasks are running") || pidOutput === "") {
          // No atlas.exe process found
          running = false;
        } else {
          // Try to parse CSV output for atlas.exe
          const csvMatch = pidOutput.match(/"atlas\.exe","(\d+)"/);
          if (csvMatch && csvMatch[1]) {
            pid = parseInt(csvMatch[1], 10);
            running = true;
          }
        }
      }
    } catch {
      // PID detection failed, daemon is not running
    }

    if (running) {
      // Try to detect port from Atlas daemon status
      try {
        const atlasCmd = new Deno.Command(getAtlasBinaryPath(), {
          args: ["daemon", "status", "--json"],
          stdout: "piped",
          stderr: "piped",
        });
        const atlasResult = await atlasCmd.output();
        if (atlasResult.success) {
          const statusData = JSON.parse(new TextDecoder().decode(atlasResult.stdout));
          port = statusData.port || 8080;
        }
      } catch {
        // Default port if detection fails
        port = 8080;
      }
    }

    return {
      running,
      platform: "windows",
      serviceName: this.serviceName,
      pid,
      port,
      uptime: running ? await this.getUptime() : undefined,
      installed: await this.isInstalled(),
    };
  }

  async isInstalled(): Promise<boolean> {
    // Check if startup batch file exists
    const homeDir = Deno.env.get("USERPROFILE") || "C:\\Users\\Default";
    const startupBatch =
      `${homeDir}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Atlas.bat`;

    try {
      await Deno.stat(startupBatch);
      return true;
    } catch {
      return false;
    }
  }

  private getUptime(): Promise<string | undefined> {
    try {
      // For Windows services, we'll use a simpler approach and just return that it's running
      // Getting exact uptime on Windows is more complex and requires WMI or PowerShell
      return Promise.resolve("running");
    } catch {
      // Uptime detection failed
    }
    return Promise.resolve(undefined);
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await Deno.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private createServiceWrapper(
    _wrapperPath: string,
    _binaryPath: string,
    _port: number,
  ): void {
    // Skip creating service wrapper - use direct daemon installation instead
    // Windows services work better with direct executable registration
    console.log("Using direct daemon registration for Windows service");
  }
}
