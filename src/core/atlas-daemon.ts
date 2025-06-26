import { Hono } from "hono";
import { cors } from "hono/cors";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { AtlasTelemetry } from "../utils/telemetry.ts";
import { AtlasLogger } from "../utils/logger.ts";
import { getWorkspaceManager, type WorkspaceCreateConfig } from "./workspace-manager.ts";
import { WorkspaceStatus } from "./workspace-registry-types.ts";
import { Workspace } from "./workspace.ts";
import { ConfigLoader } from "./config-loader.ts";
import { WorkspaceMemberRole } from "../types/core.ts";

export interface AtlasDaemonOptions {
  port?: number;
  hostname?: string;
  cors?: string | string[];
  maxConcurrentWorkspaces?: number;
  idleTimeoutMs?: number;
}

/**
 * AtlasDaemon - Single daemon managing multiple workspaces with on-demand runtime creation
 * Replaces the per-workspace WorkspaceServer architecture
 */
export class AtlasDaemon {
  private app: Hono;
  private options: AtlasDaemonOptions;
  private runtimes: Map<string, WorkspaceRuntime> = new Map();
  private idleTimeouts: Map<string, number> = new Map();
  private startTime = Date.now();
  private isShuttingDown = false;
  private server: any = null;
  private signalHandlers: Array<{ signal: Deno.Signal; handler: () => void }> = [];

  constructor(options: AtlasDaemonOptions = {}) {
    this.options = {
      maxConcurrentWorkspaces: 10,
      idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
      ...options,
    };
    this.app = new Hono();
    this.setupRoutes();
    this.setupSignalHandlers();
  }

  private setupRoutes() {
    // Setup CORS if configured
    if (this.options.cors) {
      this.app.use(
        "*",
        cors({
          origin: this.options.cors,
          credentials: true,
        }),
      );
    }

    // Daemon health check
    this.app.get("/health", (c) => {
      return c.json({
        status: "healthy",
        daemon: true,
        activeWorkspaces: this.runtimes.size,
        uptime: Date.now() - this.startTime,
        timestamp: new Date().toISOString(),
        version: {
          deno: Deno.version.deno,
          v8: Deno.version.v8,
          typescript: Deno.version.typescript,
        },
      });
    });

    // List all registered workspaces
    this.app.get("/api/workspaces", async (c) => {
      try {
        const manager = getWorkspaceManager();
        const workspaces = await manager.listWorkspaces();
        return c.json(workspaces);
      } catch (error) {
        return c.json({
          error: `Failed to list workspaces: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Get specific workspace info
    this.app.get("/api/workspaces/:workspaceId", async (c) => {
      const workspaceId = c.req.param("workspaceId");

      try {
        const manager = getWorkspaceManager();
        const workspace = await manager.describeWorkspace(workspaceId);
        return c.json(workspace);
      } catch (error) {
        return c.json({
          error: `Failed to get workspace: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Create a new workspace
    this.app.post("/api/workspaces", async (c) => {
      try {
        const body = await c.req.json() as WorkspaceCreateConfig;
        const manager = getWorkspaceManager();
        const result = await manager.createWorkspace(body);
        return c.json(result, 201);
      } catch (error) {
        return c.json({
          error: `Failed to create workspace: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Delete a workspace
    this.app.delete("/api/workspaces/:workspaceId", async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const force = c.req.query("force") === "true";

      try {
        const manager = getWorkspaceManager();
        await manager.deleteWorkspace(workspaceId, force);
        return c.json({ message: `Workspace ${workspaceId} deleted` });
      } catch (error) {
        return c.json({
          error: `Failed to delete workspace: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Refresh workspace config cache
    this.app.post("/api/workspaces/:workspaceId/refresh-config", async (c) => {
      const workspaceId = c.req.param("workspaceId");

      try {
        const manager = getWorkspaceManager();
        await manager.refreshWorkspaceConfig(workspaceId);
        return c.json({ message: `Workspace ${workspaceId} config cache refreshed` });
      } catch (error) {
        return c.json({
          error: `Failed to refresh config: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Trigger signal on specific workspace
    this.app.post("/api/workspaces/:workspaceId/signals/:signalId", async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const signalId = c.req.param("signalId");
      const payload = await c.req.json();

      return await AtlasTelemetry.withServerSpan(
        "POST /api/workspaces/:workspaceId/signals/:signalId",
        async (span) => {
          AtlasTelemetry.addComponentAttributes(span, "signal", {
            id: signalId,
            workspaceId,
            type: "daemon",
          });

          try {
            // Get or create workspace runtime
            const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);

            // Get workspace configuration to find the signal
            const workspace = (runtime as any).workspace;
            const signal = workspace.signals[signalId];

            if (!signal) {
              return c.json({ error: `Signal not found: ${signalId}` }, 404);
            }

            // Process signal asynchronously
            const sessionPromise = runtime.processSignal(signal, payload);

            // Reset idle timeout for this workspace
            this.resetIdleTimeout(workspaceId);

            return c.json({
              message: "Signal accepted for processing",
              status: "processing",
              workspaceId,
              signalId,
            });
          } catch (error) {
            return c.json({
              error: `Failed to process signal: ${
                error instanceof Error ? error.message : String(error)
              }`,
            }, 500);
          }
        },
        {
          "http.method": "POST",
          "http.url": `/api/workspaces/${workspaceId}/signals/${signalId}`,
          "signal.id": signalId,
          "workspace.id": workspaceId,
          "payload.size": JSON.stringify(payload).length,
        },
      );
    });

    // List sessions across all workspaces
    this.app.get("/api/sessions", (c) => {
      const allSessions: any[] = [];

      for (const [workspaceId, runtime] of this.runtimes) {
        const sessions = runtime.getSessions().map((session) => ({
          id: session.id,
          workspaceId,
          status: session.status,
          summary: session.summarize(),
          signal: session.signals?.triggers?.[0]?.id || "unknown",
          startTime: (session as any)._startTime,
          endTime: (session as any)._endTime,
          progress: session.progress(),
        }));
        allSessions.push(...sessions);
      }

      return c.json(allSessions);
    });

    // Get specific session from any workspace
    this.app.get("/api/sessions/:sessionId", (c) => {
      const sessionId = c.req.param("sessionId");

      // Find session across all runtimes
      for (const [workspaceId, runtime] of this.runtimes) {
        const session = runtime.getSession(sessionId);
        if (session) {
          const sessionData: any = {
            id: session.id,
            workspaceId,
            status: session.status,
            progress: session.progress(),
            summary: session.summarize(),
            signal: session.signals?.triggers?.[0]?.id || "unknown",
            startTime: (session as any)._startTime,
            endTime: (session as any)._endTime,
            artifacts: session.getArtifacts(),
          };

          // Get execution results if available
          const artifacts = session.getArtifacts();
          const resultsArtifact = artifacts.find((a) => a.type === "execution_results");
          if (resultsArtifact?.data) {
            sessionData.results = resultsArtifact.data.results;
            sessionData.summary = resultsArtifact.data.summary;
          }

          return c.json(sessionData);
        }
      }

      return c.json({ error: `Session not found: ${sessionId}` }, 404);
    });

    // Cancel session from any workspace
    this.app.delete("/api/sessions/:sessionId", async (c) => {
      const sessionId = c.req.param("sessionId");

      // Find session across all runtimes
      for (const [workspaceId, runtime] of this.runtimes) {
        const session = runtime.getSession(sessionId);
        if (session) {
          try {
            await runtime.cancelSession(sessionId);
            return c.json({ message: `Session ${sessionId} cancelled`, workspaceId });
          } catch (error) {
            return c.json({
              error: `Failed to cancel session: ${
                error instanceof Error ? error.message : String(error)
              }`,
            }, 500);
          }
        }
      }

      return c.json({ error: `Session not found: ${sessionId}` }, 404);
    });

    // List agents in a workspace
    this.app.get("/api/workspaces/:workspaceId/agents", async (c) => {
      const workspaceId = c.req.param("workspaceId");

      try {
        // Get workspace runtime to access agent configuration
        const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);
        const agents = await runtime.listAgents();
        return c.json(agents);
      } catch (error) {
        return c.json({
          error: `Failed to list agents: ${error instanceof Error ? error.message : String(error)}`,
        }, 500);
      }
    });

    // Describe specific agent in a workspace
    this.app.get("/api/workspaces/:workspaceId/agents/:agentId", async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const agentId = c.req.param("agentId");

      try {
        const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);
        const agent = await runtime.describeAgent(agentId);
        return c.json(agent);
      } catch (error) {
        return c.json({
          error: `Failed to describe agent: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // List signals in a workspace
    this.app.get("/api/workspaces/:workspaceId/signals", async (c) => {
      const workspaceId = c.req.param("workspaceId");

      try {
        const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);
        const signals = await runtime.listSignals();
        return c.json(signals);
      } catch (error) {
        return c.json({
          error: `Failed to list signals: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // List jobs in a workspace
    this.app.get("/api/workspaces/:workspaceId/jobs", async (c) => {
      const workspaceId = c.req.param("workspaceId");

      try {
        const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);
        const jobs = await runtime.listJobs();
        return c.json(jobs);
      } catch (error) {
        return c.json({
          error: `Failed to list jobs: ${error instanceof Error ? error.message : String(error)}`,
        }, 500);
      }
    });

    // Get workspace sessions
    this.app.get("/api/workspaces/:workspaceId/sessions", async (c) => {
      const workspaceId = c.req.param("workspaceId");

      try {
        const runtime = this.runtimes.get(workspaceId);
        if (!runtime) {
          return c.json([]); // No runtime = no sessions
        }

        const sessions = await runtime.listSessions();
        return c.json(sessions);
      } catch (error) {
        return c.json({
          error: `Failed to list workspace sessions: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Daemon management routes
    this.app.get("/api/daemon/status", (c) => {
      return c.json({
        status: "running",
        activeWorkspaces: this.runtimes.size,
        uptime: Date.now() - this.startTime,
        memoryUsage: Deno.memoryUsage(),
        workspaces: Array.from(this.runtimes.keys()),
        configuration: {
          maxConcurrentWorkspaces: this.options.maxConcurrentWorkspaces,
          idleTimeoutMs: this.options.idleTimeoutMs,
        },
      });
    });

    this.app.post("/api/daemon/shutdown", async (c) => {
      // Graceful shutdown endpoint
      AtlasLogger.getInstance().info("Daemon shutdown requested via API");

      // Don't await - respond immediately then shutdown
      setTimeout(() => this.shutdown(), 100);

      return c.json({ message: "Daemon shutdown initiated" });
    });
  }

  /**
   * Get or create a workspace runtime on-demand
   */
  private async getOrCreateWorkspaceRuntime(workspaceId: string): Promise<WorkspaceRuntime> {
    const logger = AtlasLogger.getInstance();

    try {
      logger.debug(`getOrCreateWorkspaceRuntime called for workspace: ${workspaceId}`);

      // Check if runtime already exists
      let runtime = this.runtimes.get(workspaceId);
      if (runtime) {
        logger.debug(`Found existing runtime for workspace: ${workspaceId}`);
        return runtime;
      }

      // Check concurrent workspace limit
      if (this.runtimes.size >= this.options.maxConcurrentWorkspaces!) {
        logger.warn(
          `Maximum concurrent workspaces reached (${this.options.maxConcurrentWorkspaces}), attempting eviction`,
        );
        // Find the oldest idle workspace to evict
        const oldestWorkspace = this.findOldestIdleWorkspace();
        if (oldestWorkspace) {
          logger.info(`Evicting oldest idle workspace: ${oldestWorkspace}`);
          await this.destroyWorkspaceRuntime(oldestWorkspace);
        } else {
          const error =
            `Maximum concurrent workspaces reached (${this.options.maxConcurrentWorkspaces})`;
          logger.error(error);
          throw new Error(error);
        }
      }

      // Find workspace in registry (manager already initialized at daemon startup)
      logger.debug(`Looking up workspace in registry: ${workspaceId}`);
      const manager = getWorkspaceManager();

      const workspace = await manager.findById(workspaceId) ||
        await manager.findByName(workspaceId);

      if (!workspace) {
        const error = `Workspace not found: ${workspaceId}`;
        logger.error(error);
        throw new Error(error);
      }

      logger.info(
        `Creating runtime for workspace: ${workspace.name} (${workspace.id}) at path: ${workspace.path}`,
      );

      // Validate workspace path exists
      try {
        const stat = await Deno.stat(workspace.path);
        if (!stat.isDirectory) {
          throw new Error(`Workspace path is not a directory: ${workspace.path}`);
        }
      } catch (error) {
        logger.error(`Failed to access workspace path: ${workspace.path}`, error);
        throw new Error(`Workspace path does not exist: ${workspace.path}`);
      }

      // Use cached configuration from workspace registry
      let mergedConfig: any;

      if (workspace.config) {
        // Use pre-cached configuration (preferred - no I/O at signal time)
        mergedConfig = workspace.config;
        logger.debug(`Using cached workspace configuration`, {
          workspaceId: workspace.id,
          configHash: workspace.configHash?.substring(0, 8) + "...",
        });
      } else {
        // Fallback: load configuration (should only happen for legacy registrations)
        logger.warn(`No cached config found, falling back to live loading`, {
          workspaceId: workspace.id,
          path: workspace.path,
        });
        const configLoader = new ConfigLoader(workspace.path);
        mergedConfig = await configLoader.load();
        logger.debug(`Configuration loaded from disk as fallback`);
      }

      logger.debug(`Creating Workspace object from config...`);
      const workspaceObj = Workspace.fromConfig(mergedConfig.workspace, {
        id: mergedConfig.workspace.workspace.id,
        name: mergedConfig.workspace.workspace.name,
        role: WorkspaceMemberRole.OWNER,
      });
      logger.debug(`Workspace object created`);

      logger.debug(`Creating WorkspaceRuntime...`);
      runtime = new WorkspaceRuntime(workspaceObj, mergedConfig, {
        lazy: true, // Always use lazy loading in daemon mode
        workspacePath: workspace.path, // Pass workspace path for daemon mode
      });
      logger.debug(`WorkspaceRuntime created successfully`);

      this.runtimes.set(workspace.id, runtime);
      logger.debug(`Runtime stored in daemon registry`);

      // Register runtime with WorkspaceManager
      manager.registerRuntime(workspace.id, runtime, workspaceObj, {
        name: workspace.name,
        description: workspace.metadata?.description,
      });
      logger.debug(`Runtime registered with WorkspaceManager`);

      // Set idle timeout
      this.resetIdleTimeout(workspace.id);
      logger.debug(`Idle timeout set for workspace: ${workspace.id}`);

      logger.info(
        `Runtime created successfully for workspace: ${workspace.name} (${workspace.id})`,
      );

      return runtime;
    } catch (error) {
      logger.error(`Failed to create workspace runtime for ${workspaceId}:`, error);
      throw error;
    }
  }

  /**
   * Find the oldest idle workspace for eviction
   */
  private findOldestIdleWorkspace(): string | null {
    let oldestTime = Date.now();
    let oldestWorkspace: string | null = null;

    for (const [workspaceId, runtime] of this.runtimes) {
      const sessions = runtime.getSessions();
      const hasActiveSessions = sessions.some((s) =>
        s.status === "running" || s.status === "starting"
      );

      if (!hasActiveSessions) {
        // Check when this workspace was last active
        const lastActivityTime = this.getLastActivityTime(workspaceId);
        if (lastActivityTime < oldestTime) {
          oldestTime = lastActivityTime;
          oldestWorkspace = workspaceId;
        }
      }
    }

    return oldestWorkspace;
  }

  /**
   * Get last activity time for a workspace
   */
  private getLastActivityTime(workspaceId: string): number {
    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) return 0;

    const sessions = runtime.getSessions();
    if (sessions.length === 0) return 0;

    // Find the most recent session activity
    return Math.max(...sessions.map((s) => (s as any)._startTime || 0));
  }

  /**
   * Reset idle timeout for a workspace
   */
  private resetIdleTimeout(workspaceId: string) {
    // Clear existing timeout
    const existingTimeout = this.idleTimeouts.get(workspaceId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set new timeout
    const timeoutId = setTimeout(() => {
      this.checkAndDestroyIdleWorkspace(workspaceId);
    }, this.options.idleTimeoutMs!);

    this.idleTimeouts.set(workspaceId, timeoutId);
  }

  /**
   * Check if workspace is idle and destroy it
   */
  private async checkAndDestroyIdleWorkspace(workspaceId: string) {
    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) return;

    const sessions = runtime.getSessions();
    const hasActiveSessions = sessions.some((s) =>
      s.status === "running" || s.status === "starting"
    );

    if (!hasActiveSessions) {
      AtlasLogger.getInstance().info(`Destroying idle workspace runtime: ${workspaceId}`);
      await this.destroyWorkspaceRuntime(workspaceId);
    } else {
      // Still has active sessions, reset timeout
      this.resetIdleTimeout(workspaceId);
    }
  }

  /**
   * Destroy a workspace runtime
   */
  private async destroyWorkspaceRuntime(workspaceId: string) {
    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) return;

    try {
      await runtime.shutdown();
    } catch (error) {
      AtlasLogger.getInstance().error(
        `Error shutting down workspace runtime ${workspaceId}:`,
        error,
      );
    }

    this.runtimes.delete(workspaceId);

    // Unregister runtime from WorkspaceManager
    const manager = getWorkspaceManager();
    manager.unregisterRuntime(workspaceId);

    // Clear idle timeout
    const timeoutId = this.idleTimeouts.get(workspaceId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.idleTimeouts.delete(workspaceId);
    }

    AtlasLogger.getInstance().info(`Workspace runtime destroyed: ${workspaceId}`);
  }

  private setupSignalHandlers() {
    const daemonId = crypto.randomUUID().slice(0, 8);

    const handleShutdown = async (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      AtlasLogger.getInstance().info(
        `Daemon [${daemonId}] received ${signal}, shutting down gracefully`,
      );
      await this.shutdown();
      Deno.exit(0);
    };

    const sigtermHandler = () => handleShutdown("SIGTERM");
    const sigintHandler = () => handleShutdown("SIGINT");

    Deno.addSignalListener("SIGTERM", sigtermHandler);
    Deno.addSignalListener("SIGINT", sigintHandler);

    this.signalHandlers.push({ signal: "SIGTERM", handler: sigtermHandler });
    this.signalHandlers.push({ signal: "SIGINT", handler: sigintHandler });
  }

  async start() {
    const port = this.options.port ?? 8080;
    const hostname = this.options.hostname || "localhost";

    // Initialize WorkspaceManager singleton at daemon startup (with auto-import)
    AtlasLogger.getInstance().info("Initializing WorkspaceManager...");
    const manager = getWorkspaceManager();
    await manager.initialize();

    AtlasLogger.getInstance().info(`Starting Atlas daemon on http://${hostname}:${port}`, {
      hostname,
      port,
      maxConcurrentWorkspaces: this.options.maxConcurrentWorkspaces,
      idleTimeoutMs: this.options.idleTimeoutMs,
    });

    this.server = Deno.serve({
      port,
      hostname,
      onListen: ({ hostname, port }) => {
        AtlasLogger.getInstance().info(`Atlas daemon running on http://${hostname}:${port}`, {
          hostname,
          port,
        });
      },
    }, this.app.fetch);

    await this.server.finished;
  }

  async startNonBlocking(): Promise<{ finished: Promise<void> }> {
    const port = this.options.port ?? 8080;
    const hostname = this.options.hostname || "localhost";

    // Initialize WorkspaceManager singleton at daemon startup (with auto-import)
    AtlasLogger.getInstance().info("Initializing WorkspaceManager...");
    const manager = getWorkspaceManager();
    await manager.initialize();

    AtlasLogger.getInstance().info(`Starting Atlas daemon on http://${hostname}:${port}`, {
      hostname,
      port,
      maxConcurrentWorkspaces: this.options.maxConcurrentWorkspaces,
      idleTimeoutMs: this.options.idleTimeoutMs,
    });

    let serverReady: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      serverReady = resolve;
    });

    this.server = Deno.serve({
      port,
      hostname,
      onListen: ({ hostname, port }) => {
        AtlasLogger.getInstance().info(`Atlas daemon running on http://${hostname}:${port}`, {
          hostname,
          port,
        });
        serverReady();
      },
    }, this.app.fetch);

    await readyPromise;
    return { finished: this.server.finished };
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    AtlasLogger.getInstance().info("Shutting down Atlas daemon...");

    // Remove signal handlers
    for (const { signal, handler } of this.signalHandlers) {
      Deno.removeSignalListener(signal, handler);
    }
    this.signalHandlers = [];

    // Shutdown all workspace runtimes
    const shutdownPromises = Array.from(this.runtimes.keys()).map((workspaceId) =>
      this.destroyWorkspaceRuntime(workspaceId)
    );
    await Promise.all(shutdownPromises);

    // Clear all idle timeouts
    for (const timeoutId of this.idleTimeouts.values()) {
      clearTimeout(timeoutId);
    }
    this.idleTimeouts.clear();

    // Shutdown HTTP server
    if (this.server && this.server.shutdown) {
      await this.server.shutdown();
    }

    AtlasLogger.getInstance().info("Atlas daemon shutdown complete");
  }

  // Status getters
  getActiveWorkspaces(): string[] {
    return Array.from(this.runtimes.keys());
  }

  getWorkspaceRuntime(workspaceId: string): WorkspaceRuntime | undefined {
    return this.runtimes.get(workspaceId);
  }

  getStatus() {
    return {
      activeWorkspaces: this.runtimes.size,
      uptime: Date.now() - this.startTime,
      configuration: {
        maxConcurrentWorkspaces: this.options.maxConcurrentWorkspaces,
        idleTimeoutMs: this.options.idleTimeoutMs,
      },
    };
  }
}
