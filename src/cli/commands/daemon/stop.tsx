import process from "node:process";
import { client, parseResult } from "@atlas/client/v2";
import { sleep, stringifyError } from "@atlas/utils";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import type { YargsInstance } from "../../utils/yargs.ts";

interface StopArgs {
  port?: number;
  force?: boolean;
}

export const command = "stop";
export const desc = "Stop the Atlas daemon";

export function builder(y: YargsInstance) {
  return y
    .option("port", {
      type: "number",
      alias: "p",
      describe: "Port to stop daemon on",
      default: 8080,
    })
    .option("force", {
      type: "boolean",
      alias: "f",
      describe: "Force stop even if workspaces are active",
      default: false,
    })
    .example("$0 daemon stop", "Stop daemon on default port")
    .example("$0 daemon stop --port 3000", "Stop daemon on specific port")
    .example("$0 daemon stop --force", "Force stop daemon");
}

export const handler = async (argv: StopArgs): Promise<void> => {
  try {
    const port = argv.port || 8080;

    const status = await parseResult(client.daemon.status.$get());
    if (!status.ok) {
      errorOutput(`Atlas daemon is not running on port ${port}`);
      process.exit(1);
    }

    // Check for active workspaces
    if (status.data.activeWorkspaces > 0 && !argv.force) {
      errorOutput(
        `Daemon has ${status.data.activeWorkspaces} active workspace(s). ` +
          `Use --force to stop anyway or wait for workspaces to become idle.`,
      );
      infoOutput(`Active workspaces: ${status.data.workspaces.join(", ")}`);
      process.exit(1);
    }

    // Send shutdown signal
    infoOutput(`Stopping Atlas daemon on port ${port}...`);

    try {
      await client.daemon.shutdown.$post();

      // Wait a moment for graceful shutdown
      await sleep(2000);

      // Verify it's actually stopped
      const stillRunning = await parseResult(client.health.index.$get());
      if (stillRunning.ok) {
        errorOutput("Daemon did not stop gracefully");
        process.exit(1);
      } else {
        successOutput("Atlas daemon stopped successfully");
      }
    } catch (error) {
      // If the request fails, the daemon might have already stopped
      await sleep(1000);
      const stillRunning = await parseResult(client.health.index.$get());

      if (stillRunning.ok) {
        errorOutput(`Failed to stop daemon: ${stringifyError(error)}`);
        process.exit(1);
      } else {
        successOutput("Atlas daemon stopped successfully");
      }
    }
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};
