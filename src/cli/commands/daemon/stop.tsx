import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import { YargsInstance } from "../../utils/yargs.ts";

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

    // First check if daemon is running
    let status;
    try {
      const response = await fetch(`http://localhost:${port}/api/daemon/status`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        errorOutput(`Atlas daemon is not running on port ${port}`);
        Deno.exit(1);
      }

      status = await response.json();
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
      const response = await fetch(`http://localhost:${port}/api/daemon/shutdown`, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        // Wait a moment for graceful shutdown
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Verify it's actually stopped
        const stillRunning = await checkDaemonRunning(port);
        if (stillRunning) {
          errorOutput("Daemon did not stop gracefully");
          Deno.exit(1);
        } else {
          successOutput("Atlas daemon stopped successfully");
        }
      } else {
        errorOutput("Failed to send shutdown signal to daemon");
        Deno.exit(1);
      }
    } catch (error) {
      // If the request fails, the daemon might have already stopped
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const stillRunning = await checkDaemonRunning(port);

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
  try {
    const response = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
