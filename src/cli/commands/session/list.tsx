import { render } from "ink";
import { SessionListComponent } from "../../modules/sessions/session-list-component.tsx";
import { getDaemonClient } from "../../utils/daemon-client.ts";
import type { YargsInstance } from "../../utils/yargs.ts";

interface ListArgs {
  json?: boolean;
  workspace?: string;
}

export const command = "list";
export const desc = "List active sessions";
export const aliases = ["ls"];

export function builder(y: YargsInstance) {
  return y
    .option("json", { type: "boolean", describe: "Output session list as JSON", default: false })
    .option("workspace", { type: "string", describe: "Filter sessions by workspace name or ID" })
    .example("$0 session list", "List all active sessions")
    .example("$0 session list --json", "Output session list as JSON")
    .example("$0 session list --workspace my-workspace", "Filter sessions by workspace")
    .example("$0 ps", "Use the 'ps' alias to list sessions");
}

export const handler = async ({ workspace, json }: ListArgs): Promise<void> => {
  try {
    // Get client - it will auto-start daemon if needed
    const client = getDaemonClient();

    // Get all sessions from daemon
    const allSessions = await client.listSessions();

    // Filter by workspace if specified
    let filteredSessions = allSessions;
    if (workspace) {
      // Filter by workspace name or ID
      filteredSessions = allSessions.filter(
        (session) => session.workspaceId === workspace || session.workspaceId.includes(workspace),
      );
    }

    if (json) {
      // JSON output for scripting
      console.log(
        JSON.stringify(
          {
            sessions: filteredSessions,
            count: filteredSessions.length,
            timestamp: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } else {
      if (filteredSessions.length === 0) {
        if (workspace) {
          console.log(`No active sessions found for workspace: ${workspace}`);
        } else {
          console.log("No active sessions found");
        }
        return;
      }

      // Transform session data to match expected interface
      const transformedSessions = filteredSessions.map((session) => ({
        id: session.id,
        workspaceName: session.workspaceId, // Use workspaceId as workspaceName
        signal: session.signal,
        status: session.status,
        agents: [], // Default empty agents array
      }));

      // Render with Ink
      const { unmount } = render(<SessionListComponent sessions={transformedSessions} />);

      // Give a moment for render then exit
      setTimeout(() => {
        unmount();
      }, 100);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  }
};
