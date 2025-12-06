import type { AgentRegistry as AgentRegistryType, AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { type SupervisorDefaults, supervisorDefaultsWrapped } from "@atlas/config";
import {
  AtlasAgentsMCPServer,
  AgentRegistry as CoreAgentRegistry,
  GlobalMCPServerPool,
  WorkspaceSessionStatus,
} from "@atlas/core";
import { CronManager } from "@atlas/cron";
import { DiscordIntegration, DiscordSignalRegistrar } from "@atlas/discord";
import { logger } from "@atlas/logger";
import { PlatformMCPServer } from "@atlas/mcp-server";
import { embeddingProviderForceDispose, embeddingProviderGetInstance } from "@atlas/memory";
import { flush as flushSentry } from "@atlas/sentry";
import { SlackIntegration, SlackSignalRegistrar } from "@atlas/slack";
import { WorkspaceManager } from "@atlas/workspace";
import type {
  WorkspaceSignalRegistrar,
  WorkspaceSignalTriggerCallback,
} from "@atlas/workspace/types";
import { StreamableHTTPTransport } from "@atlas-vendor/hono-mcp";
import type { Context, Next } from "hono";
import { cors } from "hono/cors";
import { DaemonCapabilityRegistry } from "../../../src/core/daemon-capabilities.ts";
import {
  createKVStorage,
  createLibraryStorage,
  createRegistryStorage,
  StorageConfigs,
} from "../../../src/core/storage/index.ts";
import type { LibraryStorageAdapter } from "../../../src/core/storage/library-storage-adapter.ts";
import { Workspace } from "../../../src/core/workspace.ts";
import { WorkspaceRuntime } from "../../../src/core/workspace-runtime.ts";
import { WorkspaceMemberRole } from "../../../src/types/core.ts";
import { AtlasMetrics } from "../../../src/utils/metrics.ts";
import { agents as agentsRoutes } from "../routes/agents/index.ts";
import { artifactsApp } from "../routes/artifacts.ts";
import chatRoutes from "../routes/chat.ts";
import { chatStorageRoutes } from "../routes/chat-storage.ts";
import { configRoutes } from "../routes/config.ts";
import { daemonApp } from "../routes/daemon.ts";
import { healthRoutes } from "../routes/health.ts";
import { libraryRoutes } from "../routes/library/index.ts";
import { scratchpadApp } from "../routes/scratchpad/index.ts";
import { sessionHistoryRoutes, sessionsRoutes } from "../routes/sessions/index.ts";
import { shareRoutes } from "../routes/share.ts";
import { streamsRoutes } from "../routes/streams/index.ts";
import { userRoutes } from "../routes/user/index.ts";
import { workspacesRoutes } from "../routes/workspaces/index.ts";
import { createApp } from "./factory.ts";
import { CronSignalRegistrar } from "./signal-registrars/cron-registrar.ts";
import { FsWatchSignalRegistrar } from "./signal-registrars/fs-watch-registrar.ts";
import { getAtlasDaemonUrl } from "./utils.ts";

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
export class AtlasDaemon {
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

  // Track stream metadata separately to persist after clients disconnect
  public sseStreams: Map<string, { createdAt: number; lastActivity: number; lastEmit: number }> =
    new Map();
  // Private properties
  private idleTimeouts: Map<string, number> = new Map();
  private isShuttingDown = false;
  private server: Deno.HttpServer | null = null;
  private signalHandlers: Array<{ signal: Deno.Signal; handler: () => void }> = [];
  private isInitialized = false;
  private supervisorDefaults: SupervisorDefaults | null = null;
  private libraryStorage: LibraryStorageAdapter | null = null;
  private cronManager: CronManager | null = null;
  private mcpServerPool: GlobalMCPServerPool | null = null;
  private workspaceManager: WorkspaceManager | null = null;
  private slackIntegration: SlackIntegration = new SlackIntegration();
  private discordIntegration: DiscordIntegration = new DiscordIntegration();
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
  private agentRegistry: AgentRegistryType | null = null;
  // Session limits
  private readonly MAX_AGENT_SESSIONS = 100;
  private readonly AGENT_SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
  // Store per-session Platform MCP servers and transports
  private platformMcpSessions = new Map<
    string,
    {
      server: PlatformMCPServer;
      transport: StreamableHTTPTransport;
      createdAt: number;
      lastUsed: number;
    }
  >();
  private platformSessionCleanupInterval: number | null = null;
  // Platform session limits
  private readonly MAX_PLATFORM_SESSIONS = 100;
  private readonly PLATFORM_SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
  // Store the actual port after server starts
  #port: number | undefined;

  constructor(options: AtlasDaemonOptions = {}) {
    this.options = {
      maxConcurrentWorkspaces: 10,
      idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
      sseHeartbeatIntervalMs: 30 * 1000, // 30 seconds
      sseConnectionTimeoutMs: 5 * 60 * 1000, // 5 minutes
      ...options,
    };
    const context = {
      runtimes: this.runtimes,
      startTime: this.startTime,
      sseClients: this.sseClients,
      sseStreams: this.sseStreams,
      getWorkspaceManager: this.getWorkspaceManager.bind(this),
      getOrCreateWorkspaceRuntime: this.getOrCreateWorkspaceRuntime.bind(this),
      resetIdleTimeout: this.resetIdleTimeout.bind(this),
      getWorkspaceRuntime: this.getWorkspaceRuntime.bind(this),
      destroyWorkspaceRuntime: this.destroyWorkspaceRuntime.bind(this),
      getLibraryStorage: this.getLibraryStorage.bind(this),
      daemon: this,
    };
    this.app = createApp(context);
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
      throw new Error("WorkspaceManager not initialized. Call initialize() first.");
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

    // Create WorkspaceManager (initialize later once registrars and watcher are ready)
    logger.info("Creating WorkspaceManager...");
    const registry = await createRegistryStorage(StorageConfigs.defaultKV());
    this.workspaceManager = new WorkspaceManager(registry);

    // Initialize LibraryStorage with hybrid storage
    logger.info("Initializing LibraryStorage...");
    this.libraryStorage = await createLibraryStorage(StorageConfigs.defaultKV(), {
      // Use XDG-compliant default location, but allow environment override
      contentDir: Deno.env.get("ATLAS_LIBRARY_DIR"),
      organizeByDate: true,
    });

    // Initialize daemon-level capabilities
    logger.info("Initializing daemon capabilities...");
    DaemonCapabilityRegistry.setDaemonInstance(this);
    DaemonCapabilityRegistry.initialize();

    // Initialize CronManager with KV storage
    logger.info("Initializing CronManager...");
    const kvStorageConfig = StorageConfigs.defaultKV();
    const kvStorage = await createKVStorage(kvStorageConfig); // createKVStorage now calls initialize()
    this.cronManager = new CronManager(kvStorage, logger);

    // Initialize Global MCP Server Pool
    logger.info("Initializing Global MCP Server Pool...");
    this.mcpServerPool = new GlobalMCPServerPool(logger);

    // Initialize agent registry with bundled agents
    logger.info("Initializing agent registry...");
    const agentRegistry = new CoreAgentRegistry({ includeSystemAgents: true });
    await agentRegistry.initialize();
    logger.info("Agent registry initialized");
    this.agentRegistry = agentRegistry;

    // Set up workspace wakeup callback
    const wakeupCallback: WorkspaceSignalTriggerCallback = async (
      workspaceId: string,
      signalId: string,
      signalData,
    ) => {
      try {
        await this.triggerWorkspaceSignal(workspaceId, signalId, signalData);

        logger.info("Signal processed", { workspaceId, signalId });
      } catch (error) {
        logger.error("Failed to process signal", { error, workspaceId, signalId });
        // Store error details and clean up immediately
        try {
          const manager = this.getWorkspaceManager();
          const workspace = await manager.find({ id: workspaceId });

          // Update status with error tracking (mark as inactive)
          await manager.updateWorkspaceStatus(workspaceId, "inactive", {
            metadata: {
              ...workspace?.metadata,
              lastError: error instanceof Error ? error.message : String(error),
              lastErrorAt: new Date().toISOString(),
              failureCount: (workspace?.metadata?.failureCount || 0) + 1,
            },
          });

          logger.info("Marked workspace as failed with error details", {
            workspaceId,
            signalId,
            error: error,
            failureCount: (workspace?.metadata?.failureCount || 0) + 1,
          });

          // Clean up the failed runtime immediately
          await this.destroyWorkspaceRuntime(workspaceId);
          logger.info("Cleaned up failed workspace runtime", { workspaceId });
        } catch (statusError) {
          logger.error("Failed to update workspace status or cleanup", {
            workspaceId,
            statusError,
          });
        }
      }
    };

    this.cronManager.setWakeupCallback(wakeupCallback);

    // Create signal registrars and pass them to WorkspaceManager.initialize
    const fsRegistrar = new FsWatchSignalRegistrar(wakeupCallback);
    const cronRegistrar = new CronSignalRegistrar(this.cronManager);
    const discordRegistrar = new DiscordSignalRegistrar();

    // Initialize Slack integration (self-contained config loading)
    const slackRegistrar = new SlackSignalRegistrar(logger.child({ component: "slack-registrar" }));
    await this.slackIntegration.initialize(slackRegistrar, wakeupCallback, this);

    // Initialize Discord integration (before workspace loading so it can mount HTTP handler)
    await this.discordIntegration.initialize(
      discordRegistrar,
      this.workspaceManager,
      wakeupCallback,
      this,
    );

    // Mount Discord HTTP handler after initialization
    const discordHandler = this.discordIntegration.getHttpHandler();
    if (discordHandler) {
      this.app.route("/signal/discord", discordHandler);
      logger.info("Discord webhook endpoint mounted at /signal/discord/interactions");
    }

    // Build registrars array with Discord always included, Slack conditionally
    const signalRegistrars: WorkspaceSignalRegistrar[] = [
      fsRegistrar,
      cronRegistrar,
      discordRegistrar,
    ];
    if (this.slackIntegration.getRegistrar()) {
      signalRegistrars.push(slackRegistrar);
    }

    // Initialize WorkspaceManager with registrars and watcher (manager owns lifecycle)
    await this.workspaceManager.initialize(signalRegistrars);

    // Register Discord commands now that workspaces are loaded
    await this.discordIntegration.registerCommands();

    // Start CronManager
    await this.cronManager.start();

    // Start SSE health check interval
    this.startSSEHealthCheck();

    // Start agent session cleanup interval
    this.startAgentSessionCleanup();

    // Start platform session cleanup interval
    this.startPlatformSessionCleanup();

    // Start embedding model download in background (non-blocking)
    // This prevents the first conversation from being blocked by model downloads
    logger.info("Starting background initialization of global embedding provider...");
    embeddingProviderGetInstance()
      .then(() => {
        logger.info("Global embedding provider initialized successfully in background");
      })
      .catch((error) => {
        logger.error("Failed to initialize global embedding provider in background", { error });
        // Continue daemon startup - memory features will initialize lazily when needed
      });

    // Initialize OTEL metrics
    await AtlasMetrics.init();
    if (AtlasMetrics.enabled) {
      // Register observable gauge providers
      AtlasMetrics.registerActiveWorkspacesProvider(() => this.runtimes.size);
      AtlasMetrics.registerSSEConnectionsProvider(() => {
        let count = 0;
        for (const clients of this.sseClients.values()) {
          count += clients.length;
        }
        return count;
      });
      AtlasMetrics.registerUptimeProvider(() => Math.floor((Date.now() - this.startTime) / 1000));
      logger.info("OTEL metrics providers registered");
    }

    this.isInitialized = true;
    logger.info("Atlas daemon initialized");
  }

  // fs-watch registration moved to signal registrars

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
   * Get or create per-session MCP server
   */
  private async getOrCreateAgentSession(
    sessionId: string,
  ): Promise<{ server: AtlasAgentsMCPServer; transport: StreamableHTTPTransport }> {
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
      agentRegistry: (() => {
        const registry = this.agentRegistry;
        if (!registry) throw new Error("Agent registry not initialized");
        return registry;
      })(),
      mcpServerPool: (() => {
        const pool = this.mcpServerPool;
        if (!pool) throw new Error("MCP server pool not initialized");
        return pool;
      })(),
      sessionId,
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
   * Get or create per-session Platform MCP server
   * Mirrors getOrCreateAgentSession pattern exactly
   */
  private async getOrCreatePlatformSession(
    sessionId: string,
  ): Promise<{ server: PlatformMCPServer; transport: StreamableHTTPTransport }> {
    const existing = this.platformMcpSessions.get(sessionId);
    if (existing) {
      existing.lastUsed = Date.now();
      return { server: existing.server, transport: existing.transport };
    }

    // Create new session
    logger.info("[Daemon] Creating new Platform MCP session", { sessionId });

    // Create transport
    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: () => sessionId,
      onsessioninitialized: (sid) => {
        logger.info("[Daemon] Platform session initialized", { sessionId: sid });
      },
    });

    // Create per-session Platform MCP server
    const daemonUrl = getAtlasDaemonUrl();
    const server = new PlatformMCPServer({
      daemonUrl,
      logger: logger.child({ component: "platform-mcp-server", sessionId }),
      workspaceProvider: {
        getOrCreateRuntime: (id: string) => this.getOrCreateWorkspaceRuntime(id),
      },
      workspaceConfigProvider: {
        getWorkspaceConfig: (id: string) => this.getWorkspaceManager().getWorkspaceConfig(id),
      },
    });

    // Connect to MCP server
    await server.getServer().connect(transport);

    // Store session
    this.platformMcpSessions.set(sessionId, {
      server,
      transport,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    });

    // Set up cleanup
    transport.onclose = () => {
      logger.info("[Daemon] Platform session closed", { sessionId });
      this.cleanupPlatformSession(sessionId);
    };

    return { server, transport };
  }

  /**
   * Clean up platform session
   */
  private cleanupPlatformSession(sessionId: string): void {
    const session = this.platformMcpSessions.get(sessionId);
    if (session) {
      // Platform MCP Server doesn't have explicit stop() - just remove from map
      this.platformMcpSessions.delete(sessionId);
      logger.info("[Daemon] Platform session cleaned up", { sessionId });
    }
  }

  /**
   * Initialize the daemon - load supervisor defaults, initialize WorkspaceManager, etc.
   * Must be called before start()
   */

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
   * Get library storage instance
   */
  public getLibraryStorage(): LibraryStorageAdapter {
    if (!this.libraryStorage) {
      throw new Error("Library storage not initialized");
    }
    return this.libraryStorage;
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

      const message = `HTTP ${method} ${path}`;
      const context = { method, path, status, duration: `${duration}ms`, component: "http" };

      if (status >= 400) {
        logger.error(message, context);
      } else {
        logger.info(message, context);
      }
    });

    this.app.route("/health", healthRoutes);
    this.app.route("/api/workspaces", workspacesRoutes);
    this.app.route("/api/artifacts", artifactsApp);
    this.app.route("/api/chat", chatRoutes);
    this.app.route("/api/chat-storage", chatStorageRoutes);
    this.app.route("/api/config", configRoutes);
    this.app.route("/api/user", userRoutes);
    this.app.route("/api/scratchpad", scratchpadApp);
    this.app.route("/api/sessions", sessionsRoutes);
    this.app.route("/api/sessions-history", sessionHistoryRoutes);
    this.app.route("/api/agents", agentsRoutes);
    this.app.route("/api/sse", streamsRoutes);
    this.app.route("/api/library", libraryRoutes);
    this.app.route("/api/daemon", daemonApp);
    this.app.route("/api/share", shareRoutes);

    // Discord signal route will be mounted at /signal/discord after initialization in initialize() method

    // Global error handler - catches all uncaught errors from all routes
    this.app.onError((err, c) => {
      logger.error("API error", { error: err, path: c.req.path, method: c.req.method });
      return c.json({ error: "Internal server error" }, 500);
    });

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
          const sessionId = c.req.header("mcp-session-id");

          // For new sessions (no session ID on POST), generate one
          if (!sessionId && c.req.method === "POST") {
            const newSessionId = crypto.randomUUID();
            logger.info("Creating new Platform MCP session", { sessionId: newSessionId });

            // Create and store the session
            const { transport } = await this.getOrCreatePlatformSession(newSessionId);

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
            const { transport } = await this.getOrCreatePlatformSession(sessionId);

            // Handle DELETE specially - clean up after processing
            if (c.req.method === "DELETE") {
              logger.info("Terminating Platform MCP session", { sessionId });
              const response = await transport.handleRequest(c);
              this.cleanupPlatformSession(sessionId);
              return response;
            }

            // Handle the request
            return transport.handleRequest(c);
          } else {
            // No session ID and not a POST request - this is an error
            logger.error("[Daemon] Invalid request - no session ID for non-POST", {
              method: c.req.method,
            });
            return c.json(
              {
                jsonrpc: "2.0",
                error: { code: -32000, message: "Session ID required for non-initialize requests" },
                id: null,
              },
              400,
            );
          }
        } catch (error) {
          logger.error("Platform MCP endpoint error", { error });
          return c.json(
            {
              error: `Platform MCP server error: ${error instanceof Error ? error.message : String(error)}`,
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
            logger.info("Creating new SSE session for Agent Server", { sessionId: newSessionId });

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
              logger.info("Establishing SSE connection to Agent Server", { sessionId });
              this.agentSSEConnections.add(sessionId);
            }

            // Handle DELETE specially - clean up after processing
            if (c.req.method === "DELETE") {
              logger.info("Terminating Agent Server SSE session", { sessionId });
              const response = await transport.handleRequest(c);
              await this.cleanupAgentSession(sessionId);
              return response;
            }

            // Handle the request
            return transport.handleRequest(c);
          } else {
            // No session ID and not a POST request - this is an error
            logger.error("[Daemon] Invalid request - no session ID for non-POST", {
              method: c.req.method,
            });
            return c.json(
              {
                jsonrpc: "2.0",
                error: { code: -32000, message: "Session ID required for non-initialize requests" },
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
  }

  /**
   * Get or create a workspace runtime on-demand
   */
  async getOrCreateWorkspaceRuntime(workspaceId: string): Promise<WorkspaceRuntime> {
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
          { workspaceId },
        );
      }

      // Check if runtime already exists
      let runtime = this.runtimes.get(workspaceId);
      if (runtime) {
        logger.debug("Found existing runtime", { workspaceId });
        return runtime;
      }

      // Get workspace manager
      const manager = this.getWorkspaceManager();

      // Check if workspace is inactive due to prior error and clear error fields on recovery
      let workspace = await manager.find({ id: workspaceId });
      if (workspace?.status === "inactive") {
        logger.info("Recovering inactive workspace, clearing error fields", {
          workspaceId,
          lastError: workspace.metadata?.lastError,
          failureCount: workspace.metadata?.failureCount,
        });

        // Clear error fields since we're attempting recovery
        await manager.updateWorkspaceStatus(workspaceId, "inactive", {
          metadata: {
            ...workspace.metadata,
            lastError: undefined,
            lastErrorAt: undefined,
            failureCount: undefined,
          },
        });
      }

      // Check concurrent workspace limit
      if (this.runtimes.size >= (this.options.maxConcurrentWorkspaces ?? 10)) {
        logger.warn("Maximum concurrent workspaces reached, attempting eviction", {
          maxConcurrentWorkspaces: this.options.maxConcurrentWorkspaces,
        });
        // Find the oldest idle workspace to evict
        const oldestWorkspace = this.findOldestIdleWorkspace();
        if (oldestWorkspace) {
          logger.info("Evicting oldest idle workspace", { workspaceId: oldestWorkspace });
          await this.destroyWorkspaceRuntime(oldestWorkspace);
        } else {
          const error = "Maximum concurrent workspaces reached";
          logger.error(error, { maxConcurrentWorkspaces: this.options.maxConcurrentWorkspaces });
          throw new Error(`${error} (${this.options.maxConcurrentWorkspaces})`);
        }
      }

      // Find workspace in registry (if not already found)
      logger.debug("Looking up workspace in registry", { workspaceId });
      if (!workspace) {
        workspace =
          (await manager.find({ id: workspaceId })) || (await manager.find({ name: workspaceId }));
      }

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
            throw new Error(`Workspace path is not a directory: ${workspace.path}`);
          }
        } catch (error) {
          logger.error("Failed to access workspace path", { error, workspacePath: workspace.path });
          throw new Error(`Workspace path does not exist: ${workspace.path}`);
        }
      } else {
        logger.debug("Loading system workspace", { workspaceId: workspace.id });
      }

      // Load configuration using the new WorkspaceManager
      const mergedConfig = await manager.getWorkspaceConfig(workspace.id);
      if (!mergedConfig) {
        throw new Error(`Failed to load workspace configuration: ${workspace.id}`);
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
        onSessionFinished: async ({ workspaceId, sessionId, status, finishedAt, summary }) => {
          // Record session completion metric
          if (status === "completed" || status === "failed" || status === "cancelled") {
            AtlasMetrics.recordSession(status);
          }

          try {
            const mgr = this.getWorkspaceManager();
            const ws = await mgr.find({ id: workspaceId });

            // Mark workspace as stopped when a session finishes normally
            await mgr.updateWorkspaceStatus(workspaceId, "stopped", {
              metadata: {
                ...ws?.metadata,
                lastFinishedSession: { id: sessionId, status, finishedAt, summary },
              },
            });

            // If there are no active sessions left, destroy the runtime so status won't be overridden to "running"
            const currentRuntime = this.runtimes.get(workspaceId);
            if (currentRuntime) {
              const sessions = currentRuntime.getSessions();
              const hasActive = sessions.some(
                (s) =>
                  s.status === WorkspaceSessionStatus.EXECUTING ||
                  s.status === WorkspaceSessionStatus.PENDING,
              );

              if (!hasActive) {
                await this.destroyWorkspaceRuntime(workspaceId);
              } else {
                // Still active sessions; keep idle timer fresh
                this.resetIdleTimeout(workspaceId);
              }
            }
          } catch (error) {
            logger.warn("Failed to persist lastFinishedSession or update status", {
              workspaceId,
              sessionId,
              error,
            });
          }
        },
      });
      logger.debug("WorkspaceRuntime created", { workspaceId: workspace.id });

      this.runtimes.set(workspace.id, runtime);
      logger.debug("Runtime stored in daemon registry", { workspaceId: workspace.id });

      // Register runtime with WorkspaceManager
      await manager.registerRuntime(workspace.id, runtime);
      logger.debug("Runtime registered with WorkspaceManager", { workspaceId: workspace.id });

      // Watcher is managed centrally by WorkspaceManager.initialize()

      // Set idle timeout
      this.resetIdleTimeout(workspace.id);
      logger.debug("Idle timeout set", { workspaceId: workspace.id });

      logger.info("Runtime created", { workspaceId: workspace.id, workspaceName: workspace.name });

      return runtime;
    } catch (error) {
      logger.error("Failed to create workspace runtime", { error, workspaceId });

      // Clean up on failure to prevent inconsistent state
      try {
        // Remove runtime from local registry if it was added
        if (this.runtimes.has(workspaceId)) {
          this.runtimes.delete(workspaceId);
          logger.debug("Removed failed runtime from daemon registry", { workspaceId });
        }

        // Unregister from WorkspaceManager and revert status to stopped
        try {
          const mgr = this.getWorkspaceManager();
          await mgr.unregisterRuntime(workspaceId);
          logger.debug("Unregistered failed runtime from WorkspaceManager", { workspaceId });
        } catch (unregisterError) {
          // Runtime might not have been registered yet
          logger.debug("Could not unregister runtime (may not have been registered)", {
            workspaceId,
            error: unregisterError,
          });
        }

        // Clear idle timeout if it was set
        const timeoutId = this.idleTimeouts.get(workspaceId);
        if (timeoutId) {
          clearTimeout(timeoutId);
          this.idleTimeouts.delete(workspaceId);
          logger.debug("Cleared idle timeout for failed workspace", { workspaceId });
        }
      } catch (cleanupError) {
        logger.error("Error during failed workspace cleanup", { workspaceId, cleanupError });
      }

      throw error;
    }
  }

  /**
   * Trigger a workspace signal and handle lifecycle updates (lastSeen, idle timeout)
   *
   * @param workspaceId - Workspace ID to trigger signal in
   * @param signalId - Signal ID to trigger
   * @param payload - Signal payload data
   * @param streamId - Optional stream ID for conversation context
   * @param onStreamEvent - Optional callback for streaming responses (used by Discord, web chat, etc)
   * @returns Session ID for tracking the triggered signal
   */
  public async triggerWorkspaceSignal(
    workspaceId: string,
    signalId: string,
    payload?: Record<string, unknown>,
    streamId?: string,
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void,
  ): Promise<{ sessionId: string }> {
    const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);

    // Check if there are already active sessions for this signal
    // This prevents concurrent executions when cron timers fire while previous sessions are still running
    if (runtime.hasActiveSessionsForSignal(signalId)) {
      logger.warn(
        "Skipping signal trigger - workspace already has active session for this signal",
        { workspaceId, signalId },
      );
      throw new Error(
        `Workspace ${workspaceId} already has an active session processing signal ${signalId}`,
      );
    }

    const session = await runtime.triggerSignalWithSession(
      signalId,
      payload || {},
      streamId,
      onStreamEvent,
    );

    // Record signal trigger metric by provider type (http, schedule, slack, etc.)
    const signalProvider = runtime.getSignalProvider(signalId) ?? "unknown";
    AtlasMetrics.recordSignalTrigger(signalProvider);

    try {
      const manager = this.getWorkspaceManager();
      await manager.updateWorkspaceLastSeen(runtime.workspaceId);
    } catch (error) {
      logger.warn("Failed to update lastSeen for workspace", {
        workspaceId: runtime.workspaceId,
        error,
      });
    }

    this.resetIdleTimeout(runtime.workspaceId);

    return { sessionId: session.id };
  }

  /**
   * Wait for a workspace session to complete with timeout
   *
   * Default timeout: 30 seconds (allows reasonable time for agent processing)
   *
   * @returns true if session completed successfully, false if timeout/error/not found
   */
  public async waitForSignalCompletion(
    workspaceId: string,
    sessionId: string,
    timeoutMs = 30_000,
  ): Promise<boolean> {
    const runtime = this.getWorkspaceRuntime(workspaceId);
    if (!runtime) {
      logger.error("Workspace runtime not found", { workspaceId, sessionId });
      return false;
    }

    const sessions = runtime.getSessions();
    const session = sessions.find((s) => s.id === sessionId);

    if (!session) {
      // Session not found - might have been cleaned up already
      logger.debug("Session not found (may have been cleaned up)", { workspaceId, sessionId });
      return false;
    }

    // Create timeout promise that rejects after specified duration
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), timeoutMs),
    );

    // Wait for session to reach terminal state (completed, failed, cancelled) or timeout
    try {
      await Promise.race([session.waitForCompletion(), timeoutPromise]);
      return true;
    } catch (error) {
      const isTimeout = error instanceof Error && error.message === "timeout";
      logger.error(isTimeout ? "Session timed out" : "Session failed", {
        error,
        sessionId,
        workspaceId,
        timeoutMs: isTimeout ? timeoutMs : undefined,
      });
      return false;
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
    const timeoutId = setTimeout(
      () => {
        this.checkAndDestroyIdleWorkspace(workspaceId);
      },
      this.options.idleTimeoutMs ?? 5 * 60 * 1000,
    );

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

    try {
      await runtime.shutdown();
    } catch (error) {
      logger.error("Error shutting down workspace runtime", { error, workspaceId });
    }

    this.runtimes.delete(workspaceId);

    // Unregister runtime from WorkspaceManager
    const manager = this.getWorkspaceManager();
    await manager.unregisterRuntime(workspaceId);

    // Ensure final status reflects stopped after teardown
    try {
      await manager.updateWorkspaceStatus(workspaceId, "stopped");
    } catch (error) {
      logger.warn("Failed to set workspace stopped after destroy", { workspaceId, error });
    }

    // Clear idle timeout
    const timeoutId = this.idleTimeouts.get(workspaceId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.idleTimeouts.delete(workspaceId);
    }

    logger.info("Workspace runtime destroyed", { workspaceId });
  }

  private setupSignalHandlers() {
    const daemonId = crypto.randomUUID().slice(0, 8);

    const handleShutdown = (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      logger.info("Daemon received signal, shutting down gracefully", { daemonId, signal });

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
          logger.info("Atlas daemon running", { hostname, port });
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
    const shutdownPromises = Array.from(this.runtimes.keys()).map((workspaceId) =>
      this.destroyWorkspaceRuntime(workspaceId),
    );
    await Promise.all(shutdownPromises);

    // Clear all idle timeouts
    for (const timeoutId of this.idleTimeouts.values()) {
      clearTimeout(timeoutId);
    }
    this.idleTimeouts.clear();

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

    // Stop platform session cleanup
    if (this.platformSessionCleanupInterval) {
      clearInterval(this.platformSessionCleanupInterval);
      this.platformSessionCleanupInterval = null;
    }

    // Close all SSE connections
    for (const [sessionId, clients] of this.sseClients.entries()) {
      for (const client of clients) {
        try {
          client.controller.close();
        } catch (error) {
          logger.debug("Error closing SSE client for session", { error, sessionId });
        }
      }
    }
    this.sseClients.clear();
    this.sseStreams.clear();

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

    // Clean up platform sessions
    for (const sessionId of this.platformMcpSessions.keys()) {
      try {
        this.cleanupPlatformSession(sessionId);
      } catch (error) {
        logger.debug("Error cleaning up platform session", { error, sessionId });
      }
    }
    this.platformMcpSessions.clear();

    // Shutdown CronManager
    if (this.cronManager) {
      await this.cronManager.shutdown();
      this.cronManager = null;
    }

    // Shutdown Discord integration
    await this.discordIntegration.shutdown();

    // Shutdown Slack integration
    await this.slackIntegration.shutdown();

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

    // Dispose global embedding provider
    try {
      await embeddingProviderForceDispose();
      logger.info("Global embedding provider disposed");
    } catch (error) {
      logger.error("Failed to dispose global embedding provider", { error });
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

    // Flush Sentry events before exit
    await flushSentry(2000);

    logger.info("Atlas daemon shutdown complete");
  }

  // Status getters
  getActiveWorkspaces(): string[] {
    return Array.from(this.runtimes.keys());
  }

  getWorkspaceRuntime(workspaceId: string): WorkspaceRuntime | undefined {
    return this.runtimes.get(workspaceId);
  }

  getStatus() {
    const cronStats = this.cronManager?.getStats();

    return {
      activeWorkspaces: this.runtimes.size,
      uptime: Date.now() - this.startTime,
      cronManager: cronStats
        ? { isActive: this.cronManager?.isRunning || false, ...cronStats }
        : null,
      configuration: {
        maxConcurrentWorkspaces: this.options.maxConcurrentWorkspaces,
        idleTimeoutMs: this.options.idleTimeoutMs ?? 0,
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
      const remainingClients = clients.filter((c) => !disconnectedClients.includes(c));
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

    this.sseHealthCheckInterval = setInterval(
      () => {
        this.performSSEHealthCheck();
      },
      this.options.sseHeartbeatIntervalMs ?? 30 * 1000,
    );

    logger.info("SSE health check started", { intervalMs: this.options.sseHeartbeatIntervalMs });
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

      const toEvict = sortedSessions.slice(0, this.agentSessions.size - this.MAX_AGENT_SESSIONS);

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
   * Start platform session cleanup interval
   */
  private startPlatformSessionCleanup(): void {
    if (this.platformSessionCleanupInterval) {
      clearInterval(this.platformSessionCleanupInterval);
    }

    // Check every minute for stale sessions
    this.platformSessionCleanupInterval = setInterval(() => {
      this.performPlatformSessionCleanup();
    }, 60000);

    logger.info("Platform session cleanup started", {
      intervalMs: 60000,
      maxSessions: this.MAX_PLATFORM_SESSIONS,
      timeoutMs: this.PLATFORM_SESSION_TIMEOUT_MS,
    });
  }

  /**
   * Clean up stale platform sessions
   */
  private performPlatformSessionCleanup(): void {
    const now = Date.now();
    const sessionsToCleanup: string[] = [];

    // Find stale sessions
    for (const [sessionId, session] of this.platformMcpSessions) {
      if (now - session.lastUsed > this.PLATFORM_SESSION_TIMEOUT_MS) {
        sessionsToCleanup.push(sessionId);
      }
    }

    // Clean up stale sessions
    if (sessionsToCleanup.length > 0) {
      logger.info("Cleaning up stale platform sessions", {
        count: sessionsToCleanup.length,
        totalSessions: this.platformMcpSessions.size,
      });

      for (const sessionId of sessionsToCleanup) {
        this.cleanupPlatformSession(sessionId);
      }
    }

    // Enforce session limit (LRU eviction)
    if (this.platformMcpSessions.size > this.MAX_PLATFORM_SESSIONS) {
      const sortedSessions = Array.from(this.platformMcpSessions.entries()).sort(
        (a, b) => a[1].lastUsed - b[1].lastUsed,
      );

      const toEvict = sortedSessions.slice(
        0,
        this.platformMcpSessions.size - this.MAX_PLATFORM_SESSIONS,
      );

      logger.warn("Evicting LRU platform sessions due to limit", {
        evictionCount: toEvict.length,
        totalSessions: this.platformMcpSessions.size,
        maxSessions: this.MAX_PLATFORM_SESSIONS,
      });

      for (const [sessionId] of toEvict) {
        this.cleanupPlatformSession(sessionId);
      }
    }
  }

  /**
   * Perform SSE health check - send heartbeat and prune stale connections
   */
  private performSSEHealthCheck(): void {
    const now = Date.now();
    const clientTimeoutMs = this.options.sseConnectionTimeoutMs ?? 5 * 60 * 1000;
    const streamInactivityMs = 5 * 60 * 1000; // 5 minutes for stream inactivity
    let totalClients = 0;
    let prunedClients = 0;
    let heartbeatsSent = 0;
    let prunedStreams = 0;

    // First, clean up inactive streams
    for (const [streamId, streamMeta] of this.sseStreams.entries()) {
      const inactiveTime = now - streamMeta.lastActivity;

      if (inactiveTime > streamInactivityMs) {
        // Stream has been inactive for too long, remove it
        this.sseStreams.delete(streamId);

        // Also remove any lingering clients
        const clients = this.sseClients.get(streamId);
        if (clients) {
          for (const client of clients) {
            try {
              client.controller.close();
            } catch {
              // Ignore close errors
            }
          }
          this.sseClients.delete(streamId);
        }

        prunedStreams++;
        logger.info("Closed inactive stream after timeout", {
          streamId,
          inactiveMinutes: Math.round(inactiveTime / 60000),
          createdAt: new Date(streamMeta.createdAt).toISOString(),
          lastActivity: new Date(streamMeta.lastActivity).toISOString(),
        });
      }
    }

    // Then, handle client health checks
    for (const [sessionId, clients] of this.sseClients.entries()) {
      const activeClients: typeof clients = [];

      for (const client of clients) {
        totalClients++;

        // Check if connection is stale
        if (now - client.lastActivity > clientTimeoutMs) {
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
            const heartbeat = { type: "heartbeat", data: { timestamp: new Date().toISOString() } };
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
            logger.debug("Pruned disconnected SSE client during heartbeat", { sessionId, error });
          }
        }
      }

      // Update client list but DON'T remove the session even if no clients
      // The stream metadata tracks activity separately
      if (activeClients.length === 0) {
        this.sseClients.delete(sessionId);
        // Stream metadata persists in sseStreams map
      } else {
        this.sseClients.set(sessionId, activeClients);
      }
    }

    if (prunedClients > 0 || prunedStreams > 0 || totalClients > 10) {
      logger.info("SSE health check completed", {
        totalClients,
        prunedClients,
        prunedStreams,
        heartbeatsSent,
        activeClientSessions: this.sseClients.size,
        totalStreams: this.sseStreams.size,
      });
    }
  }
}
