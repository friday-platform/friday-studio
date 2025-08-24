import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { Box, render, Text } from "ink";
import {
  checkDaemonRunning,
  createDaemonNotRunningError,
  getDaemonClient,
} from "../../utils/daemon-client.ts";

interface HistoryArgs {
  json?: boolean;
  workspace?: string;
  signal?: string;
  limit?: number;
}

export const command = "history";
export const desc = "Show signal trigger history";
export const aliases = ["log", "hist"];

export const builder = {
  json: { type: "boolean" as const, describe: "Output history as JSON", default: false },
  workspace: { type: "string" as const, alias: "w", describe: "Workspace ID or name" },
  signal: { type: "string" as const, alias: "s", describe: "Filter by specific signal name" },
  limit: {
    type: "number" as const,
    alias: "n",
    describe: "Number of entries to show",
    default: 20,
  },
};

export const handler = async (argv: HistoryArgs): Promise<void> => {
  try {
    // Check if daemon is running
    if (!(await checkDaemonRunning())) {
      throw createDaemonNotRunningError();
    }

    const client = getDaemonClient();

    // Determine target workspace
    let workspaceId: string;
    let workspaceName: string;
    let workspacePath: string;

    if (argv.workspace) {
      // Use specified workspace - try to find by ID or name
      try {
        const workspace = await client.getWorkspace(argv.workspace);
        workspaceId = workspace.id;
        workspaceName = workspace.name;
        workspacePath = workspace.path;
      } catch {
        // Try to find by name if ID lookup failed
        const allWorkspaces = await client.listWorkspaces();
        const foundWorkspace = allWorkspaces.find((w) => w.name === argv.workspace);
        if (foundWorkspace) {
          workspaceId = foundWorkspace.id;
          workspaceName = foundWorkspace.name;
          workspacePath = foundWorkspace.path;
        } else {
          throw new Error(`Workspace '${argv.workspace}' not found`);
        }
      }
    } else {
      // Use current workspace (detect from current directory)
      try {
        const adapter = new FilesystemConfigAdapter(Deno.cwd());
        const configLoader = new ConfigLoader(adapter, Deno.cwd());
        const config = await configLoader.load();
        const currentWorkspaceName = config.workspace.workspace.name;

        // Find workspace by name in daemon
        const allWorkspaces = await client.listWorkspaces();
        const currentWorkspace = allWorkspaces.find((w) => w.name === currentWorkspaceName);

        if (currentWorkspace) {
          workspaceId = currentWorkspace.id;
          workspaceName = currentWorkspace.name;
          workspacePath = currentWorkspace.path;
        } else {
          throw new Error(
            `Current workspace '${currentWorkspaceName}' not found in daemon. Use --workspace to specify target.`,
          );
        }
      } catch {
        throw new Error(
          "No workspace.yml found in current directory. Use --workspace to specify target workspace.",
        );
      }
    }

    // TODO: Implement actual signal history retrieval from daemon API
    // For now, show placeholder message but use daemon-resolved workspace info
    const historyData = {
      workspace: { id: workspaceId, name: workspaceName, path: workspacePath },
      filter: argv.signal,
      limit: argv.limit,
      entries: [],
      message:
        "Signal history is not yet implemented. This will show recent signal triggers and their session outcomes.",
    };

    if (argv.json) {
      console.log(JSON.stringify(historyData, null, 2));
    } else {
      const { unmount } = render(<SignalHistoryCommand data={historyData} />);

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

// Component that renders the signal history
interface HistoryData {
  workspace: { id: string; name: string; path: string };
  filter?: string;
  limit?: number;
  entries: unknown[];
  message: string;
}

function SignalHistoryCommand({ data }: { data: HistoryData }) {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Signal History - {data.workspace.name}
      </Text>
      <Text color="gray">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
      <Text color="yellow">{data.message}</Text>
      <Text></Text>
      <Text color="gray">When implemented, this will show:</Text>
      <Text color="gray">• Recent signal triggers with timestamps</Text>
      <Text color="gray">• Associated session IDs and outcomes</Text>
      <Text color="gray">• Signal payload data</Text>
      <Text color="gray">• Success/failure status</Text>
      {data.filter && <Text color="gray">• Filtered by signal: {data.filter}</Text>}
      <Text color="gray">• Limited to {data.limit} entries</Text>
    </Box>
  );
}
