import { join } from "@std/path";
import { exists } from "@std/fs";
import {
  LaunchAgentConfig,
  PlatformServiceManager,
  ServiceConfig,
  ServiceStatus,
} from "../types.ts";
import {
  getAtlasBinaryPath,
  getDefaultServiceName,
  getPlatformPaths,
} from "../../utils/platform.ts";

export class MacOSLaunchdService implements PlatformServiceManager {
  private readonly serviceName: string;
  private readonly serviceDir: string;
  private readonly plistPath: string;

  constructor() {
    this.serviceName = getDefaultServiceName();
    this.serviceDir = getPlatformPaths().serviceDir;
    this.plistPath = join(this.serviceDir, `${this.serviceName}.plist`);
  }

  async install(config: ServiceConfig): Promise<void> {
    // Ensure service directory exists
    try {
      await Deno.mkdir(this.serviceDir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) {
        throw new Error(
          `Failed to create service directory: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Get binary path
    const binaryPath = getAtlasBinaryPath();

    // Verify binary exists
    if (!await exists(binaryPath)) {
      throw new Error(`Atlas binary not found at ${binaryPath}. Please install Atlas first.`);
    }

    // Create LaunchAgent configuration
    const logDir = getPlatformPaths().logDir;
    await Deno.mkdir(logDir, { recursive: true });

    const launchAgentConfig: LaunchAgentConfig = {
      Label: this.serviceName,
      ProgramArguments: [
        binaryPath,
        "daemon",
        "start",
        "--port",
        config.port.toString(),
      ],
      WorkingDirectory: getPlatformPaths().configDir,
      EnvironmentVariables: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: Deno.env.get("HOME") || "",
        ...config.environment,
      },
      RunAtLoad: config.autoStart,
      KeepAlive: {
        SuccessfulExit: false, // Restart if process exits unexpectedly
      },
      StandardOutPath: join(logDir, "atlas-service.log"),
      StandardErrorPath: join(logDir, "atlas-service-error.log"),
    };

    // Convert to plist XML format
    const plistXml = this.generatePlistXml(launchAgentConfig);

    // Write plist file
    try {
      await Deno.writeTextFile(this.plistPath, plistXml);
    } catch (error) {
      throw new Error(
        `Failed to write service configuration: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Load the service with launchctl
    try {
      const loadCmd = new Deno.Command("launchctl", {
        args: ["load", this.plistPath],
        stdout: "piped",
        stderr: "piped",
      });

      const result = await loadCmd.output();

      if (!result.success) {
        const stderr = new TextDecoder().decode(result.stderr);
        throw new Error(`Failed to load service: ${stderr}`);
      }
    } catch (error) {
      // Clean up plist file if load failed
      try {
        await Deno.remove(this.plistPath);
      } catch {
        // Ignore cleanup errors
      }
      throw new Error(
        `Failed to register service with launchctl: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async uninstall(): Promise<void> {
    // Unload the service if it's loaded
    try {
      const unloadCmd = new Deno.Command("launchctl", {
        args: ["unload", this.plistPath],
        stdout: "piped",
        stderr: "piped",
      });

      await unloadCmd.output();
      // Don't throw on unload errors - service might not be loaded
    } catch {
      // Ignore unload errors
    }

    // Remove plist file
    try {
      await Deno.remove(this.plistPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new Error(
          `Failed to remove service configuration: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async start(): Promise<void> {
    const cmd = new Deno.Command("launchctl", {
      args: ["start", this.serviceName],
      stdout: "piped",
      stderr: "piped",
    });

    const result = await cmd.output();

    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to start service: ${stderr}`);
    }
  }

  async stop(force = false): Promise<void> {
    const cmd = new Deno.Command("launchctl", {
      args: force ? ["kill", "TERM", this.serviceName] : ["stop", this.serviceName],
      stdout: "piped",
      stderr: "piped",
    });

    const result = await cmd.output();

    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to stop service: ${stderr}`);
    }
  }

  async getStatus(): Promise<ServiceStatus> {
    const status: ServiceStatus = {
      running: false,
      platform: "macos",
      serviceName: this.serviceName,
      installed: await this.isInstalled(),
    };

    if (!status.installed) {
      return status;
    }

    try {
      // Check if service is loaded and running
      const listCmd = new Deno.Command("launchctl", {
        args: ["list", this.serviceName],
        stdout: "piped",
        stderr: "piped",
      });

      const result = await listCmd.output();

      if (result.success) {
        const output = new TextDecoder().decode(result.stdout);

        // Parse launchctl list output for specific service
        // The output is in property list format when querying a specific service
        if (output.includes('"PID"')) {
          // Extract PID from property list format
          const pidMatch = output.match(/"PID"\s*=\s*(\d+);/);
          const pidString = pidMatch?.[1];
          if (pidString) {
            status.running = true;
            status.pid = parseInt(pidString, 10);
          }
        }
      }

      // Try to determine port from service configuration
      try {
        const configText = await Deno.readTextFile(this.plistPath);
        const portMatch = configText.match(/--port[\s\n]*<string>(\d+)<\/string>/);
        const portString = portMatch?.[1];
        if (portString) {
          status.port = parseInt(portString, 10);
        }
      } catch {
        // Ignore config parsing errors
      }
    } catch (error) {
      status.error = error instanceof Error ? error.message : String(error);
    }

    return status;
  }

  async isInstalled(): Promise<boolean> {
    return await exists(this.plistPath);
  }

  private generatePlistXml(config: LaunchAgentConfig): string {
    const programArgs = config.ProgramArguments
      .map((arg) => `\t\t<string>${this.escapeXml(arg)}</string>`)
      .join("\n");

    const environmentVars = config.EnvironmentVariables
      ? Object.entries(config.EnvironmentVariables)
        .map(([key, value]) =>
          `\t\t<key>${this.escapeXml(key)}</key>\n\t\t<string>${this.escapeXml(value)}</string>`
        )
        .join("\n")
      : "";

    const keepAlive = typeof config.KeepAlive === "boolean"
      ? (config.KeepAlive ? "<true/>" : "<false/>")
      : `<dict>
\t\t<key>SuccessfulExit</key>
\t\t<${config.KeepAlive.SuccessfulExit ? "true" : "false"}/>
\t</dict>`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${this.escapeXml(config.Label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${programArgs}
\t</array>
${
      config.WorkingDirectory
        ? `\t<key>WorkingDirectory</key>\n\t<string>${
          this.escapeXml(config.WorkingDirectory)
        }</string>`
        : ""
    }
${
      environmentVars
        ? `\t<key>EnvironmentVariables</key>\n\t<dict>\n${environmentVars}\n\t</dict>`
        : ""
    }
\t<key>RunAtLoad</key>
\t<${config.RunAtLoad ? "true" : "false"}/>
\t<key>KeepAlive</key>
\t${keepAlive}
${
      config.StandardOutPath
        ? `\t<key>StandardOutPath</key>\n\t<string>${
          this.escapeXml(config.StandardOutPath)
        }</string>`
        : ""
    }
${
      config.StandardErrorPath
        ? `\t<key>StandardErrorPath</key>\n\t<string>${
          this.escapeXml(config.StandardErrorPath)
        }</string>`
        : ""
    }
</dict>
</plist>`;
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }
}
