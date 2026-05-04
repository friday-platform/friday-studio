import { stat } from "node:fs/promises";
import { join } from "node:path";
import process, { env } from "node:process";
import { JetStreamMemoryAdapter } from "@atlas/adapters-md";
import type { AgentRegistry as AgentRegistryType, AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { FilesystemAtlasConfigSource } from "@atlas/config/server";
import {
  AtlasAgentsMCPServer,
  AgentRegistry as CoreAgentRegistry,
  convertLLMToAgent,
  JetStreamSessionHistoryAdapter,
  SessionFailedError,
  WorkspaceNotFoundError,
  WorkspaceSessionStatus,
  wrapAtlasAgent,
} from "@atlas/core";
import { initArtifactStorage } from "@atlas/core/artifacts/server";
import { ensureChatsKVBucket, initChatStorage } from "@atlas/core/chat/storage";
import { initMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import { CronManager } from "@atlas/cron";
import { initDocumentStore } from "@atlas/document-store";
import { createPlatformModels, type PlatformModels, prewarmCatalog } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { sharedMCPProcesses } from "@atlas/mcp";
import {
  BashArgsSchema,
  executeBash,
  executeWebfetch,
  initWorkspaceStateStorage,
  PlatformMCPServer,
  WebfetchArgsSchema,
} from "@atlas/mcp-server";
import { initSkillStorage } from "@atlas/skills";
import { getFridayHome } from "@atlas/utils/paths.server";
import {
  createJetStreamKVStorage,
  createRegistryStorageJS,
  validateMCPEnvironmentForWorkspace,
  WorkspaceManager,
  WorkspaceRuntime,
} from "@atlas/workspace";
import type {
  WorkspaceSignalRegistrar,
  WorkspaceSignalTriggerCallback,
} from "@atlas/workspace/types";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { Context, Next } from "hono";
import { cors } from "hono/cors";
import { type RunMigrationsResult, readJetStreamConfig, runMigrations } from "jetstream";
import { type NatsConnection, RetentionPolicy, StorageType } from "nats";
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
import { cronRoutes } from "../routes/cron.ts";
import { daemonApp } from "../routes/daemon.ts";
import { healthRoutes } from "../routes/health.ts";
import { jobsRoutes } from "../routes/jobs.ts";
import { linkRoutes } from "../routes/link.ts";
import { mcpRegistryRouter } from "../routes/mcp-registry.ts";
import { meRoutes } from "../routes/me/index.ts";
import { memoryNarrativeRoutes } from "../routes/memory/index.ts";
import reportRoutes from "../routes/report.ts";
import { scratchpadApp } from "../routes/scratchpad/index.ts";
import { sessionsRoutes } from "../routes/sessions/index.ts";
import { shareRoutes } from "../routes/share.ts";
import { createPlatformSignalRoutes } from "../routes/signals/platform.ts";
import { skillsRoutes } from "../routes/skills.ts";
import { userRoutes } from "../routes/user/index.ts";
import { eventsRoutes, workspaceEventsRoutes } from "../routes/workspace-events.ts";
import workspaceChatRoutes from "../routes/workspaces/chat.ts";
import workspaceChatDebugRoutes from "../routes/workspaces/chat-debug.ts";
import { configRoutes as workspaceConfigRoutes } from "../routes/workspaces/config.ts";
import { workspacesRoutes } from "../routes/workspaces/index.ts";
import { integrationRoutes } from "../routes/workspaces/integrations.ts";
import { mcpRoutes } from "../routes/workspaces/mcp.ts";
import { CapabilityHandlerRegistry } from "./capability-handlers.ts";
import { CHAT_PROVIDERS, type PlatformCredentials } from "./chat-sdk/adapter-factory.ts";
import { broadcastJobOutput } from "./chat-sdk/broadcast.ts";
import {
  type ChatSdkInstance,
  type ChatSdkInstanceConfig,
  initializeChatSdkInstance,
  resolveDiscordCredentials,
  resolvePlatformCredentials,
} from "./chat-sdk/chat-sdk-instance.ts";
import { createFSMBroadcastNotifier } from "./chat-sdk/fsm-broadcast-adapter.ts";
import { ChatTurnRegistry } from "./chat-turn-registry.ts";
import { DiscordGatewayService } from "./discord-gateway-service.ts";
import { createApp } from "./factory.ts";
import { getAllMigrations } from "./migrations/index.ts";
import { NatsManager } from "./nats-manager.ts";
import { ProcessAgentExecutor } from "./process-agent-executor.ts";
import { SessionStreamRegistry } from "./session-stream-registry.ts";
import { CronSignalRegistrar } from "./signal-registrars/cron-registrar.ts";
import { FsWatchSignalRegistrar } from "./signal-registrars/fs-watch-registrar.ts";
import {
  ensureSignalsStream,
  type PublishSignalOpts,
  publishSignal,
  SignalConsumer,
  type SignalEnvelope,
} from "./signal-stream.ts";
import { initScratchpadStorage } from "./storage/scratchpad.ts";
import { StreamRegistry } from "./stream-registry.ts";
import { sweepOrphanedAgentBrowserSessions } from "./sweep-agent-browser-sessions.ts";
import { callTool, registerToolWorker, type ToolWorker } from "./tool-dispatch.ts";
import { AtlasMetrics } from "./utils/metrics.ts";
import { getAtlasDaemonUrl } from "./utils.ts";
import { ensureWorkspaceEventsStream, publishWorkspaceEvent } from "./workspace-events.ts";

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
 * Cheap pre-flight for the broadcast hook: returns `true` iff the workspace
 * declares any chat-platform config carrying a `default_destination`. Lets
 * `onSessionComplete` skip chat-SDK construction entirely for pure cron/HTTP
 * workspaces (the common case for non-chat jobs). Walks both the new
 * top-level `communicators` map and the legacy `signals.<n>.config` shape
 * since either can carry the destination.
 */
function workspaceHasBroadcastDestination(workspace: {
  signals?: Record<string, { provider?: string; config?: Record<string, unknown> }>;
  communicators?: Record<string, { kind?: string } & Record<string, unknown>>;
}): boolean {
  for (const entry of Object.values(workspace.communicators ?? {})) {
    if (
      typeof entry?.kind === "string" &&
      (CHAT_PROVIDERS as readonly string[]).includes(entry.kind) &&
      typeof entry.default_destination === "string" &&
      entry.default_destination.length > 0
    ) {
      return true;
    }
  }
  for (const signal of Object.values(workspace.signals ?? {})) {
    const provider = signal?.provider;
    const dest = signal?.config?.default_destination;
    if (
      typeof provider === "string" &&
      (CHAT_PROVIDERS as readonly string[]).includes(provider) &&
      typeof dest === "string" &&
      dest.length > 0
    ) {
      return true;
    }
  }
  return false;
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
  private idleTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private shutdownPromise: Promise<void> | null = null;
  private server: Deno.HttpServer | null = null;
  private signalHandlers: Array<{ signal: Deno.Signal; handler: () => void }> = [];
  private isInitialized = false;
  private platformModels: PlatformModels | null = null;
  private natsManager: NatsManager | null = null;
  private capabilityRegistry: CapabilityHandlerRegistry | null = null;
  private processAgentExecutor: ProcessAgentExecutor | null = null;
  private signalConsumer: SignalConsumer | null = null;
  private toolWorkers: ToolWorker[] = [];
  private cronManager: CronManager | null = null;
  private workspaceManager: WorkspaceManager | null = null;
  /**
   * Last completed migration run, populated once `runMigrations` resolves.
   * `pending` while the background runner is still in flight; populated
   * with `RunMigrationsResult` on success/failure; populated with
   * `{ ran: [], skipped: [], failed: ["__runner__"], error: ... }` if the
   * runner itself threw before producing a result. Surfaced via
   * `getStatus()` so HTTP / launcher consumers can detect a half-migrated
   * install instead of grepping logs.
   */
  private migrationStatus:
    | { state: "pending" }
    | { state: "complete"; result: RunMigrationsResult; error?: string } = { state: "pending" };
  public streamRegistry!: StreamRegistry;
  public chatTurnRegistry!: ChatTurnRegistry;
  public sessionStreamRegistry!: SessionStreamRegistry;
  public sessionHistoryAdapter!: JetStreamSessionHistoryAdapter;
  private chatSdkInstances = new Map<string, Promise<ChatSdkInstance>>();
  private sseHealthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private agentSessionCleanupInterval: ReturnType<typeof setInterval> | null = null;
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
  // NATS signal subscriptions per workspace (drained on runtime destroy)
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
  private platformSessionCleanupInterval: ReturnType<typeof setInterval> | null = null;
  // Platform session limits
  private readonly MAX_PLATFORM_SESSIONS = 100;
  private readonly PLATFORM_SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
  // Store the actual port after server starts
  #port: number | undefined;
  private discordGatewayService: DiscordGatewayService | null = null;

  constructor(options: AtlasDaemonOptions = {}) {
    // Read CORS origins from environment or options
    // Environment variable takes precedence for production deployments
    const envCorsOrigins = env.CORS_ALLOWED_ORIGINS?.split(",").map((s) => s.trim());
    const corsOrigins = envCorsOrigins ?? options.cors;

    this.options = {
      maxConcurrentWorkspaces: 10,
      idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
      sseHeartbeatIntervalMs: 30 * 1000, // 30 seconds
      sseConnectionTimeoutMs: 5 * 60 * 1000, // 5 minutes
      ...options,
      cors: corsOrigins, // Override with resolved CORS origins
    };
    const exposeKernel = process.env.FRIDAY_EXPOSE_KERNEL === "1";
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
      getAgentRegistry: this.getAgentRegistry.bind(this),
      getOrCreateChatSdkInstance: this.getOrCreateChatSdkInstance.bind(this),
      evictChatSdkInstance: this.evictChatSdkInstance.bind(this),
      daemon: this,
      get streamRegistry() {
        return this.daemon.streamRegistry;
      },
      get chatTurnRegistry() {
        return this.daemon.chatTurnRegistry;
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

  /** Get the CronManager instance (null before initialize()). */
  public getCronManager(): CronManager | null {
    return this.cronManager;
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

    // Sweep orphaned `agent-browser` daemons left by a previous atlasd that
    // died without running the bundled web agent's stopSession cleanup
    // (SIGKILL, crash, OOM, host reboot). Scoped to the atlas-web-<uuid>
    // namespace, so user-launched agent-browser sessions are untouched.
    // Pre-NATS so a sweep failure can't poison anything important.
    await sweepOrphanedAgentBrowserSessions(logger).catch((error) => {
      logger.warn("agent-browser session sweep failed", { error: String(error) });
    });

    // Load platform model configuration (friday.yml) and construct the resolver.
    // Runs eager validation — throws on malformed config or missing credentials.
    // FRIDAY_CONFIG_PATH can override the search directory (set by --atlas-config CLI flag).
    const configDir = process.env.FRIDAY_CONFIG_PATH ?? process.cwd();
    logger.info("Loading platform config", { configDir, configFile: `${configDir}/friday.yml` });
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

    // Read the env-driven JetStream limits once and propagate to every
    // stream + consumer creation site below. Single source of truth.
    const jsCfg = readJetStreamConfig();

    // Subscribe to the broker's max-deliveries advisory across ALL streams
    // and consumers so dead-lettered messages from CHAT_*, MEMORY_*, and
    // SIGNALS land in the same log surface. Wildcard matches every
    // (stream, consumer) pair.
    this.subscribeMaxDeliveriesAdvisory(nc);

    // Ensure the SESSIONS JetStream stream exists (durable session event store).
    // For NEW installs this creates File + 30d directly; for upgraded installs
    // the matching migration entry (`m_a6ab40b_sessions_stream_upgrade`) does
    // the streams.update / Memory-storage warning.
    await this.ensureSessionsStream(nc);

    // Ensure the SIGNALS JetStream stream exists. Triggers (HTTP, cron, chat,
    // future cross-cascade emits) can publish onto this for durable, redeliver-
    // able routing. The consumer worker is started after WorkspaceManager
    // initializes so it can dispatch through `triggerWorkspaceSignal`.
    await ensureSignalsStream(nc, {
      maxMsgSize: jsCfg.stream.maxMsgSize.value,
      duplicateWindowNs: jsCfg.stream.duplicateWindowNs.value,
      // SIGNALS keeps its own 7d max_age regardless of the global default —
      // signals are work units, not long-term history.
    });

    // Wire chat storage to JetStream + eagerly create the CHATS KV bucket
    // so the first cold read doesn't pay the create cost.
    initChatStorage(nc, {
      maxMsgSize: jsCfg.stream.maxMsgSize.value,
      duplicateWindowNs: jsCfg.stream.duplicateWindowNs.value,
    });
    await ensureChatsKVBucket(nc);

    // Wire MCP registry to JetStream KV. Routes / discovery code call
    // the zero-arg `getMCPRegistryAdapter()` and get back the JS-KV-backed
    // adapter. Migration entry below republishes any legacy
    // ~/.atlas/mcp-registry.db entries into the new bucket.
    initMCPRegistryAdapter(nc);

    // Run all 0.1.1 → current migrations through the consolidated runner.
    // Idempotent: each entry checks the `_FRIDAY_MIGRATIONS` KV bucket and
    // skips if already applied. First failure aborts the queue. Awaited
    // synchronously: WorkspaceManager.initialize() and CronManager.start()
    // below both depend on the registry / cron timer migrations having
    // landed first — without that, the on-disk workspace scan invents
    // fresh runtime IDs that orphan every per-workspace migration's data
    // (registry duplicates, cron timers re-registered with empty history,
    // memory readable only at the dead legacy id). Steady-state cost is
    // microseconds (audit shows everything skipped); upgrade-boot cost is
    // bounded by legacy data volume. Operators can still run `atlas
    // migrate` standalone for recovery — the lock in `runMigrations`
    // serializes us against them.
    try {
      const migrations = await getAllMigrations();
      const result = await runMigrations(nc, migrations, logger, { runner: "daemon" });
      this.migrationStatus = { state: "complete", result };
      if (result.failed.length > 0) {
        // ERROR (not WARN) so log filters/dashboards surface this. A
        // half-migrated install is a correctness hazard — the operator
        // needs to re-run `atlas migrate` (or restart the daemon, which
        // re-runs the failed entry) and inspect the per-migration error
        // recorded in the `_FRIDAY_MIGRATIONS` audit-trail KV.
        logger.error("Migrations completed with failures", {
          ran: result.ran,
          skipped: result.skipped,
          failed: result.failed,
          hint: "Inspect via `atlas migrate --list`; re-run with `atlas migrate`.",
        });
      } else {
        logger.info("Migrations summary", { ...result });
      }
    } catch (err) {
      const error = String(err);
      // The runner itself threw before producing a per-entry result —
      // most often a transient broker disconnect mid-walk, or another
      // process holding the migration lock. Same severity bump:
      // operator needs visibility, not a buried warning.
      this.migrationStatus = {
        state: "complete",
        result: { ran: [], skipped: [], failed: ["__runner__"] },
        error,
      };
      logger.error("Migration runner failed", {
        error,
        hint: "Inspect via `atlas migrate --list`; re-run with `atlas migrate`.",
      });
    }

    // Start capability handlers (wildcard subscribers for agent back-channel)
    this.capabilityRegistry = new CapabilityHandlerRegistry();
    this.capabilityRegistry.start(nc);
    this.processAgentExecutor = new ProcessAgentExecutor(nc, this.capabilityRegistry);

    // Create WorkspaceManager (initialize later once registrars and watcher are ready).
    // Registry storage is JetStream-KV-backed; the per-workspace records
    // live in the WORKSPACE_REGISTRY bucket. Migration entry republishes
    // legacy ~/.atlas/storage.db rows.
    logger.info("Creating WorkspaceManager...");
    const registry = await createRegistryStorageJS(nc);
    this.workspaceManager = new WorkspaceManager(registry);
    this.workspaceManager.setMemoryAdapter(
      new JetStreamMemoryAdapter({
        nc,
        limits: {
          maxMsgSize: jsCfg.stream.maxMsgSize.value,
          duplicateWindowNs: jsCfg.stream.duplicateWindowNs.value,
        },
      }),
    );

    // Wire up runtime invalidation callback so file watcher changes clear both maps
    this.workspaceManager.setRuntimeInvalidateCallback(this.destroyWorkspaceRuntime.bind(this));

    // Initialize CronManager with JetStream-KV-backed storage. Cron
    // only uses get/set/delete/list — JS KV's per-key model fits
    // exactly. Migration entry below republishes any legacy
    // ~/.atlas/storage.db cron rows into the CRON_TIMERS bucket.
    logger.info("Initializing CronManager...");
    const cronStorage = await createJetStreamKVStorage(nc, { bucket: "CRON_TIMERS", history: 5 });
    this.cronManager = new CronManager(cronStorage, logger);

    // Workspace events stream — append-only audit feed for the
    // `/schedules` UI and any future workspace-side subscriber. Wire
    // CronManager to publish a `schedule.missed` event on every
    // coalesce / catchup make-up firing.
    await ensureWorkspaceEventsStream(nc);
    this.cronManager.setMissedFiringNotifier((event) =>
      publishWorkspaceEvent(nc, { type: "schedule.missed", ...event }, logger),
    );

    // Wire scratchpad to its own JetStream KV bucket. Same per-key
    // pattern; migration republishes legacy ~/.atlas/storage.db
    // scratchpad entries into SCRATCHPAD bucket.
    const scratchpadStorage = await createJetStreamKVStorage(nc, {
      bucket: "SCRATCHPAD",
      history: 1, // notes are append-only; one revision is enough
    });
    initScratchpadStorage(scratchpadStorage);

    // Wire artifact storage to JetStream KV (ARTIFACTS bucket) + Object
    // Store (OBJ_artifacts). Migration entry republishes legacy
    // ~/.atlas/storage.db artifact rows + reads file contents from
    // disk into the Object Store, content-addressed by SHA-256.
    initArtifactStorage(nc);

    // Wire workspace-state storage (state_append/lookup/filter MCP tools)
    // to JetStream — one KV bucket per workspace (WS_STATE_<wsid>).
    // Replaces the legacy ~/.atlas/artifacts/<wsid>/state.db SQLite store.
    initWorkspaceStateStorage(nc);

    // Wire skill storage to JetStream (SKILLS KV bucket + SKILL_ARCHIVES
    // Object Store). Both packages/system/skills/ bootstrap and `atlas
    // skill publish` writes flow through this single adapter. Replaces
    // the legacy ~/.atlas/skills.db SQLite store.
    initSkillStorage(nc);

    // Wire DocumentStore to JetStream — one KV bucket per workspace
    // (WS_DOCS_<wsid>). Used by the workspace runtime + FSM engine for
    // per-step input/output documents and FSM state. Replaces the
    // ~/.atlas/workspaces/<wsid>/[sessions/<sid>/]<type>/<id>.json
    // FileSystemDocumentStore tree.
    initDocumentStore(nc);

    // Initialize agent registry with bundled + user agents
    logger.info("Initializing agent registry...");
    const agentRegistry = new CoreAgentRegistry({
      includeSystemAgents: true,
      userAgentsDir: join(getFridayHome(), "agents"),
    });
    await agentRegistry.initialize();
    logger.info("Agent registry initialized");
    this.agentRegistry = agentRegistry;

    // Set up workspace wakeup callback — publishes onto the SIGNALS JetStream
    // stream. The local SignalConsumer (started below) picks up the envelope
    // and dispatches via `triggerWorkspaceSignal`. Going through JetStream
    // gives us durability (broker redelivers if the daemon dies between
    // publish and dispatch) and a uniform substrate that future cross-process
    // workers consume from.
    const wakeupCallback: WorkspaceSignalTriggerCallback = async (
      workspaceId: string,
      signalId: string,
      signalData,
    ) => {
      let enrichedSignalData = signalData;
      if (!signalData.userId) {
        const manager = this.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (workspace?.metadata?.createdBy) {
          enrichedSignalData = { ...signalData, userId: workspace.metadata.createdBy };
        }
      }

      try {
        await publishSignal(nc, {
          workspaceId,
          signalId,
          payload: enrichedSignalData as Record<string, unknown>,
        });
        logger.debug("Signal published to JetStream", { workspaceId, signalId });
      } catch (error) {
        logger.error("Failed to publish wakeup signal to JetStream", {
          workspaceId,
          signalId,
          error,
        });
      }
    };

    this.cronManager.setWakeupCallback(wakeupCallback);

    // Create signal registrars and pass them to WorkspaceManager.initialize
    const fsRegistrar = new FsWatchSignalRegistrar(wakeupCallback);
    const cronRegistrar = new CronSignalRegistrar(this.cronManager);

    const signalRegistrars: WorkspaceSignalRegistrar[] = [fsRegistrar, cronRegistrar];

    // Initialize WorkspaceManager with registrars and watcher (manager owns lifecycle)
    await this.workspaceManager.initialize(signalRegistrars);

    // Spin up the SIGNALS consumer now that the workspace manager can satisfy
    // dispatched envelopes. The consumer reads from the stream and calls
    // triggerWorkspaceSignal — same in-process path the HTTP handler uses.
    //
    // Error handling mirrors the legacy per-workspace NATS subscription:
    //   - SessionFailedError = domain-level session failure → ack (signal
    //     was delivered fine; the cascade just had a domain failure).
    //   - Any other error = infra-level failure → mark the workspace
    //     "inactive" with the error metadata, destroy its runtime, and
    //     throw so the broker NAKs and redelivers (up to maxDeliver).
    this.signalConsumer = new SignalConsumer(
      nc,
      async (envelope: SignalEnvelope, ctx) => {
        try {
          return await this.triggerWorkspaceSignal(
            envelope.workspaceId,
            envelope.signalId,
            envelope.payload,
            envelope.streamId,
            ctx.onStreamEvent,
          );
        } catch (err) {
          if (err instanceof SessionFailedError) {
            logger.warn("Signal session failed", {
              workspaceId: envelope.workspaceId,
              signalId: envelope.signalId,
              status: err.status,
              error: err.message,
            });
            // Domain-level failure (not infra). For correlated callers we need
            // to surface it as ok=false on the response subject and ack so the
            // broker doesn't redeliver. For uncorrelated callers (cron-style)
            // we just ack — the legacy NATS subscriber didn't redeliver these
            // either.
            if (envelope.correlationId) {
              throw err;
            }
            return undefined;
          }
          logger.error("Failed to process signal", {
            error: err,
            workspaceId: envelope.workspaceId,
            signalId: envelope.signalId,
          });
          try {
            const manager = this.getWorkspaceManager();
            const workspace = await manager.find({ id: envelope.workspaceId });
            await manager.updateWorkspaceStatus(envelope.workspaceId, "inactive", {
              metadata: {
                ...workspace?.metadata,
                lastError: err instanceof Error ? err.message : String(err),
                lastErrorAt: new Date().toISOString(),
                failureCount: (workspace?.metadata?.failureCount ?? 0) + 1,
              },
            });
            // Note: we used to destroyWorkspaceRuntime here on signal failure.
            // That assumed a corrupted runtime is the most likely cause of a
            // signal failure, but in practice signal failures are usually
            // transient (network, MCP timeout, LLM error) and tearing down the
            // runtime forces an expensive cold restart on the next trigger.
            // Idle timeout / explicit shutdown handle genuine cleanup.
          } catch (statusError) {
            logger.error("Failed to update workspace status after signal failure", {
              workspaceId: envelope.workspaceId,
              statusError,
            });
          }
          throw err;
        }
      },
      {
        maxAckPending: jsCfg.consumer.maxAckPending.value,
        maxDeliver: jsCfg.consumer.maxDeliver.value,
        ackWaitNs: jsCfg.consumer.ackWaitNs.value,
      },
    );
    // NB: do NOT start the consumer here — that would race with the
    // rest of init (`getOrCreateWorkspaceRuntime` requires
    // `isInitialized = true`). Started below after the init flag flips.

    // Register in-process tool workers. Default behavior — each worker
    // subscribes to a NATS subject and executes the tool's handler when
    // an envelope arrives.
    //
    // Set FRIDAY_TOOL_WORKERS=external to skip in-process registration,
    // so a separate process running apps/atlasd/src/tool-worker-entry.ts
    // claims the subjects instead. Useful even single-node for process
    // isolation (a runaway tool can't crash the daemon), resource limits
    // (ulimit / cgroup the worker without affecting daemon), and
    // multi-worker scaling. Same path becomes the sandbox runtime when
    // isolation matures (run the entry inside a container).
    if (process.env.FRIDAY_TOOL_WORKERS !== "external") {
      this.toolWorkers.push(
        registerToolWorker(nc, "bash", (req, ctx) =>
          executeBash(BashArgsSchema.parse(req.args), { abortSignal: ctx.abortSignal }),
        ),
        registerToolWorker(nc, "webfetch", (req, ctx) =>
          executeWebfetch(WebfetchArgsSchema.parse(req.args), { abortSignal: ctx.abortSignal }),
        ),
      );
    } else {
      logger.info("FRIDAY_TOOL_WORKERS=external — skipping in-process tool worker registration");
    }

    // Bootstrap @atlas/* system skills before any workspace chat gets a chance
    // to ask for them. Idempotent — only republishes on content-hash mismatch.
    try {
      const { ensureSystemSkills } = await import("@atlas/system/skills/bootstrap");
      await ensureSystemSkills();
    } catch (error) {
      logger.error("Failed to bootstrap @atlas system skills", { error });
    }

    // Start CronManager — pass the live set of workspace ids so any
    // persisted timer pointing at a deleted workspace (e.g. one removed
    // outside the manager via direct rm) is pruned before the tick loop
    // can fire WorkspaceNotFoundError every cron interval.
    const knownWorkspaces = await this.workspaceManager.list({ includeSystem: true });
    await this.cronManager.start({ knownWorkspaceIds: new Set(knownWorkspaces.map((w) => w.id)) });

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
    this.chatTurnRegistry = new ChatTurnRegistry();

    // Initialize session history v2 adapter + registry. JetStream-backed:
    // events live in the SESSION_EVENTS stream, summaries in
    // SESSION_METADATA KV, in-flight markers in SESSION_INFLIGHT KV.
    // Replaces ~/.atlas/sessions-v2/<sid>/{events.jsonl, metadata.json}.
    this.sessionHistoryAdapter = new JetStreamSessionHistoryAdapter(nc);
    // Recover any sessions whose previous daemon process died mid-flight.
    this.sessionHistoryAdapter.markInterruptedSessions().catch((err: unknown) => {
      logger.warn("Failed to mark interrupted sessions on startup", { error: String(err) });
    });
    this.sessionStreamRegistry = new SessionStreamRegistry(nc);
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
      AtlasMetrics.registerUptimeProvider(() => Math.floor((Date.now() - this.startTime) / 1000));
      logger.info("OTEL metrics providers registered");
    }

    // Start chunked upload cleanup lifecycle
    initChunkedUpload();

    this.isInitialized = true;

    // Start the SIGNALS consumer LAST so no message can be dispatched
    // until every prerequisite (cron manager, session adapter, tool
    // workers, isInitialized flag) is in place. Pre-existing signals
    // in the queue (redeliveries, leftovers from a previous daemon
    // run) sit until we're ready to dispatch — no "not initialized"
    // throws / NAK / redelivery loops on boot. (Bug 2026-05-03:
    // rtx-price-check-cron seq 40 was hitting deliveryCount: 3 on
    // restart because the consumer was started ~100 lines before
    // isInitialized = true.)
    if (this.signalConsumer) await this.signalConsumer.start();

    logger.info("Atlas daemon initialized");
  }

  // fs-watch registration moved to signal registrars

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
      onsessioninitialized: (sid: string) => {
        logger.info("[Daemon] Platform session initialized", { sessionId: sid });
      },
    });

    // Create per-session Platform MCP server
    const daemonUrl = getAtlasDaemonUrl();
    const nc = this.natsManager?.connection;
    const server = new PlatformMCPServer({
      daemonUrl,
      logger: logger.child({ component: "platform-mcp-server", sessionId }),
      workspaceProvider: {
        getOrCreateRuntime: (id: string) => this.getOrCreateWorkspaceRuntime(id),
      },
      workspaceConfigProvider: {
        getWorkspaceConfig: (id: string) => this.getWorkspaceManager().getWorkspaceConfig(id),
      },
      toolDispatcher: nc
        ? {
            callTool: async <Args, Result>(toolId: string, args: Args): Promise<Result> => {
              const reply = await callTool(nc, toolId, args, {
                workspaceId: "platform",
                sessionId,
                callerAgentId: "platform-mcp",
                timeoutMs: 600_000,
              });
              if (!reply.ok) {
                throw new Error(`tool '${toolId}' failed: ${reply.error.message}`);
              }
              return reply.result as Result;
            },
          }
        : undefined,
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

  /** Get the NATS connection (available after initialize()). */
  public getNatsConnection() {
    if (!this.natsManager) {
      throw new Error("NATS not initialized — call initialize() first");
    }
    return this.natsManager.connection;
  }

  /** Get the ProcessAgentExecutor (available after NATS initializes). */
  public getProcessAgentExecutor(): ProcessAgentExecutor | null {
    return this.processAgentExecutor;
  }

  /**
   * Create the SESSIONS JetStream stream if missing. New installs get
   * File storage + 30d retention. Existing installs are upgraded by the
   * `m_a6ab40b_sessions_stream_upgrade` migration entry, which adds
   * `max_age` to streams created without one and warns if storage is
   * still Memory (storage type can't be changed via update).
   */
  private async ensureSessionsStream(nc: NatsConnection): Promise<void> {
    const jsm = await nc.jetstreamManager();
    const THIRTY_DAYS_NS = 30 * 24 * 60 * 60 * 1_000_000_000;
    try {
      await jsm.streams.info("SESSIONS");
      // Already exists — leave it. Upgrade path is the migration entry.
    } catch {
      await jsm.streams.add({
        name: "SESSIONS",
        subjects: ["sessions.*.events"],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        max_age: THIRTY_DAYS_NS,
      });
      logger.info("Created SESSIONS JetStream stream (file storage, 30d retention)");
    }
  }

  /**
   * Daemon-wide subscription to the broker's max-deliveries advisory.
   * Catches dead-lettered messages from EVERY (stream, consumer) pair —
   * SIGNALS, future CHAT_* / MEMORY_* consumers, anything else. One log
   * surface, no per-stream wiring.
   *
   * Wildcard subject: $JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.<stream>.<consumer>
   * — `>` matches both trailing tokens.
   */
  private subscribeMaxDeliveriesAdvisory(nc: NatsConnection): void {
    const sub = nc.subscribe("$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>");
    const dec = new TextDecoder();
    void (async () => {
      for await (const msg of sub) {
        try {
          const advisory = JSON.parse(dec.decode(msg.data));
          logger.error("JetStream message dead-lettered", { subject: msg.subject, advisory });
        } catch {
          // Malformed advisory; ignore.
        }
      }
    })();
  }

  /**
   * Resolved platform model selector. Initialized during `initialize()`.
   */
  getPlatformModels(): PlatformModels {
    if (!this.platformModels) {
      throw new Error("Platform models not initialized. Call initialize() first.");
    }
    return this.platformModels;
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
      const context = { method, path, status, duration: `${duration}ms`, component: "http" };

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
    this.app.route("/api/workspaces/:workspaceId/config", workspaceConfigRoutes);
    this.app.route("/api/workspaces/:workspaceId/chat", workspaceChatRoutes);
    this.app.route("/api/workspaces/:workspaceId/chat", workspaceChatDebugRoutes);
    this.app.route("/api/workspaces/:workspaceId/integrations", integrationRoutes);
    this.app.route("/api/workspaces/:workspaceId/mcp", mcpRoutes);
    this.app.route("/api/workspaces", workspaceEventsRoutes);
    this.app.route("/api/events", eventsRoutes);
    this.app.route("/api/artifacts", artifactsApp);
    this.app.route("/api/chunked-upload", chunkedUploadApp);
    this.app.route("/api/chat", chatRoutes);
    this.app.route("/api/chat-storage", chatStorageRoutes);
    this.app.route("/api/config", configRoutes);
    this.app.route("/api/user", userRoutes);
    this.app.route("/api/scratchpad", scratchpadApp);
    this.app.route("/api/sessions", sessionsRoutes);
    this.app.route("/api/agents", agentsRoutes);
    this.app.route("/api/daemon", daemonApp);
    this.app.route("/api/share", shareRoutes);
    this.app.route("/api/link", linkRoutes);
    this.app.route("/api/mcp-registry", mcpRegistryRouter);
    this.app.route("/api/me", meRoutes);
    this.app.route("/api/jobs", jobsRoutes);
    this.app.route("/api/skills", skillsRoutes);
    this.app.route("/api/report", reportRoutes);
    this.app.route("/api/memory", memoryNarrativeRoutes);
    this.app.route("/api/cron", cronRoutes);

    // Platform signal routes (Discord/Slack via Signal Gateway)
    this.app.route("/signals", createPlatformSignalRoutes(this));

    // Global error handler - catches all uncaught errors from all routes
    this.app.onError((err, c) => {
      logger.error("API error", { error: err, path: c.req.path, method: c.req.method });
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
            logger.debug("Registering workspace LLM agent", { workspaceId: workspace.id, agentId });
            const agent = convertLLMToAgent(agentConfig, agentId, logger);
            await this.agentRegistry?.registerAgent(agent);
            logger.info("Registered workspace LLM agent", { workspaceId: workspace.id, agentId });
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
            const baseAgent = await this.agentRegistry?.getAgent(agentConfig.agent);
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
        signals: mergedConfig.workspace?.signals ? Object.keys(mergedConfig.workspace.signals) : [],
      });

      // Determine workspace path
      let workspacePath: string | undefined;
      if (workspace.metadata?.system) {
        // System workspaces are in packages/system/workspaces/{workspace-name}/
        workspacePath = new URL(`../../../packages/system/workspaces`, import.meta.url).pathname;
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
          platformModels: this.getPlatformModels(),
          agentExecutor: this.processAgentExecutor ?? undefined,
          daemonUrl: `http://localhost:${this.options.port}`, // Pass daemon URL for MCP tool fetching
          broadcastNotifier: createFSMBroadcastNotifier({
            workspaceId: workspace.id,
            getInstance: (id) => this.getOrCreateChatSdkInstance(id),
          }),
          createSessionStream: (sessionId) =>
            this.sessionStreamRegistry.create(sessionId, this.sessionHistoryAdapter),
          onSessionComplete: async ({
            workspaceId,
            sessionId,
            streamId,
            status,
            finalOutput,
            jobName,
          }) => {
            // Broadcast the session's final agent output across configured chat
            // communicators — but ONLY for non-chat-triggered sessions (cron,
            // HTTP webhooks, etc.). Chat sessions already deliver their reply
            // via the inbound adapter's `thread.post(stream)` path; running
            // the broadcast on top would just spam the originating channel
            // and any other configured destinations with the same message
            // the user already saw.
            //
            // Detection: the runtime auto-injects a `handle-chat` FSM job for
            // every workspace (see runtime.ts:529–560) — every chat-triggered
            // session, regardless of inbound platform (Slack/Telegram/Atlas
            // Web/API), runs through that job. Skipping by jobName catches
            // them all, including API-triggered tests where no chat record
            // exists yet.
            if (status !== WorkspaceSessionStatus.COMPLETED || !finalOutput) return;
            if (jobName === "handle-chat") {
              logger.debug("broadcast_skipped_chat_job", { workspaceId, sessionId, jobName });
              return;
            }
            // Cheap-out before paying for chat-SDK construction: if the
            // workspace declares no chat platform with a `default_destination`,
            // there's nothing for the broadcaster to do. Spinning up `Chat` +
            // adapters just to discover an empty destinations map is wasted
            // work for pure cron/HTTP workspaces. Reads from the already-cached
            // workspace config; falls through (and thus initializes) on lookup
            // failure so legitimate broadcasts aren't accidentally dropped.
            try {
              const cfg = await this.getWorkspaceManager().getWorkspaceConfig(workspaceId);
              if (cfg && !workspaceHasBroadcastDestination(cfg.workspace)) {
                logger.debug("broadcast_skipped_no_destinations", { workspaceId, sessionId });
                return;
              }
            } catch {
              // If config lookup fails, fall through to the lazy init path so
              // we don't silently swallow a real broadcast. The init itself has
              // its own error handling below.
            }
            // Lazy-init the chat-sdk for the workspace. Workspaces that never
            // received an inbound chat message wouldn't otherwise have an
            // instance built — but the broadcast path still needs the notifier
            // and destination map.
            let instance: ChatSdkInstance;
            try {
              instance = await this.getOrCreateChatSdkInstance(workspaceId);
            } catch (err) {
              logger.warn("broadcast_chat_sdk_init_failed", {
                workspaceId,
                sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
              return;
            }
            // Source identification: chat thread IDs are canonically
            // `<platform>:<channel>:<thread>` (the chat-SDK threadId
            // convention every adapter follows). The streamId prefix IS
            // the source platform — for chat-platform inbounds, for
            // nested job sessions invoked via the chat agent's job tool
            // (which inherit the parent chat's streamId), and for any
            // future caller that passes a chat threadId. Atlas-web
            // streams use `chat_XXXXX` (no colon) and plain HTTP/cron
            // triggers use the session UUID — both fall through to
            // `null`, so every configured destination broadcasts.
            const prefix = streamId?.includes(":") ? streamId.split(":")[0] : null;
            const sourceCommunicator =
              prefix && (CHAT_PROVIDERS as readonly string[]).includes(prefix) ? prefix : null;
            await broadcastJobOutput({
              workspaceId,
              notifier: instance.notifier,
              destinations: instance.broadcastDestinations,
              sourceCommunicator,
              output: { markdown: finalOutput },
            }).catch((err) => {
              logger.warn("broadcast_job_output_failed", {
                workspaceId,
                sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          },
          onSessionFinished: async ({ workspaceId, sessionId, status, finishedAt, summary }) => {
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
                  lastFinishedSession: { id: sessionId, status, finishedAt, summary },
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
                  // Apply any deferred workspace.yml changes. If a deferred
                  // change exists, processPendingWatcherChange routes through
                  // handleWorkspaceConfigChange → stopRuntimeIfActive →
                  // destroyWorkspaceRuntime, so the runtime gets rebuilt from
                  // the new config on the next signal. If no deferred change
                  // exists, we DO NOT tear down the runtime — keep MCP
                  // connections warm; idle timeout handles eventual cleanup.
                  // The prior unconditional destroy here was the source of
                  // per-chat-turn create/destroy churn.
                  try {
                    await mgr.processPendingWatcherChange(workspaceId);
                  } catch (err) {
                    logger.warn("Failed to process pending watcher change", {
                      workspaceId,
                      error: err,
                    });
                  }
                  this.resetIdleTimeout(workspaceId);
                } else {
                  // Still active sessions or agent executions; let idle timeout handle cleanup
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
        },
      );
      logger.debug("WorkspaceRuntime created", { workspaceId: workspace.id });

      this.runtimes.set(workspace.id, runtime);
      logger.debug("Runtime stored in daemon registry", { workspaceId: workspace.id });

      // Register runtime with WorkspaceManager
      await manager.registerRuntime(workspace.id, runtime);
      logger.debug("Runtime registered with WorkspaceManager", { workspaceId: workspace.id });

      // Signal routing now goes through the SIGNALS JetStream stream and the
      // shared SignalConsumer (started in initialize()). No per-workspace
      // NATS subscription needed — the consumer dispatches every envelope
      // via triggerWorkspaceSignal which already does the runtime wakeup.

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
   * Publish a signal envelope onto the SIGNALS JetStream stream. The local
   * SignalConsumer (or any worker subscribed to the same durable consumer
   * in a multi-process deployment) will pick it up and run the cascade
   * via `triggerWorkspaceSignal`.
   *
   * Use this for fire-and-forget dispatch — the publish ack returns immediately
   * with the broker sequence number; the actual session id is allocated later
   * by whichever worker handles the message. For synchronous "trigger and
   * await result" semantics, keep using `triggerWorkspaceSignal` directly.
   */
  public publishSignalToJetStream(opts: PublishSignalOpts): Promise<{ seq: number }> {
    const nc = this.natsManager?.connection;
    if (!nc) throw new Error("NATS not initialized — call initialize() first");
    return publishSignal(nc, opts);
  }

  /**
   * Cached per workspace; torn down when the runtime is destroyed.
   *
   * Cost breakdown:
   * - getWorkspaceConfig: mtime-cached — sub-ms steady state.
   * - resolvePlatformCredentials: HTTP to Link, ~10-100ms per workspace.
   *   Paid once per workspace per daemon lifetime via this cache.
   * - buildChatSdkAdapters + new Chat: ~ms of pure object construction,
   *   no I/O.
   *
   * Per-signal cost is O(1) cache lookup. The single concrete future-work
   * risk is the cross-worker per-signal model (Phase 2/3): each worker
   * would re-resolve credentials on its first signal for a given workspace.
   * Acceptable for typical traffic; if needed, share resolved creds via
   * NATS KV with a TTL.
   */
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

  private async buildChatSdkInstance(workspaceId: string): Promise<ChatSdkInstance> {
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
      const communicators = config.workspace?.communicators as
        | Record<string, { kind?: string } & Record<string, unknown>>
        | undefined;
      const resolved = await resolvePlatformCredentials(
        workspaceId,
        userId,
        signals,
        communicators,
      );
      if (resolved.length > 0) {
        credentials = resolved.map((r) => r.credentials);
      }
    } catch (error) {
      logger.warn("chat_sdk_credential_resolution_failed", { workspaceId, error });
    }

    const instanceConfig: ChatSdkInstanceConfig = {
      workspaceId,
      userId,
      signals: config.workspace?.signals as
        | Record<string, { provider?: string; config?: Record<string, unknown> }>
        | undefined,
      communicators: config.workspace?.communicators as
        | Record<string, { kind?: string } & Record<string, unknown>>
        | undefined,
      streamRegistry: this.streamRegistry,
      chatTurnRegistry: this.chatTurnRegistry,
      exposeKernel: process.env.FRIDAY_EXPOSE_KERNEL === "1",
      triggerFn: async (signalId, signalData, streamId, onStreamEvent, abortSignal) => {
        const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);
        const session = await runtime.triggerSignalWithSession(
          signalId,
          signalData,
          streamId,
          onStreamEvent,
          undefined,
          abortSignal,
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
    let activeExecutions: Array<{ agentId: string; sessionId: string; durationMs: number }> = [];

    // WorkspaceRuntimeFSM has getOrchestrator() method
    if ("getOrchestrator" in runtime && typeof runtime.getOrchestrator === "function") {
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
        logger.debug("Workspace has active agent executions, resetting idle timeout", {
          workspaceId,
          activeExecutionsCount: activeExecutions.length,
        });
      }
      this.resetIdleTimeout(workspaceId);
    }
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
        logger.error("Error shutting down workspace runtime", { error, workspaceId });
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
      // Re-entry guard — the same handler can fire twice in quick succession.
      // Guarded by `shutdownPromise` (set inside shutdown()) so that any
      // other caller racing this path (e.g. the CLI's own SIGTERM handler in
      // apps/atlas-cli/src/commands/daemon/start.tsx) awaits the same
      // in-flight work instead of calling process.exit(0) on top of it.
      if (this.shutdownPromise) return;

      logger.info("Daemon received signal, shutting down gracefully", { daemonId, signal });

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
        hint: "Set DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY, DISCORD_APPLICATION_ID or declare a discord signal with bot_token/public_key/application_id in workspace.yml",
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

  private async resolveDiscordGatewayCredentials(): Promise<{
    botToken: string;
    publicKey: string;
    applicationId: string;
  } | null> {
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
        const communicators = config?.workspace.communicators;

        // Top-level `communicators` map wins for adapter discovery; only
        // fall back to a discord-provider signal when the kind isn't
        // declared at the new top-level site.
        let discordConfig: Record<string, unknown> | null = null;
        if (communicators) {
          for (const entry of Object.values(communicators)) {
            if (entry?.kind === "discord") {
              const { kind: _kind, ...rest } = entry;
              discordConfig = rest;
              break;
            }
          }
        }
        if (!discordConfig && signals) {
          for (const signal of Object.values(signals)) {
            if (signal.provider === "discord") {
              discordConfig = signal.config ?? {};
              break;
            }
          }
        }
        if (!discordConfig) continue;

        const userId = workspace.metadata?.createdBy ?? "default-user";
        const creds = await resolveDiscordCredentials(workspace.id, userId, discordConfig);
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
          hint: "Only one Discord bot listener is started per daemon. To run multiple bots, run multiple daemons.",
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

  shutdown(): Promise<void> {
    // Memoize so concurrent callers (signal handlers in this file and in
    // apps/atlas-cli/src/commands/daemon/start.tsx, plus any tests/HTTP
    // routes) await the same in-flight teardown instead of racing on
    // process.exit(0) and tearing down work mid-flight.
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this._doShutdown();
    return this.shutdownPromise;
  }

  private async _doShutdown(): Promise<void> {
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

    // Stop tool workers so in-flight dispatches can finish or fail cleanly.
    for (const worker of this.toolWorkers) {
      try {
        await worker.stop();
      } catch (error) {
        logger.error("Error stopping tool worker", { toolId: worker.toolId, error });
      }
    }
    this.toolWorkers = [];

    // Stop the SIGNALS consumer before tearing down runtimes so in-flight
    // dispatches can finish against live workspaces.
    if (this.signalConsumer) {
      try {
        await this.signalConsumer.stop();
      } catch (error) {
        logger.error("Error stopping SIGNALS consumer", { error });
      }
      this.signalConsumer = null;
    }

    // Reap orphaned agent-browser daemons. Done early in shutdown — after
    // the SIGNALS consumer stops (no new agent invocations can start) but
    // before runtime/MCP teardown (which can hang past the 30s shutdown
    // budget). Force-closes any in-flight web sessions; the bundled agents
    // were about to be SIGTERM'd anyway, and the next-startup sweep
    // (layer 2) is the long-stop for anything that slips through here.
    await sweepOrphanedAgentBrowserSessions(logger).catch((error) => {
      logger.warn("agent-browser session sweep failed at shutdown", { error: String(error) });
    });

    // Stop chunked upload cleanup
    shutdownChunkedUpload();

    // Shutdown all workspace runtimes
    const shutdownPromises = Array.from(this.runtimes.keys()).map((workspaceId) =>
      this.destroyWorkspaceRuntime(workspaceId),
    );
    await Promise.all(shutdownPromises);

    // SIGTERM (then SIGKILL after grace) any shared MCP subprocesses still
    // alive — workspace-mcp instances on fixed ports owned by the
    // daemon-scoped process registry. Done after runtimes shut down so no
    // new MCP connections can race the kill.
    try {
      await sharedMCPProcesses.shutdown();
    } catch (error) {
      logger.error("Error shutting down shared MCP processes", { error });
    }

    // Shutdown StreamRegistry
    this.streamRegistry?.shutdown();
    this.chatTurnRegistry?.shutdown();

    // Shutdown SessionStreamRegistry
    await this.sessionStreamRegistry?.shutdown();

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

  getStatus() {
    const cronStats = this.cronManager?.getStats();

    return {
      activeWorkspaces: this.runtimes.size,
      uptime: Date.now() - this.startTime,
      cronManager: cronStats
        ? { isActive: this.cronManager?.isRunning || false, ...cronStats }
        : null,
      migrations: this.migrationStatus,
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
