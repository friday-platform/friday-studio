import { Box, render, Text } from "ink";
import { getDaemonClient, type WorkspaceInfo } from "../../utils/daemon-client.ts";
import { YargsInstance } from "../../utils/yargs.ts";

interface ListArgs {
  json?: boolean;
}

export const command = "list";
export const desc = "List all registered workspaces";
export const aliases = ["ls"];

export function builder(y: YargsInstance) {
  return y
    .option("json", {
      type: "boolean",
      describe: "Output workspace list as JSON",
      default: false,
    })
    .example("$0 workspace list", "List all registered workspaces")
    .example("$0 workspace list --json", "Export workspace list as JSON");
}

export const handler = async (argv: ListArgs): Promise<void> => {
  try {
    // Get workspaces from daemon API
    // The client will auto-start the daemon if needed
    const client = getDaemonClient();
    const workspaces = await client.listWorkspaces();

    if (argv.json) {
      // JSON output for scripting
      console.log(
        JSON.stringify(
          {
            workspaces: workspaces.map(formatWorkspaceForJson),
            count: workspaces.length,
          },
          null,
          2,
        ),
      );
    } else {
      // Render with Ink and exit immediately
      const { rerender, unmount } = render(<WorkspaceList registeredWorkspaces={workspaces} />);
      // Give a moment for render then exit
      setTimeout(() => {
        unmount();
      }, 100);
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    Deno.exit(1);
  }
};

function formatWorkspaceForJson(workspace: WorkspaceInfo) {
  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description,
    status: workspace.status,
    path: workspace.path,
    hasActiveRuntime: workspace.hasActiveRuntime,
    createdAt: workspace.createdAt,
    lastSeen: workspace.lastSeen,
  };
}

// Component for rendering workspace list
function WorkspaceList({
  registeredWorkspaces,
}: {
  registeredWorkspaces: WorkspaceInfo[];
}) {
  const hasRegistered = registeredWorkspaces && registeredWorkspaces.length > 0;

  if (!hasRegistered) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="yellow">No workspaces found</Text>
        </Box>
        <Box>
          <Text color="gray">
            No registered workspaces found. Run 'atlas workspace init' to create a new workspace.
          </Text>
        </Box>
      </Box>
    );
  }

  const padRight = (str: string, width: number) => {
    return str.length >= width
      ? str.substring(0, width - 1) + "…"
      : str + " ".repeat(width - str.length);
  };

  // Format runtime status
  const formatRuntimeStatus = (workspace: WorkspaceInfo): string => {
    if (workspace.hasActiveRuntime) {
      return "Active";
    } else if (workspace.status === "RUNNING") {
      return "Running";
    } else {
      return "-";
    }
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          Registered Workspaces ({registeredWorkspaces.length} found)
        </Text>
      </Box>
      <Box>
        <Text></Text>
      </Box>

      {/* Table Header */}
      <Box>
        <Text bold color="white">
          {padRight("ID", 30)}
          {padRight("NAME", 50)}
          {padRight("STATUS", 10)}
          {padRight("RUNTIME", 10)}
          {padRight("LAST SEEN", 12)}
        </Text>
      </Box>
      <Box>
        <Text color="gray">{"─".repeat(108)}</Text>
      </Box>

      {/* Table Rows */}
      {registeredWorkspaces.map((workspace, i) => {
        const statusColor = workspace.status === "RUNNING"
          ? "green"
          : workspace.status === "CRASHED"
          ? "red"
          : "gray";

        const runtimeDisplay = formatRuntimeStatus(workspace);
        const runtimeColor = workspace.hasActiveRuntime ? "green" : "gray";

        // Format last seen time
        const lastSeenDate = new Date(workspace.lastSeen);
        const lastSeenDisplay = lastSeenDate.toLocaleDateString();

        return (
          <Box key={i}>
            <Text>
              <Text color="blue">{padRight(workspace.id, 30)}</Text>
              <Text color="yellow">{padRight(workspace.name, 50)}</Text>
              <Text color={statusColor}>{padRight(workspace.status, 10)}</Text>
              <Text color={runtimeColor}>{padRight(runtimeDisplay, 10)}</Text>
              <Text color="cyan">{padRight(lastSeenDisplay, 12)}</Text>
            </Text>
          </Box>
        );
      })}

      <Box>
        <Text></Text>
      </Box>
    </Box>
  );
}
