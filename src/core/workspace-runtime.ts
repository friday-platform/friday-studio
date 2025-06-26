import { type Actor, assign, createActor, fromPromise, setup } from "xstate";
import type { IWorkspace, IWorkspaceSession, IWorkspaceSignal } from "../types/core.ts";
import { logger } from "../utils/logger.ts";
import { AtlasTelemetry } from "../utils/telemetry.ts";
import { Session } from "./session.ts";
import { WorkerManager } from "./utils/worker-manager.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { type ISignalProvider, ProviderType } from "./providers/types.ts";
import { AtlasLibrary } from "./library/atlas-library.ts";

export interface WorkspaceRuntimeOptions {
  lazy?: boolean;
  supervisorModel?: string;
  workspacePath?: string; // For daemon mode - path to workspace directory
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
  | { type: "SESSION_COMPLETE"; sessionId: string }
  | { type: "SHUTDOWN" }
  | { type: "ERROR"; error: Error };

// Define the machine input
interface WorkspaceRuntimeMachineInput {
  workspace: IWorkspace;
  config?: any;
  options: WorkspaceRuntimeOptions;
  sessions: Map<string, IWorkspaceSession>;
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
  private library?: AtlasLibrary;

  constructor(
    workspace: IWorkspace,
    config?: any,
    options: WorkspaceRuntimeOptions = {},
  ) {
    this.workspace = workspace;
    this.config = config;
    this.options = options;
    this.workerManager = new WorkerManager();

    // Set up message handler for session completion
    this.setupMessageHandlers();

    // Library will be initialized lazily

    // Agent loading will happen during initialization

    // Create and start the state machine
    this.stateMachine = createActor(workspaceRuntimeMachine, {
      input: {
        workspace,
        config,
        options,
        sessions: new Map(),
        workerManager: this.workerManager,
        runtime: this, // Pass runtime instance for signal processing
      },
    });

    // Add a unique ID to track this FSM instance
    const fsmId = crypto.randomUUID().slice(0, 8);

    // Subscribe to state changes for debugging
    this.stateMachine.subscribe((state) => {
      logger.info(`Runtime FSM [${fsmId}] state change: ${state.value}`, {
        workspaceId: workspace.id,
        fsmId,
        state: state.value,
      });
    });

    this.stateMachine.start();

    // Initialize supervisor if not lazy
    if (!options.lazy) {
      logger.info("Sending INITIALIZE event (not lazy)", {
        workspaceId: workspace.id,
      });
      this.stateMachine.send({ type: "INITIALIZE" });
    }
  }

  /**
   * Set up message handlers for worker communication
   */
  private setupMessageHandlers(): void {
    // Set up global message handler for worker messages
    this.workerManager.setGlobalMessageHandler(async (workerId: string, message: any) => {
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
      const library = this.getLibrary();
      if (!library || !result) {
        logger.warn("Cannot store session results - library not available or no result", {
          workspaceId: this.workspace.id,
          sessionId,
          hasLibrary: !!library,
          hasResult: !!result,
        });
        return;
      }

      logger.info("Storing session results in library", {
        workspaceId: this.workspace.id,
        sessionId,
        resultStatus: result.status,
        hasFinalOutput: !!result.final_output,
        finalOutputType: typeof result.final_output,
        hasFinalOutputResult: !!result.final_output?.result,
        resultKeys: Object.keys(result || {}),
        timingKeys: result.timing ? Object.keys(result.timing) : null,
        finalOutputKeys: result.final_output ? Object.keys(result.final_output) : null,
        agentExecutionsCount: result.timing?.agent_executions?.length,
        totalDuration: result.timing?.total_duration,
        totalAgentsInvoked: result.total_agents_invoked,
      });

      // Extract session data for library storage
      const sessionData = {
        session_id: sessionId,
        workspace_name: this.workspace.id,
        start_time: new Date(Date.now() - (result.timing?.total_duration || 0)).toISOString(),
        end_time: new Date().toISOString(),
        agents_used: result.timing?.agent_executions?.map((exec: any) => ({
          id: exec.agent,
          type: "llm",
          purpose: `Agent execution in session ${sessionId}`,
        })) || [],
        artifacts: [],
        outcomes: [{
          type: "session_completion",
          data: result.final_output,
          agent_count: result.timing?.agent_executions?.length || 0,
          total_duration: result.timing?.total_duration || 0,
        }],
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

      // Store session archive in library
      const archiveId = await library.archiveSession(sessionData);

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

        const reportId = await library.store({
          type: "report",
          name: `Analysis Report - ${sessionId.slice(0, 8)}`,
          content: result.final_output.result,
          format: "markdown",
          source: "agent",
          tags: ["session-report", "analysis", "automated"],
          description: `Generated analysis report from session ${sessionId}`,
          metadata: {
            session_id: sessionId,
            agent_type: result.final_output.agent_type,
            agent_id: result.final_output.agent_id,
            model: result.final_output.model,
            generation_time: new Date().toISOString(),
          },
          session_id: sessionId,
          agent_ids: result.timing?.agent_executions?.map((exec: any) => exec.agent) || [],
        });

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
        const sessionId = crypto.randomUUID();

        // Create session
        const session = new Session(this.workspace.id, {
          triggers: [signal],
          // deno-lint-ignore require-await
          callback: async (result) => {
            logger.info(`Session completed`, {
              workspaceId: this.workspace.id,
              sessionId,
              result,
            });
          },
        });

        // Override session ID
        (session as any).id = sessionId;

        // Store session
        this.sessions.set(sessionId, session);

        // Send event to state machine
        this.stateMachine.send({ type: "PROCESS_SIGNAL", signal, payload });

        // Create trace headers for supervisor communication
        const traceHeaders = await AtlasTelemetry.createTraceHeaders();

        // Send task to supervisor for processing
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
   * Get the library instance for this workspace
   */
  getLibrary(): AtlasLibrary | undefined {
    if (!this.library) {
      // Initialize library synchronously on first access
      try {
        const workspacePath = Deno.cwd();

        // Validate that we have a proper workspace path
        if (!workspacePath || typeof workspacePath !== "string") {
          logger.error("Invalid workspace path", {
            workspaceId: this.workspace.id,
            workspacePath: typeof workspacePath,
            cwd: Deno.cwd(),
          });
          return undefined;
        }

        const config = {
          platform_path: "~/.atlas/library",
          workspace_relative: ".atlas/library",
        };

        this.library = new AtlasLibrary(
          config,
          workspacePath,
          this.workspace.id,
        );

        // Initialize asynchronously but don't wait
        this.library.initialize().catch((error) => {
          logger.error("Failed to initialize library", {
            workspaceId: this.workspace.id,
            error,
          });
        });

        logger.info("Library created (initializing in background)", {
          workspaceId: this.workspace.id,
          workspacePath,
        });
      } catch (error) {
        logger.error("Failed to create library", {
          workspaceId: this.workspace.id,
          error,
        });
        return undefined;
      }
    }
    return this.library;
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

              // Always log the error details for debugging
              console.error(`❌ K8s Events Signal Error:`, errorMessage);
              logger.error(`Failed to initialize stream signal: ${signalId}`, {
                error: errorMessage,
                provider: signalConfig.provider,
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

      // Load merged configuration (atlas.yml + workspace.yml)
      const { ConfigLoader } = await import("./config-loader.ts");
      const configLoader = new ConfigLoader();
      const mergedConfig = await configLoader.load();

      // Memory configuration is already loaded in mergedConfig.atlas

      // Load all agents (platform + user)
      const allAgents: Record<string, RuntimeAgentConfig> = {
        ...mergedConfig.atlas.agents,
        ...mergedConfig.workspace.agents,
      };

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
          agents: (
            await import("./agent-loader.ts")
          ).AgentLoader.serializeAgentMetadata(context.workspace.agents || {}),
          signals: Object.keys(context.workspace.signals || {}),
          workflows: Object.keys(context.workspace.workflows || {}),
        },
        // Add memory configuration at top level for WorkspaceSupervisor
        memoryConfig: mergedConfig.atlas.memory,
        config: {
          ...(context.config?.supervisor || {}),
          // Pass only serializable parts of the merged configuration
          workspaceSignals: mergedConfig.workspace.signals,
          workspaceTools: mergedConfig.workspace.tools,
          jobs: mergedConfig.jobs,
          supervisorDefaults: mergedConfig.supervisorDefaults, // Pass supervisor defaults to workers
        },
      };

      let supervisor;
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

      console.log(
        "[Runtime FSM] Supervisor ready, returning ID:",
        supervisor.id,
      );
      return { supervisorId: supervisor.id, mergedConfig };
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
          target: "terminated",
        },
      },
    },
    initializing: {
      invoke: {
        id: "initializeSupervisor",
        src: "initializeSupervisor",
        input: ({ context }) => ({ context }),
        onDone: {
          target: "initializingStreams",
          actions: [
            assign({
              supervisorId: ({ event }) => event.output.supervisorId,
              mergedConfig: ({ event }) => event.output.mergedConfig,
            }),
          ],
        },
        onError: {
          target: "uninitialized",
          actions: [
            ({ event }) => console.error("[Runtime FSM] Initialization error:", event.error),
            assign({
              error: ({ event }) => event.error as Error,
            }),
          ],
        },
      },
      on: {
        SHUTDOWN: {
          target: "terminated",
          actions: [
            assign({
              isShuttingDown: () => true,
            }),
          ],
        },
      },
    },
    initializingStreams: {
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
        SESSION_COMPLETE: [
          {
            // If no more sessions, go back to ready
            target: "ready",
            guard: ({ context, event }) => {
              // Check if this would be the last session
              let sessionCount = context.sessions.size;
              if (context.sessions.has(event.sessionId)) {
                sessionCount--;
              }
              return sessionCount === 0;
            },
            actions: [
              assign({
                sessions: ({ context, event }) => {
                  const newSessions = new Map(context.sessions);
                  newSessions.delete(event.sessionId);
                  return newSessions;
                },
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
      entry: async ({ context }) => {
        logger.info("Draining workspace - cleaning up streams and sessions", {
          workspaceId: context.workspace.id,
          sessionCount: context.sessions.size,
          streamCount: context.activeStreamSignals?.size || 0,
        });

        // First, cleanup stream signals to stop new events
        if (context.activeStreamSignals) {
          for (const [signalId, runtimeSignal] of context.activeStreamSignals) {
            try {
              logger.info(`Cleaning up stream signal: ${signalId}`);
              await runtimeSignal.teardown();
              logger.info(`Stream signal cleaned up: ${signalId}`);
            } catch (error) {
              logger.error(`Failed to cleanup stream signal: ${signalId}`, { error });
            }
          }
          context.activeStreamSignals.clear();
        }

        // Then cancel all active sessions
        for (const [sessionId, session] of context.sessions) {
          logger.debug("Cancelling session", {
            workspaceId: context.workspace.id,
            sessionId,
          });
          await session.cancel();
        }

        // Clear sessions
        context.sessions.clear();
      },
      always: [
        {
          // If no sessions, proceed to terminated
          target: "terminated",
          guard: ({ context }) => context.sessions.size === 0,
        },
      ],
      on: {
        SESSION_COMPLETE: [
          {
            // If this was the last session, terminate
            target: "terminated",
            guard: ({ context, event }) => {
              // Check if this would be the last session
              let sessionCount = context.sessions.size;
              if (context.sessions.has(event.sessionId)) {
                sessionCount--;
              }
              return sessionCount === 0;
            },
            actions: assign({
              sessions: ({ context, event }) => {
                const newSessions = new Map(context.sessions);
                newSessions.delete(event.sessionId);
                return newSessions;
              },
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
            }),
          },
        ],
      },
    },
    terminated: {
      type: "final",
      entry: async ({ context }) => {
        logger.info("Terminating workspace - shutting down worker manager", {
          workspaceId: context.workspace.id,
        });

        // Shutdown worker manager (streams already cleaned up in draining)
        await context.workerManager.shutdown();

        logger.info("Workspace shutdown complete", {
          workspaceId: context.workspace.id,
          finalState: "terminated",
        });
      },
    },
  },
});
