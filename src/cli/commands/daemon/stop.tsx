import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import { YargsInstance } from "../../utils/yargs.ts";
import { getAtlasClient } from "@atlas/client";

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
    const client = getAtlasClient({ url: `http://localhost:${port}`, timeout: 5000 });

    // First check if daemon is running
    let status;
    try {
      status = await client.getDaemonStatus();
    } catch {
      errorOutput(`Atlas daemon is not running on port ${port}`);
      Deno.exit(1);
    }

    // Check for active workspaces
    if (status.activeWorkspaces > 0 && !argv.force) {
      errorOutput(
        `Daemon has ${status.activeWorkspaces} active workspace(s). ` +
          `Use --force to stop anyway or wait for workspaces to become idle.`,
      );
      infoOutput(`Active workspaces: ${status.workspaces.join(", ")}`);
      Deno.exit(1);
    }

    // Send shutdown signal
    infoOutput(`Stopping Atlas daemon on port ${port}...`);

    try {
      await client.shutdown();

      // Wait a moment for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Verify it's actually stopped
      const stillRunning = await client.isHealthy();
      if (stillRunning) {
        errorOutput("Daemon did not stop gracefully");
        Deno.exit(1);
      } else {
        successOutput("Atlas daemon stopped successfully");
      }
    } catch (error) {
      // If the request fails, the daemon might have already stopped
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const stillRunning = await client.isHealthy();

      if (stillRunning) {
        errorOutput(
          `Failed to stop daemon: ${error instanceof Error ? error.message : String(error)}`,
        );
        Deno.exit(1);
      } else {
        successOutput("Atlas daemon stopped successfully");
      }
    }
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};

async function checkDaemonRunning(port: number): Promise<boolean> {
  const client = getAtlasClient({ url: `http://localhost:${port}`, timeout: 2000 });
  return await client.isHealthy();
}
