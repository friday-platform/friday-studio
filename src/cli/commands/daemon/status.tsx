import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import { YargsInstance } from "../../utils/yargs.ts";

interface StatusArgs {
  port?: number;
  json?: boolean;
}

export const command = "status";
export const desc = "Check Atlas daemon status";

export function builder(y: YargsInstance) {
  return y
    .option("port", {
      type: "number",
      alias: "p",
      describe: "Port to check daemon on",
      default: 8080,
    })
    .option("json", {
      type: "boolean",
      describe: "Output status as JSON",
      default: false,
    })
    .example("$0 daemon status", "Check daemon status on default port")
    .example("$0 daemon status --port 3000", "Check daemon on specific port")
    .example("$0 daemon status --json", "Output status as JSON");
}

export const handler = async (argv: StatusArgs): Promise<void> => {
  try {
    const port = argv.port || 8080;
    const response = await fetch(`http://localhost:${port}/api/daemon/status`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      if (argv.json) {
        console.log(JSON.stringify({ status: "not_running", port }, null, 2));
      } else {
        errorOutput(`Atlas daemon is not running on port ${port}`);
      }
      Deno.exit(1);
    }

    const status = await response.json();

    if (argv.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      successOutput(`Atlas daemon is running on port ${port}`);
      infoOutput(`Uptime: ${formatUptime(status.uptime)}`);
      infoOutput(`Active workspaces: ${status.activeWorkspaces}`);
      infoOutput(`Max concurrent workspaces: ${status.configuration.maxConcurrentWorkspaces}`);
      infoOutput(`Idle timeout: ${formatTimeout(status.configuration.idleTimeoutMs)}`);

      if (status.activeWorkspaces > 0) {
        infoOutput(`Active workspace IDs: ${status.workspaces.join(", ")}`);
      }

      const memoryMB = Math.round(status.memoryUsage.rss / 1024 / 1024);
      infoOutput(`Memory usage: ${memoryMB} MB`);
    }
  } catch (error) {
    if (argv.json) {
      console.log(JSON.stringify(
        {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          port: argv.port || 8080,
        },
        null,
        2,
      ));
    } else {
      errorOutput(
        `Failed to check daemon status: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    Deno.exit(1);
  }
};

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatTimeout(ms: number): string {
  const minutes = Math.floor(ms / 1000 / 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m`;
}
