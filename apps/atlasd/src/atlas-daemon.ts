import { stat } from "node:fs/promises";
import { join } from "node:path";
import process, { env } from "node:process";
import { JetStreamMemoryAdapter } from "@atlas/adapters-md";
import type { AgentRegistry as AgentRegistryType } from "@atlas/agent-sdk";
import type { ConcurrencyPolicy } from "@atlas/config";
import { FilesystemAtlasConfigSource } from "@atlas/config/server";
import {
  AtlasAgentsMCPServer,
  AgentRegistry as CoreAgentRegistry,
  convertLLMToAgent,
  JetStreamSessionHistoryAdapter,
  MissingEnvironmentError,
  SessionFailedError,
  WorkspaceNotFoundError,
  WorkspaceSessionStatus,
  wrapAtlasAgent,
} from "@atlas/core";
import { initArtifactStorage } from "@atlas/core/artifacts/server";
import { ensureChatsKVBucket, initChatStorage } from "@atlas/core/chat/storage";
import { bootstrapElicitationsStream, initElicitationStorage } from "@atlas/core/elicitations";
import { initMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import { ensureSessionsKVBucket, initSessionStorage } from "@atlas/core/sessions/storage";
import { ensureUsersKVBucket, initUserStorage, UserStorage } from "@atlas/core/users/storage";
import {
  ensureWorkspaceMembersKVBucket,
  initWorkspaceMemberStorage,
  WorkspaceMemberStorage,
} from "@atlas/core/workspace-members/storage";
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
  type TriggerSignalOpts,
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
import { HTTPException } from "hono/http-exception";
import { type RunMigrationsResult, readJetStreamConfig, runMigrations } from "jetstream";
import type { NatsConnection } from "nats";
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
import { elicitationApp } from "../routes/elicitations/index.ts";
import { healthRoutes } from "../routes/health.ts";
import { instanceEventsRoutes } from "../routes/instance-events.ts";
import { jobsRoutes } from "../routes/jobs.ts";
import { linkRoutes } from "../routes/link.ts";
import { mcpRegistryRouter } from "../routes/mcp-registry.ts";
import { meRoutes } from "../routes/me/index.ts";
import { meStreamRoutes } from "../routes/me/stream.ts";
import { memoryNarrativeRoutes } from "../routes/memory/index.ts";
import reportRoutes from "../routes/report.ts";
import { scratchUploadApp } from "../routes/scratch-upload.ts";
// O5 (review-2): scratchpad route deleted alongside the rest of the
// scratchpad surface (K1 removed the agent-sdk adapter + tools; this
// pass removes the daemon-side route + storage init + KV bucket).
// See L9 migration `m_20260507_120000_drop_scratchpad_kv` for the
// bucket cleanup on existing daemons.
import { sessionsRoutes } from "../routes/sessions/index.ts";
import { shareRoutes } from "../routes/share.ts";
import { createPlatformSignalRoutes } from "../routes/signals/platform.ts";
import { skillsRoutes } from "../routes/skills.ts";
import { userRoutes } from "../routes/user/index.ts";
import { eventsRoutes, workspaceEventsRoutes } from "../routes/workspace-events.ts";
import workspaceCacheSaltRoutes from "../routes/workspaces/cache-salt.ts";
import workspaceChatRoutes from "../routes/workspaces/chat.ts";
import workspaceChatDebugRoutes from "../routes/workspaces/chat-debug.ts";
import { configRoutes as workspaceConfigRoutes } from "../routes/workspaces/config.ts";
import { workspaceEnvRoutes } from "../routes/workspaces/env.ts";
import { workspacesRoutes } from "../routes/workspaces/index.ts";
import { integrationRoutes } from "../routes/workspaces/integrations.ts";
import { mcpRoutes } from "../routes/workspaces/mcp.ts";
import { CapabilityHandlerRegistry } from "./capability-handlers.ts";
import { CascadeConsumer, ensureCascadesStream, publishCascade } from "./cascade-stream.ts";
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
import { ensureInstanceEventsStream } from "./instance-events.ts";
import { getAllMigrations } from "./migrations/index.ts";
import { NatsManager } from "./nats-manager.ts";
import { ProcessAgentExecutor } from "./process-agent-executor.ts";
import { SessionDispatchRegistry } from "./session-dispatch-registry.ts";
import { SessionStreamRegistry } from "./session-stream-registry.ts";
import { CronSignalRegistrar } from "./signal-registrars/cron-registrar.ts";
import { FsWatchSignalRegistrar } from "./signal-registrars/fs-watch-registrar.ts";
import {
  ensureSignalsStream,
  envelopeToWebhookContext,
  type PublishSignalOpts,
  publishSignal,
  SignalConsumer,
  type SignalEnvelope,
} from "./signal-stream.ts";
// O5 (review-2): scratchpad storage deleted; see comment near `scratchpadApp` removal above.
import { StreamRegistry } from "./stream-registry.ts";
import { sweepOrphanedAgentBrowserSessions } from "./sweep-agent-browser-sessions.ts";
import {
  type ArtifactsSweeperHandle,
  startArtifactsSweeper,
} from "./sweepers/artifacts-sweeper.ts";
import {
  type ElicitationsSweeperHandle,
  startElicitationsSweeper,
} from "./sweepers/elicitations-sweeper.ts";
import { callTool, registerToolWorker, type ToolWorker } from "./tool-dispatch.ts";
import { AtlasMetrics } from "./utils/metrics.ts";
import { getAtlasDaemonUrl } from "./utils.ts";
import { ensureWorkspaceEventsStream, publishWorkspaceEvent } from "./workspace-events.ts";

export interface AtlasDaemonOptions {
  port?: number;
  hostname?: string;
  cors?: string | string[];
  sseHeartbeatIntervalMs?: number;
  sseConnectionTimeoutMs?: number;
  // PEM-encoded cert + key. When both are set, `Deno.serve` listens with
  // TLS and ALPN-negotiates HTTP/2, lifting the browser's per-origin
  // 6-socket HTTP/1.1 cap that strands the playground when SSE feeds
  // saturate the pool. Both must be set or neither — the CLI loads them
  // from FRIDAY_TLS_CERT / FRIDAY_TLS_KEY paths.
  tlsCert?: string;
  tlsKey?: string;
}

const INTERNAL_SIGNAL_BYPASS_TOKEN_ENV = "FRIDAY_INTERNAL_SIGNAL_BYPASS_TOKEN";

function ensureInternalSignalBypassToken(): void {
  let token = process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV];
  if (!token) {
    token = crypto.randomUUID();
    process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV] = token;
  }
  try {
    Deno.env.set(INTERNAL_SIGNAL_BYPASS_TOKEN_ENV, token);
  } catch {
    // Some test/embedding environments may not grant env write access.
  }
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
 * Race a shutdown step against a per-step deadline. A slow step gets
 * force-skipped on its own ceiling instead of eating the global shutdown
 * budget. Errors and timeouts are logged and swallowed — the rest of
 * shutdown continues.
 *
 * Pass a thunk (not a bare promise) when the work owns event-loop handles:
 * the step-local signal aborts on timeout so the underlying work can
 * actually cancel, instead of leaking handles and blocking process exit.
 */
export async function withShutdownTimeout<T>(
  label: string,
  task: Promise<T> | undefined | null | ((signal: AbortSignal) => Promise<T>),
  ms: number,
): Promise<void> {
  if (!task) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  try {
    let work: Promise<T>;
    if (typeof task === "function") {
      controller = new AbortController();
      work = task(controller.signal);
    } else {
      work = task;
    }
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`shutdown step "${label}" exceeded ${ms}ms`);
          controller?.abort(error);
          reject(error);
        }, ms);
      }),
    ]);
  } catch (error) {
    logger.warn("Shutdown step failed or timed out", { label, error: String(error) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Surfaced to the watchdog log so a postmortem shows which phase wedged. */
export type ShutdownPhase = "idle" | "phase-1-drain" | "phase-2" | "phase-3-nats" | "complete";

/**
 * AtlasDaemon - Single daemon managing multiple workspaces with on-demand runtime creation
 * Replaces the per-workspace WorkspaceServer architecture
 */
export class AtlasDaemon {
  private app: ReturnType<typeof createApp>;
  private options: AtlasDaemonOptions;
  // Public properties for AppContext interface
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
  private shutdownPromise: Promise<void> | null = null;
  public currentShutdownPhase: ShutdownPhase = "idle";
  private server: Deno.HttpServer | null = null;
  // Force-closes the Deno.serve listener when server.shutdown() exceeds its
  // step ceiling. Wired into both Deno.serve sites; aborted from the http
  // drain step below.
  private serverAbortController = new AbortController();
  private signalHandlers: Array<{ signal: Deno.Signal; handler: () => void }> = [];
  private isInitialized = false;
  private platformModels: PlatformModels | null = null;
  private natsManager: NatsManager | null = null;
  private capabilityRegistry: CapabilityHandlerRegistry | null = null;
  private processAgentExecutor: ProcessAgentExecutor | null = null;
  private signalConsumer: SignalConsumer | null = null;
  private cascadeConsumer: CascadeConsumer | null = null;
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
  public sessionDispatchRegistry!: SessionDispatchRegistry;
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
      activeRequests: number;
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
      activeRequests: number;
    }
  >();
  private platformSessionCleanupInterval: ReturnType<typeof setInterval> | null = null;
  // Platform session limits
  private readonly MAX_PLATFORM_SESSIONS = 100;
  private readonly PLATFORM_SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
  // Store the actual port after server starts
  #port: number | undefined;
  private discordGatewayService: DiscordGatewayService | null = null;
  /**
   * Phase 6.B — hourly sweep of ephemeral artifacts past their grace
   * window. Promotes via inbound-reference scan or deletes. Started
   * after JetStream init in {@link initialize}; stopped during the
   * domain-layer teardown phase of {@link shutdown}.
   */
  private artifactsSweeper: ArtifactsSweeperHandle | null = null;

  /**
   * G4 — pending→expired elicitation sweeper. Walks
   * `ELICITATION_STATUS` KV on a 60s tick, CAS-flips past-deadline
   * pending entries to expired. Started after JetStream init in
   * {@link initialize}; stopped during the domain-layer teardown
   * phase of {@link shutdown}.
   */
  private elicitationsSweeper: ElicitationsSweeperHandle | null = null;

  constructor(options: AtlasDaemonOptions = {}) {
    ensureInternalSignalBypassToken();
    // Read CORS origins from environment or options
    // Environment variable takes precedence for production deployments
    const envCorsOrigins = env.CORS_ALLOWED_ORIGINS?.split(",").map((s) => s.trim());
    const corsOrigins = envCorsOrigins ?? options.cors;

    this.options = {
      sseHeartbeatIntervalMs: 30 * 1000, // 30 seconds
      sseConnectionTimeoutMs: 5 * 60 * 1000, // 5 minutes
      ...options,
      cors: corsOrigins, // Override with resolved CORS origins
    };
    const exposeKernel = process.env.FRIDAY_EXPOSE_KERNEL === "1";
    const context = {
      exposeKernel,
      startTime: this.startTime,
      sseClients: this.sseClients,
      sseStreams: this.sseStreams,
      getWorkspaceManager: this.getWorkspaceManager.bind(this),
      getAgentRegistry: this.getAgentRegistry.bind(this),
      getOrCreateChatSdkInstance: this.getOrCreateChatSdkInstance.bind(this),
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
      get sessionDispatchRegistry() {
        return this.daemon.sessionDispatchRegistry;
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

    // CASCADES stream — dispatch buffer between SignalConsumer (forwarder)
    // and CascadeConsumer (executor). 1h max_age because cascades that
    // sit longer than that are queue-timeout territory anyway. The
    // CascadeConsumer enforces its own per-envelope queue-timeout
    // (FRIDAY_CASCADE_QUEUE_TIMEOUT, default 5min).
    await ensureCascadesStream(nc);

    // INSTANCE_EVENTS — instance-wide operational feed. Live updates
    // ride the per-user firehose at /api/me/stream; /api/instance/events
    // is the paginated replay endpoint. Used today for cascade backlog /
    // replace / queue-timeout signals; intentionally open to other
    // instance-level event types (daemon, health, …) without a split.
    await ensureInstanceEventsStream(nc);

    // Wire chat storage to JetStream + eagerly create the CHATS KV bucket
    // so the first cold read doesn't pay the create cost.
    initChatStorage(nc, {
      maxMsgSize: jsCfg.stream.maxMsgSize.value,
      duplicateWindowNs: jsCfg.stream.duplicateWindowNs.value,
    });
    await ensureChatsKVBucket(nc);

    // Wire user-identity storage and warm the local-user-id cache so
    // synchronous request handlers can read it via getCachedLocalUserId().
    initUserStorage(nc);
    await ensureUsersKVBucket(nc);
    {
      const localUser = await UserStorage.resolveLocalUserId();
      if (!localUser.ok) {
        throw new Error(`Failed to resolve local user id: ${localUser.error}`);
      }
      logger.info("Resolved local user id", { userId: localUser.data });
    }

    // Sessions: opaque-token middleware authority. Auto-mint in local
    // mode happens lazily on first request; the bucket just needs to
    // exist before the middleware reads from it.
    initSessionStorage(nc);
    await ensureSessionsKVBucket(nc);

    // Workspace memberships: per-user-per-workspace role rows. The
    // firehose handshake and HTTP authz middleware both read from
    // this bucket; migration below backfills owner rows for existing
    // workspaces, steady-state writes happen in WorkspaceManager via
    // the injected MembershipWriter (wired below, after the manager
    // is constructed).
    initWorkspaceMemberStorage(nc);
    await ensureWorkspaceMembersKVBucket(nc);

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
    this.processAgentExecutor = new ProcessAgentExecutor(
      nc,
      this.natsManager.url,
      this.capabilityRegistry,
    );

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

    // Stamp an `owner` membership row on every workspace registration.
    // The manager doesn't import @atlas/core directly — the writer is
    // injected here so the storage facade stays the daemon's concern.
    this.workspaceManager.setMembershipWriter({
      async stampOwner({ wsId, ownerUserId }) {
        const result = await WorkspaceMemberStorage.putIfAbsent({
          userId: ownerUserId,
          wsId,
          role: "owner",
          addedAt: new Date().toISOString(),
        });
        if (!result.ok) throw new Error(result.error);
      },
    });

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

    // O5 (review-2): SCRATCHPAD KV init removed alongside the route.
    // Migration `m_20260507_120000_drop_scratchpad_kv` deletes the
    // bucket on existing daemons. K1 removed the agent-sdk adapter +
    // chat-side tools; nothing reads from this bucket anymore.

    // Wire artifact storage to JetStream KV (ARTIFACTS bucket) + Object
    // Store (OBJ_artifacts). Migration entry republishes legacy
    // ~/.atlas/storage.db artifact rows + reads file contents from
    // disk into the Object Store, content-addressed by SHA-256.
    initArtifactStorage(nc);

    // Wire elicitation storage to JetStream — `ELICITATIONS` stream for
    // the durable audit trail of envelopes, `ELICITATION_STATUS` KV
    // bucket for O(1) status lookups. Phase 12 HITL primitive; HTTP
    // routes mounted at `/api/elicitations` below.
    initElicitationStorage(nc);

    // F7 (review-2): boot-time pre-flight — ensure the ELICITATIONS
    // stream exists with `allow_msg_ttl: true` BEFORE the first user
    // request can hit `/api/elicitations` or `request_tool_access`. The
    // adapter's lazy `ensureStream()` throws a "re-run migration"
    // error on legacy streams whose config drifted; fail-loud at boot
    // is far better UX than failing on the first elicitation publish
    // an hour into a daemon's life. Idempotent — `streams.update`
    // when present, `streams.add` when absent.
    await bootstrapElicitationsStream(nc);

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
    // stream. The local SignalConsumer forwards each envelope onto CASCADES;
    // the CascadeConsumer then applies the per-signal concurrency policy and
    // runs the cascade as a background Promise. Two streams give us:
    //   - delivery durability (SIGNALS retains the envelope until forwarded)
    //   - dispatch decoupling (a slow cascade on workspace A doesn't block
    //     workspace B's signal — head-of-line blocking that existed before
    //     the cascade split is gone)
    //   - independent observability (`nats consumer info` on each stream
    //     surfaces ingress vs execution backlog separately)
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

    // Initialize WorkspaceManager with registrars and watcher (manager owns lifecycle).
    // `defaultOwnerId` is threaded through to ensureDefaultUserWorkspace so the
    // user-workspace gets stamped with an owner membership row on first run.
    await this.workspaceManager.initialize(signalRegistrars, {
      defaultOwnerId: UserStorage.getCachedLocalUserId(),
    });

    // SignalConsumer — thin forwarder. Pulls from SIGNALS, parses the
    // envelope, publishes onto CASCADES, acks. No FSM execution here;
    // the heavy lifting moved to CascadeConsumer below.
    this.signalConsumer = new SignalConsumer(
      nc,
      (envelope: SignalEnvelope) => publishCascade(nc, envelope),
      {
        maxAckPending: jsCfg.consumer.maxAckPending.value,
        maxDeliver: jsCfg.consumer.maxDeliver.value,
        ackWaitNs: jsCfg.consumer.ackWaitNs.value,
      },
    );

    // CascadeConsumer — applies the per-signal `concurrency` policy
    // (skip / queue / concurrent / replace; default skip) and runs each
    // cascade as a background Promise so a slow cascade doesn't stall
    // delivery of the next envelope.
    //
    // Error handling for the cascade dispatcher:
    //   - SessionFailedError = domain-level session failure. Surfaces as
    //     ok=false on the correlated response subject; not retried.
    //   - Other Error = infra-level failure. Same surface, plus we
    //     mark the workspace inactive with the error metadata. Not
    //     retried (max_deliver=1 on CASCADES — failed cascades surface
    //     as failed sessions in storage, not as redelivery storms).
    this.cascadeConsumer = new CascadeConsumer(
      nc,
      async (envelope, ctx) => {
        try {
          // `envelopeToWebhookContext` extracts the byte-for-byte webhook
          // fields (body + headers, set only by the /signals/:sig/webhook
          // endpoint that fronts the tunnel proxy) into the opts-bag shape
          // `triggerWorkspaceSignal` expects. Returns `undefined` for
          // non-webhook envelopes so the runtime signal stays clean.
          return await this.triggerWorkspaceSignal(
            envelope.workspaceId,
            envelope.signalId,
            envelope.payload,
            {
              streamId: envelope.streamId,
              onStreamEvent: ctx.onStreamEvent,
              abortSignal: ctx.abortSignal,
              // Reuse the existing `sourceSessionId` envelope field as the
              // parent linkage. It was wired through on publish but never
              // consumed — Phase 11 makes it carry across into
              // `SessionSummary.parentSessionId`.
              parentSessionId: envelope.sourceSessionId,
              webhookContext: envelopeToWebhookContext(envelope),
            },
          );
        } catch (err) {
          if (err instanceof SessionFailedError) {
            logger.warn("Cascade session failed", {
              workspaceId: envelope.workspaceId,
              signalId: envelope.signalId,
              status: err.status,
              error: err.message,
            });
            throw err; // CascadeConsumer publishes ok=false on the response subject
          }
          logger.error("Failed to process cascade", {
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
          } catch (statusError) {
            logger.error("Failed to update workspace status after cascade failure", {
              workspaceId: envelope.workspaceId,
              statusError,
            });
          }
          throw err;
        }
      },
      async (workspaceId, signalId): Promise<ConcurrencyPolicy> => {
        try {
          const manager = this.getWorkspaceManager();
          const cfg = await manager.getWorkspaceConfig(workspaceId);
          const sig = cfg?.workspace?.signals?.[signalId];
          // `sig.concurrency` is typed `ConcurrencyPolicy | undefined`
          // through the WorkspaceSignalConfig schema in @atlas/config —
          // no cast needed.
          return sig?.concurrency ?? "skip";
        } catch {
          return "skip";
        }
      },
      { maxAckPending: parseInt(process.env.FRIDAY_CASCADE_CONCURRENCY ?? "32", 10) || 32 },
    );

    // NB: neither consumer starts here — they need `isInitialized=true`
    // (so `getOrCreateWorkspaceRuntime` works) and `triggerWorkspaceSignal`
    // ready. Started below after the init flag flips.

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

    // Daemon-level session-cancel routing. Subscribes once on
    // `daemon.cancel.sessions.>` and dispatches via an in-memory
    // `sessionId → AbortController` table. Subscribed sibling-of-
    // `sessions.>` so cancel commands don't get captured into the
    // SESSION_EVENTS stream.
    this.sessionDispatchRegistry = new SessionDispatchRegistry(nc);
    await this.sessionDispatchRegistry.start();

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
      // No persistent per-workspace runtimes — emit the count of in-flight
      // dispatches instead. The dispatch registry is the new authority.
      AtlasMetrics.registerActiveWorkspacesProvider(
        () => this.sessionDispatchRegistry.list().length,
      );
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

    // Phase 6.B — start the artifacts sweeper. Walks ephemeral artifacts
    // whose `expiresAt` is past on a timer; promotes them to durable if
    // an inbound reference signal is found, deletes otherwise. Wired
    // here (post-JetStream init, post-runtime registry creation) so
    // the sweeper can resolve a per-workspace scan context against
    // `this.runtimes`.
    this.artifactsSweeper = startArtifactsSweeper({
      getScanContext: async (workspaceId) => {
        const config = await this.getWorkspaceManager().getWorkspaceConfig(workspaceId);
        if (!config) return undefined;
        return { memoryStoreNames: (config.workspace.memory?.own ?? []).map((m) => m.name) };
      },
      aiSummaryFallback: async (workspaceId) => {
        const summaries = await this.sessionHistoryAdapter.listByWorkspace(workspaceId);
        return summaries.flatMap((summary) =>
          (summary.aiSummary?.keyDetails ?? [])
            .filter((detail) => detail.url)
            .map((detail) => ({ url: detail.url })),
        );
      },
    });

    // G4 — start the elicitations sweeper. Walks past-deadline
    // pending elicitations on a 60s tick (override via
    // FRIDAY_ELICITATION_SWEEP_INTERVAL_MS) and durably flips them to
    // expired with a CAS-guarded write. Pairs with read-time
    // derivation in ElicitationStorage.get/list so subscribers never
    // observe stale `pending` between sweeper ticks.
    this.elicitationsSweeper = startElicitationsSweeper();

    this.isInitialized = true;

    // Start the SIGNALS + CASCADES consumers LAST so no message can be
    // dispatched until every prerequisite (cron manager, session adapter,
    // tool workers, isInitialized flag) is in place. Pre-existing
    // envelopes in either queue (redeliveries, leftovers from a previous
    // daemon run) sit until we're ready to dispatch — no "not initialized"
    // throws / NAK / redelivery loops on boot.
    //
    // CASCADES first so when SignalConsumer starts forwarding, there's a
    // consumer ready to drain. The reverse order would briefly back up
    // CASCADES even though the daemon could service it — minor, but
    // unnecessary.
    if (this.cascadeConsumer) await this.cascadeConsumer.start();
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
      activeRequests: 0,
    });

    // Set up cleanup
    transport.onclose = () => {
      logger.info("[Daemon] Agent session closed", { sessionId });
      void this.cleanupAgentSession(sessionId);
    };

    return { server, transport };
  }

  private releaseAgentMcpRequest(sessionId: string): void {
    const current = this.agentSessions.get(sessionId);
    if (!current) return;
    current.activeRequests = Math.max(0, current.activeRequests - 1);
    current.lastUsed = Date.now();
  }

  private async handleAgentMcpRequest(
    sessionId: string,
    transport: StreamableHTTPTransport,
    c: Context,
  ): Promise<Response | undefined> {
    const session = this.agentSessions.get(sessionId);
    if (session) {
      session.activeRequests++;
      session.lastUsed = Date.now();
    }
    try {
      const response = await transport.handleRequest(c);
      return this.trackMcpResponseLifetime(response, () => this.releaseAgentMcpRequest(sessionId));
    } catch (error) {
      this.releaseAgentMcpRequest(sessionId);
      throw error;
    }
  }

  /**
   * Clean up agent session
   */
  private async cleanupAgentSession(sessionId: string): Promise<void> {
    const session = this.agentSessions.get(sessionId);
    if (!session) return;

    this.agentSessions.delete(sessionId);
    this.agentSSEConnections.delete(sessionId);
    session.transport.onclose = undefined;

    try {
      await session.transport.close();
    } catch (error) {
      logger.debug("Error closing agent MCP transport", { error, sessionId });
    }

    try {
      await session.server.stop();
    } catch (error) {
      logger.debug("Error stopping agent MCP server", { error, sessionId });
    }

    logger.info("[Daemon] Agent session cleaned up", { sessionId });
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
      natsConnection: nc,
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
      activeRequests: 0,
    });

    // Set up cleanup
    transport.onclose = () => {
      logger.info("[Daemon] Platform session closed", { sessionId });
      void this.cleanupPlatformSession(sessionId);
    };

    return { server, transport };
  }

  private releasePlatformMcpRequest(sessionId: string): void {
    const current = this.platformMcpSessions.get(sessionId);
    if (!current) return;
    current.activeRequests = Math.max(0, current.activeRequests - 1);
    current.lastUsed = Date.now();
  }

  private async handlePlatformMcpRequest(
    sessionId: string,
    transport: StreamableHTTPTransport,
    c: Context,
  ): Promise<Response | undefined> {
    const session = this.platformMcpSessions.get(sessionId);
    if (session) {
      session.activeRequests++;
      session.lastUsed = Date.now();
    }
    try {
      const response = await transport.handleRequest(c);
      return this.trackMcpResponseLifetime(response, () =>
        this.releasePlatformMcpRequest(sessionId),
      );
    } catch (error) {
      this.releasePlatformMcpRequest(sessionId);
      throw error;
    }
  }

  private trackMcpResponseLifetime(
    response: Response | undefined,
    releaseRequest: () => void,
  ): Response | undefined {
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      releaseRequest();
    };

    if (!response?.body) {
      releaseOnce();
      return response;
    }

    const reader = response.body.getReader();
    const releaseReaderLock = () => {
      try {
        reader.releaseLock();
      } catch {
        // The reader may already be released after cancellation.
      }
    };

    const trackedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            releaseOnce();
            releaseReaderLock();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          releaseOnce();
          releaseReaderLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } catch {
          // The upstream body may already be closed/cancelled.
        } finally {
          releaseOnce();
          releaseReaderLock();
        }
      },
    });

    return new Response(trackedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /**
   * Clean up platform session
   */
  private async cleanupPlatformSession(sessionId: string): Promise<void> {
    const session = this.platformMcpSessions.get(sessionId);
    if (!session) return;

    this.platformMcpSessions.delete(sessionId);
    session.transport.onclose = undefined;

    try {
      await session.transport.close();
    } catch (error) {
      logger.debug("Error closing platform MCP transport", { error, sessionId });
    }

    logger.info("[Daemon] Platform session cleaned up", { sessionId });
  }

  /** Get the NATS connection (available after initialize()). */
  public getNatsConnection() {
    if (!this.natsManager) {
      throw new Error("NATS not initialized — call initialize() first");
    }
    return this.natsManager.connection;
  }

  /** Get the resolved NATS broker URL (available after initialize()). */
  public getNatsUrl(): string {
    if (!this.natsManager) {
      throw new Error("NATS not initialized — call initialize() first");
    }
    return this.natsManager.url;
  }

  /** Get the ProcessAgentExecutor (available after NATS initializes). */
  public getProcessAgentExecutor(): ProcessAgentExecutor | null {
    return this.processAgentExecutor;
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
    this.app.route("/api/workspaces/:workspaceId/env", workspaceEnvRoutes);
    this.app.route("/api/workspaces/:workspaceId/chat", workspaceChatRoutes);
    this.app.route("/api/workspaces/:workspaceId/chat", workspaceChatDebugRoutes);
    this.app.route("/api/workspaces/:workspaceId", workspaceCacheSaltRoutes);
    this.app.route("/api/workspaces/:workspaceId/integrations", integrationRoutes);
    this.app.route("/api/workspaces/:workspaceId/mcp", mcpRoutes);
    this.app.route("/api/workspaces", workspaceEventsRoutes);
    this.app.route("/api/events", eventsRoutes);
    this.app.route("/api/instance", instanceEventsRoutes);
    this.app.route("/api/artifacts", artifactsApp);
    this.app.route("/api/scratch", scratchUploadApp);
    this.app.route("/api/chunked-upload", chunkedUploadApp);
    this.app.route("/api/chat", chatRoutes);
    this.app.route("/api/chat-storage", chatStorageRoutes);
    this.app.route("/api/config", configRoutes);
    this.app.route("/api/user", userRoutes);
    // O5 (review-2): /api/scratchpad route removed; the surface had zero
    // in-repo callers post-K1.
    this.app.route("/api/elicitations", elicitationApp);
    this.app.route("/api/sessions", sessionsRoutes);
    this.app.route("/api/agents", agentsRoutes);
    this.app.route("/api/daemon", daemonApp);
    this.app.route("/api/share", shareRoutes);
    this.app.route("/api/link", linkRoutes);
    this.app.route("/api/mcp-registry", mcpRegistryRouter);
    this.app.route("/api/me", meRoutes);
    // Mount the user-firehose under the same prefix. Kept as its own
    // route module because the long-lived SSE handling is distinct
    // from the request/response shape of the rest of /api/me.
    this.app.route("/api/me", meStreamRoutes);
    this.app.route("/api/jobs", jobsRoutes);
    this.app.route("/api/skills", skillsRoutes);
    this.app.route("/api/report", reportRoutes);
    this.app.route("/api/memory", memoryNarrativeRoutes);
    this.app.route("/api/cron", cronRoutes);

    // Platform signal routes (Discord/Slack via Signal Gateway)
    this.app.route("/signals", createPlatformSignalRoutes(this));

    // Global error handler - catches all uncaught errors from all routes.
    // `HTTPException`s (e.g. `requireWorkspaceMember` → 403, missing
    // session → 401) carry their own status + body; let them flow through
    // instead of flattening every thrown error to a 500. Otherwise the
    // route-level tests pass (they call the handler directly and see the
    // throw) but production turns every authz failure into "Internal
    // server error" — which both leaks the wrong status to the client
    // and stops clients from distinguishing "you don't have access" from
    // "the daemon is broken".
    this.app.onError((err, c) => {
      if (err instanceof HTTPException) {
        return err.getResponse();
      }
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
            const response = await this.handlePlatformMcpRequest(newSessionId, transport, c);

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
              const response = await this.handlePlatformMcpRequest(sessionId, transport, c);
              await this.cleanupPlatformSession(sessionId);
              return response;
            }

            // Handle the request
            return this.handlePlatformMcpRequest(sessionId, transport, c);
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
            const response = await this.handleAgentMcpRequest(newSessionId, transport, c);

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
              const response = await this.handleAgentMcpRequest(sessionId, transport, c);
              await this.cleanupAgentSession(sessionId);
              return response;
            }

            // Handle the request
            return this.handleAgentMcpRequest(sessionId, transport, c);
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
   * Build a fresh `WorkspaceRuntime` for a single dispatch. Construction
   * is intentionally per-call: each dispatch gets its own snapshot of
   * `workspace.yml` (via the manager's mtime-cached `getWorkspaceConfig`)
   * and runs to terminal state against that snapshot. Cross-dispatch
   * lookups (cancel, list, sessions) go through SESSION_INFLIGHT and the
   * dispatch registry — never through a shared runtime.
   *
   * Callers must `runtime.shutdown()` after the dispatch settles. The
   * `triggerWorkspaceSignal` wrapper handles this for direct dispatches;
   * routes that need a runtime for *introspection* should read from
   * `getWorkspaceConfig` instead.
   */
  async getOrCreateWorkspaceRuntime(workspaceId: string): Promise<WorkspaceRuntime> {
    try {
      logger.debug("getOrCreateWorkspaceRuntime called", { workspaceId });

      if (!this.isInitialized) {
        throw new Error("Atlas daemon not fully initialized - cannot create workspace runtime");
      }

      const manager = this.getWorkspaceManager();

      // Recover inactive workspaces by clearing their error fields once we're
      // about to dispatch against them. Same idempotent reset as before; just
      // no longer guarded behind a cache miss.
      let workspace = await manager.find({ id: workspaceId });
      if (workspace?.status === "inactive") {
        logger.info("Recovering inactive workspace, clearing error fields", {
          workspaceId,
          lastError: workspace.metadata?.lastError,
          failureCount: workspace.metadata?.failureCount,
        });

        await manager.updateWorkspaceStatus(workspaceId, "inactive", {
          metadata: {
            ...workspace.metadata,
            lastError: undefined,
            lastErrorAt: undefined,
            failureCount: undefined,
          },
        });
      }

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

      // Collected here so MCP-env degradation (just below) and agent
      // registration failures (further down) feed the same metadata surface.
      const registrationFailures: Array<{ agentId: string; reason: string }> = [];

      // Re-validate MCP environment at runtime creation (env vars may have
      // changed since registration). A misconfigured MCP server must NOT
      // brick the whole workspace: with no runtime the workspace can't even
      // spawn a chat, leaving the user no way to set the missing vars. Drop
      // just the offending servers and let the runtime come up degraded —
      // surfaced via metadata like a registration failure.
      let runtimeConfig = mergedConfig;
      if (!workspace.metadata?.system) {
        try {
          validateMCPEnvironmentForWorkspace(mergedConfig, workspace.path);
        } catch (error) {
          if (!(error instanceof MissingEnvironmentError) || error.missingVars.length === 0) {
            throw error;
          }
          const brokenServerIds = [...new Set(error.missingVars.map((v) => v.serverId))];
          logger.error(
            "Dropping MCP servers with unresolved env vars; runtime will spawn without them",
            { workspaceId: workspace.id, brokenServerIds },
          );
          const mcp = mergedConfig.workspace.tools?.mcp;
          if (mcp?.servers) {
            // Clone before stripping — getWorkspaceConfig hands back a cached
            // reference; mutating it would keep the server dropped until a
            // workspace.yml mtime bump even after the user sets the vars.
            const servers = Object.fromEntries(
              Object.entries(mcp.servers).filter(([id]) => !brokenServerIds.includes(id)),
            );
            runtimeConfig = {
              ...mergedConfig,
              workspace: {
                ...mergedConfig.workspace,
                tools: { ...mergedConfig.workspace.tools, mcp: { ...mcp, servers } },
              },
            };
          }
          for (const serverId of brokenServerIds) {
            const vars = error.missingVars
              .filter((v) => v.serverId === serverId)
              .map((v) => v.varName)
              .join(", ");
            registrationFailures.push({
              agentId: `MCP server '${serverId}'`,
              reason: `disabled — unset env vars: ${vars}`,
            });
          }
        }
      }

      // Register workspace-level LLM agents with agent registry. Collect
      // failures and surface them via workspace metadata below — without
      // that, a phantom-agent workspace.yml that bypassed validation loads
      // silently with the broken agent missing from the registry.
      const workspaceAgents = mergedConfig.workspace?.agents || {};
      for (const [agentId, agentConfig] of Object.entries(workspaceAgents)) {
        if (agentConfig.type === "llm") {
          try {
            logger.debug("Registering workspace LLM agent", { workspaceId: workspace.id, agentId });
            const agent = convertLLMToAgent(agentConfig, agentId, logger);
            await this.agentRegistry?.registerAgent(agent);
            logger.info("Registered workspace LLM agent", { workspaceId: workspace.id, agentId });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            logger.error("Failed to register workspace LLM agent", {
              workspaceId: workspace.id,
              agentId,
              error: reason,
            });
            registrationFailures.push({ agentId, reason });
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
            const reason = error instanceof Error ? error.message : String(error);
            logger.error("Failed to register workspace Atlas agent wrapper", {
              workspaceId: workspace.id,
              wrapperId: agentId,
              baseAgentId: agentConfig.agent,
              error: reason,
            });
            registrationFailures.push({
              agentId: `${agentId} (atlas → ${agentConfig.agent})`,
              reason,
            });
          }
        }
      }

      // Surface load failures via workspace metadata. Status is preserved
      // (not flipped to inactive) so partial-failure tolerance is unchanged —
      // only the visibility of the broken state changes.
      if (registrationFailures.length > 0) {
        const summary = registrationFailures.map((f) => `${f.agentId}: ${f.reason}`).join("; ");
        const lastError =
          `Workspace load: ${registrationFailures.length} failure(s) — ${summary}. ` +
          `Edit workspace.yml, set the missing env vars, or run validate_workspace to fix.`;
        try {
          await manager.updateWorkspaceStatus(workspace.id, workspace.status, {
            metadata: {
              ...workspace.metadata,
              lastError,
              lastErrorAt: new Date().toISOString(),
              // Counts load attempts that hit failures, not unique failures.
              // A daemon restart on the same broken yml bumps it again.
              failureCount: (workspace.metadata?.failureCount ?? 0) + 1,
            },
          });
        } catch (statusError) {
          logger.error("Failed to record agent-registration failures on workspace metadata", {
            workspaceId: workspace.id,
            statusError: statusError instanceof Error ? statusError.message : String(statusError),
          });
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

      const runtime: WorkspaceRuntime = new WorkspaceRuntime(
        {
          id: workspace.id,
          name: workspace.name,
          members: { userId: workspace.metadata?.createdBy },
        },
        runtimeConfig,
        {
          lazy: true, // Always use lazy loading in daemon mode
          workspacePath, // Pass workspace path for daemon mode
          platformModels: this.getPlatformModels(),
          agentExecutor: this.processAgentExecutor ?? undefined,
          // Daemon self-loopback URL for MCP tool fetching. Scheme matches
          // whatever the daemon is bound on — without this, the workspace
          // runtime sends a cleartext HTTP request to a TLS listener and
          // gets "invalid HTTP version parsed" back from reqwest/hyper.
          daemonUrl: `${this.options.tlsCert && this.options.tlsKey ? "https" : "http"}://localhost:${this.options.port}`,
          broadcastNotifier: createFSMBroadcastNotifier({
            workspaceId: workspace.id,
            getInstance: (id) => this.getOrCreateChatSdkInstance(id),
          }),
          sessionAbortRegistry: this.sessionDispatchRegistry,
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
            if (status !== WorkspaceSessionStatus.COMPLETED || !finalOutput) {
              return;
            }
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

              // Record the last-finished session on the workspace metadata.
              // Status stays "inactive" — workspaces don't have a long-lived
              // running runtime to flip to since dispatch is per-call;
              // active-dispatch counts are derived from the dispatch registry.
              await mgr.updateWorkspaceStatus(workspaceId, "inactive", {
                metadata: {
                  ...ws?.metadata,
                  lastFinishedSession: { id: sessionId, status, finishedAt, summary },
                },
              });
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
      logger.info("Runtime created", { workspaceId: workspace.id, workspaceName: workspace.name });

      return runtime;
    } catch (error) {
      logger.error("Failed to create workspace runtime", { error, workspaceId });
      throw error;
    }
  }

  /**
   * Publish a signal envelope onto the SIGNALS JetStream stream.
   *
   * Pipeline: SIGNALS → SignalConsumer (forwards to CASCADES) → CascadeConsumer
   * (applies the per-signal `concurrency` policy and runs the cascade as a
   * background Promise via `triggerWorkspaceSignal`). The publish ack returns
   * the SIGNALS sequence number immediately; the session id is allocated later
   * by the cascade worker.
   *
   * For synchronous "trigger and await result" semantics, set `correlationId`
   * on the envelope and consume the response with `awaitSignalCompletion`
   * (signal-stream.ts) — the CascadeConsumer publishes the dispatch outcome
   * onto `signals.responses.<correlationId>` regardless of which worker
   * handled the cascade. For interactive (chat) flows, bypass the queue
   * entirely and call `triggerWorkspaceSignal` directly — chat is exempt
   * from the cascade cap.
   */
  public publishSignalToJetStream(opts: PublishSignalOpts): Promise<{ seq: number }> {
    const nc = this.natsManager?.connection;
    if (!nc) throw new Error("NATS not initialized — call initialize() first");
    return publishSignal(nc, opts);
  }

  /**
   * Build a fresh `ChatSdkInstance` per call. No daemon-level cache.
   *
   * Cost: `resolvePlatformCredentials` is HTTP to Link (~10-100ms) per build;
   * the rest is in-memory object construction. Webhook handlers pay it
   * once per inbound message.
   *
   * Known trade-off — platform-retry dedup. The Chat SDK's `setIfNotExists`
   * dedup state (`packages/core/src/chat/chat-sdk-state-adapter.ts`'s in-memory
   * Map) lives on the per-call instance, so a Slack/Discord retry that arrives
   * in a separate webhook request lands on a fresh empty cache and processes
   * twice. Friday acks webhooks fast, so retries are rare. The proper fix is
   * a NATS-KV-backed dedup bucket (`CHAT_DEDUPE` with TTL) using JS KV's
   * `create()` for atomic set-if-absent — tracked as follow-up; bounded
   * memory + multi-instance correct.
   */
  getOrCreateChatSdkInstance(workspaceId: string): Promise<ChatSdkInstance> {
    return this.buildChatSdkInstance(workspaceId);
  }

  private async buildChatSdkInstance(workspaceId: string): Promise<ChatSdkInstance> {
    const manager = this.getWorkspaceManager();
    const config = await manager.getWorkspaceConfig(workspaceId);
    if (!config) {
      throw new WorkspaceNotFoundError(workspaceId);
    }

    const workspace = await manager.find({ id: workspaceId });
    const userId = workspace?.metadata?.createdBy ?? UserStorage.getCachedLocalUserId();

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
        try {
          const session = await runtime.triggerSignalWithSession(signalId, signalData, {
            streamId,
            onStreamEvent,
            abortSignal,
          });
          return { sessionId: session.id };
        } finally {
          runtime.shutdown().catch((err) => {
            logger.warn("Failed to shut down per-dispatch workspace runtime", {
              workspaceId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      },
    };

    return initializeChatSdkInstance(instanceConfig, credentials);
  }

  /**
   * Trigger a workspace signal and handle lifecycle updates (lastSeen, idle timeout).
   *
   * Concurrency control lives in `CascadeConsumer` (cascade-stream.ts) — it
   * applies the per-signal `concurrency` policy (skip / queue / concurrent /
   * replace) before calling here. By the time this method runs, the dispatch
   * is committed; we just execute.
   *
   * @param workspaceId - Workspace ID to trigger signal in
   * @param signalId - Signal ID to trigger
   * @param payload - Signal payload data
   * @param opts - Trailing optional context (streamId, onStreamEvent,
   *   skipStates, abortSignal, parentSessionId, webhookContext). See
   *   `TriggerSignalOpts` in packages/workspace/src/runtime.ts.
   * @returns Session ID for tracking the triggered signal
   */
  public async triggerWorkspaceSignal(
    workspaceId: string,
    signalId: string,
    payload?: Record<string, unknown>,
    opts: TriggerSignalOpts = {},
  ): Promise<{
    sessionId: string;
    output: Array<{ id: string; type: string; data: Record<string, unknown> }>;
    /**
     * Phase 2.C — persisted artifact ids for this session's eligible
     * outputs (Phase 2.B persisted them; this surfaces the ids so SSE
     * `job-complete` consumers can prefer refs over the full
     * `Document[]`). Empty when no eligible documents were emitted.
     */
    artifactIds: string[];
    /**
     * Phase 2.C — short session summary. Prefers the AI-generated
     * `aiSummary.summary` and falls back to the terminal-state action's
     * declared `summary` (Phase 2.A schema) or a truncated stringify of
     * the terminal output's `data`. Empty when nothing's summarizable.
     */
    summary: string;
  }> {
    const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);
    try {
      const result = await runtime.triggerSignalWithResult(signalId, payload || {}, opts);
      const session = result.session;

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

      return {
        sessionId: session.id,
        output: result.output,
        artifactIds: result.artifactIds,
        summary: result.summary,
      };
    } finally {
      // Per-dispatch runtime — tear down so MCP transports, FSM engines, and
      // memory bindings don't outlive the dispatch. Tear-down failures are
      // logged but never block the dispatch result.
      runtime.shutdown().catch((err) => {
        logger.warn("Failed to shut down per-dispatch workspace runtime", {
          workspaceId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Wait for a workspace session to complete with timeout
   *
   * Default timeout: 30 seconds (allows reasonable time for agent processing)
   *
   * @returns true if session completed successfully, false if timeout/error/not found
   */
  private setupSignalHandlers() {
    const daemonId = crypto.randomUUID().slice(0, 8);

    const handleShutdown = (signal: string) => {
      // Second signal during in-flight shutdown — user wants out NOW. The
      // CLI's own SIGTERM handler (apps/atlas-cli/src/commands/daemon/start.tsx)
      // is also coalesced via shutdownPromise; the *third* signal here
      // fast-exits past any straggling teardown work.
      if (this.shutdownPromise) {
        logger.warn("Second signal received during shutdown, forcing exit", { daemonId, signal });
        process.exit(130);
      }

      logger.info("Daemon received signal, shutting down gracefully", { daemonId, signal });

      // Per-step timeouts in _doShutdown bound each phase; this is a
      // belt-and-suspenders global cap for anything that escapes them.
      const shutdownTimeout = setTimeout(() => {
        logger.error("Shutdown timeout, forcing exit", { timeoutSeconds: 10 });
        process.exit(1);
      }, 10000);

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

    // Best-effort persistence flush on uncaughtException. The process state
    // is unrecoverable at this point; we want in-flight chat turns to
    // drain — same code path as graceful shutdown but on a tight budget —
    // before exiting. SIGKILL still loses everything.
    //
    // NOTE: This is intentionally NOT installed for `unhandledRejection`.
    // Stray rejections from background tasks are common in long-running
    // daemons and shouldn't kill the process; they're logged below for
    // visibility but don't trigger a drain or an exit.
    process.on("uncaughtException", (err) => {
      // If a graceful shutdown is already in progress, let it finish.
      // Re-entering here would race with the existing _doShutdown.
      if (this.shutdownPromise) return;
      logger.error("uncaughtException — attempting best-effort drain", {
        daemonId,
        error: err instanceof Error ? err.message : String(err),
      });
      const crashTimeout = setTimeout(() => process.exit(1), 3000);
      this.chatTurnRegistry
        ?.drainShutdown(2500)
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(crashTimeout);
          process.exit(1);
        });
    });
    process.on("unhandledRejection", (reason) => {
      logger.error("unhandledRejection (logged, not fatal)", {
        daemonId,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    });
  }

  async start() {
    // Ensure daemon is initialized
    await this.initialize();

    const port = this.options.port ?? 8080;
    const hostname = this.options.hostname || "localhost";
    const tls =
      this.options.tlsCert && this.options.tlsKey
        ? { cert: this.options.tlsCert, key: this.options.tlsKey }
        : null;
    const scheme = tls ? "https" : "http";

    logger.info("Starting Atlas daemon", { hostname, port, scheme });

    this.server = Deno.serve(
      {
        port,
        hostname,
        signal: this.serverAbortController.signal,
        ...(tls ?? {}),
        onListen: ({ hostname, port }) => {
          this.#port = port;
          logger.info("👹 Atlas daemon running", { hostname, port, scheme });
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
    const tls =
      this.options.tlsCert && this.options.tlsKey
        ? { cert: this.options.tlsCert, key: this.options.tlsKey }
        : null;
    const scheme = tls ? "https" : "http";

    logger.info("Starting Atlas daemon", { hostname, port, scheme });

    let serverReady: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      serverReady = resolve;
    });

    this.server = Deno.serve(
      {
        port,
        hostname,
        signal: this.serverAbortController.signal,
        ...(tls ?? {}),
        onListen: ({ hostname, port }) => {
          this.#port = port; // Store the actual port
          logger.info("Atlas daemon running", { hostname, port, scheme });
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

        const userId = workspace.metadata?.createdBy ?? UserStorage.getCachedLocalUserId();
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
    this.currentShutdownPhase = "phase-1-drain";

    // Drop our signal handlers up front — a second SIGINT/SIGTERM now hits
    // the OS default and force-exits, which is the desired escape hatch.
    for (const { signal, handler } of this.signalHandlers) {
      Deno.removeSignalListener(signal, handler);
    }
    this.signalHandlers = [];

    // Phase 1 — close the door, in parallel. server.shutdown() drains
    // in-flight HTTP requests while runtimes/NATS are still up (handlers
    // need them); the rest just stop accepting new work. Each step has its
    // own ceiling so a hung component can't block the others.
    await Promise.allSettled([
      withShutdownTimeout(
        "http server drain",
        (signal) => {
          signal.addEventListener(
            "abort",
            () => {
              this.serverAbortController.abort(signal.reason);
            },
            { once: true },
          );
          return this.server?.shutdown() ?? Promise.resolve();
        },
        3000,
      ),
      withShutdownTimeout("discord gateway", this.discordGatewayService?.stop(), 1500),
      // Stop the SIGNALS forwarder first so no new envelopes land on
      // CASCADES while the cascade consumer is draining.
      withShutdownTimeout(
        "signals consumer",
        (signal) => this.signalConsumer?.stop(signal) ?? Promise.resolve(),
        1500,
      ),
      withShutdownTimeout(
        "cascades consumer",
        (signal) => this.cascadeConsumer?.stop(signal) ?? Promise.resolve(),
        1500,
      ),
      withShutdownTimeout("tool workers", Promise.all(this.toolWorkers.map((w) => w.stop())), 1500),
    ]);
    this.server = null;
    this.discordGatewayService = null;
    this.signalConsumer = null;
    this.cascadeConsumer = null;
    this.toolWorkers = [];

    // Reap orphaned agent-browser daemons after Phase 1 (no new agent
    // invocations can start now) and before runtime/MCP teardown (which
    // can hang). The next-startup sweep is the long-stop.
    await withShutdownTimeout(
      "agent-browser sweep",
      sweepOrphanedAgentBrowserSessions(logger),
      3000,
    );

    shutdownChunkedUpload();

    // Drain in-flight chat turns BEFORE Phase 2. Aborts every active chat
    // turn and waits (bounded) for each turn's onFinish to run — which is
    // where partial assistant messages get persisted to JetStream. Without
    // this drain, SIGTERM would race the agent's onFinish: aborts fire, but
    // process.exit lands before the partial message reaches storage, and
    // any in-flight delegate calls / streaming text vanish on reboot. The
    // 9s outer ceiling covers the registry's 8s internal budget plus a
    // small buffer; real persistence completes in low ms once abort fires.
    await withShutdownTimeout("chat turn drain", this.chatTurnRegistry?.drainShutdown(8000), 9000);

    // Phase 2 — tear down domain layer in parallel. Per-dispatch runtimes
    // self-destruct at dispatch end; the dispatch registry's stop() is
    // what aborts any still-in-flight dispatches.
    this.currentShutdownPhase = "phase-2";
    await Promise.allSettled([
      withShutdownTimeout("shared MCP", sharedMCPProcesses.shutdown(), 2000),
      withShutdownTimeout("session stream registry", this.sessionStreamRegistry?.shutdown(), 2000),
      withShutdownTimeout("session dispatch registry", this.sessionDispatchRegistry?.stop(), 1500),
      withShutdownTimeout(
        "agent sessions",
        Promise.all(
          Array.from(this.agentSessions.keys()).map((id) => this.cleanupAgentSession(id)),
        ),
        1500,
      ),
      withShutdownTimeout("cron manager", this.cronManager?.shutdown(), 1500),
    ]);
    this.cronManager = null;

    // Synchronous registries + interval/timer cleanup. Chat turn registry
    // was drained above; the shutdown() here clears any controllers added
    // between the drain and now (defensive — shouldn't happen since the
    // signals consumer is already stopped).
    this.streamRegistry?.shutdown();
    this.chatTurnRegistry?.shutdown();
    if (this.sseHealthCheckInterval) {
      clearInterval(this.sseHealthCheckInterval);
      this.sseHealthCheckInterval = null;
    }
    if (this.agentSessionCleanupInterval) {
      clearInterval(this.agentSessionCleanupInterval);
      this.agentSessionCleanupInterval = null;
    }
    if (this.platformSessionCleanupInterval) {
      clearInterval(this.platformSessionCleanupInterval);
      this.platformSessionCleanupInterval = null;
    }
    if (this.artifactsSweeper) {
      this.artifactsSweeper.stop();
      this.artifactsSweeper = null;
    }
    if (this.elicitationsSweeper) {
      this.elicitationsSweeper.stop();
      this.elicitationsSweeper = null;
    }

    // SSE clients — the HTTP server already drained in Phase 1, but any
    // controller still held open by app code gets force-closed here.
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
    this.agentSessions.clear();
    this.agentSSEConnections.clear();

    await Promise.allSettled(
      Array.from(this.platformMcpSessions.keys()).map((sessionId) =>
        this.cleanupPlatformSession(sessionId),
      ),
    );
    this.platformMcpSessions.clear();

    if (this.capabilityRegistry) {
      this.capabilityRegistry.stop();
      this.capabilityRegistry = null;
    }
    this.processAgentExecutor = null;

    // Phase 3 — bottom of the stack. WorkspaceManager.close() may flush
    // through NATS, so close it before NATS stops.
    this.currentShutdownPhase = "phase-3-nats";
    await withShutdownTimeout("workspace manager", this.workspaceManager?.close(), 2000);
    this.workspaceManager = null;

    await withShutdownTimeout(
      "NATS",
      (signal) => this.natsManager?.stop(signal) ?? Promise.resolve(),
      2000,
    );
    this.natsManager = null;

    this.currentShutdownPhase = "complete";
    logger.info("Atlas daemon shutdown complete");
  }

  // Status getters
  getActiveWorkspaces(): string[] {
    // Successor to the runtime-cache enumeration: workspaces with at least
    // one in-flight dispatch, derived from the dispatch registry.
    const ids = new Set<string>();
    for (const entry of this.sessionDispatchRegistry?.list() ?? []) {
      ids.add(entry.workspaceId);
    }
    return Array.from(ids);
  }

  getStatus() {
    const cronStats = this.cronManager?.getStats();
    const cascadeStats = this.cascadeConsumer?.getStats();

    return {
      activeWorkspaces: this.getActiveWorkspaces().length,
      uptime: Date.now() - this.startTime,
      cronManager: cronStats
        ? { isActive: this.cronManager?.isRunning || false, ...cronStats }
        : null,
      cascadeConsumer: cascadeStats ?? null,
      migrations: this.migrationStatus,
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
      void this.performAgentSessionCleanup();
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

    // Find stale sessions. A workspace-chat/agent call can legitimately
    // hold the MCP response stream open for many minutes, so never reap a
    // session while an HTTP request is still in flight.
    for (const [sessionId, session] of this.agentSessions) {
      if (session.activeRequests > 0) continue;
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

    // Enforce session limit (LRU eviction).
    //
    // Two-pass strategy:
    //   1. Prefer evicting sessions with no active requests (clean tear-down).
    //   2. If we're still over the limit, force-evict the LRU sessions even
    //      if they have in-flight requests — otherwise long-lived SSE/MCP
    //      streams (whose `activeRequests` never drops to zero until the
    //      client disconnects) pin the map forever, the warning fires every
    //      60s with `evictionCount: 0`, and new sessions get crowded out.
    if (this.agentSessions.size > this.MAX_AGENT_SESSIONS) {
      const overage = this.agentSessions.size - this.MAX_AGENT_SESSIONS;

      const sortedByLastUsed = Array.from(this.agentSessions.entries()).sort(
        (a, b) => a[1].lastUsed - b[1].lastUsed,
      );

      const idleFirst = sortedByLastUsed.filter(([, s]) => s.activeRequests === 0);
      const toEvictIdle = idleFirst.slice(0, overage);

      const remainingOverage = overage - toEvictIdle.length;
      const evictedIdleIds = new Set(toEvictIdle.map(([id]) => id));
      const toEvictActive =
        remainingOverage > 0
          ? sortedByLastUsed.filter(([id]) => !evictedIdleIds.has(id)).slice(0, remainingOverage)
          : [];

      const toEvict = [...toEvictIdle, ...toEvictActive];

      logger.warn("Evicting LRU agent sessions due to limit", {
        evictionCount: toEvict.length,
        idleEvicted: toEvictIdle.length,
        activeEvicted: toEvictActive.length,
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
      void this.performPlatformSessionCleanup();
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
  private async performPlatformSessionCleanup(): Promise<void> {
    const now = Date.now();
    const sessionsToCleanup: string[] = [];

    // Find stale sessions. Long-running platform tools (notably
    // request_human_input) can hold an MCP request open for the full HITL
    // TTL, so never reap a session while a request is still in flight.
    for (const [sessionId, session] of this.platformMcpSessions) {
      if (session.activeRequests > 0) continue;
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
        await this.cleanupPlatformSession(sessionId);
      }
    }

    // Enforce session limit (LRU eviction). See `performAgentSessionCleanup`
    // for the two-pass rationale — long-lived SSE streams keep
    // `activeRequests > 0` and would otherwise pin the map indefinitely,
    // causing the eviction warning to fire every 60s with no progress.
    if (this.platformMcpSessions.size > this.MAX_PLATFORM_SESSIONS) {
      const overage = this.platformMcpSessions.size - this.MAX_PLATFORM_SESSIONS;

      const sortedByLastUsed = Array.from(this.platformMcpSessions.entries()).sort(
        (a, b) => a[1].lastUsed - b[1].lastUsed,
      );

      const idleFirst = sortedByLastUsed.filter(([, s]) => s.activeRequests === 0);
      const toEvictIdle = idleFirst.slice(0, overage);

      const remainingOverage = overage - toEvictIdle.length;
      const evictedIdleIds = new Set(toEvictIdle.map(([id]) => id));
      const toEvictActive =
        remainingOverage > 0
          ? sortedByLastUsed.filter(([id]) => !evictedIdleIds.has(id)).slice(0, remainingOverage)
          : [];

      const toEvict = [...toEvictIdle, ...toEvictActive];

      logger.warn("Evicting LRU platform sessions due to limit", {
        evictionCount: toEvict.length,
        idleEvicted: toEvictIdle.length,
        activeEvicted: toEvictActive.length,
        totalSessions: this.platformMcpSessions.size,
        maxSessions: this.MAX_PLATFORM_SESSIONS,
      });

      for (const [sessionId] of toEvict) {
        await this.cleanupPlatformSession(sessionId);
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
