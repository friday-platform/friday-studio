import { client, type InferResponseType, parseResult } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import { Box, render, Text, useStdout } from "ink";
import React from "react";
import type { YargsInstance } from "../../utils/yargs.ts";

type WorkspaceResponse = InferResponseType<(typeof client.workspace)["index"]["$get"], 200>[number];

interface ListArgs {
  json?: boolean;
}

export const command = "list";
export const desc = "List all registered workspaces";
export const aliases = ["ls"];

export function builder(y: YargsInstance) {
  return y
    .option("json", { type: "boolean", describe: "Output workspace list as JSON", default: false })
    .example("$0 workspace list", "List all registered workspaces")
    .example("$0 workspace list --json", "Export workspace list as JSON");
}

export const handler = async (argv: ListArgs): Promise<void> => {
  let unmount: (() => void) | undefined;

  try {
    const response = await parseResult(client.workspace.index.$get());

    if (!response.ok) {
      throw new Error(stringifyError(response.error) || "Failed to fetch workspaces");
    }

    // Render appropriate view based on output format
    const renderResult = render(
      argv.json ? (
        <JsonOutput workspaces={response.data} />
      ) : (
        <WorkspaceList registeredWorkspaces={response.data} />
      ),
    );

    unmount = renderResult.unmount;

    // Give a moment for render then exit
    setTimeout(() => {
      unmount?.();
    }, 100);
  } catch (error) {
    // Ensure cleanup before exiting on error
    if (unmount) {
      unmount();
    }

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
    const output = JSON.stringify({ workspaces, count: workspaces.length }, null, 2);
    write(output);
  }, [workspaces, write]);

  return null;
}

// Component for rendering workspace list
function WorkspaceList({ registeredWorkspaces }: { registeredWorkspaces: WorkspaceResponse[] }) {
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
      ? `${str.substring(0, width - 1)}…`
      : str + " ".repeat(width - str.length);
  };

  // Format workspace status (3-state model)
  const formatRuntimeStatus = (workspace: WorkspaceResponse): string => {
    const statusStr = String(workspace.status);
    if (statusStr === "running") return "Running";
    if (statusStr === "stopped") return "Stopped";
    if (statusStr === "inactive") return "Inactive";
    return statusStr;
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
          {padRight("LAST SEEN", 18)}
        </Text>
      </Box>
      <Box>
        <Text color="gray">{"─".repeat(114)}</Text>
      </Box>

      {/* Table Rows */}
      {registeredWorkspaces.map((workspace) => {
        // Cast to our actual status type since OpenAPI types aren't regenerated yet
        const statusStr = String(workspace.status);
        const statusColor =
          statusStr === "running" ? "green" : statusStr === "inactive" ? "yellow" : "gray";

        const runtimeDisplay = formatRuntimeStatus(workspace);
        const runtimeColor = statusStr === "running" ? "green" : "gray";

        // Format last seen time with date and time
        const lastSeenDate = new Date(workspace.lastSeen);
        const lastSeenDisplay = lastSeenDate.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });

        return (
          <Box key={workspace.name}>
            <Text>
              <Text color="blue">{padRight(workspace.id, 30)}</Text>
              <Text color="yellow">{padRight(workspace.name, 50)}</Text>
              <Text color={statusColor}>{padRight(statusStr, 10)}</Text>
              <Text color={runtimeColor}>{padRight(runtimeDisplay, 10)}</Text>
              <Text color="cyan">{padRight(lastSeenDisplay, 18)}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
