import process from "node:process";
import { ServiceManager } from "../../../services/service-manager.ts";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import type { YargsInstance } from "../../utils/yargs.ts";

interface StatusArgs {
  json?: boolean;
}

export const command = "status";
export const desc = "Check Atlas service status";

export const examples = [
  ["$0 service status", "Check service status"],
  ["$0 service status --json", "Output status as JSON"],
];

export function builder(y: YargsInstance) {
  return y
    .option("json", { type: "boolean", describe: "Output status as JSON", default: false })
    .example("$0 service status", "Check service status")
    .example("$0 service status --json", "JSON output");
}

export const handler = async (argv: StatusArgs): Promise<void> => {
  try {
    const serviceManager = ServiceManager.getInstance();

    const isInstalled = await serviceManager.isInstalled();
    const status = await serviceManager.getStatus();

    if (argv.json) {
      console.log(
        JSON.stringify(
          {
            installed: isInstalled,
            running: status.running,
            platform: status.platform,
            serviceName: status.serviceName,
            pid: status.pid,
            port: status.port,
            uptime: status.uptime,
            error: status.error,
          },
          null,
          2,
        ),
      );
      return;
    }

    // Human-readable output
    if (!isInstalled) {
      infoOutput("Atlas service is not installed");
      infoOutput("Use 'atlas service install' to install the service");
      return;
    }

    successOutput("Atlas service is installed");

    if (status.running) {
      successOutput(`Service is running (PID: ${status.pid || "unknown"})`);
      if (status.port) {
        infoOutput(`Listening on port: ${status.port}`);
      }
      if (status.uptime) {
        infoOutput(`Uptime: ${status.uptime}`);
      }
    } else {
      errorOutput("Service is not running");
      if (status.error) {
        errorOutput(`Error: ${status.error}`);
      }
      infoOutput("Use 'atlas service start' to start the service");
    }

    infoOutput(`Platform: ${status.platform}`);
    infoOutput(`Service name: ${status.serviceName}`);
  } catch (error) {
    if (argv.json) {
      console.log(
        JSON.stringify(
          {
            installed: false,
            running: false,
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      );
    } else {
      errorOutput(
        `Failed to check service status: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.exit(1);
  }
};
