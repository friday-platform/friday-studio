/**
 * WorkspaceRuntime v2 - Actor-based implementation
 * Replaces worker-based orchestration with direct actor management
 */

import { type Actor, createActor } from "xstate";
import type { IWorkspace, IWorkspaceSession, IWorkspaceSignal } from "../types/core.ts";
import { logger } from "../utils/logger.ts";
import { AtlasTelemetry } from "../utils/telemetry.ts";
import { Session } from "./session.ts";
import type { LibraryStorageAdapter } from "./storage/library-storage-adapter.ts";
import { createWorkspaceRuntimeMachine } from "./workspace-runtime-machine.ts";

export interface WorkspaceRuntimeOptions {
  lazy?: boolean;
  supervisorModel?: string;
  workspacePath?: string;
  libraryStorage?: LibraryStorageAdapter;
}

/**
 * WorkspaceRuntime orchestrates the execution of a workspace using actors.
 * It manages supervisor actors, sessions, and signal processing.
 */
export class WorkspaceRuntime {
  private workspace: IWorkspace;
  private options: WorkspaceRuntimeOptions;
  private config?: Record<string, unknown>;
  private stateMachine: Actor<ReturnType<typeof createWorkspaceRuntimeMachine>>;
  private sessions: Map<string, IWorkspaceSession> = new Map();
  private fsmId: string;

  constructor(
    workspace: IWorkspace,
    config?: Record<string, unknown>,
    options: WorkspaceRuntimeOptions = {},
  ) {
    this.workspace = workspace;
    this.config = config;
    this.options = options;

    // Create unique FSM instance ID for monitoring
    this.fsmId = crypto.randomUUID().slice(0, 8);

    // Create and start the state machine
    const machine = createWorkspaceRuntimeMachine({
      workspace,
      config,
      workspacePath: options.workspacePath,
      libraryStorage: options.libraryStorage,
    });

    this.stateMachine = createActor(machine);

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

  /**
   * Process a signal and create a session
   */
  async processSignal(
    signal: IWorkspaceSignal,
    payload: Record<string, unknown>,
  ): Promise<IWorkspaceSession> {
    return await AtlasTelemetry.withServerSpan(
      "workspace.processSignal",
      async (span) => {
        // Add workspace and signal attributes
        AtlasTelemetry.addComponentAttributes(span, "workspace", {
          id: this.workspace.id,
        });
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
            this.stateMachine.send({ type: "INITIALIZE" });
            // Wait for ready state
            await this.waitForState(["ready"]);
          } else {
            throw new Error(`Cannot process signal in state: ${state.value}`);
          }
        }

        logger.info(`Processing signal: ${signal.id}`, {
          workspaceId: this.workspace.id,
          signalId: signal.id,
        });

        // Use session ID from payload (for conversation continuity), otherwise generate new one
        const sessionId = payload?.sessionId || crypto.randomUUID();

        // Create session
        const session = new Session(
          this.workspace.id,
          {
            triggers: [signal],
            // deno-lint-ignore require-await
            callback: async (result) => {
              logger.info(`Session completed`, {
                workspaceId: this.workspace.id,
                sessionId,
                result,
              });

              // Notify state machine about completion
              this.stateMachine.send({
                type: "SESSION_COMPLETED",
                sessionId,
                result,
              });
            },
          },
          undefined, // agents
          undefined, // workflows
          undefined, // sources
          undefined, // intent
          undefined, // storageAdapter
          true, // enableCognitiveLoop
        );

        // Override session ID
        // deno-lint-ignore no-explicit-any
        (session as any).id = sessionId;

        // Store session
        this.sessions.set(sessionId, session);
        logger.debug("Session stored", {
          sessionId,
          originalSessionId: session.id,
          sessionCount: this.sessions.size,
        });

        // Create trace headers for supervisor communication
        const traceHeaders = await AtlasTelemetry.createTraceHeaders();

        // Send event to state machine for processing
        this.stateMachine.send({
          type: "PROCESS_SIGNAL",
          signal,
          payload,
          sessionId,
          traceHeaders,
        });

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
  private waitForState(targetStates: string[], timeout = 30000): Promise<void> {
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
      sessions: this.sessions.size,
      state: this.getState(),
      stats: currentState.context.stats,
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
      this.stateMachine.send({ type: "SESSION_COMPLETED", sessionId });
    }
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
      timestamp: new Date().toISOString(),
      stats: this.stateMachine.getSnapshot().context.stats,
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
  listJobs(): Array<{ name: string; description?: string }> {
    const jobs = ((this.config?.workspace as Record<string, unknown>)?.jobs as Record<
      string,
      unknown
    >) || {};
    return Object.entries(jobs).map(([name, config]) => ({
      name,
      description: (config as Record<string, unknown>)?.description as
        | string
        | undefined,
    }));
  }

  /**
   * Trigger a job in the workspace
   */
  async triggerJob(
    jobName: string,
    payload?: Record<string, unknown>,
  ): Promise<{ sessionId: string }> {
    const jobs = ((this.config?.workspace as Record<string, unknown>)?.jobs as Record<
      string,
      unknown
    >) || {};
    if (!jobs[jobName]) {
      throw new Error(`Job '${jobName}' not found`);
    }

    // Find signal that triggers this job
    const signals = ((this.config?.workspace as Record<string, unknown>)?.signals as Record<
      string,
      unknown
    >) || {};
    for (const [signalName, signalConfig] of Object.entries(signals)) {
      const jobConfig = jobs[jobName];
      const triggers = ((jobConfig as Record<string, unknown>)?.triggers as Array<{
        signal: string;
      }>) || [];
      const hasMatchingTrigger = triggers.some(
        (trigger) => trigger.signal === signalName,
      );

      if (hasMatchingTrigger) {
        const signal = {
          id: signalName,
          name: signalName,
          ...(signalConfig as object),
        } as IWorkspaceSignal;
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
    const jobs = ((this.config?.workspace as Record<string, unknown>)?.jobs as Record<
      string,
      unknown
    >) || {};
    if (!jobs[jobName]) {
      throw new Error(`Job '${jobName}' not found`);
    }
    return jobs[jobName] as Record<string, unknown>;
  }

  /**
   * List all sessions in the workspace
   */
  listSessions(): Array<{ id: string; status: string; startedAt: string }> {
    return Array.from(this.sessions.entries()).map(([id, session]) => ({
      id,
      status: session.status,
      startedAt: new Date().toISOString(), // Use current time as fallback
    }));
  }

  /**
   * Get detailed information about a session
   */
  describeSession(sessionId: string): Record<string, unknown> {
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
  listSignals(): Array<{ name: string; description?: string }> {
    const signals = ((this.config?.workspace as Record<string, unknown>)?.signals as Record<
      string,
      unknown
    >) || {};
    return Object.entries(signals).map(([name, config]) => ({
      name,
      description: (config as Record<string, unknown>)?.description as
        | string
        | undefined,
    }));
  }

  /**
   * Trigger a signal in the workspace
   */
  async triggerSignal(
    signalName: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const signals = ((this.config?.workspace as Record<string, unknown>)?.signals as Record<
      string,
      unknown
    >) || {};
    const signalConfig = signals[signalName];
    if (!signalConfig) {
      throw new Error(`Signal '${signalName}' not found`);
    }
    const signal = {
      id: signalName,
      name: signalName,
      ...(signalConfig as object),
    } as IWorkspaceSignal;
    await this.processSignal(signal, payload || {});
  }

  /**
   * List all agents in the workspace
   */
  listAgents(): Array<{ id: string; type: string; purpose?: string }> {
    const agents = ((this.config?.workspace as Record<string, unknown>)?.agents as Record<
      string,
      unknown
    >) || {};
    return Object.entries(agents).map(([id, config]) => ({
      id,
      type: ((config as Record<string, unknown>)?.type as string) || "unknown",
      purpose: (config as Record<string, unknown>)?.purpose as
        | string
        | undefined,
    }));
  }

  /**
   * Get detailed information about an agent
   */
  describeAgent(agentId: string): Record<string, unknown> {
    const agents = ((this.config?.workspace as Record<string, unknown>)?.agents as Record<
      string,
      unknown
    >) || {};
    if (!agents[agentId]) {
      throw new Error(`Agent '${agentId}' not found`);
    }
    return agents[agentId] as Record<string, unknown>;
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
    if (state.value === "shuttingDown" || state.value === "terminated") {
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

  /**
   * Get worker information (for compatibility)
   * In the actor-based model, we don't have workers
   */
  getWorkers(): Array<Record<string, unknown>> {
    const state = this.stateMachine.getSnapshot();
    const workers = [];

    if (state.context.supervisor) {
      workers.push({
        id: state.context.supervisor.id,
        type: "supervisor",
        state: "ready",
        metadata: {
          workspaceId: this.workspace.id,
        },
      });
    }

    // Add session "workers" (now actors)
    for (const [sessionId, session] of state.context.sessions) {
      workers.push({
        id: sessionId,
        type: "session",
        state: session.status,
        metadata: {
          workspaceId: this.workspace.id,
        },
      });
    }

    return workers;
  }
}
