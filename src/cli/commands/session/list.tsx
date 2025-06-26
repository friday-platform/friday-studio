import { render } from "ink";
import { SessionListComponent } from "../../modules/sessions/session-list-component.tsx";
import { fetchSessions, formatSessionsForJson } from "../../modules/sessions/fetcher.ts";
import { YargsInstance } from "../../utils/yargs.ts";

interface ListArgs {
  json?: boolean;
  workspace?: string;
  port?: number;
}

export const command = "list";
export const desc = "List active sessions";
export const aliases = ["ls"];

export function builder(y: YargsInstance) {
  return y
    .option("json", {
      type: "boolean",
      describe: "Output session list as JSON",
      default: false,
    })
    .option("workspace", {
      type: "string",
      describe: "Filter sessions by workspace name",
    })
    .option("port", {
      type: "number",
      alias: "p",
      describe: "Port of the workspace server",
      default: 8080,
    })
    .example("$0 session list", "List all active sessions")
    .example("$0 session list --json", "Output session list as JSON")
    .example(
      "$0 session list --workspace my-agent",
      "Filter sessions by workspace",
    )
    .example("$0 ps", "Use the 'ps' alias to list sessions");
}

export const handler = async (argv: ListArgs): Promise<void> => {
  try {
    const result = await fetchSessions({
      workspace: argv.workspace,
      port: argv.port,
    });

    if (!result.success) {
      const errorResult = result as { reason?: string; error: string };
      if (errorResult.reason === "server_not_running") {
        // No server running
        if (argv.json) {
          console.log(JSON.stringify({ sessions: [], count: 0 }, null, 2));
        } else {
          console.error(`Error: ${errorResult.error}`);
        }
      } else {
        console.error(`Error: ${errorResult.error}`);
      }
      Deno.exit(1);
      return;
    }

    const filteredSessions = result.filteredSessions;

    if (argv.json) {
      // JSON output for scripting
      console.log(JSON.stringify(formatSessionsForJson(filteredSessions), null, 2));
    } else {
      // Render with Ink
      render(<SessionListComponent sessions={filteredSessions} />);
      // Exit immediately after rendering
      Deno.exit(0);
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    Deno.exit(1);
  }
};
