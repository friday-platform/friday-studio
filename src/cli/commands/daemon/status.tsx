import { displayDaemonStatus, getLocalDaemonClient } from "../../utils/daemon-status.ts";
import { errorOutput } from "../../utils/output.ts";
import type { YargsInstance } from "../../utils/yargs.ts";

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
    .option("json", { type: "boolean", describe: "Output status as JSON", default: false })
    .example("$0 daemon status", "Check daemon status on default port")
    .example("$0 daemon status --port 3000", "Check daemon on specific port")
    .example("$0 daemon status --json", "Output status as JSON");
}

export const handler = async (argv: StatusArgs): Promise<void> => {
  try {
    const port = argv.port || 8080;
    const client = getLocalDaemonClient(port);

    let status;
    try {
      status = await client.getDaemonStatus();
    } catch {
      if (argv.json) {
        console.log(JSON.stringify({ status: "not_running", port }, null, 2));
      } else {
        errorOutput(`Atlas daemon is not running on port ${port}`);
      }
      Deno.exit(1);
    }

    if (argv.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      displayDaemonStatus(status, port);
    }
  } catch (error) {
    if (argv.json) {
      console.log(
        JSON.stringify(
          {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
            port: argv.port || 8080,
          },
          null,
          2,
        ),
      );
    } else {
      errorOutput(
        `Failed to check daemon status: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    Deno.exit(1);
  }
};
