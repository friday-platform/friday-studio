import {
  WorkspaceEntry,
  WorkspaceStatus as WSStatus,
} from "../../../core/workspace-registry-types.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { WorkspaceProcessManager } from "../../../core/workspace-process-manager.ts";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import { spinner } from "../../utils/prompts.tsx";

interface RestartArgs {
  workspace?: string;
  port?: number;
  detached?: boolean;
  lazy?: boolean;
  logLevel?: string;
}

export const command = "restart [workspace]";
export const desc = "Restart a workspace server";

export const builder = {
  workspace: {
    type: "string" as const,
    describe: "Workspace ID or name (defaults to current directory)",
  },
  port: {
    type: "number" as const,
    alias: "p",
    describe: "Port to run the server on",
  },
  detached: {
    type: "boolean" as const,
    alias: "d",
    describe: "Run server in background after restart",
    default: false,
  },
  lazy: {
    type: "boolean" as const,
    describe: "Start in lazy mode (agents loaded on demand)",
    default: false,
  },
  logLevel: {
    type: "string" as const,
    describe: "Logging level (debug, info, warn, error)",
    choices: ["debug", "info", "warn", "error"],
  },
};

export const handler = async (argv: RestartArgs): Promise<void> => {
  try {
    const registry = getWorkspaceRegistry();
    await registry.initialize();

    let workspace: WorkspaceEntry | undefined;
    if (argv.workspace) {
      // Find by ID or name
      workspace = (await registry.findById(argv.workspace)) ||
        (await registry.findByName(argv.workspace));
    } else {
      // Use current directory
      workspace = await registry.getCurrentWorkspace();
    }

    if (!workspace) {
      errorOutput(
        argv.workspace
          ? `Workspace '${argv.workspace}' not found. Use 'atlas workspace list' to see available workspaces.`
          : "No workspace found in current directory.",
      );
      Deno.exit(1);
    }

    const processManager = new WorkspaceProcessManager();

    // Stop if running
    if (
      workspace.status === WSStatus.RUNNING ||
      workspace.status === WSStatus.STARTING
    ) {
      const s = spinner();
      s.start(`Stopping workspace '${workspace.name}'...`);

      try {
        await processManager.stop(workspace.id);
        s.stop(`Workspace stopped`);
      } catch (err) {
        s.stop("Failed to stop workspace");
        errorOutput(
          `Error stopping workspace: ${err instanceof Error ? err.message : String(err)}`,
        );
        Deno.exit(1);
      }
    }

    // Wait a moment before restarting
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Start the workspace
    infoOutput(`Starting workspace '${workspace.name}'...`);

    if (argv.detached) {
      // Start in detached mode
      const s = spinner();
      s.start("Starting workspace in background...");

      try {
        const pid = await processManager.startDetached(workspace.path, {
          port: argv.port,
          logLevel: argv.logLevel,
        });

        // Wait for workspace to be ready
        if (await processManager.waitForReady(workspace.id)) {
          // Refresh workspace info
          const refreshedWorkspace = await registry.findById(workspace.id);
          s.stop(`Workspace '${workspace.name}' restarted in background`);
          successOutput(`PID: ${pid}`);
          successOutput(`Port: ${refreshedWorkspace?.port}`);
          successOutput(`Logs: atlas logs ${workspace.id}`);
        } else {
          throw new Error("Workspace failed to start");
        }
      } catch (err) {
        s.stop("Failed to restart workspace");
        throw err;
      }
    } else {
      // Start in foreground - import serve handler
      const { handler: serveHandler } = await import("./serve.tsx");

      // Call serve with the workspace path and options
      await serveHandler({
        workspace: workspace.id,
        port: argv.port,
        detached: false,
        lazy: argv.lazy,
        logLevel: argv.logLevel,
      });
    }

    Deno.exit(0);
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};
