import process from "node:process";
import { client, parseResult } from "@atlas/client/v2";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { displayDaemonStatus } from "../../utils/daemon-status.ts";
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
  // The hono client at @atlas/client/v2 is bound at module-load time to
  // getAtlasDaemonUrl(), so the actual URL hit is driven by FRIDAYD_URL +
  // FRIDAY_TLS_CERT — not the --port flag. Surface that URL in the
  // failure message so a TLS-cert-verification error doesn't masquerade
  // as "not running on port 8080".
  const targetUrl = getAtlasDaemonUrl();
  const port = argv.port || 8080;
  try {
    const status = await parseResult(client.daemon.status.$get());
    if (!status.ok) {
      if (argv.json) {
        console.log(JSON.stringify({ status: "not_running", url: targetUrl, port }, null, 2));
      } else {
        errorOutput(`Atlas daemon is not running at ${targetUrl}`);
      }
      process.exit(1);
    }

    if (argv.json) {
      console.log(JSON.stringify(status.data, null, 2));
    } else {
      displayDaemonStatus(status.data, port);
    }
    process.exit(0);
  } catch (error) {
    if (argv.json) {
      console.log(
        JSON.stringify(
          {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
            url: targetUrl,
            port,
          },
          null,
          2,
        ),
      );
    } else {
      errorOutput(
        `Failed to check daemon status at ${targetUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    process.exit(1);
  }
};
