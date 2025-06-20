import { getWorkspaceRegistry } from "./workspace-registry.ts";
import { findAvailablePort } from "../utils/port-finder.ts";
import { getAtlasHome } from "../utils/paths.ts";
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { logger } from "../utils/logger.ts";

export interface ProcessStartOptions {
  port?: number;
  env?: Record<string, string>;
  logLevel?: string;
  additionalFlags?: string[];
}

export class WorkspaceProcessManager {
  private registry = getWorkspaceRegistry();

  async startDetached(
    workspaceIdOrPath: string,
    options: ProcessStartOptions = {},
  ): Promise<number> {
    logger.info("Starting detached workspace", { workspaceIdOrPath, options });

    // Find or register workspace
    let workspace = await this.registry.findById(workspaceIdOrPath);
    if (!workspace) {
      workspace = await this.registry.findByName(workspaceIdOrPath);
    }
    if (!workspace) {
      // Try as path
      logger.debug("Workspace not found by ID/name, trying as path");
      workspace = await this.registry.findOrRegister(workspaceIdOrPath);
    }

    // Check if already running
    if (workspace.status === "running" || workspace.status === "starting") {
      throw new Error(`Workspace ${workspace.name} is already running`);
    }

    // Find available port
    const port = options.port || await findAvailablePort();
    logger.debug("Selected port for workspace", { port });

    // Prepare log file
    const logDir = join(getAtlasHome(), "logs", "workspaces");
    await ensureDir(logDir);
    const logFile = join(logDir, `${workspace.id}.log`);
    logger.debug("Log file path", { logFile });

    // Build command
    const args = [
      "run",
      "--allow-all",
      "--unstable-broadcast-channel",
      "--unstable-worker-options",
      "src/cli.tsx",
      "workspace",
      "serve",
      workspace.id,
      "--internalDetached",
      "--port",
      port.toString(),
      "--logFile",
      logFile,
      "--workspaceId",
      workspace.id,
    ];

    if (options.logLevel) {
      args.push("--log-level", options.logLevel);
    }

    if (options.additionalFlags) {
      args.push(...options.additionalFlags);
    }

    logger.debug("Spawning detached process", {
      command: Deno.execPath(),
      args: [...args.slice(0, 8), "..."], // Log first few args
    });

    // Use our custom script for proper detachment
    const scriptPath = join(
      dirname(import.meta.url.replace("file://", "")),
      "..",
      "utils",
      "start-detached.sh",
    );

    const cmd = new Deno.Command(scriptPath, {
      args: [Deno.execPath(), ...args],
      stdout: "piped", // We need to capture the PID
      stderr: "null",
      cwd: Deno.cwd(),
      env: {
        ...Deno.env.toObject(),
        ATLAS_WORKSPACE_ID: workspace.id,
        ATLAS_WORKSPACE_NAME: workspace.name,
        ATLAS_WORKSPACE_PATH: workspace.path,
        ATLAS_DETACHED: "true",
        ATLAS_LOG_FILE: logFile,
        ...options.env,
      },
    });

    const output = await cmd.output();

    // Parse the PID from the script output
    const pidStr = new TextDecoder().decode(output.stdout).trim();
    const pid = parseInt(pidStr, 10);

    if (isNaN(pid)) {
      throw new Error(`Failed to get PID from detached script: ${pidStr}`);
    }

    // Update registry immediately
    await this.registry.updateStatus(workspace.id, "starting", {
      pid,
      port,
      startedAt: new Date().toISOString(),
    });

    // Script handles detachment

    logger.info("Detached process spawned", {
      workspaceId: workspace.id,
      pid,
      port,
    });

    // Wait briefly for process to start
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Verify process started
    const isRunning = await this.isProcessRunning(pid);
    logger.debug("Process running check", { pid, isRunning });

    if (!isRunning) {
      // Process failed to start
      logger.error("Process failed to start", { pid });

      await this.registry.updateStatus(workspace.id, "crashed");
      throw new Error("Failed to start workspace process");
    }

    return pid;
  }

  async stop(workspaceId: string, force = false): Promise<void> {
    logger.info("Stopping workspace", { workspaceId, force });

    const workspace = await this.registry.findById(workspaceId) ||
      await this.registry.findByName(workspaceId);

    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    if (workspace.status !== "running" || !workspace.pid) {
      throw new Error(`Workspace ${workspace.name} is not running`);
    }

    // Update status
    await this.registry.updateStatus(workspace.id, "stopping");

    try {
      if (force) {
        // Force kill
        logger.warn("Force killing workspace process", { pid: workspace.pid });
        Deno.kill(workspace.pid, "SIGKILL");
      } else {
        // Graceful shutdown
        logger.debug("Sending SIGTERM to workspace process", { pid: workspace.pid });
        Deno.kill(workspace.pid, "SIGTERM");

        // Wait for process to exit (max 30 seconds)
        const timeout = 30000;
        const start = Date.now();

        while (await this.isProcessRunning(workspace.pid)) {
          if (Date.now() - start > timeout) {
            // Timeout - force kill
            logger.warn("Graceful shutdown timeout, force killing", { pid: workspace.pid });
            Deno.kill(workspace.pid, "SIGKILL");
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      await this.registry.updateStatus(workspace.id, "stopped", {
        pid: undefined,
        port: undefined,
        stoppedAt: new Date().toISOString(),
      });

      logger.info("Workspace stopped successfully", { workspaceId: workspace.id });
    } catch (error) {
      logger.error("Error stopping workspace", { error: error.message });
      await this.registry.updateStatus(workspace.id, "crashed");
      throw error;
    }
  }

  async restart(workspaceId: string): Promise<number> {
    logger.info("Restarting workspace", { workspaceId });

    const workspace = await this.registry.findById(workspaceId) ||
      await this.registry.findByName(workspaceId);

    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    // Stop if running
    if (workspace.status === "running" && workspace.pid) {
      await this.stop(workspace.id);
    }

    // Start again with same port if available
    return await this.startDetached(workspace.id, {
      port: workspace.port,
    });
  }

  async isProcessRunning(pid: number): Promise<boolean> {
    try {
      // Signal 0 would be ideal, but Deno doesn't support it
      // Instead, we can try to get process info
      const proc = new Deno.Command("ps", {
        args: ["-p", pid.toString()],
        stdout: "piped",
        stderr: "piped",
      });

      const output = await proc.output();
      return output.success;
    } catch {
      return false;
    }
  }

  async waitForReady(
    workspaceId: string,
    timeout = 30000,
  ): Promise<boolean> {
    logger.debug("Waiting for workspace to be ready", { workspaceId, timeout });

    const workspace = await this.registry.findById(workspaceId);
    if (!workspace || !workspace.port) {
      logger.warn("Workspace not found or no port assigned", { workspaceId });
      return false;
    }

    const start = Date.now();

    while (Date.now() - start < timeout) {
      try {
        const response = await fetch(
          `http://localhost:${workspace.port}/api/health`,
        );
        if (response.ok) {
          await this.registry.updateStatus(workspace.id, "running");
          logger.info("Workspace is ready", { workspaceId });
          return true;
        }
      } catch {
        // Not ready yet
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    logger.warn("Workspace failed to become ready", { workspaceId });
    return false;
  }

  async checkHttpHealth(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://localhost:${port}/api/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

// Export singleton instance
export const workspaceProcessManager = new WorkspaceProcessManager();
