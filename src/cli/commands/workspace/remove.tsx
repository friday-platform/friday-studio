import { checkAtlasRunning, createAtlasNotRunningError, getAtlasClient } from "@atlas/client";
import type { WorkspaceInfo } from "@atlas/client";
import { WorkspaceProcessManager } from "../../../core/workspace-process-manager.ts";
import { confirmAction } from "../../utils/confirm.tsx";
import { errorOutput, infoOutput, successOutput, warningOutput } from "../../utils/output.ts";
import { spinner } from "../../utils/prompts.tsx";

interface RemoveArgs {
  workspace?: string;
  force?: boolean;
  yes?: boolean;
  deleteFiles?: boolean;
}

export const command = "remove [workspace]";
export const desc = "Remove a workspace from the registry";
export const aliases = ["rm", "delete"];

export const builder = {
  workspace: {
    type: "string" as const,
    describe: "Workspace ID or name (defaults to current directory)",
  },
  force: {
    type: "boolean" as const,
    alias: "f",
    describe: "Force removal without confirmation",
    default: false,
  },
  yes: {
    type: "boolean" as const,
    alias: "y",
    describe: "Skip confirmation prompts",
    default: false,
  },
  deleteFiles: {
    type: "boolean" as const,
    describe: "Also delete workspace files from disk (DANGEROUS)",
    default: false,
  },
};

export const handler = async (argv: RemoveArgs): Promise<void> => {
  try {
    // Check if daemon is running
    if (!(await checkAtlasRunning())) {
      throw createAtlasNotRunningError();
    }

    // Get workspaces from daemon API
    const client = getAtlasClient();
    const workspaces = await client.listWorkspaces();

    let workspace: WorkspaceInfo | undefined;
    if (argv.workspace) {
      // Find by ID or name
      workspace = workspaces.find(
        (w) => w.id === argv.workspace || w.name === argv.workspace,
      );
    } else {
      // Use current directory
      const currentPath = Deno.cwd();
      workspace = workspaces.find((w) => w.path === currentPath);
    }

    if (!workspace) {
      errorOutput(
        argv.workspace
          ? `Workspace '${argv.workspace}' not found. Use 'atlas workspace list' to see available workspaces.`
          : "No workspace found in current directory.",
      );
      Deno.exit(1);
    }

    // Check if workspace is running
    if (workspace.status === "RUNNING" || workspace.status === "STARTING") {
      warningOutput(`Workspace '${workspace.name}' is currently running.`);

      const confirmStop = await confirmAction(
        "Do you want to stop it before removal?",
        { force: argv.force, yes: argv.yes, defaultValue: true },
      );

      if (!confirmStop) {
        infoOutput("Removal cancelled.");
        Deno.exit(0);
      }

      // Stop the workspace
      const processManager = new WorkspaceProcessManager();
      const s = spinner();
      s.start(`Stopping workspace '${workspace.name}'...`);

      try {
        await processManager.stop(workspace.id);
        s.stop("Workspace stopped");
      } catch (err) {
        s.stop("Failed to stop workspace");
        errorOutput(
          `Error stopping workspace: ${err instanceof Error ? err.message : String(err)}`,
        );

        const forceRemove = await confirmAction(
          "Failed to stop workspace. Remove anyway?",
          { force: argv.force, yes: argv.yes, defaultValue: false },
        );

        if (!forceRemove) {
          infoOutput("Removal cancelled.");
          Deno.exit(0);
        }
      }
    }

    // Confirm removal
    let confirmMessage = `Are you sure you want to remove workspace '${workspace.name}'?`;
    if (argv.deleteFiles) {
      confirmMessage =
        `Are you sure you want to remove workspace '${workspace.name}' AND delete all files at ${workspace.path}? This action cannot be undone!`;
    }

    const confirmed = await confirmAction(confirmMessage, {
      force: argv.force,
      yes: argv.yes,
      defaultValue: false,
    });

    if (!confirmed) {
      infoOutput("Removal cancelled.");
      Deno.exit(0);
    }

    // Remove from registry via daemon API
    const s = spinner();
    s.start(`Removing workspace '${workspace.name}' from registry...`);

    try {
      await client.deleteWorkspace(workspace.id);
      s.stop(`Workspace '${workspace.name}' removed from registry`);

      // Delete files if requested
      if (argv.deleteFiles) {
        const deleteSpinner = spinner();
        deleteSpinner.start(`Deleting workspace files at ${workspace.path}...`);

        try {
          await Deno.remove(workspace.path, { recursive: true });
          deleteSpinner.stop("Workspace files deleted");
        } catch (err) {
          deleteSpinner.stop("Failed to delete workspace files");
          warningOutput(
            `Failed to delete files: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      successOutput("Workspace removed successfully.");
    } catch (err) {
      s.stop("Failed to remove workspace");
      throw err;
    }

    Deno.exit(0);
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};
