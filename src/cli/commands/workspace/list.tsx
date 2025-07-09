import { Box, render, Text, useStdout } from "ink";
import React from "react";
import { createAtlasClient, type paths } from "@atlas/oapi-client";
import { YargsInstance } from "../../utils/yargs.ts";

// Extract WorkspaceResponse type from OpenAPI generated types
type WorkspaceResponse =
  paths["/api/workspaces"]["get"]["responses"]["200"]["content"]["application/json"][number];

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
    // Get workspaces from daemon API using OpenAPI client
    // Note: Unlike the old daemon-client, this doesn't auto-start the daemon
    const client = createAtlasClient();
    const { data, error } = await client.GET("/api/workspaces");

    if (error) {
      throw new Error(error.error || "Failed to fetch workspaces");
    }

    // Use the data directly from the API
    const workspaces = data;

    // Render appropriate view based on output format
    const { unmount } = render(
      argv.json
        ? <JsonOutput workspaces={workspaces} />
        : <WorkspaceList registeredWorkspaces={workspaces} />,
    );

    // Give a moment for render then exit
    setTimeout(() => {
      unmount();
    }, 100);
  } catch (error) {
    // Provide helpful error message if daemon is not running
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("Failed to fetch") || errorMessage.includes("NetworkError")) {
      console.error(
        "Error: Unable to connect to Atlas daemon. Make sure it's running with 'atlas daemon start'",
      );
    } else {
      console.error(`Error: ${errorMessage}`);
    }
    Deno.exit(1);
  }
};

// JSON output component using useStdout
function JsonOutput({ workspaces }: { workspaces: WorkspaceResponse[] }) {
  const { write } = useStdout();

  React.useEffect(() => {
    const output = JSON.stringify(
      {
        workspaces,
        count: workspaces.length,
      },
      null,
      2,
    );
    write(output);
  }, [workspaces, write]);

  return null;
}

// Component for rendering workspace list
function WorkspaceList({
  registeredWorkspaces,
}: {
  registeredWorkspaces: WorkspaceResponse[];
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
  const formatRuntimeStatus = (workspace: WorkspaceResponse): string => {
    if (workspace.hasActiveRuntime) {
      return "Active";
    } else if (workspace.status === "running") {
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
        const statusColor = workspace.status === "running"
          ? "green"
          : workspace.status === "crashed"
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
    </Box>
  );
}
