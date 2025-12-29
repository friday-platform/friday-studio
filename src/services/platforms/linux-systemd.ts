import { mkdir, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import { exists } from "@std/fs";
import { join } from "@std/path";
import {
  getAtlasBinaryPath,
  getDefaultServiceName,
  getPlatformPaths,
} from "../../utils/platform.ts";
import { portConfigSchema } from "../schemas.ts";
import type { PlatformServiceManager, ServiceConfig, ServiceStatus } from "../types.ts";

/**
 * Linux systemd service manager for Atlas
 * Uses user-level systemd services (systemctl --user)
 */
export class LinuxSystemdService implements PlatformServiceManager {
  private serviceName: string;
  private serviceFile: string;
  private paths: ReturnType<typeof getPlatformPaths>;
  private textDecoder = new TextDecoder();

  constructor() {
    this.serviceName = getDefaultServiceName();
    this.paths = getPlatformPaths();
    this.serviceFile = join(this.paths.serviceDir, `${this.serviceName}.service`);
  }

  async install(config: ServiceConfig): Promise<void> {
    // Ensure service directory exists
    await mkdir(this.paths.serviceDir, { recursive: true });

    // Create systemd service file
    const serviceContent = this.generateServiceFile(config);
    await writeFile(this.serviceFile, serviceContent, "utf-8");

    // Reload systemd daemon to recognize new service
    const reloadCmd = new Deno.Command("systemctl", {
      args: ["--user", "daemon-reload"],
      stdout: "piped",
      stderr: "piped",
    });

    const reloadResult = await reloadCmd.output();
    if (!reloadResult.success) {
      const error = this.textDecoder.decode(reloadResult.stderr);
      throw new Error(`Failed to reload systemd daemon: ${error}`);
    }

    // Enable service to start on boot (user session)
    const enableCmd = new Deno.Command("systemctl", {
      args: ["--user", "enable", this.serviceName],
      stdout: "piped",
      stderr: "piped",
    });

    const enableResult = await enableCmd.output();
    if (!enableResult.success) {
      const error = this.textDecoder.decode(enableResult.stderr);
      throw new Error(`Failed to enable service: ${error}`);
    }
  }

  async uninstall(): Promise<void> {
    // Stop service if running
    try {
      await this.stop(true);
    } catch {
      // Service might not be running, continue with uninstall
    }

    // Disable service
    try {
      const disableCmd = new Deno.Command("systemctl", {
        args: ["--user", "disable", this.serviceName],
        stdout: "piped",
        stderr: "piped",
      });
      await disableCmd.output();
    } catch {
      // Service might not be enabled, continue
    }

    // Remove service file
    try {
      await rm(this.serviceFile);
    } catch {
      // File might not exist, continue
    }

    // Reload systemd daemon
    const reloadCmd = new Deno.Command("systemctl", {
      args: ["--user", "daemon-reload"],
      stdout: "piped",
      stderr: "piped",
    });
    await reloadCmd.output();
  }

  async start(): Promise<void> {
    const cmd = new Deno.Command("systemctl", {
      args: ["--user", "start", this.serviceName],
      stdout: "piped",
      stderr: "piped",
    });

    const result = await cmd.output();
    if (!result.success) {
      const error = this.textDecoder.decode(result.stderr);
      throw new Error(`Failed to start service: ${error}`);
    }
  }

  async stop(force = false): Promise<void> {
    const args = force
      ? ["--user", "kill", "--signal=SIGKILL", this.serviceName]
      : ["--user", "stop", this.serviceName];

    const cmd = new Deno.Command("systemctl", { args, stdout: "piped", stderr: "piped" });

    const result = await cmd.output();
    if (!result.success) {
      const error = this.textDecoder.decode(result.stderr);
      throw new Error(`Failed to stop service: ${error}`);
    }
  }

  async getStatus(): Promise<ServiceStatus> {
    const cmd = new Deno.Command("systemctl", {
      args: ["--user", "is-active", this.serviceName],
      stdout: "piped",
      stderr: "piped",
    });

    const result = await cmd.output();
    const output = this.textDecoder.decode(result.stdout).trim();
    const running = output === "active";

    let pid: number | undefined;
    let port: number | undefined;

    if (running) {
      // Get PID
      try {
        const pidCmd = new Deno.Command("systemctl", {
          args: ["--user", "show", "--property=MainPID", this.serviceName],
          stdout: "piped",
          stderr: "piped",
        });
        const pidResult = await pidCmd.output();
        const pidOutput = this.textDecoder.decode(pidResult.stdout).trim();
        const pidMatch = pidOutput.match(/MainPID=(\d+)/);
        const pidString = pidMatch?.[1];
        if (pidString && pidString !== "0") {
          pid = parseInt(pidString, 10);
        }
      } catch {
        // PID detection failed, continue without it
      }

      // Try to detect port from Atlas daemon status
      try {
        const atlasCmd = new Deno.Command(getAtlasBinaryPath(), {
          args: ["daemon", "status", "--json"],
          stdout: "piped",
          stderr: "piped",
        });
        const atlasResult = await atlasCmd.output();
        if (atlasResult.success) {
          const statusData = portConfigSchema.parse(
            JSON.parse(this.textDecoder.decode(atlasResult.stdout)),
          );
          port = statusData.port;
        }
      } catch {
        // Default port if detection fails
        port = 8080;
      }
    }

    return {
      running,
      platform: "linux",
      serviceName: this.serviceName,
      pid,
      port,
      uptime: running ? await this.getUptime() : undefined,
      installed: await this.isInstalled(),
    };
  }

  async isInstalled(): Promise<boolean> {
    return await exists(this.serviceFile);
  }

  private generateServiceFile(config: ServiceConfig): string {
    const binaryPath = getAtlasBinaryPath();
    const description = "Atlas AI Agent Orchestration Platform";

    return `[Unit]
Description=${description}
Documentation=https://docs.tempestlabs.ai
After=network.target

[Service]
Type=exec
ExecStart=${binaryPath} daemon start --port=${config.port}
Restart=always
RestartSec=5
StandardOutput=append:${this.paths.logDir}/atlas-service.log
StandardError=append:${this.paths.logDir}/atlas-service-error.log

# Environment variables
Environment=HOME=${process.env.HOME || "/home/user"}
Environment=USER=${process.env.USER || "user"}
Environment=PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=${this.paths.configDir}

[Install]
WantedBy=default.target
`;
  }

  private async getUptime(): Promise<string | undefined> {
    try {
      const cmd = new Deno.Command("systemctl", {
        args: ["--user", "show", "--property=ActiveEnterTimestamp", this.serviceName],
        stdout: "piped",
        stderr: "piped",
      });
      const result = await cmd.output();
      const output = this.textDecoder.decode(result.stdout).trim();
      const timestampMatch = output.match(/ActiveEnterTimestamp=(.+)/);

      if (timestampMatch?.[1]) {
        const startTime = new Date(timestampMatch[1]);
        const now = new Date();
        const uptimeMs = now.getTime() - startTime.getTime();
        const uptimeSeconds = Math.floor(uptimeMs / 1000);
        const hours = Math.floor(uptimeSeconds / 3600);
        const minutes = Math.floor((uptimeSeconds % 3600) / 60);
        const seconds = uptimeSeconds % 60;

        if (hours > 0) {
          return `${hours}h ${minutes}m ${seconds}s`;
        } else if (minutes > 0) {
          return `${minutes}m ${seconds}s`;
        } else {
          return `${seconds}s`;
        }
      }
    } catch {
      // Uptime detection failed
    }
    return undefined;
  }
}
