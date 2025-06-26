import { render } from "ink";
import { SessionListComponent } from "../../modules/sessions/session-list-component.tsx";
import {
  checkDaemonRunning,
  createDaemonNotRunningError,
  getDaemonClient,
} from "../../utils/daemon-client.ts";
import { YargsInstance } from "../../utils/yargs.ts";

interface ListArgs {
  json?: boolean;
  workspace?: string;
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
      describe: "Filter sessions by workspace name or ID",
    })
    .example("$0 session list", "List all active sessions")
    .example("$0 session list --json", "Output session list as JSON")
    .example(
      "$0 session list --workspace my-workspace",
      "Filter sessions by workspace",
    )
    .example("$0 ps", "Use the 'ps' alias to list sessions");
}

export const handler = async (argv: ListArgs): Promise<void> => {
  try {
    // Check if daemon is running
    if (!(await checkDaemonRunning())) {
      throw createDaemonNotRunningError();
    }

    const client = getDaemonClient();

    // Get all sessions from daemon
    const allSessions = await client.listSessions();

    // Filter by workspace if specified
    let filteredSessions = allSessions;
    if (argv.workspace) {
      // Filter by workspace name or ID
      filteredSessions = allSessions.filter((session) =>
        session.workspaceId === argv.workspace ||
        session.workspaceId.includes(argv.workspace!)
      );
    }

    if (argv.json) {
      // JSON output for scripting
      console.log(JSON.stringify(
        {
          sessions: filteredSessions,
          count: filteredSessions.length,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ));
    } else {
      if (filteredSessions.length === 0) {
        if (argv.workspace) {
          console.log(`No active sessions found for workspace: ${argv.workspace}`);
        } else {
          console.log("No active sessions found");
        }
        return;
      }

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
