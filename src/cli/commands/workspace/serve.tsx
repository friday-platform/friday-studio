import { load } from "@std/dotenv";
import { Box, Text, useApp } from "ink";
import { useEffect, useState } from "react";
import { ConfigLoader } from "../../../core/config-loader.ts";
import { WorkspaceStatus as WSStatus } from "../../../core/workspace-registry-types.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { findAvailablePort } from "../../../utils/port-finder.ts";
import { WorkspaceCommandProps } from "./utils.ts";
import { WorkspaceProcessManager } from "../../../core/workspace-process-manager.ts";

export function WorkspaceServeCommand({ args, flags }: WorkspaceCommandProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "detached">("loading");
  const [error, setError] = useState<string>("");
  const [workspacePath, setWorkspacePath] = useState<string>("");
  const [detachedInfo, setDetachedInfo] = useState<
    { pid: number; port: number; workspaceId: string; workspaceName: string } | null
  >(null);
  const requestedPort = flags.port ? Number(flags.port) : undefined;
  const isDetached = flags.detached === true;
  const isInternalDetached = flags.internalDetached === true;

  useEffect(() => {
    const validateAndServe = async () => {
      try {
        const { exists } = await import("@std/fs");
        let targetPath = Deno.cwd();

        // If an argument is provided, treat it as workspace ID or name
        if (args.length > 0) {
          const idOrName = args[0];
          const registry = getWorkspaceRegistry();
          await registry.initialize();

          // Try to find workspace by ID or name
          const workspace = await registry.findById(idOrName) ||
            await registry.findByName(idOrName);

          if (!workspace) {
            throw new Error(
              `Workspace '${idOrName}' not found. Use 'atlas workspace list' to see available workspaces.`,
            );
          }

          targetPath = workspace.path;
        }

        // Check if workspace.yml exists in the target path
        const workspaceYmlPath = `${targetPath}/workspace.yml`;
        if (!(await exists(workspaceYmlPath))) {
          throw new Error(
            `No workspace.yml found in ${targetPath}. Run 'atlas workspace init <name>' to create a workspace.`,
          );
        }

        // Validate port if specified
        if (requestedPort && (requestedPort < 1 || requestedPort > 65535)) {
          throw new Error(
            `Invalid port number: ${requestedPort}. Port must be between 1 and 65535.`,
          );
        }

        setWorkspacePath(targetPath);

        // Handle detached mode
        if (isDetached) {
          const processManager = new WorkspaceProcessManager();
          const registry = getWorkspaceRegistry();

          try {
            // Start detached process
            const pid = await processManager.startDetached(targetPath, {
              port: requestedPort,
              logLevel: flags.logLevel as string | undefined,
            });

            // Wait for workspace to be ready
            const workspace = await registry.findByPath(targetPath) ||
              await registry.getCurrentWorkspace();

            if (workspace && await processManager.waitForReady(workspace.id)) {
              setDetachedInfo({
                pid,
                port: workspace.port!,
                workspaceId: workspace.id,
                workspaceName: workspace.name,
              });
              setStatus("detached");
            } else {
              throw new Error("Workspace failed to start");
            }
          } catch (err) {
            throw err;
          }
        } else {
          setStatus("ready");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    };

    validateAndServe();
  }, []);

  if (status === "loading") {
    return <Text>Loading...</Text>;
  }

  if (status === "error") {
    return <Text color="red">Error: {error}</Text>;
  }

  if (status === "detached") {
    return <DetachedComponent detachedInfo={detachedInfo!} />;
  }

  return (
    <ServingComponent
      requestedPort={requestedPort}
      flags={flags}
      workspacePath={workspacePath}
      isInternalDetached={isInternalDetached}
    />
  );
}

function DetachedComponent({ detachedInfo }: {
  detachedInfo: { pid: number; port: number; workspaceId: string; workspaceName: string };
}) {
  const { exit } = useApp();

  useEffect(() => {
    // Exit immediately after displaying the message
    setTimeout(() => exit(), 100);
  }, [exit]);

  return (
    <Box flexDirection="column">
      <Text color="green">✓ Workspace '{detachedInfo.workspaceName}' started in background</Text>
      <Text>ID: {detachedInfo.workspaceId}</Text>
      <Text>PID: {detachedInfo.pid}</Text>
      <Text>Port: {detachedInfo.port}</Text>
      <Text>Logs: atlas logs {detachedInfo.workspaceId}</Text>
    </Box>
  );
}

function ServingComponent({ requestedPort, flags, workspacePath, isInternalDetached }: {
  requestedPort?: number;
  flags: Record<string, unknown>;
  workspacePath: string;
  isInternalDetached: boolean;
}) {
  const { exit } = useApp();

  useEffect(() => {
    const startServer = async () => {
      try {
        console.log("Starting workspace server...");
        exit();

        await new Promise((resolve) => setTimeout(resolve, 100));

        // Handle internal detached mode
        if (isInternalDetached) {
          // Get workspace ID from flags
          const workspaceId = flags.workspaceId as string;
          if (!workspaceId) {
            throw new Error("Internal detached mode requires workspaceId flag");
          }

          // Find workspace by ID
          const registry = getWorkspaceRegistry();
          const workspace = await registry.findById(workspaceId);
          if (!workspace) {
            throw new Error(`Workspace ${workspaceId} not found`);
          }

          // Change to workspace directory
          console.log(`Changing to workspace directory: ${workspace.path}`);
          Deno.chdir(workspace.path);
        } else {
          // Change to workspace directory if needed
          const originalCwd = Deno.cwd();
          if (workspacePath && workspacePath !== originalCwd) {
            console.log(`Changing to workspace directory: ${workspacePath}`);
            Deno.chdir(workspacePath);
          }
        }

        await load({ export: true });

        const configLoader = new ConfigLoader();
        const mergedConfig = await configLoader.load();

        // Register or update workspace in registry
        const registry = getWorkspaceRegistry();
        const workspaceEntry = await registry.findOrRegister(Deno.cwd(), {
          name: mergedConfig.workspace.workspace.name,
          description: mergedConfig.workspace.workspace.description,
        });

        // Check if workspace is already running
        if (workspaceEntry.status === WSStatus.RUNNING && workspaceEntry.pid) {
          // Double-check if process is actually running
          try {
            Deno.kill(workspaceEntry.pid, "SIGCONT");
            throw new Error(
              `Workspace '${workspaceEntry.name}' is already running (PID: ${workspaceEntry.pid}, Port: ${workspaceEntry.port}). ` +
                `Stop it first with 'atlas workspace stop ${workspaceEntry.id}' or kill the process.`,
            );
          } catch (err) {
            if (err instanceof Error && err.message.includes("already running")) {
              throw err;
            }
            // Process is not running, continue
          }
        }

        // Find an available port
        let actualPort = requestedPort;
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
            throw new Error(
              `Port ${actualPort} is already in use by workspace '${occupyingWorkspace?.name}' (${occupyingWorkspace?.id}). ` +
                `Use a different port or stop the other workspace first.`,
            );
          }
        }

        // Update status to starting with the actual port
        await registry.updateStatus(
          workspaceEntry.id,
          WSStatus.STARTING,
          {
            port: actualPort,
            pid: Deno.pid,
          },
        );

        const { Workspace } = await import("../../../core/workspace.ts");
        const { WorkspaceRuntime } = await import(
          "../../../core/workspace-runtime.ts"
        );
        const { WorkspaceServer } = await import(
          "../../../core/workspace-server.ts"
        );
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
          lazy: Boolean(flags.lazy) || false,
        });

        // Already found available port above, now set hostname
        const hostname = mergedConfig.atlas.runtime?.server?.host || "localhost";

        const server = new WorkspaceServer(runtime, {
          port: actualPort,
          hostname,
        });

        // Handle graceful shutdown to update registry status
        const shutdown = async () => {
          console.log("\nShutting down workspace server...");
          await registry.updateStatus(
            workspaceEntry.id,
            WSStatus.STOPPING,
          );
          await server.shutdown();
          await registry.updateStatus(
            workspaceEntry.id,
            WSStatus.STOPPED,
          );
          console.log(`Workspace '${workspaceEntry.name}' stopped successfully.`);
          Deno.exit(0);
        };

        Deno.addSignalListener("SIGINT", shutdown);
        Deno.addSignalListener("SIGTERM", shutdown);

        console.log(
          `Starting workspace '${workspaceEntry.name}' (${workspaceEntry.id}) on http://${hostname}:${actualPort}...`,
        );

        // Start the server and wait for it to be ready
        const { finished } = await server.startNonBlocking();

        // Update status to running
        await registry.updateStatus(workspaceEntry.id, WSStatus.RUNNING);

        console.log(
          `✓ Workspace '${workspaceEntry.name}' (${workspaceEntry.id}) is running on http://${hostname}:${actualPort}`,
        );
        console.log("Press Ctrl+C to stop the server.");

        // Now wait for the server to finish
        await finished;
      } catch (err) {
        console.error(
          "Failed to start server:",
          err instanceof Error ? err.message : String(err),
        );

        // Try to update status to crashed if we have a registry entry
        try {
          const registry = getWorkspaceRegistry();
          const entry = await registry.getCurrentWorkspace();
          if (entry) {
            await registry.updateStatus(entry.id, WSStatus.CRASHED);
          }
        } catch {
          // Ignore registry errors during error handling
        }

        Deno.exit(1);
      }
    };

    startServer();
  }, [exit]);

  // Show initial loading state briefly before exiting Ink
  return <Text color="yellow">Starting workspace server...</Text>;
}
