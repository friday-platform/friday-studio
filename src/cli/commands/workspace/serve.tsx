import { load } from "@std/dotenv";
import { Text, useApp } from "ink";
import { useEffect, useState } from "react";
import { ConfigLoader } from "../../../core/config-loader.ts";
import { WorkspaceStatus as WSStatus } from "../../../core/workspace-registry-types.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { WorkspaceCommandProps } from "./utils.ts";

export function WorkspaceServeCommand({ flags }: WorkspaceCommandProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>("");
  const port = flags.port || 8080;

  useEffect(() => {
    handleServe();
  }, []);

  function handleServe() {
    setStatus("ready");
    // The actual server starting will be handled by the ServingComponent
  }

  if (status === "loading") {
    return <Text>Loading...</Text>;
  }

  if (status === "error") {
    return <Text color="red">Error: {error}</Text>;
  }

  return <ServingComponent port={port} flags={flags} />;
}

function ServingComponent({ port, flags }: { port: number; flags: any }) {
  const { exit } = useApp();

  useEffect(() => {
    const startServer = async () => {
      try {
        console.log("Starting workspace server...");
        exit();

        await new Promise((resolve) => setTimeout(resolve, 100));
        await load({ export: true });

        const configLoader = new ConfigLoader();
        const mergedConfig = await configLoader.load();

        // Register or update workspace in registry
        const registry = getWorkspaceRegistry();
        const workspaceEntry = await registry.findOrRegister(Deno.cwd(), {
          name: mergedConfig.workspace.workspace.name,
          description: mergedConfig.workspace.workspace.description,
        });

        // Update status to starting
        await registry.updateStatus(
          workspaceEntry.id,
          WSStatus.STARTING,
          {
            port: port || mergedConfig.atlas.runtime?.server?.port || 8080,
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

        const runtime = new WorkspaceRuntime(workspace, mergedConfig, {
          lazy: flags.lazy || false,
        });

        const server = new WorkspaceServer(runtime, {
          port: port || mergedConfig.atlas.runtime?.server?.port || 8080,
          hostname: mergedConfig.atlas.runtime?.server?.host || "localhost",
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
          Deno.exit(0);
        };

        Deno.addSignalListener("SIGINT", shutdown);
        Deno.addSignalListener("SIGTERM", shutdown);

        await server.start();

        // Update status to running
        await registry.updateStatus(workspaceEntry.id, WSStatus.RUNNING);

        console.log(
          `Workspace '${workspaceEntry.name}' (${workspaceEntry.id}) is running on port ${port}`,
        );
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
