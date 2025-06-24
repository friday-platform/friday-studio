import { render } from "ink";
// deno-lint-ignore no-unused-vars
import React from "react";
import { Box, Text } from "ink";
import { exists } from "@std/fs";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";

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
  json: {
    type: "boolean" as const,
    describe: "Output history as JSON",
    default: false,
  },
  workspace: {
    type: "string" as const,
    alias: "w",
    describe: "Workspace ID or name",
  },
  signal: {
    type: "string" as const,
    alias: "s",
    describe: "Filter by specific signal name",
  },
  limit: {
    type: "number" as const,
    alias: "n",
    describe: "Number of entries to show",
    default: 20,
  },
};

export const handler = async (argv: HistoryArgs): Promise<void> => {
  try {
    const workspace = await resolveWorkspace(argv.workspace);

    // TODO: Implement actual signal history retrieval
    // For now, show placeholder message
    const historyData = {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
      },
      filter: argv.signal,
      limit: argv.limit,
      entries: [],
      message:
        "Signal history is not yet implemented. This will show recent signal triggers and their session outcomes.",
    };

    if (argv.json) {
      console.log(JSON.stringify(historyData, null, 2));
    } else {
      render(<SignalHistoryCommand data={historyData} />);
      Deno.exit(0);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  }
};

// Helper function to resolve workspace
async function resolveWorkspace(workspaceId?: string): Promise<{
  path: string;
  id: string;
  name: string;
}> {
  const registry = getWorkspaceRegistry();
  await registry.initialize();

  if (workspaceId) {
    // Find workspace by ID or name in the registry
    const targetWorkspace = (await registry.findById(workspaceId)) ||
      (await registry.findByName(workspaceId));

    if (!targetWorkspace) {
      throw new Error(
        `Workspace '${workspaceId}' not found in registry. Use 'atlas workspace list' to see registered workspaces.`,
      );
    }

    return {
      path: targetWorkspace.path,
      id: targetWorkspace.id,
      name: targetWorkspace.name,
    };
  } else {
    // Check current directory for workspace.yml
    if (!await exists("workspace.yml")) {
      throw new Error(
        "No workspace specified and not in a workspace directory. " +
          "Use --workspace flag or run from a workspace directory.",
      );
    }

    // Try to find in registry or register
    const currentWorkspace = await registry.getCurrentWorkspace() ||
      await registry.findOrRegister(Deno.cwd());

    return {
      path: currentWorkspace.path,
      id: currentWorkspace.id,
      name: currentWorkspace.name,
    };
  }
}

// Component that renders the signal history
interface HistoryData {
  workspace: {
    id: string;
    name: string;
    path: string;
  };
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
      <Text color="gray">
        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      </Text>
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
