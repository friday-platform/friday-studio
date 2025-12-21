import process from "node:process";
import { exists } from "@std/fs";
import { join } from "@std/path";
import {
  getAtlasBinaryPath,
  getDefaultServiceName,
  getPlatformPaths,
  getSystemBinaryPath,
} from "../../utils/platform.ts";
import type {
  LaunchAgentConfig,
  PlatformServiceManager,
  ServiceConfig,
  ServiceStatus,
} from "../types.ts";

export class MacOSLaunchdService implements PlatformServiceManager {
  private readonly serviceName: string;
  private readonly serviceDir: string;
  private readonly plistPath: string;
  private readonly textDecoder = new TextDecoder();

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

    // Get binary path - prefer system binary path if it's a symlink to our binary
    let binaryPath = getAtlasBinaryPath();

    // Check if system binary exists and is accessible
    const systemBinaryPath = getSystemBinaryPath();
    try {
      const systemBinaryStat = await Deno.lstat(systemBinaryPath);
      if (systemBinaryStat.isSymlink) {
        // It's a symlink, check if it points to our binary
        const symlinkTarget = await Deno.readLink(systemBinaryPath);
        const resolvedTarget = symlinkTarget.startsWith("/")
          ? symlinkTarget
          : `/usr/local/bin/${symlinkTarget}`;

        // If the symlink points to a valid atlas binary, use the symlink path instead
        if (resolvedTarget === binaryPath || resolvedTarget.includes("/.atlas/bin/atlas")) {
          binaryPath = systemBinaryPath;
        }
      } else if (systemBinaryStat.isFile) {
        // It's a regular file, use it if it's executable
        binaryPath = systemBinaryPath;
      }
    } catch {
      // System binary doesn't exist or isn't accessible, use default
    }

    // Verify binary exists
    if (!(await exists(binaryPath))) {
      throw new Error(`Atlas binary not found at ${binaryPath}. Please install Atlas first.`);
    }

    // Create LaunchAgent configuration
    const logDir = getPlatformPaths().logDir;
    await Deno.mkdir(logDir, { recursive: true });

    const launchAgentConfig: LaunchAgentConfig = {
      Label: this.serviceName,
      ProgramArguments: [binaryPath, "daemon", "start", "--port", config.port.toString()],
      WorkingDirectory: getPlatformPaths().configDir,
      EnvironmentVariables: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME || "",
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

    // Before writing new plist, check if service is already loaded
    // If it is, we need to unload it first to avoid conflicts
    try {
      const listCmd = new Deno.Command("launchctl", {
        args: ["list", this.serviceName],
        stdout: "piped",
        stderr: "piped",
      });
      const listResult = await listCmd.output();

      if (listResult.success) {
        // Service is loaded, unload it first
        const unloadCmd = new Deno.Command("launchctl", {
          args: ["unload", this.plistPath],
          stdout: "piped",
          stderr: "piped",
        });
        await unloadCmd.output();
        // Give launchctl a moment to fully unload
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch {
      // Service not loaded, continue
    }

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
    // The -w flag is CRITICAL - it overrides the disabled state and ensures the service starts
    try {
      const loadCmd = new Deno.Command("launchctl", {
        args: ["load", "-w", this.plistPath],
        stdout: "piped",
        stderr: "piped",
      });

      const result = await loadCmd.output();

      if (!result.success) {
        const stderr = this.textDecoder.decode(result.stderr);
        // Don't delete plist on load failure - it might be a temporary issue
        throw new Error(`Failed to load service: ${stderr}`);
      }
    } catch (error) {
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
      const stderr = this.textDecoder.decode(result.stderr);
      throw new Error(`Failed to start service: ${stderr}`);
    }
  }

  async stop(force = false): Promise<void> {
    let args: string[];

    if (force) {
      // Get current user ID for launchctl kill target specifier
      const uid = Deno.uid();
      const target = `gui/${uid}/${this.serviceName}`;
      args = ["kill", "TERM", target];
    } else {
      args = ["stop", this.serviceName];
    }

    const cmd = new Deno.Command("launchctl", { args, stdout: "piped", stderr: "piped" });

    const result = await cmd.output();

    if (!result.success) {
      const stderr = this.textDecoder.decode(result.stderr);
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
        const output = this.textDecoder.decode(result.stdout);

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
    // We control all inputs - no need for complex escaping
    const programArgs = config.ProgramArguments.map((arg) => `    <string>${arg}</string>`).join(
      "\n",
    );

    const envVars = Object.entries(config.EnvironmentVariables || {})
      .map(([k, v]) => `    <key>${k}</key>\n    <string>${v}</string>`)
      .join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${config.Label}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>WorkingDirectory</key>
  <string>${config.WorkingDirectory}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envVars}
  </dict>
  <key>RunAtLoad</key>
  <${config.RunAtLoad}/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${config.StandardOutPath}</string>
  <key>StandardErrorPath</key>
  <string>${config.StandardErrorPath}</string>
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>10240</integer>
  </dict>
  <key>HardResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>10240</integer>
  </dict>
</dict>
</plist>`;
  }
}
