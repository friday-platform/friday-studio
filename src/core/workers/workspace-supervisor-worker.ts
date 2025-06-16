/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />

import { BaseWorker } from "./base-worker.ts";
import { WorkspaceSupervisor } from "../supervisor.ts";
import type { IWorkspace, IWorkspaceSignal } from "../../types/core.ts";
import { AtlasTelemetry } from "../../utils/telemetry.ts";
import type { AtlasMemoryConfig } from "../memory-config.ts";
import {
  ATLAS_MESSAGE_TYPES,
  AtlasMessageEnvelope,
  createErrorResponse,
  createWorkspaceSessionCompleteMessage,
  createWorkspaceSessionErrorMessage,
  createWorkspaceStatusMessage,
  isWorkspaceGetStatusMessage,
  isWorkspaceProcessSignalMessage,
  isWorkspaceSetWorkspaceMessage,
  type MessageSource,
  validateEnvelope,
  WorkspaceGetStatusPayload,
  WorkspaceProcessSignalPayload,
  WorkspaceSetWorkspacePayload,
  WorkspaceStatusPayload,
} from "../utils/message-envelope.ts";

interface WorkspaceSupervisorConfig {
  id: string;
  workspace?: IWorkspace;
  config?: {
    workspaceSignals?: Record<string, unknown>;
    jobs?: Record<string, unknown>;
    memoryConfig?: AtlasMemoryConfig;
  };
  memoryConfig?: AtlasMemoryConfig;
  model?: string;
}

interface SessionWorkerInfo {
  worker: Worker;
  port: MessagePort;
  sessionId: string;
}

// Envelope-based message handling
type WorkspaceWorkerMessage =
  | AtlasMessageEnvelope<WorkspaceProcessSignalPayload>
  | AtlasMessageEnvelope<WorkspaceGetStatusPayload>
  | AtlasMessageEnvelope<WorkspaceSetWorkspacePayload>
  | AtlasMessageEnvelope<Record<string, unknown>>; // For custom workspace operations

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

  protected initialize(config: WorkspaceSupervisorConfig): Promise<void> {
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

    this.log("Supervisor initialized");
    return Promise.resolve();
  }

  protected async processTask(
    taskId: string,
    data: unknown,
  ): Promise<Record<string, unknown>> {
    try {
      // Validate incoming message as envelope
      const envelopeValidation = validateEnvelope(data);
      if (!envelopeValidation.success) {
        throw new Error(`Invalid message envelope: ${envelopeValidation.error.message}`);
      }

      const envelope = envelopeValidation.data as WorkspaceWorkerMessage;
      if (!this.supervisor) {
        throw new Error("Workspace supervisor not initialized");
      }

      // Domain validation for workspace messages
      if (envelope.domain !== "workspace") {
        throw new Error(
          `Invalid domain "${envelope.domain}" for workspace worker. Expected "workspace"`,
        );
      }

      switch (envelope.type) {
        case ATLAS_MESSAGE_TYPES.WORKSPACE.PROCESS_SIGNAL: {
          if (!isWorkspaceProcessSignalMessage(envelope)) {
            throw new Error("Invalid workspace process signal message format");
          }

          const { signal, payload, sessionId, signalConfig, jobs } = envelope.payload;

          return await AtlasTelemetry.withWorkerSpan(
            {
              operation: "processSignal",
              component: "workspace",
              traceHeaders: envelope.traceHeaders,
              workerId: this.context.id,
              sessionId,
              signalId: signal.id,
              signalType: signal.provider?.name || "unknown",
              workspaceId: this.workspace?.id,
            },
            async (_span) => {
              // Spawn session worker
              const _sessionWorker = await this.spawnSessionWorker(sessionId);

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
                  return await this.supervisor!.analyzeSignal(
                    signal as unknown as IWorkspaceSignal,
                    payload,
                  );
                },
                { "signal.id": signal.id },
              );
              this.log(`Signal analysis complete`);

              // Create filtered context for this specific session
              this.log("Creating session context...");
              const sessionContext = await AtlasTelemetry.withSpan(
                "supervisor.createSessionContext",
                async () => {
                  return await this.supervisor!.createSessionContext(
                    intent,
                    signal as unknown as IWorkspaceSignal,
                    payload,
                    {
                      signalConfig,
                      jobs,
                    },
                  );
                },
                { "session.id": sessionId },
              );
              this.log(`Session context created`);

              // Create trace headers for session worker communication
              const sessionTraceHeaders = await AtlasTelemetry.createTraceHeaders();

              // Send filtered initialization data to session worker using envelope format
              this.log(`Sending initialization to session worker ${sessionId}...`);
              const initTaskId = crypto.randomUUID();

              // Create session initialize envelope message
              const initPayload = {
                intent,
                signal: signal as unknown as Record<string, unknown>,
                payload,
                workspaceId: this.workspace?.id || "unknown",
                agents: sessionContext.availableAgents || [],
                jobSpec: sessionContext.jobSpec,
                additionalPrompts: sessionContext.additionalPrompts,
              };

              await this.sendToSessionWorker(sessionId, {
                type: "task",
                taskId: initTaskId,
                data: {
                  id: crypto.randomUUID(),
                  type: ATLAS_MESSAGE_TYPES.SESSION.INITIALIZE,
                  domain: "session",
                  source: {
                    workerId: this.context.id,
                    workerType: "workspace-supervisor",
                    sessionId,
                    workspaceId: this.workspace?.id,
                  },
                  timestamp: Date.now(),
                  correlationId: envelope.correlationId,
                  channel: "direct",
                  traceHeaders: sessionTraceHeaders,
                  payload: initPayload,
                  priority: "normal",
                },
              });
              this.log(`Initialization sent to session worker`);

              // Start session execution in worker using envelope format
              const executionTaskId = crypto.randomUUID();
              const executePayload = {
                sessionId,
                executionOptions: {
                  timeout: 180000, // 3 minutes
                  strategy: "adaptive" as const,
                },
              };

              const result = await this.sendToSessionWorker(sessionId, {
                type: "task",
                taskId: executionTaskId,
                data: {
                  id: crypto.randomUUID(),
                  type: ATLAS_MESSAGE_TYPES.SESSION.EXECUTE,
                  domain: "session",
                  source: {
                    workerId: this.context.id,
                    workerType: "workspace-supervisor",
                    sessionId,
                    workspaceId: this.workspace?.id,
                  },
                  timestamp: Date.now(),
                  correlationId: envelope.correlationId,
                  channel: "direct",
                  traceHeaders: sessionTraceHeaders,
                  payload: executePayload,
                  priority: "normal",
                },
              });

              // Check if session completed and notify runtime using envelope format
              if (result && (result as Record<string, unknown>).status === "completed") {
                this.log(`Session ${sessionId} completed, notifying runtime`);

                // Create session complete envelope message
                const source: MessageSource = {
                  workerId: this.context.id,
                  workerType: "workspace-supervisor",
                  sessionId,
                  workspaceId: this.workspace?.id,
                };

                const sessionCompletePayload = {
                  sessionId,
                  workspaceId: this.workspace?.id,
                  status: ((result as Record<string, unknown>).status as "completed" | "failed" | "cancelled" | "timeout") || "completed",
                  result: result as Record<string, unknown>,
                  startTime: Date.now() - 180000, // Approximate start time
                  endTime: Date.now(),
                  duration: 180000, // Will be calculated properly later
                  signalId: signal.id,
                  summary: (result as Record<string, unknown>).summary as string,
                };

                const completeMessage = createWorkspaceSessionCompleteMessage(
                  envelope,
                  sessionCompletePayload,
                  source,
                );

                self.postMessage({
                  type: "sessionComplete",
                  sessionId,
                  data: completeMessage,
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

        case ATLAS_MESSAGE_TYPES.WORKSPACE.GET_STATUS: {
          if (!isWorkspaceGetStatusMessage(envelope)) {
            throw new Error("Invalid workspace get status message format");
          }

          const statusPayload: WorkspaceStatusPayload = {
            ready: true,
            workspaceId: this.workspace?.id,
            sessions: this.sessions.size,
            activeSessions: Array.from(this.sessions.values()).map((session) => ({
              sessionId: session.sessionId,
              status: "executing" as const,
              startTime: Date.now() - 60000, // Approximate
              duration: 60000,
            })),
            lastSignalProcessed: Date.now(),
          };

          // Create proper envelope response
          const source: MessageSource = {
            workerId: this.context.id,
            workerType: "workspace-supervisor",
            workspaceId: this.workspace?.id,
          };

          const statusMessage = createWorkspaceStatusMessage(statusPayload, source, {
            correlationId: envelope.correlationId,
            traceHeaders: envelope.traceHeaders,
          });

          return statusMessage.payload;
        }

        default:
          throw new Error(`Unknown message type: ${envelope.type}`);
      }
    } catch (error) {
      // Create error response using envelope format
      if (data && typeof data === "object" && "id" in data && "source" in data) {
        const envelope = data as AtlasMessageEnvelope;
        const source: MessageSource = {
          workerId: this.context.id,
          workerType: "workspace-supervisor",
          workspaceId: this.workspace?.id,
        };

        const errorResponse = createErrorResponse(
          envelope,
          {
            code: "WORKSPACE_ERROR",
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            retryable: false,
          },
          source,
        );

        // Send error response back
        self.postMessage({
          type: "result",
          taskId,
          result: errorResponse.payload,
          error: errorResponse.error,
        });

        throw error;
      }

      throw error;
    }
  }

  protected cleanup(): Promise<void> {
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
    return Promise.resolve();
  }

  private spawnSessionWorker(
    sessionId: string,
  ): Promise<SessionWorkerInfo> {
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

      // Create envelope-based error message
      const source: MessageSource = {
        workerId: this.context.id,
        workerType: "workspace-supervisor",
        sessionId,
        workspaceId: this.workspace?.id,
      };

      const errorPayload = {
        sessionId,
        workspaceId: this.workspace?.id,
        error: {
          code: "SESSION_WORKER_ERROR",
          message: error.toString(),
          retryable: true,
        },
        context: {
          workerType: "session-supervisor",
          timestamp: Date.now(),
        },
      };

      // Create a dummy envelope for the error response
      const dummyEnvelope = {
        id: crypto.randomUUID(),
        type: "unknown",
        domain: "workspace" as const,
        source: { workerId: "unknown", workerType: "workspace-supervisor" as const },
        timestamp: Date.now(),
        channel: "direct" as const,
        payload: {},
        priority: "normal" as const,
      };

      const errorMessage = createWorkspaceSessionErrorMessage(
        dummyEnvelope,
        errorPayload,
        source,
      );

      self.postMessage({
        type: "sessionError",
        sessionId,
        data: errorMessage,
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

    // Initialize session with memoryConfig
    try {
      sessionWorker.postMessage({
        type: "init",
        id: sessionId,
        workerType: "session",
        config: {
          sessionId,
          workspaceId: this.workspace?.id,
          memoryConfig,
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
    return Promise.resolve(sessionInfo);
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
          status: (message as Record<string, Record<string, unknown>>).result?.status,
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
    // Try to handle as envelope message first
    const envelopeValidation = validateEnvelope(message);
    if (envelopeValidation.success) {
      const envelope = envelopeValidation.data;

      if (
        envelope.domain === "workspace" &&
        envelope.type === ATLAS_MESSAGE_TYPES.WORKSPACE.SET_WORKSPACE
      ) {
        if (isWorkspaceSetWorkspaceMessage(envelope)) {
          if (this.supervisor && envelope.payload.workspace) {
            this.workspace = envelope.payload.workspace as unknown as IWorkspace;
            if (this.workspace) {
              this.supervisor.setWorkspace(this.workspace);
            }

            // Send envelope-based acknowledgment
            self.postMessage({
              type: "workspaceSet",
              correlationId: envelope.correlationId,
            });
          }
          return;
        }
      }
    }

    // Handle legacy messages
    switch (message.type) {
      case "setWorkspace":
        if (this.supervisor && "workspace" in message) {
          this.workspace = message.workspace as IWorkspace;
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

    // Check if this is an envelope message
    const envelopeValidation = validateEnvelope(data);
    if (envelopeValidation.success) {
      const envelope = envelopeValidation.data;

      // Handle envelope-based messages
      switch (envelope.type) {
        case ATLAS_MESSAGE_TYPES.SESSION.COMPLETE:
          this.logger.info("Session completion received via broadcast", {
            workspaceId: this.workspace?.id,
            sessionId: envelope.source.sessionId,
            messageType: envelope.type,
            domain: envelope.domain,
          });

          // Forward session completion to parent/runtime with envelope format
          self.postMessage({
            type: "sessionBroadcast",
            data: envelope,
          });
          break;

        case ATLAS_MESSAGE_TYPES.TASK.PROGRESS:
          if (envelope.domain === "session") {
            this.logger.debug("Session progress received via broadcast", {
              workspaceId: this.workspace?.id,
              sessionId: envelope.source.sessionId,
              correlationId: envelope.correlationId,
            });

            // Forward session progress to parent/runtime
            self.postMessage({
              type: "sessionBroadcast",
              data: envelope,
            });
          } else if (envelope.domain === "agent") {
            this.logger.debug("Agent progress received via broadcast", {
              workspaceId: this.workspace?.id,
              agentId: envelope.source.workerId,
              sessionId: envelope.source.sessionId,
              correlationId: envelope.correlationId,
            });

            // Could aggregate agent progress for workspace-level monitoring
            self.postMessage({
              type: "agentBroadcast",
              data: envelope,
            });
          }
          break;

        case ATLAS_MESSAGE_TYPES.AGENT.LOG:
          this.logger.debug("Agent log received via broadcast", {
            workspaceId: this.workspace?.id,
            agentId: envelope.source.workerId,
            sessionId: envelope.source.sessionId,
            messageType: envelope.type,
          });

          // Forward agent logs to parent with envelope format
          self.postMessage({
            type: "agentBroadcast",
            data: envelope,
          });
          break;

        case ATLAS_MESSAGE_TYPES.WORKSPACE.SESSION_ERROR:
          this.logger.warn("Workspace session error received via broadcast", {
            workspaceId: this.workspace?.id,
            sessionId: envelope.source.sessionId,
            correlationId: envelope.correlationId,
          });

          // Handle workspace-level session errors
          self.postMessage({
            type: "workspaceError",
            data: envelope,
          });
          break;

        default:
          this.logger.warn("Unknown envelope message type in broadcast", {
            workspaceId: this.workspace?.id,
            messageType: envelope.type,
            domain: envelope.domain,
          });
      }
    } else {
      // Handle legacy message format
      switch (data.type) {
        case "agentMessage":
          if (this.supervisor) {
            this.log(`Agent broadcast: ${data.message} from ${data.from}`);
            // Could track agent communications for workspace coordination
          }
          break;

        case "sessionComplete":
          this.log("Session completion received:", data);
          // Forward to parent (legacy format)
          self.postMessage({
            type: "sessionBroadcast",
            data,
          });
          break;

        case "supervisorCommand":
          this.log("Supervisor command:", data);
          // Handle supervisor coordination commands
          break;

        default:
          this.log(`Unknown broadcast type: ${data.type}`);
      }
    }
  }
}

// Create and start the worker
new WorkspaceSupervisorWorker();
