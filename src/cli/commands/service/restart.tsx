import process from "node:process";
import { ServiceManager } from "../../../services/service-manager.ts";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import type { YargsInstance } from "../../utils/yargs.ts";

interface RestartArgs {
  force?: boolean;
  wait?: boolean;
}

export const command = "restart";
export const desc = "Restart Atlas service";

export const examples = [
  ["$0 service restart", "Restart Atlas service"],
  ["$0 service restart --force", "Force restart the service"],
  ["$0 service restart --wait", "Restart service and wait for it to be ready"],
];

export function builder(y: YargsInstance) {
  return y
    .option("force", {
      type: "boolean",
      describe: "Force stop the service before restarting",
      default: false,
    })
    .option("wait", {
      type: "boolean",
      describe: "Wait for service to be ready after restart",
      default: false,
    })
    .example("$0 service restart", "Restart the service")
    .example("$0 service restart --force", "Force restart")
    .example("$0 service restart --wait", "Restart and wait for ready");
}

export const handler = async (argv: RestartArgs): Promise<void> => {
  try {
    const serviceManager = ServiceManager.getInstance();

    // Check if service is installed
    const isInstalled = await serviceManager.isInstalled();
    if (!isInstalled) {
      errorOutput("Atlas service is not installed. Use 'atlas service install' first.");
      process.exit(1);
    }

    // Check current status
    const currentStatus = await serviceManager.getStatus();
    const wasRunning = currentStatus.running;

    if (wasRunning) {
      // Stop the service first
      const action = argv.force ? "Force stopping" : "Stopping";
      infoOutput(`${action} Atlas service...`);

      await serviceManager.stop(argv.force);

      // Wait for service to stop
      infoOutput("Waiting for service to stop...");
      let attempts = 0;
      const maxAttempts = 30; // 30 seconds

      while (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const status = await serviceManager.getStatus();
        if (!status.running) {
          break;
        }

        attempts++;
      }

      if (attempts >= maxAttempts) {
        errorOutput("Service stop timeout - proceeding with start anyway");
      }

      // Wait 1 second before starting after stop
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } else {
      infoOutput("Atlas service is not running, starting service...");
    }

    // Start the service
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
          successOutput("Atlas service restarted successfully");
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
      return;
    } else {
      successOutput("Atlas service restart command issued");
      infoOutput("Use 'atlas service status' to check if service restarted successfully");
    }
  } catch (error) {
    errorOutput(
      `Failed to restart service: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
};
