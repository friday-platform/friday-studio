import process from "node:process";
import { parseResult, client as v2Client } from "@atlas/client/v2";
import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { stringifyError } from "@atlas/utils";
import { define } from "gunshi";
import { createDaemonNotRunningError, getDaemonClient } from "../../../utils/daemon-client.ts";

export const describeCommand = define({
  name: "describe",
  description: "Show detailed information about an agent",
  args: {
    name: { type: "string", short: "n", description: "Agent name to describe", required: true },
    workspace: { type: "string", short: "w", description: "Workspace ID or name" },
  },
  rendering: { header: null },
  run: async (ctx) => {
    const name = ctx.values.name;
    if (!name) {
      console.error("Error: --name is required");
      process.exit(1);
    }

    const workspace = ctx.values.workspace;

    // Check if daemon is running
    const health = await parseResult(v2Client.health.index.$get());
    if (!health.ok) {
      throw createDaemonNotRunningError();
    }

    const client = getDaemonClient();

    // Determine target workspace
    let workspaceId: string;

    if (workspace) {
      // Use specified workspace - try to find by ID or name
      try {
        const ws = await client.getWorkspace(workspace);
        workspaceId = ws.id;
      } catch {
        throw new Error(`Workspace '${workspace}' not found`);
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
          throw new Error(`Failed to fetch workspaces: ${allWorkspaces.error}`);
        }
        const currentWorkspace = allWorkspaces.data.find((w) => w.name === currentWorkspaceName);

        if (currentWorkspace) {
          workspaceId = currentWorkspace.id;
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

    // Get agent details from daemon
    const agentConfig = await parseResult(
      v2Client.workspace[":workspaceId"].agents[":agentId"].$get({
        param: { workspaceId, agentId: name },
      }),
    );
    if (!agentConfig.ok) {
      console.error(`Error: ${stringifyError(agentConfig.error)}`);
      process.exit(1);
    }

    console.log(JSON.stringify(agentConfig.data, null, 2));
  },
});
