import process from "node:process";
import { ServiceManager } from "../../services/service-manager.ts";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import type { YargsInstance } from "../../utils/yargs.ts";

interface UninstallArgs {
  force?: boolean;
}

export const command = "uninstall";
export const desc = "Uninstall Atlas system service";

export const examples = [
  ["$0 service uninstall", "Uninstall Atlas service"],
  ["$0 service uninstall --force", "Force uninstall even if service is running"],
];

export function builder(y: YargsInstance) {
  return y
    .option("force", {
      type: "boolean",
      describe: "Force uninstall even if service is running",
      default: false,
    })
    .example("$0 service uninstall", "Remove Atlas service")
    .example("$0 service uninstall --force", "Force removal");
}

export const handler = async (argv: UninstallArgs): Promise<void> => {
  try {
    const serviceManager = ServiceManager.getInstance();

    // Check if service is installed
    const isInstalled = await serviceManager.isInstalled();
    if (!isInstalled) {
      infoOutput("Atlas service is not installed");
      return;
    }

    // Check if service is running
    const status = await serviceManager.getStatus();
    if (status.running && !argv.force) {
      errorOutput(
        "Atlas service is currently running. Stop it first or use --force to force uninstall.",
      );
      process.exit(1);
    }

    if (status.running) {
      infoOutput("Stopping running service...");
      try {
        await serviceManager.stop();
        successOutput("Service stopped");
      } catch (error) {
        if (argv.force) {
          infoOutput("Failed to stop service gracefully, proceeding with forced uninstall");
        } else {
          throw error;
        }
      }
    }

    infoOutput("Uninstalling Atlas service...");
    await serviceManager.uninstall();
    successOutput("Atlas service uninstalled successfully");
    infoOutput("Service will no longer start automatically on system boot");
  } catch (error) {
    errorOutput(
      `Failed to uninstall service: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
};
