import { type Actor, assign, createActor, fromPromise, setup } from "xstate";
import type { IWorkspace, IWorkspaceSession, IWorkspaceSignal } from "../types/core.ts";
import { logger } from "../utils/logger.ts";
import { AtlasTelemetry } from "../utils/telemetry.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { type ISignalProvider, ProviderType } from "./providers/types.ts";
import { Session } from "./session.ts";
import type { LibraryStorageAdapter } from "./storage/library-storage-adapter.ts";
import { ManagedWorker, WorkerManager } from "./utils/worker-manager.ts";

export interface WorkspaceRuntimeOptions {
  lazy?: boolean;
  supervisorModel?: string;
  workspacePath?: string; // For daemon mode - path to workspace directory
  libraryStorage?: LibraryStorageAdapter; // For daemon mode - shared library storage
}

export interface RuntimeAgentConfig {
  type: string;
  name?: string;
  nickname?: string;
  version?: string;
  provider?: string;
  purpose?: string;
  prompts?: {
    system?: string;
    user?: string;
  };
  model?: string;
  [key: string]: any; // Allow additional properties
}

// Define the context for the state machine
interface WorkspaceRuntimeContext {
  workspace: IWorkspace;
  config?: any;
  options: WorkspaceRuntimeOptions;
  supervisorId?: string;
  sessions: Map<string, IWorkspaceSession>;
  sessionCount: number; // Optimized session counting for guards
  workerManager: WorkerManager;
  runtime?: WorkspaceRuntime; // Reference to runtime instance for signal processing
  error?: Error;
  activeStreamSignals?: Map<string, any>; // Track active stream signal connections
  isShuttingDown?: boolean; // Flag to prevent new signal processing during shutdown
  mergedConfig?: {
    atlas: {
      agents: Record<string, RuntimeAgentConfig>;
    };
    workspace: {
      agents: Record<string, RuntimeAgentConfig>;
      signals?: Record<string, any>;
    };
    jobs?: Record<string, any>;
  };
}

// Define the events for the state machine
type WorkspaceRuntimeEvent =
  | { type: "INITIALIZE" }
  | { type: "PROCESS_SIGNAL"; signal: IWorkspaceSignal; payload: any }
  | { type: "SESSION_CREATED"; sessionId: string }
  | { type: "SESSION_COMPLETE"; sessionId: string }
  | { type: "SHUTDOWN" }
  | { type: "ERROR"; error: Error };

// Define the machine input
interface WorkspaceRuntimeMachineInput {
  workspace: IWorkspace;
  config?: any;
  options: WorkspaceRuntimeOptions;
  sessions: Map<string, IWorkspaceSession>;
  sessionCount: number; // Optimized session counting
  workerManager: WorkerManager;
  runtime?: WorkspaceRuntime;
}

/**
 * WorkspaceRuntime orchestrates the execution of a workspace.
 * It manages workers, sessions, and signal processing.
 */
export class WorkspaceRuntime {
  private workspace: IWorkspace;
  private workerManager: WorkerManager;
  private sessions: Map<string, IWorkspaceSession> = new Map();
  private options: WorkspaceRuntimeOptions;
  private config?: any;
  private stateMachine: Actor<typeof workspaceRuntimeMachine>;
  private libraryStorage?: LibraryStorageAdapter;
  private fsmId: string; // Unique FSM instance ID for monitoring

  constructor(
    workspace: IWorkspace,
    config?: any,
    options: WorkspaceRuntimeOptions = {},
  ) {
    this.workspace = workspace;
    this.config = config;
    this.options = options;
    this.workerManager = new WorkerManager();

    // Use provided library storage if available (daemon mode)
    this.libraryStorage = options.libraryStorage;

    // Set up message handler for session completion
    this.setupMessageHandlers();

    // Agent loading will happen during initialization

    // Create and start the state machine
    this.stateMachine = createActor(workspaceRuntimeMachine, {
      input: {
        workspace,
        config,
        options,
        sessions: new Map(),
        sessionCount: 0, // Optimized session counting
        workerManager: this.workerManager,
        runtime: this, // Pass runtime instance for signal processing
      },
    });

    // Add a unique ID to track this FSM instance
    this.fsmId = crypto.randomUUID().slice(0, 8);

    this.stateMachine.start();

    // Initialize supervisor if not lazy
    if (!options.lazy) {
      logger.info("Sending INITIALIZE event (not lazy)", {
        workspaceId: workspace.id,
        options: options,
      });
      this.stateMachine.send({ type: "INITIALIZE" });
    } else {
      logger.info("Lazy initialization - waiting for manual INITIALIZE", {
        workspaceId: workspace.id,
        options: options,
      });
    }
  }

  /**
   * Set up message handlers for worker communication
   */
  private setupMessageHandlers(): void {
    // Set up global message handler for worker messages
    this.workerManager.setGlobalMessageHandler(async (_workerId: string, message: any) => {
      if (message.type === "sessionComplete") {
        await this.handleSessionComplete(message.sessionId, message.result);
      }
    });
  }

  /**
   * Handle session completion and store results in library
   */
  private async handleSessionComplete(sessionId: string, result: any): Promise<void> {
    try {
      if (!this.libraryStorage || !result) {
        logger.warn("Cannot store session results - library storage not available or no result", {
          workspaceId: this.workspace.id,
          sessionId,
          hasLibraryStorage: !!this.libraryStorage,
          hasResult: !!result,
        });
        return;
      }

      logger.info("Storing session results in library", {
        workspaceId: this.workspace.id,
        sessionId,
        resultType: typeof result,
        hasPhases: !!result.phases_executed,
        hasTiming: !!result.timing,
        hasFinalOutput: !!result.final_output,
        finalOutputType: typeof result.final_output,
        finalOutputResultLength: result.final_output?.result?.length || 0,
      });

      // Build session data for archiving
      const sessionRecord = this.sessions.get(sessionId);
      if (!sessionRecord) {
        logger.warn("No session record found for completed session", {
          sessionId,
          availableSessions: Array.from(this.sessions.keys()),
        });
        return;
      }

      // Extract session data for library storage
      const sessionData = {
        sessionId,
        workspaceId: this.workspace.id,
        signalId: sessionRecord.signals.triggers[0]?.id || "unknown",
        result,
        timestamp: new Date().toISOString(),
        metadata: {
          signal: result.original_input || {},
          phases_executed: result.phases_executed || 1,
          total_agents_invoked: result.total_agents_invoked || 0,
          final_output_size: result.final_output?.result?.length || 0,
          raw_result_structure: Object.keys(result || {}),
          timing_structure: Object.keys(result.timing || {}),
          final_output_structure: Object.keys(result.final_output || {}),
        },
      };

      // Store session archive in library using new storage adapter
      const archiveId = crypto.randomUUID();
      await this.libraryStorage.storeItem({
        id: archiveId,
        type: "session_archive",
        name: `Session Archive - ${sessionId.slice(0, 8)}`,
        description: `Complete session data and results from session ${sessionId}`,
        content: JSON.stringify(sessionData, null, 2),
        metadata: {
          format: "json",
          source: "system",
          session_id: sessionId,
          custom_fields: sessionData.metadata,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tags: ["session-archive", "automated"],
        workspace_id: this.workspace.id,
      });

      // Also store the final report as a separate library item if available
      logger.info("Checking for final report to store", {
        hasFinalOutput: !!result.final_output,
        hasFinalOutputResult: !!result.final_output?.result,
        finalOutputResultLength: result.final_output?.result?.length || 0,
      });

      if (result.final_output?.result) {
        logger.info("Creating separate report item", {
          sessionId,
          reportLength: result.final_output.result.length,
        });

        const reportId = crypto.randomUUID();
        try {
          await this.libraryStorage.storeItem({
            id: reportId,
            type: "report",
            name: `Analysis Report - ${sessionId.slice(0, 8)}`,
            description: `Generated analysis report from session ${sessionId}`,
            content: result.final_output.result,
            metadata: {
              format: "markdown",
              source: "agent",
              session_id: sessionId,
              agent_ids: result.timing?.agent_executions?.map((exec: any) => exec.agent) || [],
              custom_fields: {
                agent_type: result.final_output.agent_type,
                agent_id: result.final_output.agent_id,
                model: result.final_output.model,
                generation_time: new Date().toISOString(),
              },
            },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            tags: ["session-report", "analysis", "automated"],
            workspace_id: this.workspace.id,
          });
          logger.info("Report item stored successfully", { reportId, sessionId });
        } catch (error) {
          logger.error("Failed to store report item", {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            reportId,
            sessionId,
          });
        }

        logger.info("Session results stored in library", {
          workspaceId: this.workspace.id,
          sessionId,
          archiveId,
          reportId,
        });
      }
    } catch (error) {
      logger.error("Failed to store session results in library", {
        workspaceId: this.workspace.id,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get current state
   */
  getState(): string {
    const state = this.stateMachine.getSnapshot();
    return typeof state.value === "string" ? state.value : JSON.stringify(state.value);
  }

  /**
   * Process a signal and create a session
   */
  async processSignal(
    signal: IWorkspaceSignal,
    payload: any,
  ): Promise<IWorkspaceSession> {
    return await AtlasTelemetry.withServerSpan(
      "workspace.processSignal",
      async (span) => {
        // Add workspace and signal attributes
        AtlasTelemetry.addComponentAttributes(span, "workspace", { id: this.workspace.id });
        AtlasTelemetry.addComponentAttributes(
          span,
          "signal",
          {
            id: signal.id,
            type: signal.provider?.name || signal.provider?.id || "unknown",
          },
        );

        const state = this.stateMachine.getSnapshot();

        // Check if shutting down - reject immediately
        if (state.context.isShuttingDown) {
          throw new Error("Cannot process signal: workspace is shutting down");
        }

        // Check if we're in a valid state to process signals
        if (
          state.value !== "ready" && state.value !== "processing" &&
          state.value !== "initializingStreams"
        ) {
          // If uninitialized, initialize first
          if (state.value === "uninitialized") {
            this.stateMachine.send({ type: "INITIALIZE" });
            // Wait for ready state
            await this.waitForState(["ready"]);
          } else {
            throw new Error(`Cannot process signal in state: ${state.value}`);
          }
        }

        // Get supervisor ID and merged config from FSM context
        const currentState = this.stateMachine.getSnapshot();
        const supervisorId = currentState.context.supervisorId;
        const mergedConfig = currentState.context.mergedConfig;

        if (!supervisorId) {
          throw new Error("Supervisor not initialized in FSM context");
        }

        const supervisor = this.workerManager.getWorker(supervisorId);
        if (!supervisor) {
          throw new Error("Supervisor worker not found");
        }

        logger.info(`Processing signal: ${signal.id}`, {
          workspaceId: this.workspace.id,
          signalId: signal.id,
        });

        // Generate task ID for tracking
        const taskId = crypto.randomUUID();

        // Use session ID from payload (for conversation continuity), otherwise generate new one
        const sessionId = payload?.sessionId || crypto.randomUUID();

        // Create session options
        const sessionOptions: any = {
          triggers: [signal],
          // deno-lint-ignore require-await
          callback: async (result) => {
            logger.info(`Session completed`, {
              workspaceId: this.workspace.id,
              sessionId,
              result,
            });
          },
        };

        // Create session without response config (sessions no longer handle response channels directly)
        const session = new Session(
          this.workspace.id,
          sessionOptions,
          undefined, // agents
          undefined, // workflows
          undefined, // sources
          undefined, // intent
          undefined, // storageAdapter
          true, // enableCognitiveLoop
        );

        // Store original session ID for debugging
        const originalSessionId = session.id;

        // Override session ID
        (session as any).id = sessionId;

        // Store session
        this.sessions.set(sessionId, session);
        logger.debug("Session stored", {
          sessionId,
          originalSessionId,
          sessionIdAfterOverride: session.id,
          sessionCount: this.sessions.size,
        });

        // Notify FSM about session creation for sessionCount tracking
        this.stateMachine.send({ type: "SESSION_CREATED", sessionId });

        // Send event to state machine
        this.stateMachine.send({ type: "PROCESS_SIGNAL", signal, payload });

        // Create trace headers for supervisor communication
        const traceHeaders = await AtlasTelemetry.createTraceHeaders();

        // Send task to supervisor for processing
        try {
          await this.workerManager.sendTask(
            supervisorId,
            taskId,
            {
              action: "processSignal",
              signal: {
                id: signal.id,
                provider: signal.provider,
                // Only send serializable signal data
              },
              payload,
              sessionId,
              // Pass job configuration for this signal processing
              signalConfig: mergedConfig?.workspace?.signals?.[signal.id],
              jobs: mergedConfig?.jobs,
              traceHeaders, // Pass trace context to supervisor
            },
          );
        } catch (error) {
          logger.error(`Task ${taskId} failed`, {
            workspaceId: this.workspace.id,
            signalId: signal.id,
            supervisorId,
            error: error.message,
          });

          // Mark session as failed and clean up
          session.signals.callback.onError(error);

          // Remove failed session from tracking
          this.sessions.delete(sessionId);

          throw error; // Re-throw to allow caller to handle
        }

        return session;
      },
      {
        "workspace.state": this.getState(),
        "signal.payload.size": JSON.stringify(payload).length,
      },
    );
  }

  /**
   * Wait for specific states
   */
  private waitForState(
    targetStates: string[],
    timeout = 30000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(
          new Error(`Timeout waiting for states: ${targetStates.join(", ")}`),
        );
      }, timeout);

      const checkState = () => {
        const state = this.stateMachine.getSnapshot();
        if (targetStates.includes(state.value as string)) {
          clearTimeout(timeoutId);
          resolve();
        }
      };

      // Check immediately
      checkState();

      // Subscribe to state changes
      const subscription = this.stateMachine.subscribe((state) => {
        if (targetStates.includes(state.value as string)) {
          clearTimeout(timeoutId);
          subscription.unsubscribe();
          resolve();
        }
      });
    });
  }

  /**
   * Get runtime status
   */
  getStatus(): {
    workspace: string;
    supervisor: string | undefined;
    sessions: number;
    workers: any;
    state: string;
  } {
    const currentState = this.stateMachine.getSnapshot();
    const supervisorId = currentState.context.supervisorId;
    const supervisorState = supervisorId
      ? this.workerManager.getWorkerState(supervisorId)
      : undefined;

    return {
      workspace: this.workspace.id,
      supervisor: supervisorState,
      sessions: this.sessions.size,
      workers: {
        total: this.workerManager.getWorkersByType("agent").length +
          this.workerManager.getWorkersByType("session").length +
          (supervisorId ? 1 : 0),
        byType: {
          supervisor: supervisorId ? 1 : 0,
          session: this.workerManager.getWorkersByType("session").length,
          agent: this.workerManager.getWorkersByType("agent").length,
        },
      },
      state: this.getState(),
    };
  }

  /**
   * Get all active sessions
   */
  getSessions(): IWorkspaceSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get a specific session
   */
  getSession(sessionId: string): IWorkspaceSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Cancel a session
   */
  async cancelSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.cancel();
      this.sessions.delete(sessionId);

      // Notify state machine
      this.stateMachine.send({ type: "SESSION_COMPLETE", sessionId });
    }
  }

  /**
   * Get all workers
   */
  getWorkers(): any[] {
    return [
      ...this.workerManager.getWorkersByType("supervisor"),
      ...this.workerManager.getWorkersByType("session"),
      ...this.workerManager.getWorkersByType("agent"),
    ].map((worker) => ({
      id: worker.id,
      type: worker.type,
      state: this.workerManager.getWorkerState(worker.id),
      metadata: worker.metadata,
    }));
  }

  /**
   * Save state checkpoint
   */
  saveStateCheckpoint(): void {
    logger.info("Saving state checkpoint", { workspaceId: this.workspace.id });

    const state = {
      workspace: this.workspace.snapshot(),
      sessions: Array.from(this.sessions.entries()).map(([id, session]) => ({
        id,
        status: session.status,
        summary: session.summarize(),
      })),
      workers: this.getWorkers(),
      timestamp: new Date().toISOString(),
    };

    // TODO: Implement actual persistence
    logger.debug("State checkpoint saved", {
      workspaceId: this.workspace.id,
      checkpoint: state,
    });
  }

  /**
   * List all jobs in the workspace
   */
  async listJobs(): Promise<Array<{ name: string; description?: string }>> {
    const jobs = this.config?.workspace?.jobs || {};
    return Object.entries(jobs).map(([name, config]) => ({
      name,
      description: (config as any)?.description,
    }));
  }

  /**
   * Trigger a job in the workspace
   */
  async triggerJob(jobName: string, payload?: any): Promise<{ sessionId: string }> {
    const jobs = this.config?.workspace?.jobs || {};
    if (!jobs[jobName]) {
      throw new Error(`Job '${jobName}' not found`);
    }

    // Find signal that triggers this job
    const signals = this.config?.workspace?.signals || {};
    for (const [signalName, signalConfig] of Object.entries(signals)) {
      const jobConfig = jobs[jobName];
      const triggers = (jobConfig as any)?.triggers || [];
      const hasMatchingTrigger = triggers.some((trigger: any) => trigger.signal === signalName);

      if (hasMatchingTrigger) {
        const signal = { id: signalName, name: signalName, ...(signalConfig as object) } as any;
        const result = await this.processSignal(signal, payload || {});
        return { sessionId: result.id || crypto.randomUUID() };
      }
    }

    throw new Error(`No signal found that triggers job '${jobName}'`);
  }

  /**
   * Get detailed information about a job
   */
  async describeJob(jobName: string): Promise<any> {
    const jobs = this.config?.workspace?.jobs || {};
    if (!jobs[jobName]) {
      throw new Error(`Job '${jobName}' not found`);
    }
    return jobs[jobName];
  }

  /**
   * List all sessions in the workspace
   */
  async listSessions(): Promise<Array<{ id: string; status: string; startedAt: string }>> {
    return Array.from(this.sessions.entries()).map(([id, session]) => ({
      id,
      status: session.status,
      startedAt: new Date().toISOString(), // Use current time as fallback
    }));
  }

  /**
   * Get detailed information about a session
   */
  async describeSession(sessionId: string): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }
    return {
      id: sessionId,
      status: session.status,
      startedAt: new Date().toISOString(),
      summary: session.summarize(),
    };
  }

  /**
   * List all signals in the workspace
   */
  async listSignals(): Promise<Array<{ name: string; description?: string }>> {
    const signals = this.config?.workspace?.signals || {};
    return Object.entries(signals).map(([name, config]) => ({
      name,
      description: (config as any)?.description,
    }));
  }

  /**
   * Trigger a signal in the workspace
   */
  async triggerSignal(signalName: string, payload?: any): Promise<void> {
    const signals = this.config?.workspace?.signals || {};
    const signalConfig = signals[signalName];
    if (!signalConfig) {
      throw new Error(`Signal '${signalName}' not found`);
    }
    const signal = { id: signalName, name: signalName, ...(signalConfig as object) } as any;
    await this.processSignal(signal, payload || {});
  }

  /**
   * List all agents in the workspace
   */
  async listAgents(): Promise<Array<{ id: string; type: string; purpose?: string }>> {
    const agents = this.config?.workspace?.agents || {};
    return Object.entries(agents).map(([id, config]) => ({
      id,
      type: (config as any)?.type || "unknown",
      purpose: (config as any)?.purpose,
    }));
  }

  /**
   * Get detailed information about an agent
   */
  async describeAgent(agentId: string): Promise<any> {
    const agents = this.config?.workspace?.agents || {};
    if (!agents[agentId]) {
      throw new Error(`Agent '${agentId}' not found`);
    }
    return agents[agentId];
  }

  /**
   * Manually initialize the runtime (for lazy initialization)
   */
  async initialize(): Promise<void> {
    const state = this.stateMachine.getSnapshot();

    if (state.value !== "uninitialized") {
      logger.warn("Runtime already initialized or initializing", {
        workspaceId: this.workspace.id,
        currentState: state.value,
      });
      return;
    }

    logger.info("Manually initializing runtime", {
      workspaceId: this.workspace.id,
    });

    this.stateMachine.send({ type: "INITIALIZE" });

    // Wait for initialization to complete
    await this.waitForState(["ready", "terminated"]);
  }

  /**
   * Shutdown the runtime
   */
  async shutdown(): Promise<void> {
    const state = this.stateMachine.getSnapshot();

    // Check if already shutting down or terminated
    if (state.value === "draining" || state.value === "terminated") {
      logger.warn("Already shutting down or terminated", {
        workspaceId: this.workspace.id,
      });
      return;
    }

    // Send shutdown event
    this.stateMachine.send({ type: "SHUTDOWN" });

    // Wait for terminated state
    await this.waitForState(["terminated"]);
  }
}

// Define the state machine using setup for better type inference
const workspaceRuntimeMachine = setup({
  types: {
    context: {} as WorkspaceRuntimeContext,
    events: {} as WorkspaceRuntimeEvent,
    input: {} as WorkspaceRuntimeMachineInput,
  },
  actors: {
    initializeStreamSignals: fromPromise<
      { activeStreamSignals: Map<string, any> },
      { context: WorkspaceRuntimeContext }
    >(async ({ input }) => {
      const { context } = input;
      const activeStreamSignals = new Map<string, any>();

      // Register built-in providers to ensure stream provider is available
      ProviderRegistry.registerBuiltinProviders();
      const registry = ProviderRegistry.getInstance();

      logger.info("Initializing stream signals", {
        workspaceId: context.workspace.id,
        signalCount: Object.keys(context.mergedConfig?.workspace.signals || {}).length,
      });

      // Initialize stream signals
      if (context.mergedConfig?.workspace.signals) {
        for (
          const [signalId, signalConfig] of Object.entries(context.mergedConfig.workspace.signals)
        ) {
          if (signalConfig.provider === "stream" || signalConfig.provider === "k8s-events") {
            try {
              logger.info(`Initializing real-time signal: ${signalId}`, {
                provider: signalConfig.provider,
                endpoint: signalConfig.endpoint,
                source: signalConfig.source,
              });

              // Create provider config based on signal type
              const providerConfig = {
                id: signalId,
                type: ProviderType.SIGNAL,
                provider: signalConfig.provider,
                config: signalConfig.provider === "stream"
                  ? {
                    source: signalConfig.source,
                    endpoint: signalConfig.endpoint,
                    timeout_ms: signalConfig.timeout_ms,
                    retry_config: signalConfig.retry_config,
                  }
                  : {
                    // k8s-events config
                    kubeconfig: signalConfig.kubeconfig,
                    kubeconfig_content: signalConfig.kubeconfig_content,
                    kubeconfig_env: signalConfig.kubeconfig_env,
                    use_service_account: signalConfig.use_service_account,
                    api_server: signalConfig.api_server,
                    token: signalConfig.token,
                    ca_cert: signalConfig.ca_cert,
                    insecure: signalConfig.insecure,
                    namespace: signalConfig.namespace,
                    timeout_ms: signalConfig.timeout_ms,
                    retry_config: signalConfig.retry_config,
                  },
              };

              // Load the signal provider
              const provider = await registry.loadFromConfig(providerConfig);
              const signalProvider = provider as ISignalProvider;
              const signal = signalProvider.createSignal(providerConfig.config);

              // Convert to runtime signal
              const runtimeSignal = signal.toRuntimeSignal();

              // Initialize the stream connection
              await runtimeSignal.initialize({
                id: signalId, // Pass the actual signal ID from configuration, not workspace ID
                processSignal: async (signalId: string, payload: any) => {
                  // Process the signal through the runtime
                  const signalConfig = context.mergedConfig?.workspace.signals?.[signalId];
                  if (signalConfig && context.runtime) {
                    logger.info(`Real-time signal triggered: ${signalId}`, {
                      source: payload.source,
                      eventType: payload.event?.reason,
                    });

                    try {
                      // Create a signal object that matches IWorkspaceSignal interface
                      const signal = {
                        id: signalId,
                        provider: { id: signalConfig.provider, name: signalConfig.provider },
                        config: signalConfig,
                      };

                      // Process the signal through the runtime
                      await context.runtime.processSignal(signal as any, payload);

                      logger.info(`Stream signal processed successfully: ${signalId}`);
                    } catch (error) {
                      logger.error(`Failed to process stream signal: ${signalId}`, {
                        error: error instanceof Error ? error.message : String(error),
                        stack: error instanceof Error ? error.stack : undefined,
                      });
                    }
                  }
                },
              });

              activeStreamSignals.set(signalId, runtimeSignal);

              logger.info(`Stream signal initialized successfully: ${signalId}`);
            } catch (error) {
              // Extract friendly error message if available
              const errorMessage = error instanceof Error ? error.message : String(error);

              // Log the error details for debugging
              logger.error(`Failed to initialize stream signal: ${signalId}`, {
                error: errorMessage,
                provider: signalConfig.provider,
                stack: error instanceof Error ? error.stack : undefined,
              });
            }
          }
        }
      }

      logger.info("Stream signal initialization complete", {
        workspaceId: context.workspace.id,
        activeSignals: activeStreamSignals.size,
      });

      return { activeStreamSignals };
    }),

    initializeSupervisor: fromPromise<
      { supervisorId: string; mergedConfig: any },
      { context: WorkspaceRuntimeContext }
    >(async ({ input }) => {
      const { context } = input;
      await logger.info("Initializing supervisor", {
        workspaceId: context.workspace.id,
      });

      // Load workspace .env file globally for MCP server environment variables
      if (context.options.workspacePath) {
        try {
          const { load } = await import("@std/dotenv");
          const { join } = await import("@std/path");
          const { exists } = await import("@std/fs");

          const envFilePath = join(context.options.workspacePath, ".env");
          if (await exists(envFilePath)) {
            await load({ export: true, envPath: envFilePath });
            logger.debug("Loaded workspace .env file for global environment", {
              workspaceId: context.workspace.id,
              envPath: envFilePath,
            });
          }
        } catch (error) {
          logger.debug("Could not load workspace .env file", {
            workspaceId: context.workspace.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Use pre-loaded configuration or load as fallback
      let mergedConfig: any;

      logger.info(`Loading workspace config from context: ${JSON.stringify(context.config)}`, {
        workspaceId: context.workspace.id,
      });

      if (context.config) {
        // Use pre-loaded configuration (preferred - no I/O)
        mergedConfig = context.config;
        await logger.debug("Using pre-loaded configuration", {
          workspaceId: context.workspace.id,
        });
      } else {
        // Fallback: load configuration (should only happen for legacy cases)
        await logger.warn("No pre-loaded config found, falling back to loading from disk", {
          workspaceId: context.workspace.id,
        });
        const { ConfigLoader } = await import("@atlas/config");
        const { FilesystemConfigAdapter } = await import("@atlas/storage");
        const adapter = new FilesystemConfigAdapter();
        const configLoader = new ConfigLoader(adapter);
        mergedConfig = await configLoader.load();
      }

      // Memory configuration is already loaded in mergedConfig.atlas

      // Load all agents (platform + user)
      logger.debug("Agent config before merging", {
        atlasAgents: Object.keys(mergedConfig.atlas?.agents || {}),
        workspaceAgents: Object.keys(mergedConfig.workspace?.agents || {}),
        conversationAgentType: mergedConfig.workspace?.agents?.["conversation-agent"]?.type,
      });

      const allAgents: Record<string, RuntimeAgentConfig> = {
        ...(mergedConfig.atlas?.agents || {}),
        ...(mergedConfig.workspace?.agents || {}),
      };

      logger.debug("Agent config after merging", {
        allAgents: Object.keys(allAgents),
        conversationAgentType: allAgents["conversation-agent"]?.type,
      });

      if (allAgents && Object.keys(allAgents).length > 0) {
        const { AgentLoader } = await import("./agent-loader.ts");
        const loadResult = await AgentLoader.loadAgents(
          context.workspace,
          allAgents,
        );

        logger.info(
          `Agent loading complete: ${loadResult.loaded.length} loaded, ${loadResult.failed.length} failed`,
          {
            workspaceId: context.workspace.id,
            loadedCount: loadResult.loaded.length,
            failedCount: loadResult.failed.length,
          },
        );
      }

      // Use consolidated worker creation method
      const supervisorConfig = {
        workspace: {
          ...context.workspace.snapshot(),
          id: context.workspace.id,
          // Serialize agents to pass only metadata
          agents: await (async () => {
            try {
              logger.debug("Loading agent metadata", {
                workspaceId: context.workspace.id,
                agentCount: Object.keys(context.workspace.agents || {}).length,
              });
              const agentLoader = await import("./agent-loader.ts");
              return agentLoader.AgentLoader.serializeAgentMetadata(context.workspace.agents || {});
            } catch (error) {
              logger.error("Failed to load agent metadata", {
                workspaceId: context.workspace.id,
                error: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
          })(),
          signals: Object.keys(context.workspace.signals || {}),
          workflows: Object.keys(context.workspace.workflows || {}),
        },
        // Add memory configuration at top level for WorkspaceSupervisor
        memoryConfig: mergedConfig.atlas.memory,
        config: {
          ...(context.config?.supervisor || {}),
          // Pass only serializable parts of the merged configuration
          workspaceSignals: mergedConfig.workspace.signals,
          workspaceTools: mergedConfig.workspace.tools?.mcp?.servers
            ? {
              mcp: {
                servers: mergedConfig.workspace.tools.mcp.servers,
              },
            }
            : undefined,
          jobs: mergedConfig.jobs,
          supervisorDefaults: mergedConfig.supervisorDefaults, // Pass supervisor defaults to workers
          workspacePath: context.options.workspacePath, // Pass workspace path for .env loading in workers
        },
      };

      let supervisor: ManagedWorker;
      try {
        supervisor = await context.workerManager.spawnSupervisorWorker(
          context.workspace.id,
          supervisorConfig,
          {
            model: context.options.supervisorModel ||
              context.config?.supervisor?.model,
            timeout: 10000,
          },
        );
      } catch (error) {
        const err = error as Error;
        await logger.error("Failed to spawn supervisor worker", {
          workspaceId: context.workspace.id,
          error: err.message,
          stack: err.stack,
        });
        throw new Error(`Failed to spawn supervisor: ${err.message}`);
      }

      logger.info("Supervisor ready", { supervisorId: supervisor?.id });

      if (!supervisor?.id) {
        throw new Error("Supervisor was created but has no ID");
      }

      logger.debug("Returning supervisor initialization result", {
        supervisorId: supervisor.id,
        hasMergedConfig: !!mergedConfig,
        workspaceId: context.workspace.id,
      });

      try {
        const result = { supervisorId: supervisor.id, mergedConfig };
        logger.debug("Supervisor initialization result created successfully", {
          resultKeys: Object.keys(result),
          supervisorId: result.supervisorId,
        });
        return result;
      } catch (error) {
        logger.error("Failed to create supervisor initialization result", {
          error: error instanceof Error ? error.message : String(error),
          supervisorId: supervisor?.id,
          hasMergedConfig: !!mergedConfig,
        });
        throw error;
      }
    }),
  },
}).createMachine({
  id: "workspaceRuntime",
  initial: "uninitialized",
  context: ({ input }) => ({
    workspace: input.workspace,
    config: input.config,
    options: input.options,
    sessions: input.sessions,
    sessionCount: input.sessionCount,
    workerManager: input.workerManager,
    runtime: input.runtime,
    supervisorId: undefined,
    error: undefined,
    activeStreamSignals: new Map(),
    isShuttingDown: false,
    mergedConfig: undefined,
  }),
  states: {
    uninitialized: {
      on: {
        INITIALIZE: {
          target: "initializing",
        },
        SHUTDOWN: {
          target: "draining",
        },
      },
    },
    initializing: {
      entry: () => {
        logger.debug("Entering initializing state");
      },
      invoke: {
        id: "initializeSupervisor",
        src: "initializeSupervisor",
        input: ({ context }) => ({ context }),
        onDone: {
          target: "initializingStreams",
          actions: [
            ({ event }) => {
              logger.debug("Supervisor initialization completed, assigning context", {
                supervisorId: event.output.supervisorId,
                hasMergedConfig: !!event.output.mergedConfig,
              });
            },
            assign({
              supervisorId: ({ event }) => {
                try {
                  logger.debug("Assigning supervisorId", {
                    supervisorId: event.output.supervisorId,
                  });
                  return event.output.supervisorId;
                } catch (error) {
                  logger.error("Error assigning supervisorId", {
                    error: error instanceof Error ? error.message : String(error),
                  });
                  throw error;
                }
              },
              mergedConfig: ({ event }) => {
                try {
                  logger.debug("Assigning mergedConfig", {
                    hasMergedConfig: !!event.output.mergedConfig,
                  });
                  return event.output.mergedConfig;
                } catch (error) {
                  logger.error("Error assigning mergedConfig", {
                    error: error instanceof Error ? error.message : String(error),
                  });
                  throw error;
                }
              },
            }),
          ],
        },
        onError: {
          target: "uninitialized",
          actions: [
            ({ event }) => {
              const error = event.error instanceof Error
                ? event.error
                : new Error(String(event.error));
              logger.error("Runtime FSM initialization error", {
                error: error.message,
                stack: error.stack,
              });
            },
            assign({
              error: ({ event }) => event.error as Error,
            }),
          ],
        },
      },
      on: {
        SHUTDOWN: {
          target: "draining",
          actions: [
            assign({
              isShuttingDown: () => true,
            }),
          ],
        },
      },
    },
    initializingStreams: {
      entry: () => {
        logger.debug("Entering initializingStreams state");
      },
      invoke: {
        id: "initializeStreamSignals",
        src: "initializeStreamSignals",
        input: ({ context }) => ({ context }),
        onDone: {
          target: "ready",
          actions: [
            assign({
              activeStreamSignals: ({ event }) => event.output.activeStreamSignals,
            }),
            ({ context }) =>
              logger.info("Workspace ready with stream signals", {
                workspaceId: context.workspace.id,
                activeStreams: context.activeStreamSignals?.size || 0,
              }),
          ],
        },
        onError: {
          target: "ready",
          actions: [
            ({ event }) =>
              logger.error("Stream signal initialization failed", { error: event.error }),
            assign({
              error: ({ event }) => event.error as Error,
              activeStreamSignals: () => new Map(),
            }),
          ],
        },
      },
      on: {
        SHUTDOWN: {
          target: "draining",
          actions: [
            assign({
              isShuttingDown: () => true,
            }),
          ],
        },
      },
    },
    ready: {
      on: {
        PROCESS_SIGNAL: {
          target: "processing",
        },
        SESSION_CREATED: {
          actions: [
            assign({
              sessionCount: ({ context }) => context.sessionCount + 1,
            }),
          ],
        },
        SHUTDOWN: {
          target: "draining",
          actions: [
            assign({
              isShuttingDown: () => true,
            }),
          ],
        },
      },
    },
    processing: {
      on: {
        PROCESS_SIGNAL: {
          // Can process multiple signals concurrently
          target: "processing",
        },
        SESSION_CREATED: {
          actions: [
            assign({
              sessionCount: ({ context }) => context.sessionCount + 1,
            }),
          ],
        },
        SESSION_COMPLETE: [
          {
            // If no more sessions, go back to ready
            target: "ready",
            guard: ({ context }) => {
              // Optimized: Use sessionCount property instead of calculating
              return context.sessionCount <= 1; // Will be 0 after deletion
            },
            actions: [
              assign({
                sessions: ({ context, event }) => {
                  const newSessions = new Map(context.sessions);
                  newSessions.delete(event.sessionId);
                  return newSessions;
                },
                sessionCount: ({ context }) => Math.max(0, context.sessionCount - 1),
              }),
              ({ context, event }) => {
                // Return session worker to pool for reuse (major performance optimization)
                const session = context.sessions.get(event.sessionId);
                if (session && (session as any).workerId) {
                  context.workerManager.returnWorkerToPool((session as any).workerId);
                }
              },
            ],
          },
          {
            // Otherwise stay in processing
            target: "processing",
            actions: [
              assign({
                sessions: ({ context, event }) => {
                  const newSessions = new Map(context.sessions);
                  newSessions.delete(event.sessionId);
                  return newSessions;
                },
                sessionCount: ({ context }) => Math.max(0, context.sessionCount - 1),
              }),
              ({ context, event }) => {
                // Return session worker to pool for reuse (major performance optimization)
                const session = context.sessions.get(event.sessionId);
                if (session && (session as any).workerId) {
                  context.workerManager.returnWorkerToPool((session as any).workerId);
                }
              },
            ],
          },
        ],
        SHUTDOWN: {
          target: "draining",
          actions: [
            assign({
              isShuttingDown: () => true,
            }),
          ],
        },
        ERROR: {
          target: "ready",
          actions: assign({
            error: ({ event }) => event.error,
          }),
        },
      },
    },
    draining: {
      invoke: {
        src: fromPromise(async ({ input }: {
          input: {
            workspace: any;
            sessions: Map<string, any>;
            activeStreamSignals?: Map<string, any>;
          };
        }) => {
          logger.info("Draining workspace - cleaning up streams and sessions", {
            workspaceId: input.workspace.id,
            sessionCount: input.sessions.size,
            streamCount: input.activeStreamSignals?.size || 0,
          });

          // First, cleanup stream signals to stop new events
          if (input.activeStreamSignals) {
            for (const [signalId, runtimeSignal] of input.activeStreamSignals) {
              try {
                logger.info(`Cleaning up stream signal: ${signalId}`);
                await runtimeSignal.teardown();
                logger.info(`Stream signal cleaned up: ${signalId}`);
              } catch (error) {
                logger.error(`Failed to cleanup stream signal: ${signalId}`, { error });
              }
            }
          }

          // Then cancel all active sessions
          for (const [sessionId, session] of input.sessions) {
            logger.debug("Cancelling session", {
              workspaceId: input.workspace.id,
              sessionId,
            });
            try {
              await session.cancel();
            } catch (error) {
              logger.error(`Failed to cancel session: ${sessionId}`, { error });
            }
          }

          return { drained: true };
        }),
        input: ({ context }) => ({
          workspace: context.workspace,
          sessions: context.sessions,
          activeStreamSignals: context.activeStreamSignals,
        }),
        onDone: {
          target: "terminating",
          actions: assign({
            sessions: () => new Map(),
            activeStreamSignals: () => new Map(),
          }),
        },
        onError: {
          target: "terminating",
          actions: [
            assign({
              sessions: () => new Map(),
              activeStreamSignals: () => new Map(),
            }),
            ({ event }) => {
              logger.error("Draining workspace failed", {
                error: event.error instanceof Error ? event.error.message : String(event.error),
              });
            },
          ],
        },
      },
      after: {
        30000: { // 30 second timeout for draining
          target: "terminating",
          actions: [
            assign({
              sessions: () => new Map(),
              activeStreamSignals: () => new Map(),
            }),
            () => {
              logger.warn("Draining workspace timeout exceeded, forcing termination");
            },
          ],
        },
      },
      on: {
        SESSION_COMPLETE: [
          {
            // If this was the last session, terminate
            target: "terminating",
            guard: ({ context }) => {
              // Optimized: Use sessionCount property instead of calculating
              return context.sessionCount <= 1; // Will be 0 after deletion
            },
            actions: assign({
              sessions: ({ context, event }) => {
                const newSessions = new Map(context.sessions);
                newSessions.delete(event.sessionId);
                return newSessions;
              },
              sessionCount: ({ context }) => Math.max(0, context.sessionCount - 1),
            }),
          },
          {
            // Otherwise stay in draining
            target: "draining",
            actions: assign({
              sessions: ({ context, event }) => {
                const newSessions = new Map(context.sessions);
                newSessions.delete(event.sessionId);
                return newSessions;
              },
              sessionCount: ({ context }) => Math.max(0, context.sessionCount - 1),
            }),
          },
        ],
      },
    },
    terminating: {
      invoke: {
        src: fromPromise(async ({ input }: {
          input: {
            workspace: any;
            workerManager: any;
          };
        }) => {
          logger.info("Terminating workspace - shutting down worker manager", {
            workspaceId: input.workspace.id,
          });

          try {
            // Shutdown worker manager (streams already cleaned up in draining)
            await input.workerManager.shutdown();

            logger.info("Workspace shutdown complete", {
              workspaceId: input.workspace.id,
              finalState: "terminated",
            });

            return { terminated: true };
          } catch (error) {
            logger.error("Worker manager shutdown failed", {
              workspaceId: input.workspace.id,
              error: error instanceof Error ? error.message : String(error),
            });
            // Still consider it terminated even if shutdown failed
            return { terminated: true };
          }
        }),
        input: ({ context }) => ({
          workspace: context.workspace,
          workerManager: context.workerManager,
        }),
        onDone: {
          target: "terminated",
        },
        onError: {
          target: "terminated",
          actions: ({ event }) => {
            logger.error("Workspace termination failed", {
              error: event.error instanceof Error ? event.error.message : String(event.error),
            });
          },
        },
      },
      after: {
        10000: { // 10 second timeout for termination
          target: "terminated",
          actions: () => {
            logger.warn("Workspace termination timeout exceeded, forcing final state");
          },
        },
      },
    },
    terminated: {
      type: "final",
    },
  },
});
