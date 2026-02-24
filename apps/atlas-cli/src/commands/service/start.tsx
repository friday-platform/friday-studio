import process from "node:process";
import { ServiceManager } from "../../services/service-manager.ts";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import type { YargsInstance } from "../../utils/yargs.ts";

interface StartArgs {
  wait?: boolean;
}

export const command = "start";
export const desc = "Start Atlas service";

export const examples = [
  ["$0 service start", "Start Atlas service"],
  ["$0 service start --wait", "Start service and wait for it to be ready"],
];

export function builder(y: YargsInstance) {
  return y
    .option("wait", {
      type: "boolean",
      describe: "Wait for service to be ready before returning",
      default: false,
    })
    .example("$0 service start", "Start the service")
    .example("$0 service start --wait", "Start and wait for ready");
}

export const handler = async (argv: StartArgs): Promise<void> => {
  try {
    const serviceManager = ServiceManager.getInstance();

    // Check if service is installed
    const isInstalled = await serviceManager.isInstalled();
    if (!isInstalled) {
      errorOutput("Atlas service is not installed. Use 'atlas service install' first.");
      process.exit(1);
    }

    // Check if service is already running
    const currentStatus = await serviceManager.getStatus();
    if (currentStatus.running) {
      infoOutput("Atlas service is already running");
      if (currentStatus.port) {
        infoOutput(`Listening on port: ${currentStatus.port}`);
      }
      return;
    }

    infoOutput("Starting Atlas service...");
    await serviceManager.start();

    if (argv.wait) {
      infoOutput("Waiting for service to be ready...");

      // On macOS, give launchd extra time to start the process after binary update
      const platform = serviceManager.getPlatform();
      if (platform === "macos") {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      let attempts = 0;
      const maxAttempts = 30; // 30 seconds

      while (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const status = await serviceManager.getStatus();
        if (status.running) {
          successOutput("Atlas service started successfully");
          if (status.port) {
            infoOutput(`Service is listening on port: ${status.port}`);
          }
          return;
        }

        attempts++;
      }

      // Don't treat timeout as error - service may still be starting
      infoOutput("Service is taking longer than expected to start");
      infoOutput("Check service status with 'atlas service status'");
      // Exit with success to avoid false error in update command
      return;
    } else {
      successOutput("Atlas service start command issued");
      infoOutput("Use 'atlas service status' to check if service started successfully");
    }
  } catch (error) {
    errorOutput(
      `Failed to start service: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
};
