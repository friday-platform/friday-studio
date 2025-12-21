import process from "node:process";
import { parseResult, client as v2Client } from "@atlas/client/v2";
import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { render } from "ink";
import { AgentListComponent } from "../../modules/agents/agent-list-component.tsx";
import { createDaemonNotRunningError, getDaemonClient } from "../../utils/daemon-client.ts";

interface ListArgs {
  json?: boolean;
  workspace?: string;
}

export const command = "list";
export const desc = "List workspace agents";
export const aliases = ["ls"];

export const builder = {
  json: { type: "boolean" as const, describe: "Output agent list as JSON", default: false },
  workspace: { type: "string" as const, alias: "w", describe: "Workspace ID or name" },
};

export const handler = async (argv: ListArgs): Promise<void> => {
  try {
    // Check if daemon is running
    const health = await parseResult(v2Client.health.index.$get());
    if (!health.ok) {
      throw createDaemonNotRunningError();
    }

    const client = getDaemonClient();

    // Determine target workspace
    let workspaceId: string;
    let workspaceName: string;

    if (argv.workspace) {
      // Use specified workspace - try to find by ID or name
      try {
        const workspace = await client.getWorkspace(argv.workspace);
        workspaceId = workspace.id;
        workspaceName = workspace.name;
      } catch {
        // Try to find by name if ID lookup failed
        const allWorkspaces = await parseResult(v2Client.workspace.index.$get());
        if (!allWorkspaces.ok) {
          throw new Error("Failed to fetch workspaces");
        }
        const foundWorkspace = allWorkspaces.data.find((w) => w.name === argv.workspace);
        if (foundWorkspace) {
          workspaceId = foundWorkspace.id;
          workspaceName = foundWorkspace.name;
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
        const allWorkspaces = await parseResult(v2Client.workspace.index.$get());
        if (!allWorkspaces.ok) {
          throw new Error("Failed to fetch workspaces");
        }
        const currentWorkspace = allWorkspaces.data.find((w) => w.name === currentWorkspaceName);

        if (currentWorkspace) {
          workspaceId = currentWorkspace.id;
          workspaceName = currentWorkspace.name;
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

    // Get agents from daemon
    const agents = await client.listAgents(workspaceId);

    if (argv.json) {
      // JSON output for scripting
      console.log(
        JSON.stringify(
          {
            workspace: { id: workspaceId, name: workspaceName },
            agents: agents,
            count: agents.length,
            timestamp: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } else {
      if (agents.length === 0) {
        console.log(`No agents found in workspace: ${workspaceName}`);
        return;
      }

      // Transform agent data to match expected interface
      const transformedAgents = agents.map((agent) => ({
        name: agent.id, // Use ID as name
        type: agent.type,
        model: "N/A", // Default model if not provided
        status: "unknown", // Default status
        purpose: agent.purpose || "No purpose specified",
      }));

      // Render with Ink
      const { unmount } = render(
        <AgentListComponent agents={transformedAgents} workspaceName={workspaceName} />,
      );

      // Give a moment for render then exit
      setTimeout(() => {
        unmount();
      }, 100);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
};
