import { rm } from "node:fs/promises";
import process from "node:process";
import type { WorkspaceInfo } from "@atlas/client";
import { createAtlasNotRunningError } from "@atlas/client";
import { parseResult, client as v2Client } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
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
    const health = await parseResult(v2Client.health.index.$get());
    if (!health.ok) {
      throw createAtlasNotRunningError();
    }

    // Get workspaces from daemon API
    const workspaces = await parseResult(v2Client.workspace.index.$get());
    if (!workspaces.ok) {
      errorOutput("Failed to fetch workspaces.");
      process.exit(1);
    }

    let workspace: WorkspaceInfo | undefined;
    if (argv.workspace) {
      // Find by ID or name
      workspace = workspaces.data.find((w) => w.id === argv.workspace || w.name === argv.workspace);
    } else {
      // Use current directory
      const currentPath = Deno.cwd();
      workspace = workspaces.data.find((w) => w.path === currentPath);
    }

    if (!workspace) {
      errorOutput(
        argv.workspace
          ? `Workspace '${argv.workspace}' not found. Use 'atlas workspace list' to see available workspaces.`
          : "No workspace found in current directory.",
      );
      process.exit(1);
    }

    // Check if workspace is running
    if (workspace.status === "RUNNING" || workspace.status === "STARTING") {
      warningOutput(`Workspace '${workspace.name}' is currently running.`);

      const confirmStop = await confirmAction("Do you want to stop it before removal?", {
        force: argv.force,
        yes: argv.yes,
        defaultValue: true,
      });

      if (!confirmStop) {
        infoOutput("Removal cancelled.");
        process.exit(0);
      }
    }

    // Confirm removal
    let confirmMessage = `Are you sure you want to remove workspace '${workspace.name}'?`;
    if (argv.deleteFiles) {
      confirmMessage = `Are you sure you want to remove workspace '${workspace.name}' AND delete all files at ${workspace.path}? This action cannot be undone!`;
    }

    const confirmed = await confirmAction(confirmMessage, {
      force: argv.force,
      yes: argv.yes,
      defaultValue: false,
    });

    if (!confirmed) {
      infoOutput("Removal cancelled.");
      process.exit(0);
    }

    // Remove from registry via daemon API
    const s = spinner();
    s.start(`Removing workspace '${workspace.name}' from registry...`);

    const res = await parseResult(
      v2Client.workspace[":workspaceId"].$delete({ param: { workspaceId: workspace.id } }),
    );
    if (!res.ok) {
      s.stop("Failed to remove workspace");
      throw res.error;
    }
    s.stop(`Workspace '${workspace.name}' removed from registry`);

    // Delete files if requested
    if (argv.deleteFiles) {
      const deleteSpinner = spinner();
      deleteSpinner.start(`Deleting workspace files at ${workspace.path}...`);

      try {
        await rm(workspace.path, { recursive: true });
        deleteSpinner.stop("Workspace files deleted");
      } catch (err) {
        deleteSpinner.stop("Failed to delete workspace files");
        warningOutput(`Failed to delete files: ${stringifyError(err)}`);
      }
    }

    successOutput("Workspace removed successfully.");

    process.exit(0);
  } catch (error) {
    errorOutput(stringifyError(error));
    process.exit(1);
  }
};
