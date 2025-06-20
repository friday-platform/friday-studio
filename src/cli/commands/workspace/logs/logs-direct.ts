import { getWorkspaceRegistry } from "../../../../core/workspace-registry.ts";
import { formatLog, parseContextFilters, parseDuration, WorkspaceLogReader } from "./log-reader.ts";

interface WorkspaceLogsFlags {
  follow?: boolean;
  tail?: number;
  since?: string;
  timestamps?: boolean;
  json?: boolean;
  level?: string;
  context?: string[];
}

export async function runWorkspaceLogs(args: string[], flags: WorkspaceLogsFlags): Promise<void> {
  try {
    const workspaceIdOrName = args[0];
    const registry = getWorkspaceRegistry();

    let workspaceId: string;

    if (!workspaceIdOrName) {
      // Try to get current workspace
      const workspace = await registry.getCurrentWorkspace();
      if (!workspace) {
        throw new Error("No workspace specified and not in a workspace directory");
      }
      workspaceId = workspace.id;
    } else {
      // Find workspace by ID or name
      const workspace = await registry.findById(workspaceIdOrName) ||
        await registry.findByName(workspaceIdOrName);
      if (!workspace) {
        throw new Error(`Workspace '${workspaceIdOrName}' not found`);
      }
      workspaceId = workspace.id;
    }

    const logReader = new WorkspaceLogReader(workspaceId);

    // Apply filters
    const filters = {
      level: flags.level,
      since: flags.since ? parseDuration(flags.since) : undefined,
      context: parseContextFilters(flags.context),
    };

    if (flags.follow) {
      console.log("\x1b[90mFollowing logs... (Press Ctrl+C to stop)\x1b[0m");

      // Set up graceful shutdown
      const abortController = new AbortController();

      Deno.addSignalListener("SIGINT", () => {
        console.log("\n\x1b[90mStopping log follow...\x1b[0m");
        abortController.abort();
        logReader.stop();
        Deno.exit(0);
      });

      // Stream logs with tail
      await logReader.follow({
        tail: flags.tail || 100,
        filters,
        onLog: (log) => {
          const formatted = formatLog(log, {
            timestamps: flags.timestamps !== false,
            json: flags.json || false,
          });
          console.log(formatted);
        },
      });
    } else {
      // Read logs once
      const entries = await logReader.read({
        tail: flags.tail || 100,
        filters,
      });

      if (entries.length === 0) {
        console.log("\x1b[90mNo logs found for this workspace\x1b[0m");
      } else {
        for (const log of entries) {
          const formatted = formatLog(log, {
            timestamps: flags.timestamps !== false,
            json: flags.json || false,
          });
          console.log(formatted);
        }
      }
    }
  } catch (err) {
    console.error(`\x1b[31mError: ${(err as Error).message}\x1b[0m`);
    Deno.exit(1);
  }
}
