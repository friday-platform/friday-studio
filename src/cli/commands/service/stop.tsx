import { ServiceManager } from "../../../services/service-manager.ts";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import type { YargsInstance } from "../../utils/yargs.ts";

interface StopArgs {
  force?: boolean;
  wait?: boolean;
}

export const command = "stop";
export const desc = "Stop Atlas service";

export const examples = [
  ["$0 service stop", "Stop Atlas service gracefully"],
  ["$0 service stop --force", "Force stop the service"],
  ["$0 service stop --wait", "Stop service and wait for it to fully stop"],
];

export function builder(y: YargsInstance) {
  return y
    .option("force", { type: "boolean", describe: "Force stop the service", default: false })
    .option("wait", {
      type: "boolean",
      describe: "Wait for service to fully stop before returning",
      default: false,
    })
    .example("$0 service stop", "Stop the service")
    .example("$0 service stop --force", "Force stop")
    .example("$0 service stop --wait", "Stop and wait");
}

export const handler = async (argv: StopArgs): Promise<void> => {
  try {
    const serviceManager = ServiceManager.getInstance();

    // Check if service is installed
    const isInstalled = await serviceManager.isInstalled();
    if (!isInstalled) {
      infoOutput("Atlas service is not installed");
      return;
    }

    // Check if service is running
    const currentStatus = await serviceManager.getStatus();
    if (!currentStatus.running) {
      infoOutput("Atlas service is not running");
      return;
    }

    const action = argv.force ? "Force stopping" : "Stopping";
    infoOutput(`${action} Atlas service...`);

    await serviceManager.stop(argv.force);

    if (argv.wait) {
      infoOutput("Waiting for service to stop...");

      let attempts = 0;
      const maxAttempts = 30; // 30 seconds

      while (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const status = await serviceManager.getStatus();
        if (!status.running) {
          successOutput("Atlas service stopped successfully");
          return;
        }

        attempts++;
      }

      errorOutput("Service stop timeout - service may still be stopping");
      infoOutput("Check service status with 'atlas service status'");
    } else {
      successOutput("Atlas service stop command issued");
      infoOutput("Use 'atlas service status' to verify service stopped");
    }
  } catch (error) {
    errorOutput(
      `Failed to stop service: ${error instanceof Error ? error.message : String(error)}`,
    );
    Deno.exit(1);
  }
};
