import process from "node:process";
import { ServiceManager } from "../../services/service-manager.ts";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import type { YargsInstance } from "../../utils/yargs.ts";

interface InstallArgs {
  force?: boolean;
  port?: number;
  autoStart?: boolean;
}

export const command = "install";
export const desc = "Install Atlas as a system service";

export const examples = [
  ["$0 service install", "Install Atlas service with default settings"],
  ["$0 service install --force", "Force reinstall if service already exists"],
  ["$0 service install --port 3000", "Install service on specific port"],
  ["$0 service install --no-auto-start", "Install but don't start service automatically"],
];

export function builder(y: YargsInstance) {
  return y
    .option("force", {
      type: "boolean",
      describe: "Force reinstall if service already exists",
      default: false,
    })
    .option("port", {
      type: "number",
      alias: "p",
      describe: "Port for Atlas daemon service",
      default: 8080,
    })
    .option("auto-start", {
      type: "boolean",
      describe: "Automatically start service after installation",
      default: true,
    })
    .example("$0 service install", "Install with default settings")
    .example("$0 service install --force", "Force reinstall")
    .example("$0 service install --port 3000", "Install on specific port");
}

export const handler = async (argv: InstallArgs): Promise<void> => {
  try {
    const serviceManager = ServiceManager.getInstance();

    // Check if service already exists
    const isInstalled = await serviceManager.isInstalled();
    if (isInstalled && !argv.force) {
      errorOutput("Atlas service is already installed. Use --force to reinstall.");
      process.exit(1);
    }

    if (isInstalled && argv.force) {
      infoOutput("Removing existing service before reinstall...");
      await serviceManager.uninstall();
    }

    infoOutput("Installing Atlas service...");

    const config = { port: argv.port || 8080, autoStart: argv.autoStart ?? true };

    await serviceManager.install(config);
    successOutput("Atlas service installed successfully");

    if (config.autoStart) {
      infoOutput("Starting Atlas service...");
      await serviceManager.start();
      successOutput("Atlas service started");

      // Give service a moment to start
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const status = await serviceManager.getStatus();
      if (status.running) {
        successOutput(`Service is running on port ${config.port}`);
        infoOutput("Service will automatically start on system boot");
      } else {
        errorOutput("Service installed but failed to start. Check logs for details.");
      }
    } else {
      infoOutput("Service installed but not started. Use 'atlas service start' to start it.");
    }
  } catch (error) {
    errorOutput(
      `Failed to install service: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
};
