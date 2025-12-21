import process from "node:process";
import { logger } from "@atlas/logger";
import { z } from "zod";
import {
  getAtlasBinaryPath,
  getDefaultServiceName,
  getPlatformPaths,
} from "../../utils/platform.ts";
import { portConfigSchema } from "../schemas.ts";
import type { PlatformServiceManager, ServiceConfig, ServiceStatus } from "../types.ts";

/**
 * Windows service manager for Atlas
 * Uses vanilla Windows tooling (sc command and batch scripts) to manage services
 */
export class WindowsService implements PlatformServiceManager {
  private serviceName: string;
  private paths: ReturnType<typeof getPlatformPaths>;
  private configPath: string;
  private textDecoder = new TextDecoder();

  constructor() {
    this.serviceName = getDefaultServiceName();
    this.paths = getPlatformPaths();
    this.configPath = `${this.paths.configDir}\\service.json`;
  }

  async install(config: ServiceConfig): Promise<void> {
    const binaryPath = getAtlasBinaryPath();
    const homeDir = process.env.USERPROFILE || "C:\\Users\\Default";

    // Create log directory
    await Deno.mkdir(this.paths.logDir, { recursive: true });

    // Persist configuration for later start/status
    try {
      await Deno.mkdir(this.paths.configDir, { recursive: true });
      await Deno.writeTextFile(this.configPath, JSON.stringify({ port: config.port }, null, 2));
    } catch (_err) {
      // Best effort; start() will fallback to default port
    }

    // For Windows, we'll use the Startup folder approach (no admin required)
    const startupFolder = `${homeDir}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup`;
    const startupBatch = `${startupFolder}\\Atlas.bat`;

    // Create batch file content that starts service in background
    const batchContent = `@echo off
rem Atlas Service Auto-Start
cd /d "${homeDir}"
rem Start Atlas service (which manages the daemon in background)
"${binaryPath}" service start
exit
`;

    // Write to startup folder
    try {
      await Deno.mkdir(startupFolder, { recursive: true });
      await Deno.writeTextFile(startupBatch, batchContent);
      logger.info("Atlas startup configured successfully", { startupBatch });
    } catch (error) {
      logger.warn("Could not create startup entry", { error });
    }
  }

  async uninstall(): Promise<void> {
    const homeDir = process.env.USERPROFILE || "C:\\Users\\Default";

    // Stop service if running
    try {
      await this.stop(true);
    } catch {
      // Service might not be running, continue with uninstall
    }

    // Remove startup folder entry
    const startupBatch = `${homeDir}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Atlas.bat`;
    try {
      await Deno.remove(startupBatch);
      logger.info("Atlas startup entries removed successfully");
    } catch {
      // File might not exist
    }

    // Remove stored config
    try {
      await Deno.remove(this.configPath);
    } catch {
      // ignore
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

    // Start Atlas daemon in a background windowless process using PowerShell Start-Process
    const binaryPath = getAtlasBinaryPath();
    const port = await this.getConfiguredPort();
    const psArgs = [
      "-NoProfile",
      "-Command",
      // Use -WindowStyle Hidden to avoid a visible window
      `Start-Process -WindowStyle Hidden -FilePath '${binaryPath.replaceAll(
        "'",
        "''",
      )}' -ArgumentList 'daemon start --port ${port}'`,
    ];

    try {
      const cmd = new Deno.Command("powershell.exe", {
        args: psArgs,
        stdout: "null",
        stderr: "null",
        stdin: "null",
      });
      cmd.spawn();
    } catch (error) {
      throw new Error(
        `Failed to launch Atlas daemon in background: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Wait up to ~10s for the daemon to report running
    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const s = await this.getStatus();
      if (s.running) break;
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

    // Force kill daemon-only atlas processes if still running or if force flag is set
    // Avoid killing the updater or CLI processes running other commands
    if (force || (await this.getStatus()).running) {
      try {
        // Use PowerShell to enumerate atlas.exe processes with their command lines
        const listCmd = new Deno.Command("powershell.exe", {
          args: [
            "-NoProfile",
            "-Command",
            // Convert to JSON for reliable parsing; handle zero/one/many results
            "($procs = Get-CimInstance Win32_Process -Filter \"name='atlas.exe'\") | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress",
          ],
          stdout: "piped",
          stderr: "piped",
        });
        const listRes = await listCmd.output();

        if (listRes.success) {
          const json = this.textDecoder.decode(listRes.stdout).trim();
          if (json) {
            // Schema for WMI process entry
            const WmiProcessSchema = z.object({
              ProcessId: z.number(),
              CommandLine: z.string().nullable().optional(),
            });
            const WmiProcessArraySchema = z.union([WmiProcessSchema, z.array(WmiProcessSchema)]);

            let entries: z.infer<typeof WmiProcessSchema>[] = [];
            try {
              const parsed = WmiProcessArraySchema.parse(JSON.parse(json));
              entries = Array.isArray(parsed) ? parsed : [parsed];
            } catch {
              entries = [];
            }

            const currentPid = Deno.pid;
            const daemonPids = entries
              .filter((e) => typeof e.ProcessId === "number")
              .filter(
                (e) =>
                  (e.CommandLine || "").toLowerCase().includes("daemon") &&
                  (e.CommandLine || "").toLowerCase().includes("start"),
              )
              .map((e) => e.ProcessId)
              .filter((pid) => pid !== currentPid);

            for (const pid of daemonPids) {
              try {
                const kill = new Deno.Command("taskkill", {
                  args: ["/PID", String(pid), "/F"],
                  stdout: "piped",
                  stderr: "piped",
                });
                await kill.output();
              } catch {
                // ignore individual failures
              }
            }
          }
        }
      } catch {
        // As a last resort, do not blanket-kill by image name to avoid terminating the updater
      }
    }
  }

  async getStatus(): Promise<ServiceStatus> {
    // Determine daemon status by checking the listening port and mapping to PID
    let running = false;
    let pid: number | undefined;
    let port: number | undefined;

    const configuredPort = await this.getConfiguredPort();
    try {
      // netstat -ano shows PID for listening sockets on Windows
      const netstatCmd = new Deno.Command("netstat", {
        args: ["-ano"],
        stdout: "piped",
        stderr: "piped",
      });
      const netstatResult = await netstatCmd.output();
      if (netstatResult.success) {
        const output = this.textDecoder.decode(netstatResult.stdout);
        // Match lines like: TCP    0.0.0.0:8080         0.0.0.0:0              LISTENING       1234
        const line = output
          .split("\n")
          .find((l) => l.includes(`:${configuredPort}`) && l.toUpperCase().includes("LISTENING"));
        if (line) {
          const parts = line.trim().split(/\s+/);
          const maybePid = parts[parts.length - 1];
          if (maybePid) {
            const parsedPid = Number.parseInt(maybePid, 10);
            if (Number.isFinite(parsedPid)) {
              // Verify the PID belongs to atlas.exe
              try {
                const tlCmd = new Deno.Command("tasklist", {
                  args: ["/FI", `PID eq ${parsedPid}`, "/FO", "CSV", "/NH"],
                  stdout: "piped",
                  stderr: "piped",
                });
                const tlRes = await tlCmd.output();
                if (tlRes.success) {
                  const tlOut = this.textDecoder.decode(tlRes.stdout).trim();
                  if (tlOut?.startsWith('"atlas.exe"')) {
                    pid = parsedPid;
                    running = true;
                    port = configuredPort;
                  }
                }
              } catch {
                // If tasklist check fails, still consider the port as running
                pid = parsedPid;
                running = true;
                port = configuredPort;
              }
            }
          }
        }
      }
    } catch {
      // If netstat fails, fall back to simple process presence (best-effort)
      try {
        const pidCmd = new Deno.Command("tasklist", {
          args: ["/FI", "IMAGENAME eq atlas.exe", "/FO", "CSV", "/NH"],
          stdout: "piped",
          stderr: "piped",
        });
        const pidResult = await pidCmd.output();
        if (pidResult.success) {
          const out = this.textDecoder.decode(pidResult.stdout).trim();
          if (!(out.includes("INFO:") || out === "")) {
            running = true; // unknown PID/port
          }
        }
      } catch {
        // ignore
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
    const homeDir = process.env.USERPROFILE || "C:\\Users\\Default";
    const startupBatch = `${homeDir}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Atlas.bat`;

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

  private async getConfiguredPort(): Promise<number> {
    try {
      const text = await Deno.readTextFile(this.configPath);
      const configData = portConfigSchema.parse(JSON.parse(text));
      return configData.port;
    } catch {
      // ignore
    }
    return 8080;
  }
}
