import { ConfigLoader, type SupervisorDefaults, supervisorDefaultsWrapped } from "@atlas/config";
import {
  CronManager,
  type CronTimerConfig,
  type CronTimerSignalData,
  type WorkspaceWakeupCallback,
} from "@atlas/cron";
import { PlatformMCPServer } from "@atlas/mcp-server";
import { FilesystemConfigAdapter, FilesystemWorkspaceCreationAdapter } from "@atlas/storage";
import { getAtlasDaemonUrl } from "@atlas/atlasd";
import { StreamableHTTPTransport } from "@hono/mcp";
import { dirname, join } from "@std/path";
import { cors } from "hono/cors";
import { AgentRegistry, AtlasAgentsMCPServer, GlobalMCPServerPool } from "@atlas/core";
import type { Context, Next } from "hono";
import { DaemonCapabilityRegistry } from "../../../src/core/daemon-capabilities.ts";
import type { LibrarySearchQuery } from "../../../src/core/library/types.ts";
import {
  createKVStorage,
  createLibraryStorage,
  createRegistryStorage,
  StorageConfigs,
} from "../../../src/core/storage/index.ts";
import type { LibraryStorageAdapter } from "../../../src/core/storage/library-storage-adapter.ts";
import { WorkspaceRuntime } from "../../../src/core/workspace-runtime.ts";
import { Workspace } from "../../../src/core/workspace.ts";
import { WorkspaceMemberRole } from "../../../src/types/core.ts";
import { logger } from "@atlas/logger";
import { WorkspaceSessionStatus } from "@atlas/core";
import { healthRoutes } from "../routes/health.ts";
import { createOpenAPIHandlers } from "../routes/openapi.ts";
import { workspacesRoutes } from "../routes/workspaces/index.ts";
import { conversationStorageRoutes } from "../routes/conversation-storage/index.ts";
import { todoStorageRoutes } from "../routes/todo-storage/index.ts";
import { signalRoutes } from "../routes/signals/index.ts";
import { userRoutes } from "../routes/user/index.ts";
import { agents as agentsRoutes } from "../routes/agents/index.ts";
import { type AppContext, createApp } from "./factory.ts";
import { WorkspaceManager } from "@atlas/workspace";
import { parse } from "@std/yaml";
import { WorkspaceFileWatcher } from "./workspace-file-watcher.ts";

export interface AtlasDaemonOptions {
  port?: number;
  hostname?: string;
  cors?: string | string[];
  maxConcurrentWorkspaces?: number;
  idleTimeoutMs?: number;
  sseHeartbeatIntervalMs?: number;
  sseConnectionTimeoutMs?: number;
}

/**
 * AtlasDaemon - Single daemon managing multiple workspaces with on-demand runtime creation
 * Replaces the per-workspace WorkspaceServer architecture
 */
export class AtlasDaemon implements AppContext {
  private app: ReturnType<typeof createApp>;
  private options: AtlasDaemonOptions;
  // Public properties for AppContext interface
  public runtimes: Map<string, WorkspaceRuntime> = new Map();
  public startTime = Date.now();
  public sseClients: Map<
    string,
    Array<{
      controller: ReadableStreamDefaultController<Uint8Array>;
      connectedAt: number;
      lastActivity: number;
    }>
  > = new Map();
  // Private properties
  private idleTimeouts: Map<string, number> = new Map();
  private isShuttingDown = false;
  private server: Deno.HttpServer | null = null;
  private signalHandlers: Array<{ signal: Deno.Signal; handler: () => void }> = [];
  private isInitialized = false;
  private supervisorDefaults: SupervisorDefaults | null = null;
  private libraryStorage: LibraryStorageAdapter | null = null;
  private workspaceCreationAdapter: FilesystemWorkspaceCreationAdapter | null = null;
  private cronManager: CronManager | null = null;
  private mcpServer: PlatformMCPServer | null = null;
  private mcpServerPool: GlobalMCPServerPool | null = null;
  private workspaceManager: WorkspaceManager | null = null;
  private sseHealthCheckInterval: number | null = null;
  private agentSessionCleanupInterval: number | null = null;
  // Store per-session MCP servers and transports
  private agentSessions = new Map<
    string,
    {
      server: AtlasAgentsMCPServer;
      transport: StreamableHTTPTransport;
      createdAt: number;
      lastUsed: number;
    }
  >();
  // Track active SSE connections per session
  private agentSSEConnections = new Set<string>();
  // Single shared agent registry
  private agentRegistry: AgentRegistry | null = null;
  // Session limits
  private readonly MAX_AGENT_SESSIONS = 100;
  private readonly AGENT_SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
  // Store the actual port after server starts
  #port: number | undefined;
  private fileWatcher: WorkspaceFileWatcher | null = null;

  constructor(options: AtlasDaemonOptions = {}) {
    this.options = {
      maxConcurrentWorkspaces: 10,
      idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
      sseHeartbeatIntervalMs: 30 * 1000, // 30 seconds
      sseConnectionTimeoutMs: 5 * 60 * 1000, // 5 minutes
      ...options,
    };
    this.app = createApp(this);
    this.setupRoutes();
    this.setupSignalHandlers();
  }

  get port(): number {
    if (!this.#port) {
      throw new Error("Port not initialized. Call start() first.");
    }
    return this.#port;
  }

  public getWorkspaceManager(): WorkspaceManager {
    if (!this.workspaceManager) {
      throw new Error(
        "WorkspaceManager not initialized. Call initialize() first.",
      );
    }
    return this.workspaceManager;
  }

  /**
   * Initialize the daemon - load supervisor defaults, initialize WorkspaceManager, etc.
   * Must be called before start()
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    logger.info("Initializing Atlas daemon...");

    // Load supervisor defaults once at startup
    this.loadSupervisorDefaults();

    // Initialize WorkspaceManager
    logger.info("Initializing WorkspaceManager...");
    const registry = await createRegistryStorage(StorageConfigs.defaultKV());
    this.workspaceManager = new WorkspaceManager(registry);
    await this.workspaceManager.initialize();

    // Register cron signal hook for automatic timer registration
    this.workspaceManager.addRegistrationHook(async (entry) => {
      // Skip system workspaces as they don't have cron signals
      if (!entry.metadata?.system) {
        logger.debug("Executing cron registration hook for workspace", {
          workspaceId: entry.id,
          workspacePath: entry.path,
        });
        await this.registerWorkspaceCronSignals(entry.id, entry.path);
      }
    });

    // System workspaces are now registered automatically during manager.initialize()

    // Initialize LibraryStorage with hybrid storage
    logger.info("Initializing LibraryStorage...");
    this.libraryStorage = await createLibraryStorage(
      StorageConfigs.defaultKV(),
      {
        // Use XDG-compliant default location, but allow environment override
        contentDir: Deno.env.get("ATLAS_LIBRARY_DIR"),
        organizeByType: true,
        organizeByDate: true,
      },
    );

    // Initialize daemon-level capabilities
    logger.info("Initializing daemon capabilities...");
    DaemonCapabilityRegistry.setDaemonInstance(this);
    DaemonCapabilityRegistry.initialize();
    // Initialize workspace creation adapter
    logger.info("Initializing workspace creation adapter...");
    this.workspaceCreationAdapter = new FilesystemWorkspaceCreationAdapter();

    // Initialize CronManager with KV storage
    logger.info("Initializing CronManager...");
    const kvStorageConfig = StorageConfigs.defaultKV();
    const kvStorage = await createKVStorage(kvStorageConfig); // createKVStorage now calls initialize()
    this.cronManager = new CronManager(kvStorage, logger);

    // Initialize Platform MCP Server
    logger.info("Initializing Platform MCP server...");
    const daemonUrl = getAtlasDaemonUrl();
    this.mcpServer = new PlatformMCPServer({
      daemonUrl,
      logger: logger.child({ component: "platform-mcp-server" }),
    });
    logger.info("Platform MCP server initialized");

    // Initialize Global MCP Server Pool
    logger.info("Initializing Global MCP Server Pool...");
    this.mcpServerPool = new GlobalMCPServerPool(logger);

    // Initialize agent registry with bundled agents
    logger.info("Initializing agent registry...");
    const agentRegistry = new AgentRegistry({
      includeSystemAgents: true,
    });
    await agentRegistry.initialize();
    logger.info("Agent registry initialized");
    this.agentRegistry = agentRegistry;
    // Initialize file watcher
    logger.info("Initializing file watcher...");
    this.fileWatcher = new WorkspaceFileWatcher({
      onConfigChange: this.handleWorkspaceConfigChange.bind(this),
      debounceMs: 1000, // Wait 1 second after last change
    });

    // Initialize Platform MCP Server (moved to lazy initialization in getMCPServer)

    // Set up workspace wakeup callback
    const wakeupCallback: WorkspaceWakeupCallback = async (
      workspaceId: string,
      signalId: string,
      signalData: CronTimerSignalData,
    ) => {
      logger.info("CronManager waking up workspace for timer signal", {
        workspaceId,
        signalId,
        timestamp: signalData.timestamp,
      });

      try {
        // Get or create workspace runtime (this will wake up the workspace)
        const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);

        // Process the timer signal using triggerSignal which handles signal creation
        await runtime.triggerSignal(
          signalId,
          { ...signalData.data },
        );

        logger.info("Timer signal processed", { workspaceId, signalId });
      } catch (error) {
        logger.error("Failed to process timer signal", {
          error,
          workspaceId,
          signalId,
        });
      }
    };

    this.cronManager.setWakeupCallback(wakeupCallback);

    // Start CronManager
    await this.cronManager.start();

    // Register cron signals for all existing workspaces
    await this.discoverAndRegisterExistingCronSignals();

    // Start SSE health check interval
    this.startSSEHealthCheck();

    // Start agent session cleanup interval
    this.startAgentSessionCleanup();

    this.isInitialized = true;
    logger.info("Atlas daemon initialized");
  }

  /**
   * Load supervisor defaults (compiled into the application)
   */
  private loadSupervisorDefaults(): void {
    // Use compiled-in defaults - no file I/O needed
    this.supervisorDefaults = supervisorDefaultsWrapped;

    logger.info("Loaded supervisor defaults", {
      source: "compiled",
      version: this.supervisorDefaults.version,
      hasSupervisors: !!this.supervisorDefaults?.supervisors,
    });
  }

  /**
   * Get MCP server instance
   */
  private getMCPServer(): PlatformMCPServer {
    if (!this.mcpServer) {
      throw new Error(
        "Platform MCP server not initialized. Call initialize() first.",
      );
    }
    return this.mcpServer;
  }

  /**
   * Get or create per-session MCP server
   */
  private async getOrCreateAgentSession(sessionId: string): Promise<{
    server: AtlasAgentsMCPServer;
    transport: StreamableHTTPTransport;
  }> {
    const existing = this.agentSessions.get(sessionId);
    if (existing) {
      existing.lastUsed = Date.now();
      return { server: existing.server, transport: existing.transport };
    }

    // Create new session
    logger.info("[Daemon] Creating new agent MCP session", { sessionId });

    // Create transport
    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: () => sessionId,
      onsessioninitialized: (sid) => {
        logger.info("[Daemon] Agent session initialized", { sessionId: sid });
      },
    });

    // Create per-session MCP server
    const server = AtlasAgentsMCPServer.create({
      daemonUrl: getAtlasDaemonUrl(),
      logger: logger,
      agentRegistry: this.agentRegistry!,
      mcpServerPool: this.mcpServerPool!,
      sessionId: sessionId,
      hasActiveSSE: (sid?: string) => {
        const checkId = sid || sessionId;
        return this.agentSSEConnections.has(checkId);
      },
    });

    // Start the server and connect transport
    await server.start();
    await server.getServer().connect(transport);

    // Store session
    this.agentSessions.set(sessionId, {
      server,
      transport,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    });

    // Set up cleanup
    transport.onclose = () => {
      logger.info("[Daemon] Agent session closed", { sessionId });
      this.cleanupAgentSession(sessionId);
    };

    return { server, transport };
  }

  /**
   * Clean up agent session
   */
  private async cleanupAgentSession(sessionId: string): Promise<void> {
    const session = this.agentSessions.get(sessionId);
    if (session) {
      await session.server.stop();
      this.agentSessions.delete(sessionId);
      this.agentSSEConnections.delete(sessionId);
      logger.info("[Daemon] Agent session cleaned up", { sessionId });
    }
  }

  /**
   * Initialize the daemon - load supervisor defaults, initialize WorkspaceManager, etc.
   * Must be called before start()
   */
  // System workspace methods removed - using standard workspace pattern

  // setupWorkspaceRoutes removed - using standard workspace pattern

  /**
   * Get cached supervisor defaults
   */
  getSupervisorDefaults(): SupervisorDefaults {
    if (!this.supervisorDefaults) {
      throw new Error("Supervisor defaults not loaded");
    }
    return this.supervisorDefaults;
  }

  /**
   * Get the configured Hono app instance
   * Used for OpenAPI spec generation
   */
  public getApp(): ReturnType<typeof createApp> {
    return this.app;
  }

  private setupRoutes() {
    // Custom HTTP request logger using AtlasLogger
    this.app.use("*", async (c: Context, next: Next) => {
      const start = Date.now();
      const method = c.req.method;
      const path = c.req.path;

      await next();

      const duration = Date.now() - start;
      const status = c.res.status;

      // Log in consistent format with other Atlas logs
      logger.info(`HTTP ${method} ${path}`, {
        method,
        path,
        status,
        duration: `${duration}ms`,
        // Add component to match other logs
        component: "http",
      });
    });

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

    // Mount health routes
    this.app.route("/health", healthRoutes);

    // Mount workspace routes
    this.app.route("/api/workspaces", workspacesRoutes);

    // Mount signal routes
    this.app.route("/api/workspaces", signalRoutes);

    // Mount conversation storage routes
    this.app.route("/api/conversation-storage", conversationStorageRoutes);

    this.app.route("/api/user", userRoutes);

    // Mount todo storage routes
    this.app.route("/api/todos", todoStorageRoutes);
    // Mount agent routes
    this.app.route("/api/agents", agentsRoutes);

    // Create a new workspace (functionality moved to create-from-template and create-from-config endpoints)
    this.app.post("/api/workspaces", (c) => {
      return c.json(
        {
          error:
            "Direct workspace creation not supported. Use /api/workspaces/create-from-template or /api/workspaces/create-from-config instead.",
        },
        400,
      );
    });

    // Delete a workspace
    this.app.delete("/api/workspaces/:workspaceId", async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const force = c.req.query("force") === "true";

      try {
        // Unregister cron signals before deleting workspace
        await this.unregisterWorkspaceCronSignals(workspaceId);

        const manager = this.getWorkspaceManager();
        await manager.deleteWorkspace(workspaceId, { force });
        return c.json({ message: `Workspace ${workspaceId} deleted` });
      } catch (error) {
        logger.error("Failed to delete workspace", { error, workspaceId });
        return c.json(
          {
            error: `Failed to delete workspace: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // Add a single workspace by path
    this.app.post("/api/workspaces/add", async (c) => {
      try {
        const body = (await c.req.json()) as {
          path: string;
          name?: string;
          description?: string;
        };
        const {
          path,
          name: providedName,
          description: providedDescription,
        } = body;

        if (!path) {
          return c.json({ error: "Path is required" }, 400);
        }

        // Validate path exists and is a directory
        let stats: Deno.FileInfo;
        try {
          stats = await Deno.stat(path);
        } catch {
          return c.json({ error: `Path not found: ${path}` }, 404);
        }

        if (!stats.isDirectory) {
          return c.json({ error: `Path is not a directory: ${path}` }, 400);
        }

        // Check for workspace.yml
        const workspaceYmlPath = join(path, "workspace.yml");
        try {
          await Deno.stat(workspaceYmlPath);
        } catch {
          return c.json({ error: `workspace.yml not found in: ${path}` }, 400);
        }

        // Try to read workspace.yml to get name and description
        let workspaceName = providedName;
        let workspaceDescription = providedDescription;

        // Only read workspace.yml if name wasn't explicitly provided
        if (!providedName) {
          try {
            const yamlContent = await Deno.readTextFile(workspaceYmlPath);
            const config = parse(yamlContent) as {
              workspace?: { name?: string; description?: string };
            };

            if (config.workspace?.name) {
              workspaceName = config.workspace.name;
            }
            // Also use description from config if not provided
            if (!providedDescription && config.workspace?.description) {
              workspaceDescription = config.workspace.description;
            }
          } catch {
            // Ignore parsing errors, registerWorkspace will use directory name as fallback
          }
        }

        const manager = this.getWorkspaceManager();

        // Check if workspace already exists at this path
        const existingByPath = await manager.find({ path });
        if (existingByPath) {
          return c.json(
            {
              error: `Workspace already registered at path: ${path}`,
            },
            409,
          );
        }

        // If name is determined (provided or from config), check for naming conflicts
        if (workspaceName) {
          const existingByName = await manager.find({ name: workspaceName });
          if (existingByName) {
            return c.json(
              {
                error: `Workspace with name '${workspaceName}' already exists`,
              },
              409,
            );
          }
        }

        // Register the workspace
        const entry = await manager.registerWorkspace(path, {
          name: workspaceName,
          description: workspaceDescription,
        });

        // Cron signals are now automatically registered via WorkspaceManager hooks

        // Convert to API response format
        const workspaceInfo = {
          id: entry.id,
          name: entry.name,
          description: entry.metadata?.description,
          status: entry.status,
          path: entry.path,
          createdAt: entry.createdAt,
          lastSeen: entry.lastSeen,
        };

        return c.json(workspaceInfo, 201);
      } catch (error) {
        logger.error("Failed to add workspace", { error });
        return c.json(
          {
            error: `Failed to add workspace: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // Add multiple workspaces by paths (batch operation)
    this.app.post("/api/workspaces/add-batch", async (c) => {
      try {
        const body = (await c.req.json()) as { paths: string[] };
        const { paths } = body;

        if (!paths || !Array.isArray(paths) || paths.length === 0) {
          return c.json({ error: "Paths array is required" }, 400);
        }

        const manager = this.getWorkspaceManager();
        const results: {
          added: Array<{
            id: string;
            name: string;
            description?: string;
            status: string;
            path: string;
            createdAt: string;
            lastSeen: string;
          }>;
          failed: Array<{
            path: string;
            error: string;
          }>;
        } = {
          added: [],
          failed: [],
        };

        // Process paths with reasonable concurrency (5 parallel)
        const batchSize = 5;
        for (let i = 0; i < paths.length; i += batchSize) {
          const batch = paths.slice(i, i + batchSize);
          const batchPromises = batch.map(async (path) => {
            try {
              // Validate path exists and is a directory
              let stats: Deno.FileInfo;
              try {
                stats = await Deno.stat(path);
              } catch {
                results.failed.push({
                  path,
                  error: `Path not found: ${path}`,
                });
                return;
              }

              if (!stats.isDirectory) {
                results.failed.push({
                  path,
                  error: `Path is not a directory: ${path}`,
                });
                return;
              }

              // Check for workspace.yml
              const workspaceYmlPath = join(path, "workspace.yml");
              try {
                await Deno.stat(workspaceYmlPath);
              } catch {
                results.failed.push({
                  path,
                  error: `workspace.yml not found in: ${path}`,
                });
                return;
              }

              // Check if workspace already exists at this path
              const existingByPath = await manager.find({ path });
              if (existingByPath) {
                results.failed.push({
                  path,
                  error: `Workspace already registered at path: ${path}`,
                });
                return;
              }

              // Try to read workspace.yml to get name and description
              let workspaceName: string | undefined;
              let workspaceDescription: string | undefined;

              try {
                const yamlContent = await Deno.readTextFile(workspaceYmlPath);
                const config = parse(yamlContent) as {
                  workspace?: { name?: string; description?: string };
                };

                if (config.workspace?.name) {
                  workspaceName = config.workspace.name;
                }
                if (config.workspace?.description) {
                  workspaceDescription = config.workspace.description;
                }
              } catch {
                // Ignore parsing errors, registerWorkspace will use directory name as fallback
              }

              // Register the workspace
              const entry = await manager.registerWorkspace(path, {
                name: workspaceName,
                description: workspaceDescription,
              });

              // Cron signals are now automatically registered via WorkspaceManager hooks

              results.added.push({
                id: entry.id,
                name: entry.name,
                description: entry.metadata?.description,
                status: entry.status,
                path: entry.path,
                createdAt: entry.createdAt,
                lastSeen: entry.lastSeen,
              });
            } catch (error) {
              results.failed.push({
                path,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          });

          await Promise.all(batchPromises);
        }

        return c.json(results, 200);
      } catch (error) {
        logger.error("Failed to add workspaces", { error });
        return c.json(
          {
            error: `Failed to add workspaces: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // Validate workspace configuration

    // Create workspace from configuration YAML
    this.app.post("/api/workspaces/create-from-config", async (c) => {
      try {
        const body = (await c.req.json()) as {
          name: string;
          description: string;
          config: string;
          path?: string;
          cwd?: string; // Add CWD to body type
        };

        const { name, description, config, path, cwd } = body;

        if (!name || !description || !config) {
          return c.json(
            { error: "name, description, and config are required" },
            400,
          );
        }

        if (!this.workspaceCreationAdapter) {
          return c.json(
            { error: "Workspace creation adapter not initialized" },
            500,
          );
        }

        // Determine base path
        let basePath: string;
        if (path) {
          // Explicit path provided - use its parent directory
          basePath = dirname(path);
        } else if (cwd) {
          // Use provided CWD
          basePath = cwd;
        } else {
          // Fallback to ~/.atlas/workspaces
          basePath = join(Deno.env.get("HOME") || "/tmp", ".atlas/workspaces");
        }

        // Create workspace directory with collision detection
        const workspacePath = await this.workspaceCreationAdapter.createWorkspaceDirectory(
          basePath,
          name,
        );

        // Write workspace files
        await this.workspaceCreationAdapter.writeWorkspaceFiles(
          workspacePath,
          config,
        );

        // Register the new workspace
        const manager = this.getWorkspaceManager();
        const entry = await manager.registerWorkspace(workspacePath, {
          name,
          description,
        });

        // Cron signals are now automatically registered via WorkspaceManager hooks

        return c.json(
          {
            id: entry.id,
            name: entry.name,
            path: entry.path,
            description,
            message: `Workspace created from configuration`,
          },
          201,
        );
      } catch (error) {
        logger.error("Failed to create workspace from config", { error });
        return c.json(
          {
            error: `Failed to create workspace from config: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // Refresh workspace config cache
    this.app.post("/api/workspaces/:workspaceId/refresh-config", (c) => {
      const workspaceId = c.req.param("workspaceId");

      try {
        // TODO/FIXME: The refreshConfig method was removed from WorkspaceManager in the refactor
        // Need to reimplement config refresh functionality
        // Previously: await manager.refreshConfig(workspaceId);

        // For now, return a placeholder response
        return c.json(
          {
            message:
              `Config refresh not implemented - refreshConfig method removed from WorkspaceManager`,
            workspaceId,
          },
          501,
        );
      } catch (error) {
        logger.error("Failed to refresh config", { error });
        return c.json(
          {
            error: `Failed to refresh config: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // Refresh atlas config cache
    this.app.post("/api/atlas/refresh-config", (c) => {
      try {
        // TODO/FIXME: The refreshAtlasConfig method was removed from WorkspaceManager in the refactor
        // Need to reimplement atlas config refresh functionality
        // Previously: await manager.refreshAtlasConfig();

        // For now, return a placeholder response
        return c.json(
          {
            message:
              `Atlas config refresh not implemented - refreshAtlasConfig method removed from WorkspaceManager`,
          },
          501,
        );
      } catch (error) {
        logger.error("Failed to refresh atlas config", { error });
        return c.json(
          {
            error: `Failed to refresh atlas config: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // List sessions across all workspaces
    this.app.get("/api/sessions", (c) => {
      interface SessionInfo {
        id: string;
        workspaceId: string;
        status: string;
        summary: string;
        signal: string;
        startTime?: unknown;
        endTime?: unknown;
        progress: number;
      }

      const allSessions: SessionInfo[] = [];

      for (const [workspaceId, runtime] of this.runtimes) {
        const sessions = runtime.getSessions().map((session) => ({
          id: session.id,
          workspaceId,
          status: session.status,
          summary: session.summarize(),
          signal: session.signals?.triggers?.[0]?.id || "unknown",
          startTime: undefined, // Private property, not accessible
          endTime: undefined, // Private property, not accessible
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
          interface SessionDetails {
            id: string;
            workspaceId: string;
            status: string;
            progress: number;
            summary: string;
            signal: string;
            startTime?: unknown;
            endTime?: unknown;
            artifacts: unknown[];
            results?: unknown;
          }

          const sessionData: SessionDetails = {
            id: session.id,
            workspaceId,
            status: session.status,
            progress: session.progress(),
            summary: session.summarize(),
            signal: session.signals?.triggers?.[0]?.id || "unknown",
            startTime: undefined, // Private property, not accessible
            endTime: undefined, // Private property, not accessible
            artifacts: session.getArtifacts(),
          };

          // Get execution results if available
          const artifacts = session.getArtifacts();
          const resultsArtifact = artifacts.find(
            (a) => a.type === "execution_results",
          );
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
            return c.json({
              message: `Session ${sessionId} cancelled`,
              workspaceId,
            });
          } catch (error) {
            logger.error("Failed to cancel session", { error, sessionId });
            return c.json({
              message: `Session ${sessionId} cancelled`,
              workspaceId,
            });
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
        const agents = runtime.listAgents();
        return c.json(agents);
      } catch (error) {
        logger.error("Failed to list agents", { error, workspaceId });
        return c.json(
          {
            error: `Failed to list agents: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // Describe specific agent in a workspace
    this.app.get("/api/workspaces/:workspaceId/agents/:agentId", async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const agentId = c.req.param("agentId");

      try {
        const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);
        const agent = runtime.describeAgent(agentId);
        return c.json(agent);
      } catch (error) {
        logger.error("Failed to describe agent", {
          error,
          workspaceId,
          agentId,
        });
        return c.json(
          {
            error: `Failed to describe agent: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // List signals in a workspace
    this.app.get("/api/workspaces/:workspaceId/signals", async (c) => {
      const workspaceId = c.req.param("workspaceId");

      try {
        const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);
        const signals = runtime.listSignals();
        return c.json(signals);
      } catch (error) {
        logger.error("Failed to list signals", { error, workspaceId });
        return c.json(
          {
            error: `Failed to list signals: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
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
        logger.error("Failed to list jobs", { error, workspaceId });
        return c.json(
          {
            error: `Failed to list jobs: ${error instanceof Error ? error.message : String(error)}`,
          },
          500,
        );
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
        logger.error("Failed to list workspace sessions", {
          error,
          workspaceId,
        });
        return c.json(
          {
            error: `Failed to list workspace sessions: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // Library management routes
    // List library items
    this.app.get("/api/library", async (c) => {
      try {
        if (!this.libraryStorage) {
          throw new Error("Library storage not initialized");
        }

        // Parse query parameters
        const query: LibrarySearchQuery = {
          query: c.req.query("q") || c.req.query("query"),
          type: c.req.query("type") ? c.req.query("type")!.split(",") : undefined,
          tags: c.req.query("tags") ? c.req.query("tags")!.split(",") : undefined,
          since: c.req.query("since"),
          until: c.req.query("until"),
          limit: c.req.query("limit") ? parseInt(c.req.query("limit")!) : 50,
          offset: c.req.query("offset") ? parseInt(c.req.query("offset")!) : 0,
        };

        const result = await this.libraryStorage.search(query);
        return c.json(result);
      } catch (error) {
        logger.error("Failed to list library items", { error });
        return c.json(
          {
            error: `Failed to list library items: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // Search library items (before itemId route)
    this.app.get("/api/library/search", async (c) => {
      try {
        if (!this.libraryStorage) {
          throw new Error("Library storage not initialized");
        }

        const query: LibrarySearchQuery = {
          query: c.req.query("q") || c.req.query("query"),
          type: c.req.query("type") ? c.req.query("type")!.split(",") : undefined,
          tags: c.req.query("tags") ? c.req.query("tags")!.split(",") : undefined,
          since: c.req.query("since"),
          until: c.req.query("until"),
          limit: c.req.query("limit") ? parseInt(c.req.query("limit")!) : 50,
          offset: c.req.query("offset") ? parseInt(c.req.query("offset")!) : 0,
        };

        const result = await this.libraryStorage.search(query);
        return c.json(result);
      } catch (error) {
        logger.error("Failed to search library", { error });
        return c.json(
          {
            error: `Failed to search library: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // List available templates (before itemId route)
    this.app.get("/api/library/templates", async (c) => {
      try {
        if (!this.libraryStorage) {
          throw new Error("Library storage not initialized");
        }

        const templates = await this.libraryStorage.listTemplates();
        return c.json(templates);
      } catch (error) {
        logger.error("Failed to list templates", { error });
        return c.json(
          {
            error: `Failed to list templates: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // Get library statistics (before itemId route)
    this.app.get("/api/library/stats", async (c) => {
      try {
        if (!this.libraryStorage) {
          throw new Error("Library storage not initialized");
        }

        const stats = await this.libraryStorage.getStats();
        return c.json(stats);
      } catch (error) {
        logger.error("Failed to get library stats", { error });
        return c.json(
          {
            error: `Failed to get library stats: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // Generate content from template (before itemId route)
    this.app.post("/api/library/generate", async (c) => {
      try {
        if (!this.libraryStorage) {
          throw new Error("Library storage not initialized");
        }

        const { templateId, data, options } = await c.req.json();

        if (!templateId) {
          return c.json({ error: "templateId is required" }, 400);
        }

        // This would need template engine integration
        // For now, return a simple response
        return c.json(
          {
            message: "Template generation not yet implemented",
            templateId,
            data,
            options,
          },
          501,
        );
      } catch (error) {
        logger.error("Failed to generate from template", { error });
        return c.json(
          {
            error: `Failed to generate from template: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // Get specific library item (must be after specific routes)
    this.app.get("/api/library/:itemId", async (c) => {
      const itemId = c.req.param("itemId");
      const includeContent = c.req.query("content") === "true";

      try {
        if (!this.libraryStorage) {
          throw new Error("Library storage not initialized");
        }

        const result = includeContent
          ? await this.libraryStorage.getItemWithContent(itemId)
          : await this.libraryStorage.getItem(itemId);

        if (!result) {
          return c.json({ error: `Library item not found: ${itemId}` }, 404);
        }

        if (includeContent && "content" in result) {
          return c.json({
            item: result.item,
            content: result.content,
          });
        } else {
          return c.json({ item: result.item });
        }
      } catch (error) {
        logger.error("Failed to get library item", { error, itemId });
        return c.json(
          {
            error: `Failed to get library item: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // Create library item
    this.app.post("/api/library", async (c) => {
      try {
        if (!this.libraryStorage) {
          throw new Error("Library storage not initialized");
        }

        const itemData = await c.req.json();

        // Validate required fields
        if (!itemData.type) {
          return c.json({ error: "type is required" }, 400);
        }
        if (!itemData.name) {
          return c.json({ error: "name is required" }, 400);
        }
        if (!itemData.content) {
          return c.json({ error: "content is required" }, 400);
        }

        // Generate ID and timestamps
        const itemId = crypto.randomUUID();
        const now = new Date().toISOString();

        const libraryItem = {
          id: itemId,
          type: itemData.type,
          name: itemData.name,
          description: itemData.description || "",
          content: itemData.content,
          metadata: {
            format: itemData.format || "markdown",
            source: itemData.source || "agent",
            session_id: itemData.session_id,
            agent_ids: itemData.agent_ids || [],
            ...itemData.metadata,
          },
          created_at: now,
          updated_at: now,
          tags: itemData.tags || [],
          workspace_id: itemData.workspace_id,
        };

        await this.libraryStorage.storeItem(libraryItem);

        return c.json({
          success: true,
          itemId,
          message: `Library item '${itemData.name}' created`,
          item: libraryItem,
        });
      } catch (error) {
        logger.error("Failed to create library item", { error });
        return c.json(
          {
            error: `Failed to create library item: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // Delete library item
    this.app.delete("/api/library/:itemId", async (c) => {
      const itemId = c.req.param("itemId");

      try {
        if (!this.libraryStorage) {
          throw new Error("Library storage not initialized");
        }

        const deleted = await this.libraryStorage.deleteItem(itemId);
        if (!deleted) {
          return c.json({ error: `Library item not found: ${itemId}` }, 404);
        }

        return c.json({ message: `Library item ${itemId} deleted` });
      } catch (error) {
        logger.error("Failed to delete library item", { error, itemId });
        return c.json(
          {
            error: `Failed to delete library item: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          500,
        );
      }
    });

    // Daemon management routes
    this.app.get("/api/daemon/status", (c) => {
      return c.json({
        status: "running",
        ...this.getStatus(),
        memoryUsage: Deno.memoryUsage(),
        workspaces: Array.from(this.runtimes.keys()),
      });
    });

    // OpenAPI documentation - after all routes are mounted
    const { openAPIHandler, scalarHandler } = createOpenAPIHandlers(this.app, {
      hostname: this.options.hostname,
      port: this.options.port,
    });

    // Mount OpenAPI spec endpoint
    this.app.get("/openapi.json", openAPIHandler);

    // Mount Scalar UI endpoint
    this.app.get("/openapi", scalarHandler);

    // Proxy to platform MCP server with specific CORS for MCP
    this.app.all(
      "/mcp",
      cors({
        origin: this.options.cors || "*",
        credentials: true,
        exposeHeaders: ["Mcp-Session-Id"],
        allowHeaders: ["Content-Type", "Mcp-Session-Id"],
      }),
      async (c) => {
        try {
          // Get MCP server instance
          const mcpServer = this.getMCPServer();

          // Create streaming transport
          const transport = new StreamableHTTPTransport();

          // Connect MCP server to transport
          await mcpServer.getServer().connect(transport);

          // Handle the request
          return transport.handleRequest(c);
        } catch (error) {
          logger.error("MCP endpoint error", { error });
          return c.json(
            {
              error: `MCP server error: ${error instanceof Error ? error.message : String(error)}`,
            },
            500,
          );
        }
      },
    );

    // Handle agents MCP server requests with specific CORS for MCP
    this.app.all(
      "/agents",
      cors({
        origin: this.options.cors || "*",
        credentials: true,
        exposeHeaders: ["Mcp-Session-Id"],
        allowHeaders: ["Content-Type", "Mcp-Session-Id"],
      }),
      async (c) => {
        try {
          const sessionId = c.req.header("mcp-session-id");

          // For new sessions (no session ID on POST), generate one.
          // This is helpful when using MCP Inspector where it initializes a new connection
          // without a pre-existing Atlas Session ID.
          if (!sessionId && c.req.method === "POST") {
            const newSessionId = crypto.randomUUID();
            logger.info("Creating new SSE session for Agent Server", {
              sessionId: newSessionId,
            });

            // Create and store the session
            const { transport } = await this.getOrCreateAgentSession(newSessionId);

            // Handle the request - this will set the Mcp-Session-Id header
            const response = await transport.handleRequest(c);

            // The transport now has the session ID set
            if (transport.sessionId) {
              logger.info("Session ID set on transport", {
                sessionId: transport.sessionId,
                originalId: newSessionId,
              });
            }

            return response;
          } else if (sessionId) {
            // Existing session - get or create
            const { transport } = await this.getOrCreateAgentSession(sessionId);

            // Track SSE connections for GET requests
            if (c.req.method === "GET") {
              logger.info("Establishing SSE connection to Agent Server", {
                sessionId,
              });
              this.agentSSEConnections.add(sessionId);
            }

            // Handle DELETE specially - clean up after processing
            if (c.req.method === "DELETE") {
              logger.info("Terminating Agent Server SSE session", {
                sessionId,
              });
              const response = await transport.handleRequest(c);
              await this.cleanupAgentSession(sessionId);
              return response;
            }

            // Handle the request
            return transport.handleRequest(c);
          } else {
            // No session ID and not a POST request - this is an error
            logger.error(
              "[Daemon] Invalid request - no session ID for non-POST",
              {
                method: c.req.method,
              },
            );
            return c.json(
              {
                jsonrpc: "2.0",
                error: {
                  code: -32000,
                  message: "Session ID required for non-initialize requests",
                },
                id: null,
              },
              400,
            );
          }
        } catch (error) {
          logger.error("Agents MCP endpoint error", { error });
          return c.json(
            {
              error: `Agents MCP server error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
            500,
          );
        }
      },
    );

    this.app.post("/api/daemon/shutdown", (c) => {
      // Graceful shutdown endpoint
      logger.info("Daemon shutdown requested via API");

      // Don't await - respond immediately then shutdown
      setTimeout(() => this.shutdown(), 100);

      return c.json({ message: "Daemon shutdown initiated" });
    });

    // Create a new stream session
    this.app.post("/api/streams", async (c) => {
      try {
        const body = await c.req.json();
        const streamId = body.streamId || crypto.randomUUID(); // Use existing streamId if provided

        // For createOnly requests, just return the stream info
        if (body.createOnly) {
          return c.json({
            success: true,
            stream_id: streamId,
            sse_url: `/api/stream/${streamId}/stream`,
          });
        }

        // No special conversation logic - client should use regular workspace triggers
        // For requests that include a workspace and signal, trigger the signal
        if (body.workspaceId && body.signal) {
          const runtime = this.runtimes.get(body.workspaceId);
          if (!runtime) {
            return c.json(
              { error: `Workspace not found: ${body.workspaceId}` },
              404,
            );
          }

          // Trigger signal with streamId
          runtime
            .triggerSignal(body.signal, {
              ...body,
              streamId,
            })
            .catch((error) => {
              logger.error("Signal trigger failed", { error });
            });
        }

        return c.json({
          success: true,
          stream_id: streamId, // Return the same streamId that was used
          sse_url: `/api/stream/${streamId}/stream`,
        });
      } catch (error) {
        logger.error("Failed to create stream", { error });
        return c.json({ error: "Failed to create stream" }, 500);
      }
    });

    // SSE endpoint for stream subscriptions
    this.app.get("/api/stream/:streamId/stream", (c) => {
      const streamId = c.req.param("streamId");
      return this.handleGenericSSERequest(c, streamId);
    });

    // Stream API endpoint for MCP tools
    this.app.post("/api/stream/:streamId", async (c) => {
      const streamId = c.req.param("streamId");

      try {
        const body = await c.req.json();
        const { message, userId, scope, metadata, conversationId } = body;

        // Trigger the conversation workspace signal with the message
        const conversationWorkspace = await this.getOrCreateWorkspaceRuntime("atlas-conversation");

        await conversationWorkspace.triggerSignal("conversation-stream", {
          streamId,
          message,
          userId: userId || "cli-user",
          conversationId,
          scope,
          metadata,
        });

        return c.json({
          success: true,
          message: "Reply streamed",
          messageId: crypto.randomUUID(),
        });
      } catch (error) {
        logger.error("Stream API error", { streamId, error });
        return c.json(
          {
            error: `Stream API error: ${error instanceof Error ? error.message : String(error)}`,
          },
          500,
        );
      }
    });

    // SSE event emission endpoint for daemon capabilities
    this.app.post("/api/stream/:streamId/emit", async (c) => {
      const streamId = c.req.param("streamId");

      try {
        const event = await c.req.json();

        // Emit the SSE event to all connected clients for this stream
        this.emitSSEEvent(streamId, event);

        return c.json({ success: true });
      } catch (error) {
        logger.error("SSE emit error", { streamId, error });
        return c.json(
          {
            error: `SSE emit error: ${error instanceof Error ? error.message : String(error)}`,
          },
          500,
        );
      }
    });
  }

  /**
   * Get or create a workspace runtime on-demand
   */
  async getOrCreateWorkspaceRuntime(
    workspaceId: string,
  ): Promise<WorkspaceRuntime> {
    try {
      logger.debug("getOrCreateWorkspaceRuntime called", { workspaceId });

      // Ensure daemon is properly initialized before creating runtimes
      if (!this.isInitialized) {
        throw new Error("Atlas daemon not fully initialized - cannot create workspace runtime");
      }

      // Verify required services are available
      if (!this.mcpServerPool) {
        logger.warn(
          "MCP server pool not initialized - workspace runtime will have limited tool access",
          {
            workspaceId,
          },
        );
      }

      // Check if runtime already exists
      let runtime = this.runtimes.get(workspaceId);
      if (runtime) {
        logger.debug("Found existing runtime", { workspaceId });
        return runtime;
      }

      // Check concurrent workspace limit
      if (this.runtimes.size >= this.options.maxConcurrentWorkspaces!) {
        logger.warn(
          "Maximum concurrent workspaces reached, attempting eviction",
          {
            maxConcurrentWorkspaces: this.options.maxConcurrentWorkspaces,
          },
        );
        // Find the oldest idle workspace to evict
        const oldestWorkspace = this.findOldestIdleWorkspace();
        if (oldestWorkspace) {
          logger.info("Evicting oldest idle workspace", {
            workspaceId: oldestWorkspace,
          });
          await this.destroyWorkspaceRuntime(oldestWorkspace);
        } else {
          const error = "Maximum concurrent workspaces reached";
          logger.error(error, {
            maxConcurrentWorkspaces: this.options.maxConcurrentWorkspaces,
          });
          throw new Error(`${error} (${this.options.maxConcurrentWorkspaces})`);
        }
      }

      // Find workspace in registry (manager already initialized at daemon startup)
      logger.debug("Looking up workspace in registry", { workspaceId });
      const manager = this.getWorkspaceManager();

      const workspace = (await manager.find({ id: workspaceId })) ||
        (await manager.find({ name: workspaceId }));

      if (!workspace) {
        const error = "Workspace not found";
        logger.error(error, { workspaceId });
        throw new Error(`${error}: ${workspaceId}`);
      }

      logger.info("Creating runtime for workspace", {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspacePath: workspace.path,
      });

      // System workspace check - skip filesystem validation
      if (!workspace.metadata?.system) {
        // Validate workspace path exists
        try {
          const stat = await Deno.stat(workspace.path);
          if (!stat.isDirectory) {
            throw new Error(
              `Workspace path is not a directory: ${workspace.path}`,
            );
          }
        } catch (error) {
          logger.error("Failed to access workspace path", {
            error,
            workspacePath: workspace.path,
          });
          throw new Error(`Workspace path does not exist: ${workspace.path}`);
        }
      } else {
        logger.debug("Loading system workspace", {
          workspaceId: workspace.id,
        });
      }

      // Load configuration using the new WorkspaceManager
      const mergedConfig = await manager.getWorkspaceConfig(workspace.id);
      if (!mergedConfig) {
        throw new Error(
          `Failed to load workspace configuration: ${workspace.id}`,
        );
      }

      logger.debug("Workspace configuration loaded", {
        workspaceId: workspace.id,
        signals: Object.keys(mergedConfig.workspace?.signals || {}).length,
        jobs: Object.keys(mergedConfig.workspace?.jobs || {}).length,
        agents: Object.keys(mergedConfig.workspace?.agents || {}).length,
      });

      logger.debug("Creating Workspace object from config");
      logger.debug("Workspace signals", {
        workspaceId: workspace.id,
        signals: mergedConfig.workspace?.signals ? Object.keys(mergedConfig.workspace.signals) : [],
      });

      const workspaceObj = Workspace.fromConfig(mergedConfig.workspace, {
        id: workspace.id,
        name: workspace.name,
        role: WorkspaceMemberRole.OWNER,
      });

      logger.debug("Workspace object created", {
        workspaceId: workspace.id,
        signalsCount: Object.keys(workspaceObj.signals).length,
      });

      // Status will be updated to "running" when registerRuntime is called

      logger.debug("Creating WorkspaceRuntime", { workspaceId: workspace.id });
      runtime = new WorkspaceRuntime(workspaceObj, mergedConfig, {
        lazy: true, // Always use lazy loading in daemon mode
        workspacePath: workspace.metadata?.system ? undefined : workspace.path, // Pass workspace path for daemon mode
        libraryStorage: this.libraryStorage || undefined, // Share daemon's library storage
        mcpServerPool: this.mcpServerPool || undefined, // Share daemon's MCP server pool
        daemonUrl: `http://localhost:${this.options.port}`, // Pass daemon URL for MCP tool fetching
      });
      logger.debug("WorkspaceRuntime created", { workspaceId: workspace.id });

      this.runtimes.set(workspace.id, runtime);
      logger.debug("Runtime stored in daemon registry", {
        workspaceId: workspace.id,
      });

      // Register runtime with WorkspaceManager
      await manager.registerRuntime(workspace.id, runtime);
      logger.debug("Runtime registered with WorkspaceManager", {
        workspaceId: workspace.id,
      });

      // Start watching workspace configuration file if not a system workspace
      if (this.fileWatcher && !workspace.metadata?.system) {
        await this.fileWatcher.watchWorkspace(workspace);
        logger.debug("Started watching workspace configuration", {
          workspaceId: workspace.id,
        });
      }

      // Set idle timeout
      this.resetIdleTimeout(workspace.id);
      logger.debug("Idle timeout set", { workspaceId: workspace.id });

      logger.info("Runtime created", {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      });

      return runtime;
    } catch (error) {
      logger.error("Failed to create workspace runtime", {
        error,
        workspaceId,
      });

      // Status update will be handled by WorkspaceManager if needed

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
      const hasActiveSessions = sessions.some(
        (s) =>
          s.status === WorkspaceSessionStatus.EXECUTING ||
          s.status === WorkspaceSessionStatus.PENDING,
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
    // Since _startTime is private, we can't access it directly
    // Return current time as approximation (sessions are active)
    return Date.now();
  }

  /**
   * Reset idle timeout for a workspace
   */
  resetIdleTimeout(workspaceId: string) {
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
    const hasActiveSessions = sessions.some(
      (s) =>
        s.status === WorkspaceSessionStatus.EXECUTING ||
        s.status === WorkspaceSessionStatus.PENDING,
    );

    if (!hasActiveSessions) {
      logger.info("Destroying idle workspace runtime", { workspaceId });
      await this.destroyWorkspaceRuntime(workspaceId);
    } else {
      // Still has active sessions, reset timeout
      this.resetIdleTimeout(workspaceId);
    }
  }

  /**
   * Destroy a workspace runtime
   */
  async destroyWorkspaceRuntime(workspaceId: string) {
    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) return;

    // Stop watching workspace configuration file
    if (this.fileWatcher) {
      await this.fileWatcher.unwatchWorkspace(workspaceId);
    }

    try {
      await runtime.shutdown();
    } catch (error) {
      logger.error("Error shutting down workspace runtime", {
        error,
        workspaceId,
      });
    }

    this.runtimes.delete(workspaceId);

    // Unregister runtime from WorkspaceManager
    const manager = this.getWorkspaceManager();
    await manager.unregisterRuntime(workspaceId);

    // Clear idle timeout
    const timeoutId = this.idleTimeouts.get(workspaceId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.idleTimeouts.delete(workspaceId);
    }

    logger.info("Workspace runtime destroyed", { workspaceId });
  }

  // setupSystemWorkspaceRoutes removed - using standard workspace + daemon capabilities pattern

  /**
   * Handle workspace configuration changes detected by file watcher
   */
  private async handleWorkspaceConfigChange(
    workspaceId: string,
    filePath: string,
  ) {
    logger.info("Workspace configuration changed, reloading runtime", {
      workspaceId,
      filePath,
    });

    // Reuse existing runtime destruction logic
    await this.destroyWorkspaceRuntime(workspaceId);
  }

  private setupSignalHandlers() {
    const daemonId = crypto.randomUUID().slice(0, 8);

    const handleShutdown = (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      logger.info("Daemon received signal, shutting down gracefully", {
        daemonId,
        signal,
      });

      // Handle async shutdown in a promise to ensure proper cleanup
      // Add a timeout to prevent hanging indefinitely
      const shutdownTimeout = setTimeout(() => {
        logger.error("Shutdown timeout, forcing exit", { timeoutSeconds: 30 });
        Deno.exit(1);
      }, 30000);

      this.shutdown()
        .then(() => {
          clearTimeout(shutdownTimeout);
          logger.info("Daemon shutdown complete", { daemonId });
          Deno.exit(0);
        })
        .catch((error) => {
          clearTimeout(shutdownTimeout);
          logger.error("Error during shutdown", { error, daemonId });
          Deno.exit(1);
        });
    };

    const sigintHandler = () => handleShutdown("SIGINT");
    Deno.addSignalListener("SIGINT", sigintHandler);
    this.signalHandlers.push({ signal: "SIGINT", handler: sigintHandler });

    // SIGTERM is not supported on Windows
    if (Deno.build.os !== "windows") {
      const sigtermHandler = () => handleShutdown("SIGTERM");
      Deno.addSignalListener("SIGTERM", sigtermHandler);
      this.signalHandlers.push({ signal: "SIGTERM", handler: sigtermHandler });
    }
  }

  async start() {
    // Ensure daemon is initialized
    await this.initialize();

    const port = this.options.port ?? 8080;
    const hostname = this.options.hostname || "localhost";

    logger.info("Starting Atlas daemon", {
      hostname,
      port,
      maxConcurrentWorkspaces: this.options.maxConcurrentWorkspaces,
      idleTimeoutMs: this.options.idleTimeoutMs,
    });

    this.server = Deno.serve(
      {
        port,
        hostname,
        onListen: ({ hostname, port }) => {
          this.#port = port;
          logger.info("👹 Atlas daemon running", { hostname, port });
        },
      },
      this.app.fetch,
    );

    await this.server.finished;
  }

  async startNonBlocking(): Promise<{ finished: Promise<void> }> {
    // Ensure daemon is initialized
    await this.initialize();

    const port = this.options.port ?? 8080;
    const hostname = this.options.hostname || "localhost";

    logger.info("Starting Atlas daemon", {
      hostname,
      port,
      maxConcurrentWorkspaces: this.options.maxConcurrentWorkspaces,
      idleTimeoutMs: this.options.idleTimeoutMs,
    });

    let serverReady: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      serverReady = resolve;
    });

    this.server = Deno.serve(
      {
        port,
        hostname,
        onListen: ({ hostname, port }) => {
          this.#port = port; // Store the actual port
          logger.info("Atlas daemon running", {
            hostname,
            port,
          });
          serverReady();
        },
      },
      this.app.fetch,
    );

    await readyPromise;
    return { finished: this.server.finished };
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info("Shutting down Atlas daemon...");

    // Remove signal handlers
    for (const { signal, handler } of this.signalHandlers) {
      Deno.removeSignalListener(signal, handler);
    }
    this.signalHandlers = [];

    // Shutdown all workspace runtimes
    const shutdownPromises = Array.from(this.runtimes.keys()).map(
      (workspaceId) => this.destroyWorkspaceRuntime(workspaceId),
    );
    await Promise.all(shutdownPromises);

    // Unregister all cron signals
    if (this.cronManager) {
      const activeTimers = this.cronManager.listActiveTimers();
      for (const timer of activeTimers) {
        await this.unregisterWorkspaceCronSignals(timer.workspaceId);
      }
    }

    // Clear all idle timeouts
    for (const timeoutId of this.idleTimeouts.values()) {
      clearTimeout(timeoutId);
    }
    this.idleTimeouts.clear();

    // Stop file watcher
    if (this.fileWatcher) {
      await this.fileWatcher.stop();
      this.fileWatcher = null;
    }

    // Stop SSE health check
    if (this.sseHealthCheckInterval) {
      clearInterval(this.sseHealthCheckInterval);
      this.sseHealthCheckInterval = null;
    }

    // Stop agent session cleanup
    if (this.agentSessionCleanupInterval) {
      clearInterval(this.agentSessionCleanupInterval);
      this.agentSessionCleanupInterval = null;
    }

    // Close all SSE connections
    for (const [sessionId, clients] of this.sseClients.entries()) {
      for (const client of clients) {
        try {
          client.controller.close();
        } catch (error) {
          logger.debug("Error closing SSE client for session", {
            error,
            sessionId,
          });
        }
      }
    }
    this.sseClients.clear();

    // Clean up agent sessions
    for (const sessionId of this.agentSessions.keys()) {
      try {
        await this.cleanupAgentSession(sessionId);
      } catch (error) {
        logger.debug("Error cleaning up agent session", { error, sessionId });
      }
    }
    this.agentSessions.clear();
    this.agentSSEConnections.clear();

    // Shutdown CronManager
    if (this.cronManager) {
      await this.cronManager.shutdown();
      this.cronManager = null;
    }

    // Note: Per-session MCP servers are cleaned up above

    // Dispose MCP Server Pool
    if (this.mcpServerPool) {
      logger.info("Disposing Global MCP Server Pool...");
      await this.mcpServerPool.dispose();
      this.mcpServerPool = null;
    }

    // Shutdown WorkspaceManager
    if (this.workspaceManager) {
      await this.workspaceManager.close();
      this.workspaceManager = null;
    }

    // Close LibraryStorage
    if (this.libraryStorage) {
      try {
        await this.libraryStorage.close();
        this.libraryStorage = null;
        logger.info("LibraryStorage closed");
      } catch (error) {
        logger.error("Failed to close LibraryStorage", { error });
      }
    }

    // Shutdown HTTP server
    if (this.server) {
      try {
        // Deno.serve() returns a server with a shutdown() method
        await this.server.shutdown();
      } catch (error) {
        logger.error("Error shutting down HTTP server", { error });
      }
    }

    logger.info("Atlas daemon shutdown complete");
  }

  // Status getters
  getActiveWorkspaces(): string[] {
    return Array.from(this.runtimes.keys());
  }

  getWorkspaceRuntime(workspaceId: string): WorkspaceRuntime | undefined {
    return this.runtimes.get(workspaceId);
  }

  getCronManager(): CronManager | null {
    return this.cronManager;
  }

  /**
   * Extract and register cron signals from a workspace configuration
   */
  public async registerWorkspaceCronSignals(
    workspaceId: string,
    workspacePath: string,
  ): Promise<void> {
    if (!this.cronManager) {
      logger.warn(
        "CronManager not initialized, skipping cron signal registration",
        { workspaceId },
      );
      return;
    }

    try {
      // Check if workspace directory exists first
      try {
        await Deno.stat(workspacePath);
      } catch {
        logger.debug(
          "Skipping cron signal registration for non-existent workspace",
          {
            workspaceId,
            workspacePath,
          },
        );
        return;
      }

      // Load workspace configuration
      const adapter = new FilesystemConfigAdapter(workspacePath);
      const configLoader = new ConfigLoader(adapter, workspacePath);
      const config = await configLoader.load();

      // Extract timer signals from configuration
      const signals = config.workspace?.signals || {};
      const cronTimers: CronTimerConfig[] = [];

      for (const [signalId, signalConfig] of Object.entries(signals)) {
        // Check if this is a timer signal with cron schedule
        // Schedule signals have provider="schedule" and config.schedule per the schema
        if (
          signalConfig &&
          typeof signalConfig === "object" &&
          "provider" in signalConfig &&
          signalConfig.provider === "schedule" &&
          "config" in signalConfig &&
          signalConfig.config &&
          typeof signalConfig.config === "object" &&
          "schedule" in signalConfig.config &&
          typeof signalConfig.config.schedule === "string"
        ) {
          const cronConfig: CronTimerConfig = {
            workspaceId,
            signalId,
            schedule: signalConfig.config.schedule,
            timezone: signalConfig.config.timezone || "UTC",
            description: signalConfig.description,
          };

          cronTimers.push(cronConfig);
        }
      }

      // Register all cron timers with CronManager sequentially to prevent conflicts
      for (const cronConfig of cronTimers) {
        try {
          await this.cronManager.registerTimer(cronConfig);
          logger.info("Registered cron timer", {
            workspaceId,
            signalId: cronConfig.signalId,
            schedule: cronConfig.schedule,
          });
        } catch (error) {
          logger.error("Failed to register cron timer", {
            error,
            workspaceId,
            signalId: cronConfig.signalId,
          });
          // Continue with other timers even if one fails
        }
      }

      if (cronTimers.length > 0) {
        logger.info("Workspace cron signals registered", {
          workspaceId,
          timerCount: cronTimers.length,
        });
      }
    } catch (error) {
      logger.error("Failed to register workspace cron signals", {
        error,
        workspaceId,
        workspacePath,
      });
    }
  }

  /**
   * Unregister all cron signals for a workspace
   */
  private async unregisterWorkspaceCronSignals(
    workspaceId: string,
  ): Promise<void> {
    if (!this.cronManager) {
      return;
    }

    try {
      await this.cronManager.unregisterWorkspaceTimers(workspaceId);
      logger.info("Unregistered workspace cron signals", { workspaceId });
    } catch (error) {
      logger.error("Failed to unregister workspace cron signals", {
        error,
        workspaceId,
      });
    }
  }

  /**
   * Discover and register cron signals for all existing workspaces
   */
  private async discoverAndRegisterExistingCronSignals(): Promise<void> {
    if (!this.cronManager) {
      logger.warn(
        "CronManager not initialized, skipping existing workspace discovery",
      );
      return;
    }

    try {
      const manager = this.getWorkspaceManager();
      const workspaces = await manager.list();

      logger.info("Discovering cron signals for existing workspaces", {
        workspaceCount: workspaces.length,
      });

      let registeredTimers = 0;
      let processedWorkspaces = 0;

      // Process workspaces sequentially to prevent registration conflicts
      for (const workspace of workspaces) {
        try {
          const timersBefore = this.cronManager.listActiveTimers().length;
          await this.registerWorkspaceCronSignals(workspace.id, workspace.path);
          const timersAfter = this.cronManager.listActiveTimers().length;
          registeredTimers += timersAfter - timersBefore;
          processedWorkspaces++;

          logger.debug("Processed workspace cron signals", {
            workspaceId: workspace.id,
            timersAdded: timersAfter - timersBefore,
            progress: `${processedWorkspaces}/${workspaces.length}`,
          });
        } catch (error) {
          logger.warn(
            "Failed to register cron signals for existing workspace",
            {
              workspaceId: workspace.id,
              workspacePath: workspace.path,
              error,
            },
          );
          processedWorkspaces++;
        }
      }

      logger.info("Cron signal discovery complete", {
        workspacesProcessed: processedWorkspaces,
        totalWorkspaces: workspaces.length,
        timersRegistered: registeredTimers,
      });
    } catch (error) {
      logger.error("Failed to discover existing workspace cron signals", {
        error,
      });
    }
  }

  getStatus() {
    const cronStats = this.cronManager?.getStats();

    return {
      activeWorkspaces: this.runtimes.size,
      uptime: Date.now() - this.startTime,
      cronManager: cronStats
        ? {
          isActive: this.cronManager?.isActive() || false,
          ...cronStats,
        }
        : null,
      configuration: {
        maxConcurrentWorkspaces: this.options.maxConcurrentWorkspaces,
        idleTimeoutMs: this.options.idleTimeoutMs,
      },
    };
  }

  /**
   * Emit an SSE event to all connected clients for a stream
   */
  public emitSSEEvent(sessionId: string, event: unknown): void {
    const clients = this.sseClients.get(sessionId);

    if (!clients || clients.length === 0) {
      logger.warn("No SSE clients connected", { sessionId });
      return;
    }

    const sseData = `data: ${JSON.stringify(event)}\n\n`;
    const now = Date.now();
    const disconnectedClients: typeof clients = [];

    // Send to all connected clients for this session
    for (const client of clients) {
      try {
        client.controller.enqueue(new TextEncoder().encode(sseData));
        // Update last activity on successful send
        client.lastActivity = now;
      } catch (error) {
        // Client disconnected, mark for removal
        logger.debug("SSE client disconnected", { sessionId, error });
        disconnectedClients.push(client);
      }
    }

    // Remove disconnected clients
    if (disconnectedClients.length > 0) {
      const remainingClients = clients.filter(
        (c) => !disconnectedClients.includes(c),
      );
      if (remainingClients.length === 0) {
        this.sseClients.delete(sessionId);
      } else {
        this.sseClients.set(sessionId, remainingClients);
      }
      logger.debug("Removed disconnected SSE clients", {
        sessionId,
        removedCount: disconnectedClients.length,
      });
    }
  }

  /**
   * Start SSE health check interval
   */
  private startSSEHealthCheck(): void {
    if (this.sseHealthCheckInterval) {
      clearInterval(this.sseHealthCheckInterval);
    }

    this.sseHealthCheckInterval = setInterval(() => {
      this.performSSEHealthCheck();
    }, this.options.sseHeartbeatIntervalMs!);

    logger.info("SSE health check started", {
      intervalMs: this.options.sseHeartbeatIntervalMs,
    });
  }

  /**
   * Start agent session cleanup interval
   */
  private startAgentSessionCleanup(): void {
    if (this.agentSessionCleanupInterval) {
      clearInterval(this.agentSessionCleanupInterval);
    }

    // Check every minute for stale sessions
    this.agentSessionCleanupInterval = setInterval(() => {
      this.performAgentSessionCleanup();
    }, 60000);

    logger.info("Agent session cleanup started", {
      intervalMs: 60000,
      maxSessions: this.MAX_AGENT_SESSIONS,
      timeoutMs: this.AGENT_SESSION_TIMEOUT_MS,
    });
  }

  /**
   * Clean up stale agent sessions
   */
  private async performAgentSessionCleanup(): Promise<void> {
    const now = Date.now();
    const sessionsToCleanup: string[] = [];

    // Find stale sessions
    for (const [sessionId, session] of this.agentSessions) {
      if (now - session.lastUsed > this.AGENT_SESSION_TIMEOUT_MS) {
        sessionsToCleanup.push(sessionId);
      }
    }

    // Clean up stale sessions
    if (sessionsToCleanup.length > 0) {
      logger.info("Cleaning up stale agent sessions", {
        count: sessionsToCleanup.length,
        totalSessions: this.agentSessions.size,
      });

      for (const sessionId of sessionsToCleanup) {
        await this.cleanupAgentSession(sessionId);
      }
    }

    // Enforce session limit (LRU eviction)
    if (this.agentSessions.size > this.MAX_AGENT_SESSIONS) {
      const sortedSessions = Array.from(this.agentSessions.entries()).sort(
        (a, b) => a[1].lastUsed - b[1].lastUsed,
      );

      const toEvict = sortedSessions.slice(
        0,
        this.agentSessions.size - this.MAX_AGENT_SESSIONS,
      );

      logger.warn("Evicting LRU agent sessions due to limit", {
        evictionCount: toEvict.length,
        totalSessions: this.agentSessions.size,
        maxSessions: this.MAX_AGENT_SESSIONS,
      });

      for (const [sessionId] of toEvict) {
        await this.cleanupAgentSession(sessionId);
      }
    }
  }

  /**
   * Perform SSE health check - send heartbeat and prune stale connections
   */
  private performSSEHealthCheck(): void {
    const now = Date.now();
    const timeoutMs = this.options.sseConnectionTimeoutMs!;
    let totalClients = 0;
    let prunedClients = 0;
    let heartbeatsSent = 0;

    for (const [sessionId, clients] of this.sseClients.entries()) {
      const activeClients: typeof clients = [];

      for (const client of clients) {
        totalClients++;

        // Check if connection is stale
        if (now - client.lastActivity > timeoutMs) {
          try {
            client.controller.close();
          } catch {
            // Ignore close errors
          }
          prunedClients++;
          logger.debug("Pruned stale SSE client", {
            sessionId,
            connectionDuration: now - client.connectedAt,
            lastActivity: now - client.lastActivity,
          });
        } else {
          // Send heartbeat to active clients
          try {
            const heartbeat = {
              type: "heartbeat",
              data: { timestamp: new Date().toISOString() },
            };
            client.controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify(heartbeat)}\n\n`),
            );
            client.lastActivity = now;
            activeClients.push(client);
            heartbeatsSent++;
          } catch (error) {
            // Client disconnected
            try {
              client.controller.close();
            } catch {
              // Ignore close errors
            }
            prunedClients++;
            logger.debug("Pruned disconnected SSE client during heartbeat", {
              sessionId,
              error,
            });
          }
        }
      }

      // Update client list or remove empty sessions
      if (activeClients.length === 0) {
        this.sseClients.delete(sessionId);
      } else {
        this.sseClients.set(sessionId, activeClients);
      }
    }

    if (prunedClients > 0 || totalClients > 10) {
      logger.info("SSE health check completed", {
        totalClients,
        prunedClients,
        heartbeatsSent,
        activeSessions: this.sseClients.size,
      });
    }
  }

  /**
   * Handle generic SSE requests for streaming responses
   */
  private handleGenericSSERequest(_c: unknown, sessionId: string): Response {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const now = Date.now();

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        streamController = controller;

        // Add client to SSE clients map with metadata
        if (!this.sseClients.has(sessionId)) {
          this.sseClients.set(sessionId, []);
        }

        const clientInfo = {
          controller,
          connectedAt: now,
          lastActivity: now,
        };

        this.sseClients.get(sessionId)!.push(clientInfo);

        // Send initial connection event
        const initialEvent = {
          type: "connection_opened",
          data: { sessionId, timestamp: new Date().toISOString() },
        };
        try {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify(initialEvent)}\n\n`,
            ),
          );
        } catch (error) {
          logger.error("Failed to send initial SSE event", { error });
        }

        logger.debug("SSE client connected", {
          sessionId,
          totalClients: this.sseClients.get(sessionId)!.length,
        });
      },
      cancel: () => {
        // Remove client from SSE clients map
        const clients = this.sseClients.get(sessionId);
        if (clients && streamController) {
          const filteredClients = clients.filter(
            (client) => client.controller !== streamController,
          );
          if (filteredClients.length === 0) {
            this.sseClients.delete(sessionId);
          } else {
            this.sseClients.set(sessionId, filteredClients);
          }

          logger.debug("SSE client disconnected", {
            sessionId,
            remainingClients: filteredClients.length,
          });
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Cache-Control",
      },
    });
  }
}
