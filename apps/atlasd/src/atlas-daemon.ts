import { cp, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process, { env } from "node:process";
import {
  type ActivityStorageAdapter,
  createActivityLedgerClient,
} from "@atlas/activity";
import { LocalActivityAdapter } from "@atlas/activity/local-adapter";
import type {
  AgentRegistry as AgentRegistryType,
  AtlasUIMessageChunk,
} from "@atlas/agent-sdk";
import { createAnalyticsClient } from "@atlas/analytics";
import { FilesystemAtlasConfigSource } from "@atlas/config/server";
import {
  AgentRegistry as CoreAgentRegistry,
  AtlasAgentsMCPServer,
  convertLLMToAgent,
  LocalSessionHistoryAdapter,
  SessionFailedError,
  WorkspaceNotFoundError,
  WorkspaceSessionStatus,
  wrapAtlasAgent,
} from "@atlas/core";
import { CronManager } from "@atlas/cron";
import type { ResourceStorageAdapter } from "@atlas/ledger";
import {
  createPlatformModels,
  type PlatformModels,
  prewarmCatalog,
} from "@atlas/llm";
import { logger } from "@atlas/logger";
import { PlatformMCPServer } from "@atlas/mcp-server";
import { createLedgerClient } from "@atlas/resources/ledger-client";
import { flush as flushSentry } from "@atlas/sentry";
import type { LibraryStorageAdapter } from "@atlas/storage";
import { getAtlasHome } from "@atlas/utils/paths.server";
import {
  createKVStorage,
  createLibraryStorage,
  createRegistryStorage,
  type ImproverAgentInput,
  type ImproverAgentResult,
  ImproverResultDataSchema,
  StorageConfigs,
  validateMCPEnvironmentForWorkspace,
  WorkspaceManager,
  WorkspaceRuntime,
} from "@atlas/workspace";
import { buildAgent, resolveSdkPath } from "@atlas/workspace/agent-builder";
import type {
  WorkspaceSignalRegistrar,
  WorkspaceSignalTriggerCallback,
} from "@atlas/workspace/types";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { Context, Next } from "hono";
import { cors } from "hono/cors";
import { activityRoutes } from "../routes/activity.ts";
import { agents as agentsRoutes } from "../routes/agents/index.ts";
import { artifactsApp } from "../routes/artifacts.ts";
import chatRoutes from "../routes/chat.ts";
import { chatStorageRoutes } from "../routes/chat-storage.ts";
import {
  chunkedUploadApp,
  initChunkedUpload,
  shutdownChunkedUpload,
} from "../routes/chunked-upload.ts";
import { configRoutes } from "../routes/config.ts";
import { daemonApp } from "../routes/daemon.ts";
import { healthRoutes } from "../routes/health.ts";
import { jobsRoutes } from "../routes/jobs.ts";
import { libraryRoutes } from "../routes/library/index.ts";
import { linkRoutes } from "../routes/link.ts";
import { mcpRegistryRouter } from "../routes/mcp-registry.ts";
import { meRoutes } from "../routes/me/index.ts";
import { memoryNarrativeRoutes } from "../routes/memory/index.ts";
import reportRoutes from "../routes/report.ts";
import { scheduleExpandRoutes } from "../routes/schedule-expand.ts";
import { scratchpadApp } from "../routes/scratchpad/index.ts";
import { sessionsRoutes } from "../routes/sessions/index.ts";
import { shareRoutes } from "../routes/share.ts";
import { createPlatformSignalRoutes } from "../routes/signals/platform.ts";
import { skillsRoutes } from "../routes/skills.ts";
import { userRoutes } from "../routes/user/index.ts";
import workspaceChatRoutes from "../routes/workspaces/chat.ts";
import { configRoutes as workspaceConfigRoutes } from "../routes/workspaces/config.ts";
import { workspacesRoutes } from "../routes/workspaces/index.ts";
import { integrationRoutes } from "../routes/workspaces/integrations.ts";
import { CapabilityHandlerRegistry } from "./capability-handlers.ts";
import type { PlatformCredentials } from "./chat-sdk/adapter-factory.ts";
import {
  type ChatSdkInstance,
  type ChatSdkInstanceConfig,
  initializeChatSdkInstance,
  resolveDiscordCredentials,
  resolvePlatformCredentials,
} from "./chat-sdk/chat-sdk-instance.ts";
import { DiscordGatewayService } from "./discord-gateway-service.ts";
import { createApp } from "./factory.ts";
import { NatsManager } from "./nats-manager.ts";
import { ProcessAgentExecutor } from "./process-agent-executor.ts";
import { SessionStreamRegistry } from "./session-stream-registry.ts";
import { CronSignalRegistrar } from "./signal-registrars/cron-registrar.ts";
import { FsWatchSignalRegistrar } from "./signal-registrars/fs-watch-registrar.ts";
import { StreamRegistry } from "./stream-registry.ts";
import { AtlasMetrics } from "./utils/metrics.ts";
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
  public sseStreams: Map<
    string,
    { createdAt: number; lastActivity: number; lastEmit: number }
  > = new Map();
  // Private properties
  private idleTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private isShuttingDown = false;
  private server: Deno.HttpServer | null = null;
  private signalHandlers: Array<{ signal: Deno.Signal; handler: () => void }> =
    [];
  private isInitialized = false;
  private platformModels: PlatformModels | null = null;
  private libraryStorage: LibraryStorageAdapter | null = null;
  private natsManager: NatsManager | null = null;
  private capabilityRegistry: CapabilityHandlerRegistry | null = null;
  private processAgentExecutor: ProcessAgentExecutor | null = null;
  private cronManager: CronManager | null = null;
  private workspaceManager: WorkspaceManager | null = null;
  private resourceStorage: ResourceStorageAdapter | null = null;
  private activityAdapter: ActivityStorageAdapter | null = null;
  public streamRegistry!: StreamRegistry;
  public sessionStreamRegistry!: SessionStreamRegistry;
  public sessionHistoryAdapter!: LocalSessionHistoryAdapter;
  private chatSdkInstances = new Map<string, Promise<ChatSdkInstance>>();
  private sseHealthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private agentSessionCleanupInterval: ReturnType<typeof setInterval> | null =
    null;
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
  private platformSessionCleanupInterval:
    | ReturnType<typeof setInterval>
    | null = null;
  // Platform session limits
  private readonly MAX_PLATFORM_SESSIONS = 100;
  private readonly PLATFORM_SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
  // Store the actual port after server starts
  #port: number | undefined;
  private discordGatewayService: DiscordGatewayService | null = null;

  constructor(options: AtlasDaemonOptions = {}) {
    // Read CORS origins from environment or options
    // Environment variable takes precedence for production deployments
    const envCorsOrigins = env.CORS_ALLOWED_ORIGINS?.split(",").map((s) =>
      s.trim()
    );
    const corsOrigins = envCorsOrigins ?? options.cors;

    this.options = {
      maxConcurrentWorkspaces: 10,
      idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
      sseHeartbeatIntervalMs: 30 * 1000, // 30 seconds
      sseConnectionTimeoutMs: 5 * 60 * 1000, // 5 minutes
      ...options,
      cors: corsOrigins, // Override with resolved CORS origins
    };
    const exposeKernel = process.env.ATLAS_EXPOSE_KERNEL === "1";
    const context = {
      exposeKernel,
      runtimes: this.runtimes,
      startTime: this.startTime,
      sseClients: this.sseClients,
      sseStreams: this.sseStreams,
      getWorkspaceManager: this.getWorkspaceManager.bind(this),
      getOrCreateWorkspaceRuntime: this.getOrCreateWorkspaceRuntime.bind(this),
      resetIdleTimeout: this.resetIdleTimeout.bind(this),
      getWorkspaceRuntime: this.getWorkspaceRuntime.bind(this),
      destroyWorkspaceRuntime: this.destroyWorkspaceRuntime.bind(this),
      getActivityAdapter: this.getActivityAdapter.bind(this),
      getLibraryStorage: this.getLibraryStorage.bind(this),
      getLedgerAdapter: this.getLedgerAdapter.bind(this),
      getAgentRegistry: this.getAgentRegistry.bind(this),
      getOrCreateChatSdkInstance: this.getOrCreateChatSdkInstance.bind(this),
      evictChatSdkInstance: this.evictChatSdkInstance.bind(this),
      daemon: this,
      get streamRegistry() {
        return this.daemon.streamRegistry;
      },
      get sessionStreamRegistry() {
        return this.daemon.sessionStreamRegistry;
      },
      get sessionHistoryAdapter() {
        return this.daemon.sessionHistoryAdapter;
      },
      get platformModels() {
        // Lazy getter: platformModels is constructed later in initialize(),
        // but routes read it on demand (not at AppContext construction).
        return this.daemon.getPlatformModels();
      },
    };
    // Only pass env var origins to global CORS (production)
    // Local dev uses "*" for global routes, but MCP endpoints still use this.options.cors
    this.app = createApp(context, { corsOrigins: envCorsOrigins });
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

    // Load platform model configuration (friday.yml) and construct the resolver.
    // Runs eager validation — throws on malformed config or missing credentials.
    // ATLAS_CONFIG_PATH can override the search directory (set by --atlas-config CLI flag).
    const configDir = process.env.ATLAS_CONFIG_PATH ?? process.cwd();
    logger.info("Loading platform config", {
      configDir,
      configFile: `${configDir}/friday.yml`,
    });
    const atlasConfigSource = new FilesystemAtlasConfigSource(configDir);
    const atlasConfig = await atlasConfigSource.load();
    this.platformModels = createPlatformModels(atlasConfig);
    logger.info("Platform models resolver initialized", {
      configLoaded: atlasConfig !== null,
      configured: atlasConfig?.models ? Object.keys(atlasConfig.models) : [],
    });

    // Start NATS server and establish daemon connection
    logger.info("Starting NATS...");
    this.natsManager = new NatsManager();
    const nc = await this.natsManager.start();
    logger.info("NATS ready");

    // Start capability handlers (wildcard subscribers for agent back-channel)
    this.capabilityRegistry = new CapabilityHandlerRegistry();
    await this.capabilityRegistry.start(nc);
    this.processAgentExecutor = new ProcessAgentExecutor(nc, this.capabilityRegistry);

    // Create WorkspaceManager (initialize later once registrars and watcher are ready)
    logger.info("Creating WorkspaceManager...");
    const registry = await createRegistryStorage(StorageConfigs.defaultKV());
    this.workspaceManager = new WorkspaceManager(registry);

    // Wire up runtime invalidation callback so file watcher changes clear both maps
    this.workspaceManager.setRuntimeInvalidateCallback(
      this.destroyWorkspaceRuntime.bind(this),
    );

    // Initialize LibraryStorage with hybrid storage
    logger.info("Initializing LibraryStorage...");
    this.libraryStorage = await createLibraryStorage(
      StorageConfigs.defaultKV(),
      {
        // Use XDG-compliant default location, but allow environment override
        contentDir: env.ATLAS_LIBRARY_DIR,
        organizeByDate: true,
      },
    );

    // Initialize CronManager with KV storage
    logger.info("Initializing CronManager...");
    const kvStorageConfig = StorageConfigs.defaultKV();
    const kvStorage = await createKVStorage(kvStorageConfig); // createKVStorage now calls initialize()
    this.cronManager = new CronManager(kvStorage, logger);

    // Initialize Ledger client for versioned resource storage (auto-publish, resource tools)
    try {
      this.resourceStorage = createLedgerClient();
    } catch {
      logger.warn("Ledger client not initialized (LEDGER_URL not set)");
    }

    // Initialize activity storage adapter
    if (process.env.LEDGER_URL) {
      this.activityAdapter = createActivityLedgerClient();
      logger.info("Activity storage using Ledger client");
    } else {
      this.activityAdapter = new LocalActivityAdapter();
      logger.info("Activity storage using local SQLite adapter");
    }

    // Build agents from source directory (host-mounted volume in Docker, repo-local ./agents otherwise)
    const agentSourceDir = process.env.AGENT_SOURCE_DIR ?? "./agents";
    if (agentSourceDir) {
      try {
        const srcStat = await stat(agentSourceDir);
        if (srcStat.isDirectory()) {
          const entries = await readdir(agentSourceDir, {
            withFileTypes: true,
          });
          const dirs = entries.filter((e) => e.isDirectory());
          if (dirs.length > 0) {
            const sdkPath = resolveSdkPath(agentSourceDir);
            if (!sdkPath) {
              logger.warn(
                "AGENT_SOURCE_DIR set but friday-agent-sdk not found, skipping source builds",
              );
            } else {
              logger.info(
                `Building ${dirs.length} agent(s) from ${agentSourceDir} (parallel)`,
              );
              await Promise.all(
                dirs.map(async (dir) => {
                  const srcDir = join(agentSourceDir, dir.name);
                  const tmpDir = await mkdtemp(join(tmpdir(), "atlas-build-"));
                  try {
                    const agentDir = join(tmpDir, dir.name);
                    await cp(srcDir, agentDir, { recursive: true });
                    const result = await buildAgent({
                      agentDir,
                      sdkPath,
                      logger,
                    });
                    logger.info(
                      `Built agent ${result.id}@${result.version} from source`,
                    );
                  } catch (err: unknown) {
                    const msg = err instanceof Error
                      ? err.message
                      : String(err);
                    logger.warn(
                      `Failed to build agent from ${dir.name}: ${msg}`,
                    );
                  } finally {
                    await rm(tmpDir, { recursive: true, force: true }).catch(
                      () => {},
                    );
                  }
                }),
              );
            }
          }
        }
      } catch {
        // Directory doesn't exist or isn't readable — not an error
        logger.debug(
          "AGENT_SOURCE_DIR not accessible, skipping source builds",
          { agentSourceDir },
        );
      }
    }

    // Initialize agent registry with bundled + user agents
    logger.info("Initializing agent registry...");
    const agentRegistry = new CoreAgentRegistry({
      includeSystemAgents: true,
      userAgentsDir: join(getAtlasHome(), "agents"),
    });
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
        // Inject workspace owner's userId for analytics if not present in signal
        // This ensures cron/schedule signals track analytics correctly
        let enrichedSignalData = signalData;
        if (!signalData.userId) {
          const manager = this.getWorkspaceManager();
          const workspace = await manager.find({ id: workspaceId });
          if (workspace?.metadata?.createdBy) {
            enrichedSignalData = {
              ...signalData,
              userId: workspace.metadata.createdBy,
            };
          }
        }

        await this.triggerWorkspaceSignal(
          workspaceId,
          signalId,
          enrichedSignalData,
        );

        logger.info("Signal processed", { workspaceId, signalId });
      } catch (error) {
        // Session-level failures (LLM timeout, missing OAuth, etc.) are non-fatal —
        // the workspace runtime is fine, only this session failed. Don't destroy.
        if (error instanceof SessionFailedError) {
          logger.warn("Signal session failed", {
            workspaceId,
            signalId,
            status: error.status,
            error: error.message,
          });
          return;
        }

        // Infrastructure errors (workspace not found, runtime crash) — mark inactive and destroy
        logger.error("Failed to process signal", {
          error,
          workspaceId,
          signalId,
        });
        try {
          const manager = this.getWorkspaceManager();
          const workspace = await manager.find({ id: workspaceId });

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

    const signalRegistrars: WorkspaceSignalRegistrar[] = [
      fsRegistrar,
      cronRegistrar,
    ];

    // Initialize WorkspaceManager with registrars and watcher (manager owns lifecycle)
    await this.workspaceManager.initialize(signalRegistrars);

    // Bootstrap @atlas/* system skills before any workspace chat gets a chance
    // to ask for them. Idempotent — only republishes on content-hash mismatch.
    try {
      const { ensureSystemSkills } = await import(
        "@atlas/system/skills/bootstrap"
      );
      await ensureSystemSkills();
    } catch (error) {
      logger.error("Failed to bootstrap @atlas system skills", { error });
    }

    // Start CronManager — pass the live set of workspace ids so any
    // persisted timer pointing at a deleted workspace (e.g. one removed
    // outside the manager via direct rm) is pruned before the tick loop
    // can fire WorkspaceNotFoundError every cron interval.
    const knownWorkspaces = await this.workspaceManager.list({
      includeSystem: true,
    });
    await this.cronManager.start({
      knownWorkspaceIds: new Set(knownWorkspaces.map((w) => w.id)),
    });

    // Prewarm the model catalog so the Settings page dropdown renders
    // instantly on first open. Fire-and-forget: failures here shouldn't
    // block daemon startup — the on-demand `GET /api/config/models/catalog`
    // call will retry the fetch at request time.
    void prewarmCatalog().catch((error) => {
      logger.warn("Model catalog prewarm failed", { error });
    });

    // Initialize StreamRegistry
    this.streamRegistry = new StreamRegistry();
    this.streamRegistry.start();

    // Initialize session history v2 adapter + registry
    this.sessionHistoryAdapter = new LocalSessionHistoryAdapter(
      join(getAtlasHome(), "sessions-v2"),
    );
    this.sessionStreamRegistry = new SessionStreamRegistry();
    this.sessionStreamRegistry.start();

    // Start SSE health check interval
    this.startSSEHealthCheck();

    // Start agent session cleanup interval
    this.startAgentSessionCleanup();

    // Start platform session cleanup interval
    this.startPlatformSessionCleanup();

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
      AtlasMetrics.registerUptimeProvider(() =>
        Math.floor((Date.now() - this.startTime) / 1000)
      );
      logger.info("OTEL metrics providers registered");
    }

    // Start chunked upload cleanup lifecycle
    initChunkedUpload();

    this.isInitialized = true;
    logger.info("Atlas daemon initialized");
  }

  // fs-watch registration moved to signal registrars

  /**
   * Get or create per-session MCP server
   */
  private async getOrCreateAgentSession(
    sessionId: string,
  ): Promise<
    { server: AtlasAgentsMCPServer; transport: StreamableHTTPTransport }
  > {
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
      onsessioninitialized: (sid: string) => {
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
      platformModels: this.getPlatformModels(),
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
  ): Promise<
    { server: PlatformMCPServer; transport: StreamableHTTPTransport }
  > {
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
      onsessioninitialized: (sid: string) => {
        logger.info("[Daemon] Platform session initialized", {
          sessionId: sid,
        });
      },
    });

    // Create per-session Platform MCP server
    const daemonUrl = getAtlasDaemonUrl();
    const server = new PlatformMCPServer({
      daemonUrl,
      logger: logger.child({ component: "platform-mcp-server", sessionId }),
      workspaceProvider: {
        getOrCreateRuntime: (id: string) =>
          this.getOrCreateWorkspaceRuntime(id),
      },
      workspaceConfigProvider: {
        getWorkspaceConfig: (id: string) =>
          this.getWorkspaceManager().getWorkspaceConfig(id),
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
   * Resolved platform model selector. Initialized during `initialize()`.
   */
  getPlatformModels(): PlatformModels {
    if (!this.platformModels) {
      throw new Error(
        "Platform models not initialized. Call initialize() first.",
      );
    }
    return this.platformModels;
  }

  /** Get activity storage adapter (constructed during initialize). */
  public getActivityAdapter(): ActivityStorageAdapter {
    if (!this.activityAdapter) {
      throw new Error(
        "Activity adapter not initialized — call initialize() first",
      );
    }
    return this.activityAdapter;
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

  /** Get Ledger resource storage adapter */
  public getLedgerAdapter(): ResourceStorageAdapter {
    if (!this.resourceStorage) {
      throw new Error("Ledger adapter not initialized (LEDGER_URL not set)");
    }
    return this.resourceStorage;
  }

  /**
   * Get shared agent registry instance
   */
  public getAgentRegistry(): AgentRegistryType {
    if (!this.agentRegistry) {
      throw new Error("Agent registry not initialized");
    }
    return this.agentRegistry;
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

      // Skip health checks to reduce log noise
      if (path === "/health") return;

      const message = `HTTP ${method} ${path}`;
      const context = {
        method,
        path,
        status,
        duration: `${duration}ms`,
        component: "http",
      };

      if (status >= 500) {
        logger.error(message, context);
      } else if (status >= 400) {
        logger.warn(message, context);
      } else {
        logger.info(message, context);
      }
    });

    this.app.route("/health", healthRoutes);
    this.app.route("/api/workspaces", workspacesRoutes);
    // Mount workspace config routes for partial updates (separate from workspacesRoutes to avoid circular deps)
    this.app.route(
      "/api/workspaces/:workspaceId/config",
      workspaceConfigRoutes,
    );
    this.app.route("/api/workspaces/:workspaceId/chat", workspaceChatRoutes);
    this.app.route(
      "/api/workspaces/:workspaceId/integrations",
      integrationRoutes,
    );
    this.app.route("/api/artifacts", artifactsApp);
    this.app.route("/api/chunked-upload", chunkedUploadApp);
    this.app.route("/api/chat", chatRoutes);
    this.app.route("/api/chat-storage", chatStorageRoutes);
    this.app.route("/api/config", configRoutes);
    this.app.route("/api/user", userRoutes);
    this.app.route("/api/scratchpad", scratchpadApp);
    this.app.route("/api/sessions", sessionsRoutes);
    this.app.route("/api/activity", activityRoutes);
    this.app.route("/api/agents", agentsRoutes);
    this.app.route("/api/library", libraryRoutes);
    this.app.route("/api/daemon", daemonApp);
    this.app.route("/api/share", shareRoutes);
    this.app.route("/api/link", linkRoutes);
    this.app.route("/api/mcp-registry", mcpRegistryRouter);
    this.app.route("/api/me", meRoutes);
    this.app.route("/api/jobs", jobsRoutes);
    this.app.route("/api/skills", skillsRoutes);
    this.app.route("/api/report", reportRoutes);
    this.app.route("/api/memory", memoryNarrativeRoutes);
    this.app.route("/api/schedule-expand", scheduleExpandRoutes);

    // Platform signal routes (Discord/Slack via Signal Gateway)
    this.app.route("/signals", createPlatformSignalRoutes(this));

    // Global error handler - catches all uncaught errors from all routes
    this.app.onError((err, c) => {
      logger.error("API error", {
        error: err,
        path: c.req.path,
        method: c.req.method,
      });
      return c.json({ error: "Internal server error" }, 500);
    });

    // Proxy to platform MCP server with specific CORS for MCP
    this.app.all(
      "/mcp",
      cors({
        origin: this.options.cors ?? "*",
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
            logger.info("Creating new Platform MCP session", {
              sessionId: newSessionId,
            });

            // Create and store the session
            const { transport } = await this.getOrCreatePlatformSession(
              newSessionId,
            );

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
            const { transport } = await this.getOrCreatePlatformSession(
              sessionId,
            );

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
          logger.error("Platform MCP endpoint error", { error });
          return c.json(
            {
              error: `Platform MCP server error: ${
                error instanceof Error ? error.message : String(error)
              }`,
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
        origin: this.options.cors ?? "*",
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
            const { transport } = await this.getOrCreateAgentSession(
              newSessionId,
            );

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
        throw new Error(
          "Atlas daemon not fully initialized - cannot create workspace runtime",
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

      // Find workspace in registry (if not already found)
      logger.debug("Looking up workspace in registry", { workspaceId });
      if (!workspace) {
        workspace = (await manager.find({ id: workspaceId })) ||
          (await manager.find({ name: workspaceId }));
      }

      if (!workspace) {
        logger.error("Workspace not found", { workspaceId });
        throw new WorkspaceNotFoundError(workspaceId);
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
          const pathStat = await stat(workspace.path);
          if (!pathStat.isDirectory()) {
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
        logger.debug("Loading system workspace", { workspaceId: workspace.id });
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
        agents: Object.keys(mergedConfig.workspace?.agents || {}).length,
      });

      // Re-validate MCP environment at runtime creation (env vars may have changed since registration)
      if (!workspace.metadata?.system) {
        validateMCPEnvironmentForWorkspace(mergedConfig, workspace.path);
      }

      // Register workspace-level LLM agents with agent registry
      const workspaceAgents = mergedConfig.workspace?.agents || {};
      for (const [agentId, agentConfig] of Object.entries(workspaceAgents)) {
        if (agentConfig.type === "llm") {
          try {
            logger.debug("Registering workspace LLM agent", {
              workspaceId: workspace.id,
              agentId,
            });
            const agent = convertLLMToAgent(agentConfig, agentId, logger);
            await this.agentRegistry?.registerAgent(agent);
            logger.info("Registered workspace LLM agent", {
              workspaceId: workspace.id,
              agentId,
            });
          } catch (error) {
            logger.error("Failed to register workspace LLM agent", {
              workspaceId: workspace.id,
              agentId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else if (agentConfig.type === "atlas") {
          try {
            logger.debug("Registering workspace Atlas agent wrapper", {
              workspaceId: workspace.id,
              wrapperId: agentId,
              baseAgentId: agentConfig.agent,
            });

            // Get the bundled agent from registry
            const baseAgent = await this.agentRegistry?.getAgent(
              agentConfig.agent,
            );
            if (!baseAgent) {
              throw new Error(`Base agent not found: ${agentConfig.agent}`);
            }

            // Create wrapper agent with custom prompt and env
            const wrapperAgent = wrapAtlasAgent(
              baseAgent,
              agentId,
              agentConfig.prompt,
              agentConfig.env,
              agentConfig.description,
              logger,
            );

            await this.agentRegistry?.registerAgent(wrapperAgent);
            logger.info("Registered workspace Atlas agent wrapper", {
              workspaceId: workspace.id,
              wrapperId: agentId,
              baseAgentId: agentConfig.agent,
            });
          } catch (error) {
            logger.error("Failed to register workspace Atlas agent wrapper", {
              workspaceId: workspace.id,
              wrapperId: agentId,
              baseAgentId: agentConfig.agent,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      logger.debug("Creating WorkspaceRuntime", {
        workspaceId: workspace.id,
        signals: mergedConfig.workspace?.signals
          ? Object.keys(mergedConfig.workspace.signals)
          : [],
      });

      // Determine workspace path
      let workspacePath: string | undefined;
      if (workspace.metadata?.system) {
        // System workspaces are in packages/system/workspaces/{workspace-name}/
        workspacePath =
          new URL(`../../../packages/system/workspaces`, import.meta.url)
            .pathname;
      } else {
        workspacePath = workspace.path;
      }

      runtime = new WorkspaceRuntime(
        {
          id: workspace.id,
          name: workspace.name,
          members: { userId: workspace.metadata?.createdBy },
        },
        mergedConfig,
        {
          lazy: true, // Always use lazy loading in daemon mode
          workspacePath, // Pass workspace path for daemon mode
          resourceStorage: this.resourceStorage ?? undefined, // Share daemon's Ledger client (auto-publish)
          activityStorage: this.getActivityAdapter(), // Share activity storage for feed items
          platformModels: this.getPlatformModels(),
          agentExecutor: this.processAgentExecutor ?? undefined,
          daemonUrl: `http://localhost:${this.options.port}`, // Pass daemon URL for MCP tool fetching
          blueprintArtifactId: workspace.metadata?.blueprintArtifactId,
          invokeImprover: this.createImproverCallback(workspace.id),
          hasPendingRevision: !!workspace.metadata?.pendingRevision,
          createSessionStream: (sessionId) =>
            this.sessionStreamRegistry.create(
              sessionId,
              this.sessionHistoryAdapter,
            ),
          onSessionFinished: async (
            { workspaceId, sessionId, status, finishedAt, summary },
          ) => {
            // Record session completion metric
            // "skipped" = user config error (OAuth not connected, missing env vars) - NOT a platform failure
            AtlasMetrics.recordSession(status);

            try {
              const mgr = this.getWorkspaceManager();
              const ws = await mgr.find({ id: workspaceId });

              // Mark workspace as stopped when a session finishes normally
              await mgr.updateWorkspaceStatus(workspaceId, "stopped", {
                metadata: {
                  ...ws?.metadata,
                  lastFinishedSession: {
                    id: sessionId,
                    status,
                    finishedAt,
                    summary,
                  },
                },
              });

              // If there are no active sessions or agent executions left, destroy the runtime
              // so status won't be overridden to "running".
              // Must check BOTH session status AND orchestrator active executions to avoid
              // killing MCP transports while callTool requests are still in flight.
              const currentRuntime = this.runtimes.get(workspaceId);
              if (currentRuntime) {
                const sessions = currentRuntime.getSessions();
                const hasActiveSessions = sessions.some(
                  (s) => s.session.status === WorkspaceSessionStatus.ACTIVE,
                );

                // Check orchestrator for in-flight agent executions (matches checkAndDestroyIdleWorkspace)
                let hasActiveExecutions = false;
                if (
                  "getOrchestrator" in currentRuntime &&
                  typeof currentRuntime.getOrchestrator === "function"
                ) {
                  const orchestrator = currentRuntime.getOrchestrator();
                  hasActiveExecutions = orchestrator.hasActiveExecutions();
                }

                if (!hasActiveSessions && !hasActiveExecutions) {
                  // Apply any deferred workspace.yml changes BEFORE destroying
                  // the runtime — handleWorkspaceConfigChange itself will
                  // tear it down and re-load from the (now updated) config.
                  // Order matters: if we destroyed first, processPending
                  // would see no runtime and fall through.
                  try {
                    await mgr.processPendingWatcherChange(workspaceId);
                  } catch (err) {
                    logger.warn("Failed to process pending watcher change", {
                      workspaceId,
                      error: err,
                    });
                  }
                  await this.destroyWorkspaceRuntime(workspaceId);
                } else {
                  // Still active sessions or agent executions; let idle timeout handle cleanup
                  this.resetIdleTimeout(workspaceId);
                }
              }
            } catch (error) {
              logger.warn(
                "Failed to persist lastFinishedSession or update status",
                {
                  workspaceId,
                  sessionId,
                  error,
                },
              );
            }
          },
        },
      );
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

      // Watcher is managed centrally by WorkspaceManager.initialize()

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

      // Clean up on failure to prevent inconsistent state
      try {
        // Remove runtime from local registry if it was added
        if (this.runtimes.has(workspaceId)) {
          this.runtimes.delete(workspaceId);
          logger.debug("Removed failed runtime from daemon registry", {
            workspaceId,
          });
        }

        // Unregister from WorkspaceManager and revert status to stopped
        try {
          const mgr = this.getWorkspaceManager();
          await mgr.unregisterRuntime(workspaceId);
          logger.debug("Unregistered failed runtime from WorkspaceManager", {
            workspaceId,
          });
        } catch (unregisterError) {
          // Runtime might not have been registered yet
          logger.debug(
            "Could not unregister runtime (may not have been registered)",
            {
              workspaceId,
              error: unregisterError,
            },
          );
        }

        // Clear idle timeout if it was set
        const timeoutId = this.idleTimeouts.get(workspaceId);
        if (timeoutId) {
          clearTimeout(timeoutId);
          this.idleTimeouts.delete(workspaceId);
          logger.debug("Cleared idle timeout for failed workspace", {
            workspaceId,
          });
        }
      } catch (cleanupError) {
        logger.error("Error during failed workspace cleanup", {
          workspaceId,
          cleanupError,
        });
      }

      throw error;
    }
  }

  /** Cached per workspace; torn down when the runtime is destroyed. */
  getOrCreateChatSdkInstance(workspaceId: string): Promise<ChatSdkInstance> {
    const existing = this.chatSdkInstances.get(workspaceId);
    if (existing) return existing;

    const promise = this.buildChatSdkInstance(workspaceId);
    this.chatSdkInstances.set(workspaceId, promise);
    promise.catch(() => {
      // Let the next caller retry on failure.
      if (this.chatSdkInstances.get(workspaceId) === promise) {
        this.chatSdkInstances.delete(workspaceId);
      }
    });
    return promise;
  }

  private async buildChatSdkInstance(
    workspaceId: string,
  ): Promise<ChatSdkInstance> {
    const manager = this.getWorkspaceManager();
    const config = await manager.getWorkspaceConfig(workspaceId);
    if (!config) {
      throw new WorkspaceNotFoundError(workspaceId);
    }

    const workspace = await manager.find({ id: workspaceId });
    const userId = workspace?.metadata?.createdBy ?? "default-user";

    let credentials: PlatformCredentials[] | undefined;
    try {
      const signals = (config.workspace?.signals ?? {}) as Record<
        string,
        { provider?: string; config?: Record<string, unknown> }
      >;
      const resolved = await resolvePlatformCredentials(workspaceId, signals);
      if (resolved.length > 0) {
        credentials = resolved.map((r) => r.credentials);
      }
    } catch (error) {
      logger.warn("chat_sdk_credential_resolution_failed", {
        workspaceId,
        error,
      });
    }

    const instanceConfig: ChatSdkInstanceConfig = {
      workspaceId,
      userId,
      signals: config.workspace?.signals as
        | Record<
          string,
          { provider?: string; config?: Record<string, unknown> }
        >
        | undefined,
      streamRegistry: this.streamRegistry,
      exposeKernel: process.env.ATLAS_EXPOSE_KERNEL === "1",
      triggerFn: async (signalId, signalData, streamId, onStreamEvent) => {
        const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);
        const session = await runtime.triggerSignalWithSession(
          signalId,
          signalData,
          streamId,
          onStreamEvent,
        );
        return { sessionId: session.id };
      },
    };

    return initializeChatSdkInstance(instanceConfig, credentials);
  }

  /**
   * Drop the cached Chat SDK instance so the next get rebuilds it with fresh
   * config. Does NOT disable Slack event subscriptions — those stay active
   * so incoming Slack messages can wake an idle workspace. Use
   * `disconnectSlack()` for explicit Slack removal.
   */
  async evictChatSdkInstance(workspaceId: string): Promise<void> {
    const pending = this.chatSdkInstances.get(workspaceId);
    if (!pending) return;
    this.chatSdkInstances.delete(workspaceId);
    try {
      const instance = await pending;
      await instance.teardown();
    } catch (error) {
      logger.error("Error evicting Chat SDK instance", { error, workspaceId });
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
   * @param skipStates - Optional state IDs to skip during FSM execution
   * @returns Session ID for tracking the triggered signal
   */
  public async triggerWorkspaceSignal(
    workspaceId: string,
    signalId: string,
    payload?: Record<string, unknown>,
    streamId?: string,
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void,
    skipStates?: string[],
  ): Promise<{
    sessionId: string;
    output: Array<{ id: string; type: string; data: Record<string, unknown> }>;
  }> {
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
      skipStates,
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

    // Propagate session failures so callers (MCP tools, HTTP clients) see the error.
    // SessionFailedError lets the cron wakeup callback distinguish session-level failures
    // (transient, don't destroy workspace) from infrastructure errors (workspace missing, etc.)
    if (
      session.status === "failed" ||
      session.status === "skipped" ||
      session.status === "cancelled"
    ) {
      throw new SessionFailedError(signalId, session.status, session.error);
    }

    // Surface the FSM's final output documents so synchronous callers
    // (workspace-chat job tool) can return the agent's actual answer to
    // whatever invoked the job. Without this, calls like "search the KB"
    // complete but workspace-chat has no content to render.
    const output = runtime.getSessionFsmDocuments(session.id);

    return { sessionId: session.id, output };
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
      logger.debug("Session not found (may have been cleaned up)", {
        workspaceId,
        sessionId,
      });
      return false;
    }

    // Create timeout promise that rejects after specified duration
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), timeoutMs)
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
        sessionError: session.session.error,
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
        (s) => s.session.status === WorkspaceSessionStatus.ACTIVE,
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
      (s) => s.session.status === WorkspaceSessionStatus.ACTIVE,
    );

    // Check for active agent executions in the orchestrator
    let hasActiveExecutions = false;
    let activeExecutions: Array<
      { agentId: string; sessionId: string; durationMs: number }
    > = [];

    // WorkspaceRuntimeFSM has getOrchestrator() method
    if (
      "getOrchestrator" in runtime &&
      typeof runtime.getOrchestrator === "function"
    ) {
      const orchestrator = runtime.getOrchestrator();
      hasActiveExecutions = orchestrator.hasActiveExecutions();
      if (hasActiveExecutions) {
        activeExecutions = orchestrator.getActiveExecutions();
      }
    }

    // Log detailed info for debugging
    logger.debug("Checking idle workspace", {
      workspaceId,
      sessionsCount: sessions.length,
      sessionStatuses: sessions.map((s) => s.session.status),
      hasActiveSessions,
      hasActiveExecutions,
      activeExecutionsCount: activeExecutions.length,
      activeExecutions: activeExecutions.map((e) => ({
        agentId: e.agentId,
        sessionId: e.sessionId,
        durationSec: Math.round(e.durationMs / 1000),
      })),
    });

    if (!hasActiveSessions && !hasActiveExecutions) {
      logger.info("Destroying idle workspace runtime", { workspaceId });
      await this.destroyWorkspaceRuntime(workspaceId);
    } else {
      // Still has active sessions or executions, reset timeout
      if (hasActiveExecutions) {
        logger.debug(
          "Workspace has active agent executions, resetting idle timeout",
          {
            workspaceId,
            activeExecutionsCount: activeExecutions.length,
          },
        );
      }
      this.resetIdleTimeout(workspaceId);
    }
  }

  /**
   * Create callback for workspace-improver agent invocation.
   * Used by the improvement loop to invoke the agent without circular deps.
   */
  private createImproverCallback(
    workspaceId: string,
  ): (input: ImproverAgentInput) => Promise<ImproverAgentResult> {
    return async (input: ImproverAgentInput): Promise<ImproverAgentResult> => {
      const registry = this.agentRegistry;
      if (!registry) {
        return { ok: false, error: "Agent registry not initialized" };
      }

      const agent = await registry.getAgent("workspace-improver");
      if (!agent) {
        return {
          ok: false,
          error: "workspace-improver agent not found in registry",
        };
      }

      // workspace-improver agent accepts JSON string input (parses internally)
      const payload = await agent.execute(JSON.stringify(input), {
        tools: {},
        session: {
          sessionId: `improver-${workspaceId}-${Date.now()}`,
          workspaceId,
        },
        env: {},
        stream: undefined,
        logger: logger.child({ component: "workspace-improver", workspaceId }),
        platformModels: this.getPlatformModels(),
      });

      // Transform AgentPayload → ImproverAgentResult
      if (!payload.ok) {
        const errorPayload = payload.error;
        return {
          ok: false,
          error: typeof errorPayload === "object" && errorPayload !== null &&
              "reason" in errorPayload
            ? String(errorPayload.reason)
            : String(errorPayload),
        };
      }

      const parsed = ImproverResultDataSchema.safeParse(payload.data);
      if (!parsed.success) {
        return {
          ok: false,
          error: `Unexpected agent result shape: ${parsed.error.message}`,
        };
      }

      return { ok: true, data: parsed.data };
    };
  }

  /**
   * Destroy a workspace runtime. The chat SDK cache is evicted regardless of
   * whether a live runtime exists — a workspace can have a cached chat SDK
   * (built by an inbound Slack/Teams/etc. event) while its runtime has been
   * idle-reaped. The config-change path must still flush those creds so the
   * next message rebuilds the adapter from the current workspace.yml.
   */
  async destroyWorkspaceRuntime(workspaceId: string) {
    const runtime = this.runtimes.get(workspaceId);
    if (runtime) {
      try {
        await runtime.shutdown();
      } catch (error) {
        logger.error("Error shutting down workspace runtime", {
          error,
          workspaceId,
        });
      }
      this.runtimes.delete(workspaceId);
    }

    await this.evictChatSdkInstance(workspaceId);

    // Unregister runtime from WorkspaceManager
    const manager = this.getWorkspaceManager();
    await manager.unregisterRuntime(workspaceId);

    // Ensure final status reflects stopped after teardown
    try {
      await manager.updateWorkspaceStatus(workspaceId, "stopped");
    } catch (error) {
      logger.warn("Failed to set workspace stopped after destroy", {
        workspaceId,
        error,
      });
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

      logger.info("Daemon received signal, shutting down gracefully", {
        daemonId,
        signal,
      });

      // Handle async shutdown in a promise to ensure proper cleanup
      // Add a timeout to prevent hanging indefinitely
      const shutdownTimeout = setTimeout(() => {
        logger.error("Shutdown timeout, forcing exit", { timeoutSeconds: 30 });
        process.exit(1);
      }, 30000);

      this.shutdown()
        .then(() => {
          clearTimeout(shutdownTimeout);
          logger.info("Daemon shutdown complete", { daemonId });
          process.exit(0);
        })
        .catch((error) => {
          clearTimeout(shutdownTimeout);
          logger.error("Error during shutdown", { error, daemonId });
          process.exit(1);
        });
    };

    const sigintHandler = () => handleShutdown("SIGINT");
    Deno.addSignalListener("SIGINT", sigintHandler);
    this.signalHandlers.push({ signal: "SIGINT", handler: sigintHandler });

    // SIGTERM is not supported on Windows
    if (process.platform !== "win32") {
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

    // Start the Discord Gateway service AFTER the HTTP server is listening —
    // its forwardUrl points at ourselves, so the route target must exist first.
    this.maybeStartDiscordGateway().catch((error) => {
      logger.error("discord_gateway_service_start_failed", { error });
    });

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

    // Start the Discord Gateway service AFTER the HTTP server is listening —
    // its forwardUrl points at ourselves, so the route target must exist first.
    this.maybeStartDiscordGateway().catch((error) => {
      logger.error("discord_gateway_service_start_failed", { error });
    });

    return { finished: this.server.finished };
  }

  /**
   * Start the daemon-scoped Discord Gateway listener.
   *
   * Resolution order mirrors the config-first / env-fallback shape of the
   * other chat providers:
   *   1. Walk every workspace with a `discord` signal and try
   *      `resolveDiscordCredentials`. Pick the first workspace whose signal
   *      config (merged with env fallbacks) yields full creds.
   *   2. If no workspace resolves, fall back to reading the three
   *      `DISCORD_*` env vars directly (keeps the "daemon-default bot" dev
   *      workflow — no workspace yaml required).
   *   3. If neither path resolves, log `discord_gateway_not_configured`
   *      and skip — same no-op as today.
   *
   * Single-bot limitation: if multiple workspaces resolve to *different*
   * creds we log a warn and use the first workspace's creds. True multi-bot
   * (one listener per unique cred set) is a deferred P2.
   */
  private async maybeStartDiscordGateway(): Promise<void> {
    const resolved = await this.resolveDiscordGatewayCredentials();
    if (!resolved) {
      logger.info("discord_gateway_not_configured", {
        hint:
          "Set DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY, DISCORD_APPLICATION_ID or declare a discord signal with bot_token/public_key/application_id in workspace.yml",
      });
      return;
    }

    const service = new DiscordGatewayService({
      credentials: resolved,
      forwardUrl: `http://localhost:${this.port}/signals/discord`,
      logger: logger.child({ component: "discord-gateway-service" }),
    });
    this.discordGatewayService = service;
    await service.start();
  }

  private async resolveDiscordGatewayCredentials(): Promise<
    {
      botToken: string;
      publicKey: string;
      applicationId: string;
    } | null
  > {
    const manager = this.workspaceManager;
    const workspaceResolved: {
      workspaceId: string;
      creds: { botToken: string; publicKey: string; applicationId: string };
    }[] = [];

    if (manager) {
      const workspaces = await manager.list({ includeSystem: true });
      for (const workspace of workspaces) {
        const config = await manager.getWorkspaceConfig(workspace.id);
        const signals = config?.workspace.signals;
        if (!signals) continue;
        const hasDiscord = Object.values(signals).some((s) =>
          s.provider === "discord"
        );
        if (!hasDiscord) continue;

        const creds = resolveDiscordCredentials(signals);
        if (!creds || creds.credentials.kind !== "discord") continue;
        const { botToken, publicKey, applicationId } = creds.credentials;
        workspaceResolved.push({
          workspaceId: workspace.id,
          creds: { botToken, publicKey, applicationId },
        });
      }
    }

    if (workspaceResolved.length > 0) {
      const first = workspaceResolved[0];
      if (!first) return null;
      const conflict = workspaceResolved.find(
        (w) =>
          w.creds.botToken !== first.creds.botToken ||
          w.creds.publicKey !== first.creds.publicKey ||
          w.creds.applicationId !== first.creds.applicationId,
      );
      if (conflict) {
        logger.warn("discord_gateway_multi_workspace_conflict", {
          selectedWorkspaceId: first.workspaceId,
          conflictingWorkspaceId: conflict.workspaceId,
          hint:
            "Only one Discord bot listener is started per daemon. To run multiple bots, run multiple daemons.",
        });
      }
      return first.creds;
    }

    const botToken = process.env.DISCORD_BOT_TOKEN;
    const publicKey = process.env.DISCORD_PUBLIC_KEY;
    const applicationId = process.env.DISCORD_APPLICATION_ID;
    if (!botToken || !publicKey || !applicationId) return null;
    return { botToken, publicKey, applicationId };
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info("Shutting down Atlas daemon...");

    // Stop the Discord Gateway service FIRST so the WebSocket closes cleanly
    // before the HTTP server (its forwardUrl target) goes away.
    if (this.discordGatewayService) {
      try {
        await this.discordGatewayService.stop();
      } catch (error) {
        logger.error("Error stopping Discord Gateway service", { error });
      }
      this.discordGatewayService = null;
    }

    // Remove signal handlers
    for (const { signal, handler } of this.signalHandlers) {
      Deno.removeSignalListener(signal, handler);
    }
    this.signalHandlers = [];

    // Stop chunked upload cleanup
    shutdownChunkedUpload();

    // Shutdown all workspace runtimes
    const shutdownPromises = Array.from(this.runtimes.keys()).map((
      workspaceId,
    ) => this.destroyWorkspaceRuntime(workspaceId));
    await Promise.all(shutdownPromises);

    // Shutdown StreamRegistry
    this.streamRegistry?.shutdown();

    // Shutdown SessionStreamRegistry
    this.sessionStreamRegistry?.shutdown();

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
          logger.debug("Error closing SSE client for session", {
            error,
            sessionId,
          });
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
        logger.debug("Error cleaning up platform session", {
          error,
          sessionId,
        });
      }
    }
    this.platformMcpSessions.clear();

    // Shutdown CronManager
    if (this.cronManager) {
      await this.cronManager.shutdown();
      this.cronManager = null;
    }

    // Stop capability handlers then NATS
    if (this.capabilityRegistry) {
      this.capabilityRegistry.stop();
      this.capabilityRegistry = null;
    }
    this.processAgentExecutor = null;
    if (this.natsManager) {
      await this.natsManager.stop();
      this.natsManager = null;
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

    // Flush analytics events before exit
    try {
      const analytics = createAnalyticsClient();
      await analytics.shutdown();
      logger.info("Analytics provider shutdown complete");
    } catch (error) {
      logger.error("Error shutting down analytics provider", { error });
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
      const remainingClients = clients.filter((c) =>
        !disconnectedClients.includes(c)
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

    this.sseHealthCheckInterval = setInterval(
      () => {
        this.performSSEHealthCheck();
      },
      this.options.sseHeartbeatIntervalMs ?? 30 * 1000,
    );

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
      const sortedSessions = Array.from(this.platformMcpSessions.entries())
        .sort(
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
    const clientTimeoutMs = this.options.sseConnectionTimeoutMs ??
      5 * 60 * 1000;
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
            const heartbeat = {
              type: "heartbeat",
              data: { timestamp: new Date().toISOString() },
            };
            client.controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(heartbeat)}\n\n`,
              ),
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
