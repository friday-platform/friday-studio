import { join } from "node:path";
import process from "node:process";
import { parseResult, client as v2Client } from "@atlas/client/v2";
import { ConfigLoader } from "@atlas/config";
import { UserAdapter } from "@atlas/core/agent-loader";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { define } from "gunshi";
import { render } from "ink";
import { AgentListComponent } from "../../../modules/agents/agent-list-component.tsx";
import { createDaemonNotRunningError, getDaemonClient } from "../../../utils/daemon-client.ts";

export const listCommand = define({
  name: "list",
  description: "List agents",
  args: {
    json: { type: "boolean", description: "Output agent list as JSON", default: false },
    workspace: { type: "string", short: "w", description: "Workspace ID or name" },
    user: {
      type: "boolean",
      description: "List user-built agents from <friday-home>/agents/",
      default: false,
    },
  },
  rendering: { header: null },
  run: async (ctx) => {
    try {
      const json = ctx.values.json ?? false;
      const user = ctx.values.user ?? false;
      const workspace = ctx.values.workspace;

      // --user flag → list user-built agents directly
      if (user) {
        await listUserAgents(json);
        return;
      }

      // Check if daemon is running
      const health = await parseResult(v2Client.health.index.$get());
      if (!health.ok) {
        throw createDaemonNotRunningError();
      }

      const client = getDaemonClient();

      // Determine target workspace
      let workspaceId: string;
      let workspaceName: string;

      if (workspace) {
        // Use specified workspace - try to find by ID or name
        try {
          const ws = await client.getWorkspace(workspace);
          workspaceId = ws.id;
          workspaceName = ws.name;
        } catch {
          // Try to find by name if ID lookup failed
          const allWorkspaces = await parseResult(v2Client.workspace.index.$get());
          if (!allWorkspaces.ok) {
            throw new Error("Failed to fetch workspaces");
          }
          const foundWorkspace = allWorkspaces.data.find((w) => w.name === workspace);
          if (foundWorkspace) {
            workspaceId = foundWorkspace.id;
            workspaceName = foundWorkspace.name;
          } else {
            throw new Error(`Workspace '${workspace}' not found`);
          }
        }
      } else {
        // Try current workspace; fall back to user agents if not in a workspace
        try {
          const fsAdapter = new FilesystemConfigAdapter(Deno.cwd());
          const configLoader = new ConfigLoader(fsAdapter, Deno.cwd());
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
          // No workspace context — show user-built agents
          await listUserAgents(json);
          return;
        }
      }

      // Get agents from daemon
      const agents = await client.listAgents(workspaceId);

      if (json) {
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
          name: agent.id,
          type: agent.type,
          model: "N/A",
          status: "unknown",
          purpose: agent.description || "No description",
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
  },
});

async function listUserAgents(json: boolean): Promise<void> {
  const agentsDir = join(getAtlasHome(), "agents");
  const adapter = new UserAdapter(agentsDir);
  const agents = await adapter.listAgents();

  if (json) {
    console.log(
      JSON.stringify(
        {
          source: "user",
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
      console.log(`No user-built agents found in ${join(getAtlasHome(), "agents")}`);
      return;
    }

    const transformedAgents = agents.map((agent) => ({
      name: agent.id,
      type: "user",
      model: "N/A",
      status: "unknown",
      purpose: agent.description ?? "No description",
    }));

    const { unmount } = render(
      <AgentListComponent agents={transformedAgents} workspaceName="User Agents" source="user" />,
    );

    setTimeout(() => {
      unmount();
    }, 100);
  }
}
