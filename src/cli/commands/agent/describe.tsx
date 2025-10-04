import { parseResult, client as v2Client } from "@atlas/client/v2";
import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { stringifyError } from "@atlas/utils";
import { createDaemonNotRunningError, getDaemonClient } from "../../utils/daemon-client.ts";

interface DescribeArgs {
  name: string;
  workspace?: string;
}

export const command = "describe <name>";
export const desc = "Show detailed information about an agent";
export const aliases = ["show", "get"];

export const builder = {
  name: { type: "string" as const, describe: "Agent name to describe", demandOption: true },
  workspace: { type: "string" as const, alias: "w", describe: "Workspace ID or name" },
};

export const handler = async (argv: DescribeArgs): Promise<void> => {
  // Check if daemon is running
  const health = await parseResult(v2Client.health.index.$get());
  if (!health.ok) {
    throw createDaemonNotRunningError();
  }

  const client = getDaemonClient();

  // Determine target workspace
  let workspaceId: string;

  if (argv.workspace) {
    // Use specified workspace - try to find by ID or name
    try {
      const workspace = await client.getWorkspace(argv.workspace);
      workspaceId = workspace.id;
    } catch {
      throw new Error(`Workspace '${argv.workspace}' not found`);
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
      param: { workspaceId, agentId: argv.name },
    }),
  );
  if (!agentConfig.ok) {
    console.error(`Error: ${stringifyError(agentConfig.error)}`);
    Deno.exit(1);
  }

  console.log(JSON.stringify(agentConfig.data, null, 2));
};
