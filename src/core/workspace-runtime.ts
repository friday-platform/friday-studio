/**
 * WorkspaceRuntime v2 - Actor-based implementation
 * Replaces worker-based orchestration with direct actor management
 */

import type { MergedConfig, WorkspaceSignalConfig } from "@atlas/config";
import type { AgentOrchestrator, GlobalMCPServerPool } from "@atlas/core";
import { logger } from "@atlas/logger";
import { type ActorRefFrom, createActor } from "xstate";
import type { IWorkspace, IWorkspaceSession, IWorkspaceSignal } from "../types/core.ts";
import { AtlasTelemetry } from "../utils/telemetry.ts";
import type { LibraryStorageAdapter } from "./storage/library-storage-adapter.ts";
import {
  createWorkspaceRuntimeMachine,
  type WorkspaceRuntimeMachineInput,
} from "./workspace-runtime-machine.ts";

export interface WorkspaceRuntimeOptions {
  lazy?: boolean;
  supervisorModel?: string;
  workspacePath?: string;
  libraryStorage?: LibraryStorageAdapter;
  mcpServerPool?: GlobalMCPServerPool;
  daemonUrl?: string;
  onSessionFinished?: (data: {
    workspaceId: string;
    sessionId: string;
    status: "completed" | "failed";
    finishedAt: string;
    summary?: string;
  }) => void | Promise<void>;
}

/**
 * WorkspaceRuntime orchestrates the execution of a workspace using actors.
 * It manages supervisor actors, sessions, and signal processing.
 */
export class WorkspaceRuntime {
  private workspace: IWorkspace;
  private config?: MergedConfig;
  private stateMachine: ActorRefFrom<ReturnType<typeof createWorkspaceRuntimeMachine>>;
  private fsmId: string;

  constructor(workspace: IWorkspace, config: MergedConfig, options: WorkspaceRuntimeOptions = {}) {
    this.workspace = workspace;
    this.config = config;

    // Create unique FSM instance ID for monitoring
    this.fsmId = crypto.randomUUID().slice(0, 8);

    // Create machine input
    const machineInput: WorkspaceRuntimeMachineInput = {
      workspace,
      config,
      workspacePath: options.workspacePath,
      libraryStorage: options.libraryStorage,
      mcpServerPool: options.mcpServerPool,
      daemonUrl: options.daemonUrl,
      onSessionFinished: options.onSessionFinished,
    };

    // Create and start the state machine
    const machine = createWorkspaceRuntimeMachine(machineInput);

    this.stateMachine = createActor(machine, { input: machineInput });

    // Subscribe to state changes for debugging
    this.stateMachine.subscribe((state) => {
      logger.debug("Runtime state changed", {
        workspaceId: workspace.id,
        fsmId: this.fsmId,
        state: state.value,
        activeSessions: state.context.stats.activeSessionCount,
      });
    });

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
   * Get current state
   */
  getState(): string {
    const state = this.stateMachine.getSnapshot();
    return typeof state.value === "string" ? state.value : JSON.stringify(state.value);
  }

  get workspaceId(): string {
    return this.workspace.id;
  }

  /**
   * Process a signal and create a session
   */
  async processSignal(
    signal: {
      id: string;
      name?: string;
      provider?: { id: string; name: string };
      [key: string]: unknown;
    },
    payload: Record<string, unknown>,
    _sessionId?: string,
    streamId?: string,
  ): Promise<IWorkspaceSession> {
    return await AtlasTelemetry.withServerSpan(
      "workspace.processSignal",
      async (span) => {
        // Add workspace and signal attributes
        AtlasTelemetry.addComponentAttributes(span, "workspace", { id: this.workspace.id });
        AtlasTelemetry.addComponentAttributes(span, "signal", {
          id: signal.id,
          type: signal.provider?.name || signal.provider?.id || "unknown",
        });

        const state = this.stateMachine.getSnapshot();

        // Check if shutting down - reject immediately
        if (state.context.isShuttingDown) {
          throw new Error("Cannot process signal: workspace is shutting down");
        }

        // Check if we're in a valid state to process signals
        if (state.value !== "ready") {
          // If uninitialized, initialize first
          if (state.value === "uninitialized") {
            logger.info("Workspace uninitialized, starting initialization", {
              workspaceId: this.workspace.id,
              currentState: state.value,
            });

            this.stateMachine.send({ type: "INITIALIZE" });
            // Wait for ready state
            await this.waitForState(["ready"]);

            // Get fresh state after initialization completes
            const freshState = this.stateMachine.getSnapshot();
            logger.info("Fresh state after initialization", {
              workspaceId: this.workspace.id,
              state: freshState.value,
              hasSupervisor: !!freshState.context.supervisor,
              supervisorId: freshState.context.supervisor?.id,
              contextKeys: Object.keys(freshState.context),
            });

            if (freshState.value !== "ready") {
              throw new Error(
                `Failed to initialize workspace: expected 'ready' but got '${freshState.value}'`,
              );
            }

            // Verify supervisor is initialized
            if (!freshState.context.supervisor) {
              logger.error("Supervisor not found in context", {
                workspaceId: this.workspace.id,
                contextKeys: Object.keys(freshState.context),
                hasWorkspace: !!freshState.context.workspace,
                hasConfig: !!freshState.context.config,
                hasOptions: !!freshState.context.options,
              });
              throw new Error("Workspace reached ready state but supervisor is not initialized");
            }

            logger.info("Workspace initialization complete", {
              workspaceId: this.workspace.id,
              newState: freshState.value,
              hasSupervisor: !!freshState.context.supervisor,
            });
          } else {
            throw new Error(`Cannot process signal in state: ${state.value}`);
          }
        }

        logger.info(`Processing signal: ${signal.id}`, {
          workspaceId: this.workspace.id,
          signalId: signal.id,
        });

        // Use session ID from payload (for conversation continuity), otherwise generate new one
        const sessionId =
          (typeof payload?.sessionId === "string" ? payload.sessionId : null) ||
          crypto.randomUUID();

        // Create trace headers for supervisor communication
        const traceHeaders = await AtlasTelemetry.createTraceHeaders();

        // Send event to state machine for processing
        // The state machine will create and manage the session
        this.stateMachine.send({
          type: "PROCESS_SIGNAL",
          signal: { ...signal, provider: signal.provider || { id: "unknown", name: "unknown" } }, // Ensure provider field is present
          payload,
          sessionId,
          streamId,
          traceHeaders,
        });

        // Wait for the session to be created by the state machine
        // We need to give it time to process the event
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Get the session from the state machine's context
        const currentState = this.stateMachine.getSnapshot();
        const session = currentState.context.sessions.get(sessionId);

        if (!session) {
          // If session not found yet, wait a bit more
          await new Promise((resolve) => setTimeout(resolve, 100));
          const retryState = this.stateMachine.getSnapshot();
          const retrySession = retryState.context.sessions.get(sessionId);

          if (!retrySession) {
            throw new Error(`Session ${sessionId} was not created by state machine`);
          }

          return retrySession;
        }

        return session;
      },
      { "workspace.state": this.getState(), "signal.payload.size": JSON.stringify(payload).length },
    );
  }

  /**
   * Wait for specific states
   */
  private waitForState(targetStates: string[], timeout = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Timeout waiting for states: ${targetStates.join(", ")}`));
      }, timeout);

      const checkState = () => {
        const state = this.stateMachine.getSnapshot();
        if (targetStates.includes(state.value)) {
          clearTimeout(timeoutId);
          resolve();
        }
      };

      // Subscribe to state changes
      const subscription = this.stateMachine.subscribe((state) => {
        if (targetStates.includes(state.value)) {
          clearTimeout(timeoutId);
          subscription.unsubscribe();
          resolve();
        }
      });

      // Check immediately after subscribing
      checkState();
    });
  }

  /**
   * Get runtime status
   */
  getStatus(): {
    workspace: string;
    supervisor: boolean;
    sessions: number;
    state: string;
    stats: {
      totalSignalsProcessed: number;
      totalSessionsCreated: number;
      activeSessionCount: number;
    };
  } {
    const currentState = this.stateMachine.getSnapshot();

    return {
      workspace: this.workspace.id,
      supervisor: !!currentState.context.supervisor,
      sessions: currentState.context.sessions.size,
      state: this.getState(),
      stats: currentState.context.stats,
    };
  }

  /**
   * Get the agent orchestrator for this workspace
   */
  getAgentOrchestrator(): AgentOrchestrator {
    const state = this.stateMachine.getSnapshot();
    if (!state.context.agentOrchestrator) {
      throw new Error("Agent orchestrator not initialized");
    }
    return state.context.agentOrchestrator;
  }

  /**
   * Get all active sessions
   */
  getSessions(): IWorkspaceSession[] {
    // Get sessions from state machine context (source of truth)
    const state = this.stateMachine.getSnapshot();
    return Array.from(state.context.sessions.values());
  }

  /**
   * Get a specific session
   */
  getSession(sessionId: string): IWorkspaceSession | undefined {
    // Get session from state machine context (source of truth)
    const state = this.stateMachine.getSnapshot();
    return state.context.sessions.get(sessionId);
  }

  /**
   * Cancel a session
   */
  async cancelSession(sessionId: string): Promise<void> {
    const state = this.stateMachine.getSnapshot();
    const session = state.context.sessions.get(sessionId);
    if (session) {
      await session.cancel();

      // Notify state machine
      this.stateMachine.send({ type: "SESSION_COMPLETED", sessionId });
    }
  }

  /**
   * Save state checkpoint
   */
  saveStateCheckpoint(): void {
    logger.info("Saving state checkpoint", { workspaceId: this.workspace.id });

    const snapshot = this.stateMachine.getSnapshot();
    const state = {
      workspace: this.workspace.snapshot(),
      sessions: Array.from(snapshot.context.sessions.entries()).map(([id, session]) => ({
        id,
        status: session.status,
        summary: session.summarize(),
      })),
      timestamp: new Date().toISOString(),
      stats: snapshot.context.stats,
    };

    // TODO: Implement actual persistence
    logger.debug("State checkpoint saved", { workspaceId: this.workspace.id, checkpoint: state });
  }

  /**
   * List all jobs in the workspace
   */
  listJobs(): Array<{ name: string; description?: string }> {
    const jobs = this.config?.workspace?.jobs || {};
    return Object.entries(jobs).map(([name, config]) => ({
      name,
      description: config?.description,
    }));
  }

  /**
   * Trigger a job in the workspace
   */
  async triggerJob(
    jobName: string,
    payload?: Record<string, unknown>,
  ): Promise<{ sessionId: string }> {
    const jobs = this.config?.workspace?.jobs || {};
    if (!jobs[jobName]) {
      throw new Error(`Job '${jobName}' not found`);
    }

    // Find signal that triggers this job
    const signals = this.config?.workspace?.signals || {};
    for (const [signalName, signalConfig] of Object.entries(signals)) {
      const jobConfig = jobs[jobName];
      const triggers = jobConfig?.triggers || [];
      const hasMatchingTrigger = triggers.some((trigger) => trigger.signal === signalName);

      if (hasMatchingTrigger) {
        const signal = { id: signalName, name: signalName, ...signalConfig };
        const result = await this.processSignal(signal, payload || {});
        return { sessionId: result.id || crypto.randomUUID() };
      }
    }

    throw new Error(`No signal found that triggers job '${jobName}'`);
  }

  /**
   * Get detailed information about a job
   */
  describeJob(jobName: string): Record<string, unknown> {
    const jobs = this.config?.workspace?.jobs || {};
    if (!jobs[jobName]) {
      throw new Error(`Job '${jobName}' not found`);
    }
    return jobs[jobName];
  }

  /**
   * List all sessions in the workspace
   */
  listSessions(): Array<{ id: string; status: string; startedAt: string }> {
    const state = this.stateMachine.getSnapshot();
    return Array.from(state.context.sessions.entries()).map(([id, session]) => ({
      id,
      status: session.status,
      startedAt: new Date().toISOString(), // Use current time as fallback
    }));
  }

  /**
   * Get detailed information about a session
   */
  describeSession(sessionId: string): Record<string, unknown> {
    const session = this.getSession(sessionId);
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
  listSignals(): Record<string, WorkspaceSignalConfig> {
    return this.config?.workspace?.signals || {};
  }

  /**
   * Trigger a signal in the workspace
   */
  async triggerSignal(signalName: string, payload?: Record<string, unknown>): Promise<void> {
    await this.triggerSignalWithSession(signalName, payload);
    // Original method returns void, discarding session
  }

  /**
   * Trigger a signal in the workspace and return the session
   */
  async triggerSignalWithSession(
    signalName: string,
    payload?: Record<string, unknown>,
    streamId?: string,
  ): Promise<IWorkspaceSession> {
    const signals = this.config?.workspace?.signals || {};
    const signalConfig = signals[signalName];
    if (!signalConfig) {
      throw new Error(`Signal '${signalName}' not found`);
    }
    const signal = { id: signalName, name: signalName, ...signalConfig };
    return await this.processSignal(signal, payload || {}, undefined, streamId);
  }

  /**
   * List all agents in the workspace
   */
  listAgents(): Array<{ id: string; type: string; purpose?: string }> {
    const agents = this.config?.workspace?.agents || {};
    return Object.entries(agents).map(([id, config]) => ({
      id,
      type: config?.type || "unknown",
      purpose: config?.purpose,
    }));
  }

  /**
   * Get detailed information about an agent
   */
  describeAgent(agentId: string): Record<string, unknown> {
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

    logger.info("Manually initializing runtime", { workspaceId: this.workspace.id });

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
    if (state.value === "shuttingDown" || state.value === "terminated") {
      logger.warn("Already shutting down or terminated", { workspaceId: this.workspace.id });
      return;
    }

    // Send shutdown event
    this.stateMachine.send({ type: "SHUTDOWN" });

    // Wait for terminated state
    await this.waitForState(["terminated"]);
  }

  /**
   * Get worker information (for compatibility)
   * In the actor-based model, we don't have workers
   */
  getWorkers(): Array<Record<string, unknown>> {
    const state = this.stateMachine.getSnapshot();
    const workers = [];

    if (state.context.supervisor) {
      workers.push({
        id: `supervisor-${this.workspace.id}`,
        type: "supervisor",
        state: "ready",
        metadata: { workspaceId: this.workspace.id },
      });
    }

    // Add session "workers" (now actors)
    for (const [sessionId, session] of state.context.sessions) {
      workers.push({
        id: sessionId,
        type: "session",
        state: session.status,
        metadata: { workspaceId: this.workspace.id },
      });
    }

    return workers;
  }
}
