import { render } from "ink";
import { WorkspaceList as WorkspaceListComponent } from "../../../cli/commands/workspace/list.tsx";
import { WorkspaceEntry } from "../../../core/workspace-registry-types.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";

interface ListArgs {
  json?: boolean;
}

export const command = "list";
export const desc = "List all registered workspaces";
export const aliases = ["ls"];

export const builder = {
  json: {
    type: "boolean" as const,
    describe: "Output workspace list as JSON",
    default: false,
  },
};

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
      render(<WorkspaceListCommand workspaces={workspaces} />);
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

// Component that wraps the existing WorkspaceList component
function WorkspaceListCommand({
  workspaces,
}: {
  workspaces: WorkspaceEntry[];
}) {
  return <WorkspaceListComponent registeredWorkspaces={workspaces} />;
}
