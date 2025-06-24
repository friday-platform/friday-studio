import { load } from "@std/dotenv";
import { exists } from "@std/fs";
import * as p from "@clack/prompts";
import { ConfigLoader } from "../../../core/config-loader.ts";
import { WorkspaceStatus as WSStatus } from "../../../core/workspace-registry-types.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { WorkspaceProcessManager } from "../../../core/workspace-process-manager.ts";
import { findAvailablePort } from "../../../utils/port-finder.ts";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";

interface ServeArgs {
  workspace?: string;
  port?: number;
  detached?: boolean;
  lazy?: boolean;
  logLevel?: string;
  force?: boolean;
}

export const command = "serve [workspace]";
export const desc = "Start the workspace server";
export const aliases = ["start"];

export const examples = [
  ["$0 workspace serve", "Start server in current workspace directory"],
  ["$0 workspace serve --detached", "Start server in background mode"],
  ["$0 workspace serve --port 3000", "Start server on specific port"],
  ["$0 work serve my-agent -d", "Start workspace 'my-agent' in detached mode"],
];

export function builder(y: YargsInstance) {
  return yargs
    .positional("workspace", {
      type: "string",
      describe: "Workspace ID or name (defaults to current directory)",
    })
    .option("port", {
      type: "number",
      alias: "p",
      describe: "Port to run the server on",
    })
    .option("detached", {
      type: "boolean",
      alias: "d",
      describe: "Run server in background (detached mode)",
      default: false,
    })
    .option("lazy", {
      type: "boolean",
      describe: "Start in lazy mode (agents loaded on demand)",
      default: false,
    })
    .option("logLevel", {
      type: "string",
      describe: "Logging level (debug, info, warn, error)",
      choices: ["debug", "info", "warn", "error"],
    })
    .option("force", {
      type: "boolean",
      alias: "f",
      describe: "Force start even if already running",
      default: false,
    })
    .example("$0 workspace serve", "Start server in current workspace directory")
    .example("$0 workspace serve --detached", "Start server in background mode")
    .example("$0 workspace serve --port 3000", "Start server on specific port")
    .example("$0 work serve my-agent -d", "Start workspace 'my-agent' in detached mode");
}

export const handler = async (argv: ServeArgs): Promise<void> => {
  try {
    let targetPath = Deno.cwd();
    const registry = getWorkspaceRegistry();
    await registry.initialize();

    // If a workspace is specified, find it
    if (argv.workspace) {
      const workspace = await registry.findById(argv.workspace) ||
        await registry.findByName(argv.workspace);

      if (!workspace) {
        errorOutput(
          `Workspace '${argv.workspace}' not found. Use 'atlas workspace list' to see available workspaces.`,
        );
        Deno.exit(1);
      }

      targetPath = workspace.path;
    }

    // Check if workspace.yml exists
    const workspaceYmlPath = `${targetPath}/workspace.yml`;
    if (!(await exists(workspaceYmlPath))) {
      errorOutput(
        `No workspace.yml found in ${targetPath}. Run 'atlas workspace init <name>' to create a workspace.`,
      );
      Deno.exit(1);
    }

    // Validate port if specified
    if (argv.port && (argv.port < 1 || argv.port > 65535)) {
      errorOutput(
        `Invalid port number: ${argv.port}. Port must be between 1 and 65535.`,
      );
      Deno.exit(1);
    }

    // Handle detached mode
    if (argv.detached) {
      await startDetached(targetPath, argv);
    } else {
      await startForeground(targetPath, argv);
    }
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};

async function startDetached(workspacePath: string, argv: ServeArgs): Promise<void> {
  const processManager = new WorkspaceProcessManager();
  const registry = getWorkspaceRegistry();

  // Show spinner while starting
  const s = p.spinner();
  s.start("Starting workspace in background...");

  try {
    // Start detached process
    const pid = await processManager.startDetached(workspacePath, {
      port: argv.port,
      logLevel: argv.logLevel,
    });

    // Wait for workspace to be ready
    const workspace = await registry.findByPath(workspacePath) ||
      await registry.getCurrentWorkspace();

    if (workspace && await processManager.waitForReady(workspace.id)) {
      s.stop(`Workspace '${workspace.name}' started in background`);
      successOutput(`ID: ${workspace.id}`);
      successOutput(`PID: ${pid}`);
      successOutput(`Port: ${workspace.port}`);
      successOutput(`Logs: atlas logs ${workspace.id}`);
    } else {
      throw new Error("Workspace failed to start");
    }
  } catch (err) {
    s.stop("Failed to start workspace");
    throw err;
  }

  Deno.exit(0);
}

async function startForeground(workspacePath: string, argv: ServeArgs): Promise<void> {
  // Change to workspace directory if needed
  const originalCwd = Deno.cwd();
  if (workspacePath !== originalCwd) {
    infoOutput(`Changing to workspace directory: ${workspacePath}`);
    Deno.chdir(workspacePath);
  }

  // Load environment variables
  await load({ export: true });

  // Load configuration
  const configLoader = new ConfigLoader();
  const mergedConfig = await configLoader.load();

  // Register or update workspace in registry
  const registry = getWorkspaceRegistry();
  const workspaceEntry = await registry.findOrRegister(Deno.cwd(), {
    name: mergedConfig.workspace.workspace.name,
    description: mergedConfig.workspace.workspace.description,
  });

  // Check if workspace is already running
  if (workspaceEntry.status === WSStatus.RUNNING && workspaceEntry.pid && !argv.force) {
    // Double-check if process is actually running
    try {
      Deno.kill(workspaceEntry.pid, "SIGCONT");
      errorOutput(
        `Workspace '${workspaceEntry.name}' is already running (PID: ${workspaceEntry.pid}, Port: ${workspaceEntry.port}). ` +
          `Stop it first with 'atlas workspace stop ${workspaceEntry.id}' or use --force to override.`,
      );
      Deno.exit(1);
    } catch (_err) {
      // Process is not running, continue
    }
  }

  // Find an available port
  let actualPort = argv.port;
  const configPort = mergedConfig.atlas.runtime?.server?.port;

  // Get list of occupied ports from running workspaces
  const runningWorkspaces = await registry.getRunning();
  const occupiedPorts = new Set(
    runningWorkspaces
      .filter((w) => w.port && w.id !== workspaceEntry.id)
      .map((w) => w.port!),
  );

  // If no port specified, find an available one
  if (!actualPort) {
    // Try config port first, then find available
    const preferredPort = configPort || 8080;

    if (!occupiedPorts.has(preferredPort)) {
      try {
        // Double-check port is actually available
        const conn = await Deno.connect({ port: preferredPort, hostname: "localhost" }).catch(
          () => null,
        );
        if (conn) {
          conn.close();
          // Port is in use but not by a workspace - find another
          actualPort = findAvailablePort({
            preferredPort: preferredPort + 1,
            startPort: 8080,
            endPort: 8180,
          });
        } else {
          actualPort = preferredPort;
        }
      } catch {
        actualPort = preferredPort;
      }
    } else {
      // Preferred port is occupied by another workspace
      actualPort = findAvailablePort({
        startPort: 8080,
        endPort: 8180,
      });
    }
  } else {
    // Check if requested port is occupied by another workspace
    if (occupiedPorts.has(actualPort)) {
      const occupyingWorkspace = runningWorkspaces.find((w) => w.port === actualPort);
      errorOutput(
        `Port ${actualPort} is already in use by workspace '${occupyingWorkspace?.name}' (${occupyingWorkspace?.id}). ` +
          `Use a different port or stop the other workspace first.`,
      );
      Deno.exit(1);
    }
  }

  // Update status to starting
  await registry.updateStatus(
    workspaceEntry.id,
    WSStatus.STARTING,
    {
      port: actualPort,
      pid: Deno.pid,
    },
  );

  // Import workspace components
  const { Workspace } = await import("../../../core/workspace.ts");
  const { WorkspaceRuntime } = await import("../../../core/workspace-runtime.ts");
  const { WorkspaceServer } = await import("../../../core/workspace-server.ts");
  const { WorkspaceMemberRole } = await import("../../../types/core.ts");

  const workspace = Workspace.fromConfig(mergedConfig.workspace, {
    id: mergedConfig.workspace.workspace.id,
    name: mergedConfig.workspace.workspace.name,
    role: WorkspaceMemberRole.OWNER,
  });

  // Register workspace ID to registry ID mapping for logging
  const { logger } = await import("../../../utils/logger.ts");
  logger.registerWorkspaceMapping(workspace.id, workspaceEntry.id);

  const runtime = new WorkspaceRuntime(workspace, mergedConfig, {
    lazy: argv.lazy || false,
  });

  const hostname = mergedConfig.atlas.runtime?.server?.host || "localhost";
  const server = new WorkspaceServer(runtime, {
    port: actualPort,
    hostname,
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    infoOutput("\nShutting down workspace server...");
    await registry.updateStatus(workspaceEntry.id, WSStatus.STOPPING);
    await server.shutdown();
    await registry.updateStatus(workspaceEntry.id, WSStatus.STOPPED);
    successOutput(`Workspace '${workspaceEntry.name}' stopped successfully.`);
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  infoOutput(
    `Starting workspace '${workspaceEntry.name}' (${workspaceEntry.id}) on http://${hostname}:${actualPort}...`,
  );

  // Start the server
  const { finished } = await server.startNonBlocking();

  // Update status to running
  await registry.updateStatus(workspaceEntry.id, WSStatus.RUNNING);

  successOutput(
    `Workspace '${workspaceEntry.name}' (${workspaceEntry.id}) is running on http://${hostname}:${actualPort}`,
  );
  infoOutput("Press Ctrl+C to stop the server.");

  // Wait for the server to finish
  await finished;
}
