import * as p from "@clack/prompts";
import { WorkspaceStatus as WSStatus } from "../../../core/workspace-registry-types.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { WorkspaceProcessManager } from "../../../core/workspace-process-manager.ts";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";

interface StopArgs {
  workspace?: string;
  all?: boolean;
}

export const command = "stop [workspace]";
export const desc = "Stop a running workspace server";

export const builder = {
  workspace: {
    type: "string" as const,
    describe: "Workspace ID or name (defaults to current directory)",
  },
  all: {
    type: "boolean" as const,
    describe: "Stop all running workspaces",
    default: false,
  },
};

export const handler = async (argv: StopArgs): Promise<void> => {
  try {
    const registry = getWorkspaceRegistry();
    await registry.initialize();

    if (argv.all) {
      await stopAllWorkspaces();
    } else {
      await stopSingleWorkspace(argv.workspace);
    }

    Deno.exit(0);
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};

async function stopSingleWorkspace(idOrName?: string): Promise<void> {
  const registry = getWorkspaceRegistry();
  const processManager = new WorkspaceProcessManager();

  let workspace;
  if (idOrName) {
    // Find by ID or name
    workspace = (await registry.findById(idOrName)) ||
      (await registry.findByName(idOrName));
  } else {
    // Use current directory
    workspace = await registry.getCurrentWorkspace();
  }

  if (!workspace) {
    errorOutput(
      idOrName
        ? `Workspace '${idOrName}' not found. Use 'atlas workspace list' to see available workspaces.`
        : "No workspace found in current directory.",
    );
    Deno.exit(1);
  }

  // Check if workspace is running
  if (workspace.status !== WSStatus.RUNNING && workspace.status !== WSStatus.STARTING) {
    infoOutput(`Workspace '${workspace.name}' is not running (status: ${workspace.status}).`);
    return;
  }

  // Show spinner while stopping
  const s = p.spinner();
  s.start(`Stopping workspace '${workspace.name}'...`);

  try {
    await processManager.stop(workspace.id);
    s.stop(`Workspace '${workspace.name}' stopped successfully`);
  } catch (err) {
    s.stop("Error stopping workspace");
    throw err;
  }
}

async function stopAllWorkspaces(): Promise<void> {
  const registry = getWorkspaceRegistry();
  const processManager = new WorkspaceProcessManager();

  const runningWorkspaces = await registry.getRunning();

  if (runningWorkspaces.length === 0) {
    infoOutput("No running workspaces found.");
    return;
  }

  infoOutput(`Found ${runningWorkspaces.length} running workspace(s).`);

  for (const workspace of runningWorkspaces) {
    const s = p.spinner();
    s.start(`Stopping workspace '${workspace.name}'...`);

    try {
      await processManager.stop(workspace.id);
      s.stop(`✓ Stopped '${workspace.name}'`);
    } catch (err) {
      s.stop(
        `✗ Error stopping '${workspace.name}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  successOutput("All workspaces stopped.");
}
