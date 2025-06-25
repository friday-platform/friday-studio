import { Box, render, Text } from "ink";
import {
  WorkspaceEntry,
  WorkspaceStatus as WSStatus,
} from "../../../core/workspace-registry-types.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
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
    // Get workspaces from registry
    const registry = getWorkspaceRegistry();
    await registry.initialize();
    const workspaces = await registry.listAll();

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
      // Render with Ink
      render(<WorkspaceList registeredWorkspaces={workspaces} />);
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

function formatWorkspaceForJson(workspace: WorkspaceEntry) {
  return {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    status: workspace.status,
    port: workspace.port,
    pid: workspace.pid,
    configPath: workspace.configPath,
    metadata: workspace.metadata,
    createdAt: workspace.createdAt,
    lastSeen: workspace.lastSeen,
    startedAt: workspace.startedAt,
    stoppedAt: workspace.stoppedAt,
  };
}

// Component for rendering workspace list
function WorkspaceList({
  registeredWorkspaces,
}: {
  registeredWorkspaces: WorkspaceEntry[];
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

  // Format uptime from startedAt timestamp
  const formatUptime = (workspace: WorkspaceEntry): string => {
    if (workspace.status !== WSStatus.RUNNING || !workspace.startedAt) {
      return "-";
    }

    const start = new Date(workspace.startedAt).getTime();
    const now = Date.now();
    const ms = now - start;

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m`;
    } else {
      return `${seconds}s`;
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
          {padRight("ID", 15)}
          {padRight("NAME", 50)}
          {padRight("STATUS", 10)}
          {padRight("PORT", 8)}
          {padRight("UPTIME", 10)}
        </Text>
      </Box>
      <Box>
        <Text color="gray">
          {"─".repeat(93)}
        </Text>
      </Box>

      {/* Table Rows */}
      {registeredWorkspaces.map((workspace, i) => {
        const statusColor = workspace.status === WSStatus.RUNNING
          ? "green"
          : workspace.status === WSStatus.CRASHED
          ? "red"
          : "gray";

        const portDisplay = workspace.port ? workspace.port.toString() : "-";
        const uptimeDisplay = formatUptime(workspace);

        return (
          <Box key={i}>
            <Text>
              <Text color="blue">{padRight(workspace.id, 15)}</Text>
              <Text color="yellow">{padRight(workspace.name, 50)}</Text>
              <Text color={statusColor}>{padRight(workspace.status, 10)}</Text>
              <Text color="cyan">{padRight(portDisplay, 8)}</Text>
              <Text color="green">{padRight(uptimeDisplay, 10)}</Text>
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
