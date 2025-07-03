import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import { YargsInstance } from "../../utils/yargs.ts";
import { getAtlasClient } from "@atlas/client";

interface RestartArgs {
  port?: number;
  hostname?: string;
  maxWorkspaces?: number;
  idleTimeout?: number;
  force?: boolean;
}

export const command = "restart";
export const desc = "Restart the Atlas daemon";

export function builder(y: YargsInstance) {
  return y
    .option("port", {
      type: "number",
      alias: "p",
      describe: "Port to run the daemon on",
      default: 8080,
    })
    .option("hostname", {
      type: "string",
      describe: "Hostname to bind to",
      default: "localhost",
    })
    .option("max-workspaces", {
      type: "number",
      describe: "Maximum number of concurrent workspace runtimes",
      default: 10,
    })
    .option("idle-timeout", {
      type: "number",
      describe: "Idle timeout for workspace runtimes in seconds",
      default: 300,
    })
    .option("force", {
      type: "boolean",
      alias: "f",
      describe: "Force restart even if workspaces are active",
      default: false,
    })
    .example("$0 daemon restart", "Restart daemon with same settings")
    .example("$0 daemon restart --force", "Force restart daemon")
    .example("$0 daemon restart --max-workspaces 20", "Restart with higher workspace limit");
}

export const handler = async (argv: RestartArgs): Promise<void> => {
  try {
    const port = argv.port || 8080;

    // First try to stop the daemon if it's running
    infoOutput("Checking daemon status...");

    let wasRunning = false;
    const client = getAtlasClient({ url: `http://localhost:${port}`, timeout: 5000 });
    try {
      const status = await client.getDaemonStatus();
      wasRunning = true;

      // Check for active workspaces
      if (status.activeWorkspaces > 0 && !argv.force) {
        errorOutput(
          `Daemon has ${status.activeWorkspaces} active workspace(s). ` +
            `Use --force to restart anyway or wait for workspaces to become idle.`,
        );
        infoOutput(`Active workspaces: ${status.workspaces.join(", ")}`);
        Deno.exit(1);
      }

      // Stop the daemon
      infoOutput("Stopping existing daemon...");
      try {
        await client.shutdown();

        // Wait for shutdown
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } catch {
        // Daemon might have already stopped
      }
    } catch {
      // Daemon not running, that's fine
    }

    // Verify daemon is stopped
    if (wasRunning) {
      const stillRunning = await client.isHealthy();
      if (stillRunning) {
        errorOutput("Failed to stop existing daemon");
        Deno.exit(1);
      } else {
        successOutput("Existing daemon stopped successfully");
      }
    } else {
      infoOutput("No existing daemon found");
    }

    // Start new daemon
    infoOutput("Starting new daemon...");

    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--unstable-kv",
        "--unstable-broadcast-channel",
        "--unstable-worker-options",
        "--env-file",
        Deno.mainModule,
        "daemon",
        "start",
        "--detached",
        "--port",
        port.toString(),
        "--hostname",
        argv.hostname || "localhost",
        "--max-workspaces",
        (argv.maxWorkspaces || 10).toString(),
        "--idle-timeout",
        (argv.idleTimeout || 300).toString(),
      ],
      env: Deno.env.toObject(),
    });

    const { success, stderr } = await cmd.output();

    if (!success) {
      const errorText = new TextDecoder().decode(stderr);
      errorOutput(`Failed to start daemon: ${errorText}`);
      Deno.exit(1);
    }

    // Wait a moment and verify it's running
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const newClient = getAtlasClient({ url: `http://localhost:${port}` });
    const isRunning = await newClient.isHealthy();
    if (isRunning) {
      successOutput(`Atlas daemon restarted successfully on port ${port}`);
    } else {
      errorOutput("Daemon failed to start after restart");
      Deno.exit(1);
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
