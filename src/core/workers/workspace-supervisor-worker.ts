/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />

import { BaseWorker } from "./base-worker.ts";
import { WorkspaceSupervisor } from "../supervisor.ts";
import type { IWorkspace, IWorkspaceSignal } from "../../types/core.ts";
import { AtlasTelemetry } from "../../utils/telemetry.ts";
import type { AtlasMemoryConfig } from "../memory-config.ts";

interface WorkspaceSupervisorConfig {
  id: string;
  workspace?: IWorkspace;
  config?: {
    workspaceSignals?: Record<string, unknown>;
    jobs?: Record<string, unknown>;
    memoryConfig?: AtlasMemoryConfig;
    workspaceMcpServers?: Record<string, any>; // MCP servers from workspace
  };
  memoryConfig?: AtlasMemoryConfig;
  model?: string;
}

interface SessionWorkerInfo {
  worker: Worker;
  port: MessagePort;
  sessionId: string;
}

interface ProcessSignalData {
  action: "processSignal";
  signal: IWorkspaceSignal;
  payload: Record<string, unknown>;
  sessionId: string;
  signalConfig?: Record<string, unknown>;
  jobs?: Record<string, unknown>;
  traceHeaders?: Record<string, string>;
}

interface GetStatusData {
  action: "getStatus";
}

interface SetWorkspaceData {
  type: "setWorkspace";
  workspace: IWorkspace;
}

type WorkspaceWorkerData = ProcessSignalData | GetStatusData;
type WorkspaceWorkerMessage = SetWorkspaceData | Record<string, unknown>;

class WorkspaceSupervisorWorker extends BaseWorker {
  private supervisor: WorkspaceSupervisor | null = null;
  private workspace: IWorkspace | null = null;
  private sessions: Map<string, SessionWorkerInfo> = new Map();
  private config: WorkspaceSupervisorConfig | null = null;

  constructor() {
    super(crypto.randomUUID().slice(0, 8), "workspace-supervisor");
  }

  private error(message: string, context?: Record<string, unknown>): void {
    this.logger.error(message, context);
  }

  protected async initialize(config: WorkspaceSupervisorConfig): Promise<void> {
    this.config = config;
    this.log("Initializing with config:", config);
    this.log("Config structure:", {
      hasConfig: !!config.config,
      hasMemoryConfig: !!config.config?.memoryConfig,
      configKeys: Object.keys(config),
      configConfigKeys: config.config ? Object.keys(config.config) : "no config.config",
    });

    // Create supervisor
    const workspaceId = config.id || config.workspace?.id || "default";
    const supervisorConfig = config.config || {};

    // Validate memoryConfig is available
    const memoryConfig = supervisorConfig.memoryConfig || config.memoryConfig;
    if (!memoryConfig) {
      const errorMsg = "WorkspaceSupervisor requires memoryConfig";
      this.error(errorMsg, {
        workspaceId,
        configKeys: Object.keys(config),
        supervisorConfigKeys: Object.keys(supervisorConfig),
        hasMemoryConfig: !!config.memoryConfig,
        hasNestedMemoryConfig: !!supervisorConfig.memoryConfig,
      });
      throw new Error(errorMsg);
    }

    this.log("Creating WorkspaceSupervisor with config:", {
      workspaceId,
      hasMemoryConfig: !!memoryConfig,
      configKeys: Object.keys(supervisorConfig),
    });

    // Create supervisor with proper typed config
    const typedSupervisorConfig = {
      ...supervisorConfig,
      memoryConfig,
    };

    this.supervisor = new WorkspaceSupervisor(workspaceId, typedSupervisorConfig);

    // If workspace info provided, store it
    if (config.workspace) {
      this.workspace = config.workspace;
      if (this.workspace) {
        this.supervisor.setWorkspace(this.workspace);
      }
    }

    this.log("Supervisor created, initializing advanced planning...");

    // Initialize supervisor with advanced planning and job precomputation
    await this.supervisor.initialize();

    this.log("Supervisor initialization complete");
  }

  protected async processTask(
    _taskId: string,
    data: WorkspaceWorkerData,
  ): Promise<Record<string, unknown>> {
    if (!this.supervisor) {
      throw new Error("Supervisor not initialized");
    }

    switch (data.action) {
      case "processSignal": {
        const processData = data as ProcessSignalData;
        const { signal, payload, sessionId, signalConfig, jobs, traceHeaders } = processData;

        return await AtlasTelemetry.withWorkerSpan(
          {
            operation: "processSignal",
            component: "workspace",
            traceHeaders,
            workerId: this.context.id,
            sessionId,
            signalId: signal.id,
            signalType: signal.provider?.name || "unknown",
            workspaceId: this.workspace?.id,
          },
          async (_span) => {
            // Spawn session worker
            this.spawnSessionWorker(sessionId);

            // Join the session's broadcast channel
            this.actor.send({
              type: "JOIN_CHANNEL",
              channel: `session-${sessionId}`,
            });

            // Use WorkspaceSupervisor's intelligence to analyze the signal
            this.log("Analyzing signal with WorkspaceSupervisor...");
            const intent = await AtlasTelemetry.withSpan(
              "supervisor.analyzeSignal",
              async () => {
                return await this.supervisor!.analyzeSignal(signal, payload);
              },
              { "signal.id": signal.id },
            );
            this.log(`Signal analysis complete`);

            // Create filtered context for this specific session
            this.log("Creating session context...");
            const sessionContext = await AtlasTelemetry.withSpan(
              "supervisor.createSessionContext",
              async () => {
                return await this.supervisor!.createSessionContext(intent, signal, payload, {
                  signalConfig,
                  jobs,
                });
              },
              { "session.id": sessionId },
            );
            this.log(`Session context created`);

            // Create trace headers for session worker communication
            const sessionTraceHeaders = await AtlasTelemetry.createTraceHeaders();

            // Send filtered initialization data to session worker
            this.log(`Sending initialization to session worker ${sessionId}...`);
            const initTaskId = crypto.randomUUID();
            await this.sendToSessionWorker(sessionId, {
              type: "task",
              taskId: initTaskId,
              data: {
                action: "initialize",
                intent,
                signal,
                payload,
                workspaceId: this.workspace?.id,
                agents: sessionContext.availableAgents || [],
                filteredMemory: sessionContext.filteredMemory || [],
                jobSpec: sessionContext.jobSpec, // Pass job specification to session
                constraints: sessionContext.constraints,
                additionalPrompts: sessionContext.additionalPrompts,
                workspaceMcpServers: this.config?.config?.workspaceMcpServers, // Pass MCP servers to session
                traceHeaders: sessionTraceHeaders, // Pass trace context to session
              },
            });
            this.log(`Initialization sent to session worker`);

            // Start session execution in worker (SessionSupervisor will create the plan)
            const executionTaskId = crypto.randomUUID();
            const result = await this.sendToSessionWorker(sessionId, {
              type: "task",
              taskId: executionTaskId,
              data: {
                action: "executeSession",
                traceHeaders: sessionTraceHeaders, // Pass trace context
              },
            });

            // Check if session completed and notify runtime
            if (result && (result as any).status === "completed") {
              this.log(`Session ${sessionId} completed, notifying runtime`);
              self.postMessage({
                type: "sessionComplete",
                sessionId,
                result,
              });
            }

            return {
              sessionId,
              status: "started",
              result,
            };
          },
        );
      }

      case "getStatus": {
        return {
          ready: true,
          workspaceId: this.workspace?.id,
          sessions: this.sessions.size,
        };
      }

      default:
        throw new Error(`Unknown task action: ${(data as any).action}`);
    }
  }

  protected async cleanup(): Promise<void> {
    this.log("Cleaning up supervisor...");

    // Terminate all session workers
    for (const [_sessionId, info] of this.sessions) {
      info.worker.postMessage({ type: "shutdown" });
      info.worker.terminate();
      info.port.close();
    }

    this.sessions.clear();
    this.supervisor = null;
    this.workspace = null;

    await Promise.resolve();
  }

  private spawnSessionWorker(
    sessionId: string,
  ): SessionWorkerInfo {
    this.log(`Spawning session worker: ${sessionId}`);

    // Create session worker with permissions to use BroadcastChannel
    let sessionWorker: Worker;
    try {
      sessionWorker = new Worker(
        new URL("./session-supervisor-worker.ts", import.meta.url).href,
        {
          type: "module",
          deno: {
            permissions: "inherit",
          },
        } as WorkerOptions,
      );
      this.log(`Session worker created successfully: ${sessionId}`);
    } catch (error) {
      this.log(`Failed to create session worker: ${error}`);
      throw error;
    }

    // Create message channel for direct communication
    const { port1, port2 } = new MessageChannel();

    // Store session info
    const sessionInfo: SessionWorkerInfo = {
      worker: sessionWorker,
      port: port1,
      sessionId,
    };
    this.sessions.set(sessionId, sessionInfo);

    // Setup worker message handling
    sessionWorker.onmessage = (event) => {
      this.log(`Session worker message: ${event.data.type} from ${sessionId}`);
      this.handleSessionMessage(sessionId, event.data);
    };

    sessionWorker.onerror = (error) => {
      this.log(`Session ${sessionId} error:`, error);
      self.postMessage({
        type: "sessionError",
        sessionId,
        error: error.toString(),
      });
    };

    this.log(`Setting up session worker initialization for ${sessionId}`);

    // Validate that we have memory config before proceeding
    if (!this.config) {
      const errorMsg = `No config available for session worker ${sessionId}`;
      this.error(errorMsg, { sessionId });
      throw new Error(errorMsg);
    }

    const memoryConfig = this.config.memoryConfig || this.config.config?.memoryConfig;
    if (!memoryConfig) {
      const errorMsg = `Missing memoryConfig for session worker ${sessionId}`;
      this.error(errorMsg, {
        sessionId,
        configKeys: Object.keys(this.config),
        hasConfig: !!this.config.config,
        hasMemoryConfig: !!this.config.memoryConfig,
        hasNestedMemoryConfig: !!this.config.config?.memoryConfig,
      });
      throw new Error(errorMsg);
    }

    // Initialize session with memoryConfig and shared planning cache
    try {
      // Get precomputed plans from WorkspaceSupervisor's planning engine with security validation
      const workspaceId = this.workspace?.id;
      const precomputedPlans = this.supervisor?.getPrecomputedPlans(workspaceId) || {};

      sessionWorker.postMessage({
        type: "init",
        id: sessionId,
        workerType: "session",
        config: {
          sessionId,
          workspaceId: this.workspace?.id,
          memoryConfig,
          precomputedPlans, // Share the planning cache
        },
      });
      this.log(`Init message sent to session worker ${sessionId}`);
    } catch (error) {
      const errorMsg = `Failed to send init message to session worker: ${error}`;
      this.error(errorMsg, {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new Error(errorMsg);
    }

    // Send port for direct communication
    sessionWorker.postMessage({
      type: "setPort",
      peerId: "supervisor",
      port: port2,
    }, [port2]);

    // Setup port message handling
    port1.onmessage = (event) => {
      this.handleSessionDirectMessage(sessionId, event.data);
    };

    this.log(`Session worker setup complete for ${sessionId}`);
    return sessionInfo;
  }

  private handleSessionMessage(sessionId: string, message: Record<string, unknown>): void {
    switch (message.type) {
      case "initialized":
        // Session initialization logged by SessionSupervisorWorker
        break;

      case "agentSpawned":
        this.log(`Session ${sessionId} spawned agent: ${message.agentId}`);
        break;

      case "sessionBroadcast":
        this.log(`Session ${sessionId} broadcast:`, message.data);
        // Could analyze agent communications
        break;

      default:
        this.log(`Session message received`, {
          sessionId,
          messageType: message.type,
          taskId: message.taskId,
          status: (message as Record<string, any>).result?.status,
        });
    }
  }

  private handleSessionDirectMessage(sessionId: string, message: Record<string, unknown>): void {
    this.log(`Session direct message received`, {
      sessionId,
      messageType: message.type,
    });

    // Handle coordination requests from sessions
    if (message.type === "requestGuidance") {
      // Supervisor could provide guidance based on workspace goals
    }
  }

  // Helper to send tasks to session worker and wait for response
  private sendToSessionWorker(
    sessionId: string,
    message: Record<string, unknown>,
  ): Promise<unknown> {
    const sessionInfo = this.sessions.get(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Session worker timeout for task: ${message.taskId}`));
      }, 180000);

      // Listen for result
      const handleMessage = (event: MessageEvent) => {
        if (
          event.data.type === "result" && event.data.taskId === message.taskId
        ) {
          clearTimeout(timeout);
          sessionInfo.worker.removeEventListener("message", handleMessage);
          resolve(event.data.result);
        } else if (
          event.data.type === "error" && event.data.taskId === message.taskId
        ) {
          clearTimeout(timeout);
          sessionInfo.worker.removeEventListener("message", handleMessage);
          reject(new Error(event.data.error));
        }
      };

      sessionInfo.worker.addEventListener("message", handleMessage);
      sessionInfo.worker.postMessage(message);
    });
  }

  // Override to handle supervisor-specific messages
  protected override handleCustomMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case "setWorkspace":
        const setWorkspaceMsg = message as unknown as SetWorkspaceData;
        if (this.supervisor && setWorkspaceMsg.workspace) {
          this.workspace = setWorkspaceMsg.workspace;
          if (this.workspace) {
            this.supervisor.setWorkspace(this.workspace);
          }
          self.postMessage({ type: "workspaceSet" });
        }
        break;

      default:
        super.handleCustomMessage(message);
    }
  }

  // Handle broadcast messages from other agents
  protected override handleBroadcast(channel: string, data: Record<string, unknown>): void {
    this.log(`Received broadcast on ${channel}:`, data);

    // Supervisor could coordinate based on broadcasts
    if (data.type === "agentMessage" && this.supervisor) {
      // Could track agent communications, etc.
    }
  }
}

// Create and start the worker
new WorkspaceSupervisorWorker();
