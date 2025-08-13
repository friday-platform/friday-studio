import { checkAtlasRunning, createAtlasNotRunningError, getAtlasClient } from "@atlas/client";
import type { WorkspaceInfo } from "@atlas/client";
import { confirmAction } from "../../utils/confirm.tsx";
import { errorOutput, infoOutput, successOutput, warningOutput } from "../../utils/output.ts";
import { spinner } from "../../utils/prompts.tsx";
import { exists } from "@std/fs";

interface CleanupArgs {
  force?: boolean;
  yes?: boolean;
}

export const command = "cleanup";
export const desc = "Remove workspaces from registry that no longer exist on disk";
export const aliases = ["clean"];

export const builder = {
  force: {
    type: "boolean" as const,
    alias: "f",
    describe: "Force cleanup without confirmation",
    default: false,
  },
  yes: {
    type: "boolean" as const,
    alias: "y",
    describe: "Skip confirmation prompts",
    default: false,
  },
};

export const handler = async (argv: CleanupArgs): Promise<void> => {
  try {
    // Check if daemon is running
    if (!(await checkAtlasRunning())) {
      throw createAtlasNotRunningError();
    }

    // Get workspaces from daemon API
    const client = getAtlasClient();
    const workspaces = await client.listWorkspaces();

    if (workspaces.length === 0) {
      infoOutput("No workspaces found in registry.");
      Deno.exit(0);
    }

    // Check which workspaces have missing directories
    const s = spinner();
    s.start("Checking workspace directories...");

    const invalidWorkspaces: WorkspaceInfo[] = [];

    for (const workspace of workspaces) {
      try {
        const dirExists = await exists(workspace.path);
        if (!dirExists) {
          invalidWorkspaces.push(workspace);
        }
      } catch {
        // If we can't access the path, consider it invalid
        invalidWorkspaces.push(workspace);
      }
    }

    s.stop();

    if (invalidWorkspaces.length === 0) {
      successOutput("All workspaces have valid directories. No cleanup needed.");
      Deno.exit(0);
    }

    // Show what will be cleaned up
    warningOutput(`Found ${invalidWorkspaces.length} workspace(s) with missing directories:`);
    for (const workspace of invalidWorkspaces) {
      console.log(`  • ${workspace.name} (${workspace.id}) - ${workspace.path}`);
    }

    // Confirm cleanup
    const confirmed = await confirmAction(
      `Remove ${invalidWorkspaces.length} workspace(s) from registry?`,
      {
        force: argv.force,
        yes: argv.yes,
        defaultValue: false,
      },
    );

    if (!confirmed) {
      infoOutput("Cleanup cancelled.");
      Deno.exit(0);
    }

    // Remove invalid workspaces
    const cleanupSpinner = spinner();
    cleanupSpinner.start("Cleaning up invalid workspaces...");

    let removedCount = 0;
    const errors: string[] = [];

    for (const workspace of invalidWorkspaces) {
      try {
        await client.deleteWorkspace(workspace.id);
        removedCount++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`Failed to remove ${workspace.name}: ${errorMsg}`);
      }
    }

    cleanupSpinner.stop();

    // Report results
    if (removedCount > 0) {
      successOutput(`Successfully removed ${removedCount} workspace(s) from registry.`);
    }

    if (errors.length > 0) {
      warningOutput("Some workspaces could not be removed:");
      for (const error of errors) {
        console.log(`  • ${error}`);
      }
    }

    if (removedCount === 0 && errors.length > 0) {
      errorOutput("Failed to remove any workspaces.");
      Deno.exit(1);
    }

    Deno.exit(0);
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};
