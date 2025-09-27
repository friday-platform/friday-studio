/**
 * Simplified Session Implementation
 *
 * Thin wrapper around SessionSupervisorActor that maintains API compatibility
 * while delegating all state management to the actor.
 */

import { WorkspaceSessionStatus } from "@atlas/core";
import { type Logger, logger } from "@atlas/logger";
import type {
  ICoALAMemoryStorageAdapter,
  IWorkspaceAgent,
  IWorkspaceArtifact,
  IWorkspaceSession,
  IWorkspaceSignal,
  IWorkspaceSignalCallback,
  IWorkspaceSource,
  IWorkspaceWorkflow,
} from "../types/core.ts";
import type { SessionSupervisorActor } from "./actors/session-supervisor-actor.ts";
import { AtlasScope } from "./scope.ts";

// Session Intent types (preserve for API compatibility)
export interface SessionIntent {
  id: string;
  signal: { type: string; data: unknown; metadata?: Record<string, unknown> };
  goals: string[];
  constraints?: { timeLimit?: number; costLimit?: number; requiredApprovals?: string[] };
  suggestedAgents?: string[];
  executionHints?: {
    strategy?: "exploratory" | "deterministic" | "iterative";
    parallelism?: boolean;
    maxIterations?: number;
  };
  successCriteria?: {
    type: "all" | "any" | "custom";
    conditions: Array<{ description: string; evaluator?: (result: unknown) => boolean }>;
  };
  userPrompt?: string;
}

export class Session extends AtlasScope implements IWorkspaceSession {
  // Core session properties
  public signals: { triggers: IWorkspaceSignal[]; callback: IWorkspaceSignalCallback };
  public agents?: IWorkspaceAgent[];
  public workflows?: IWorkspaceWorkflow[];
  public sources?: IWorkspaceSource[];
  public intent?: SessionIntent;

  // The actual actor that manages this session
  private sessionActor?: SessionSupervisorActor;
  private _status: string = WorkspaceSessionStatus.PENDING;
  private _error?: Error;

  // Execution state
  protected logger: Logger;

  constructor(
    workspaceId: string,
    signals: {
      triggers: IWorkspaceSignal[];
      callback: IWorkspaceSignalCallback | ((result: unknown) => Promise<void>);
    },
    agents?: IWorkspaceAgent[],
    workflows?: IWorkspaceWorkflow[],
    sources?: IWorkspaceSource[],
    intent?: SessionIntent,
    storageAdapter?: ICoALAMemoryStorageAdapter,
    enableCognitiveLoop: boolean = true,
  ) {
    super({ workspaceId, storageAdapter, enableCognitiveLoop });

    this.signals = {
      triggers: signals.triggers,
      callback:
        typeof signals.callback === "function"
          ? new FunctionCallback(signals.callback)
          : signals.callback,
    };
    this.agents = agents;
    this.workflows = workflows;
    this.sources = sources;
    this.intent = intent;

    // Initialize logger
    this.logger = logger.child({ sessionId: this.id, workerType: "session" });

    this.logger.info("Session created", {
      sessionId: this.id,
      workspaceId,
      signalCount: signals.triggers.length,
      agentCount: agents?.length || 0,
    });
  }

  // API Interface Methods

  get status(): string {
    // If we have a session actor, try to get status from it
    if (this.sessionActor) {
      const executionStatus = this.sessionActor.getExecutionStatus();
      // Map actor status to session status
      switch (executionStatus) {
        case "planning":
        case "executing":
          return WorkspaceSessionStatus.EXECUTING;
        case "completed":
          return WorkspaceSessionStatus.COMPLETED;
        case "failed":
          return WorkspaceSessionStatus.FAILED;
        case "idle":
        case "initializing":
          // Actor is attached but not yet executing, use our internal status
          return this._status;
        default:
          // Unknown actor status, use our internal status
          return this._status;
      }
    }
    // No actor attached yet, use internal status
    return this._status;
  }

  progress(): number {
    if (this.sessionActor) {
      const executionStatus = this.sessionActor.getExecutionStatus();
      switch (executionStatus) {
        case "planning":
          return 25;
        case "executing":
          return 50;
        case "completed":
          return 100;
        case "failed":
          return 100;
        default:
          return 0;
      }
    }

    // Fallback to simple progress based on internal status
    switch (this._status) {
      case WorkspaceSessionStatus.PENDING:
        return 0;
      case WorkspaceSessionStatus.EXECUTING:
        return 50;
      case WorkspaceSessionStatus.COMPLETED:
      case WorkspaceSessionStatus.FAILED:
        return 100;
      default:
        return 0;
    }
  }

  summarize(): string {
    if (this.sessionActor) {
      return this.sessionActor.getSummary();
    }

    const artifacts = this.getArtifacts();
    return `Session ${this.id}: ${this._status} - ${this.signals.triggers.length} signals, ${artifacts.length} artifacts`;
  }

  getArtifacts(): IWorkspaceArtifact[] {
    if (this.sessionActor) {
      return this.sessionActor.getExecutionArtifacts();
    }
    return [];
  }

  // Session Lifecycle Management

  async start(): Promise<void> {
    this.logger.info(`Starting session with ${this.signals.triggers.length} signals`, {
      signalCount: this.signals.triggers.length,
    });

    // Session is already pending from constructor, but if actor is attached, we're executing
    if (this.sessionActor) {
      this._status = WorkspaceSessionStatus.EXECUTING;
    }
    // Session execution is initiated by attaching the SessionSupervisorActor
  }

  cancel(): void {
    // Don't cancel already completed or failed sessions
    if (
      this._status === WorkspaceSessionStatus.COMPLETED ||
      this._status === WorkspaceSessionStatus.FAILED
    ) {
      this.logger.debug("Session already finalized, skipping cancellation", {
        status: this._status,
        sessionId: this.id,
      });
      return;
    }

    this.logger.info("Cancelling session");

    this._status = WorkspaceSessionStatus.CANCELLED;
    this._error = new Error("Session cancelled");

    // Cancel session execution in the supervisor actor.
    if (this.sessionActor) {
      this.sessionActor.cancel();
    }

    this.rememberSessionEvent("session-cancelled", { cancelledAt: new Date().toISOString() });

    this.signals.callback.onError(this._error);

    // Clear session-scoped WORKING memory on cancellation
    this.clearWorkingMemoryForSession();
  }

  /**
   * Clean up session resources without changing status.
   * Used during workspace shutdown to free resources while preserving session history.
   */
  cleanup(): void {
    this.logger.debug("Cleaning up session resources", {
      status: this._status,
      sessionId: this.id,
      hasSessionActor: !!this.sessionActor,
    });

    // Cleanup the session actor if present
    if (this.sessionActor) {
      try {
        this.sessionActor.shutdown();
        this.logger.debug("Session actor cleaned up", {
          sessionId: this.id,
          actorId: this.sessionActor.id,
        });
      } catch (error) {
        this.logger.error("Failed to cleanup session actor", {
          sessionId: this.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Note: We intentionally preserve session status and history for analysis
    // Only clean up active resources like actors and connections
  }

  complete(result?: unknown): void {
    this.logger.info("Session completed", { hasResult: !!result });

    this._status = WorkspaceSessionStatus.COMPLETED;

    this.signals.callback.onSuccess(result || this.getArtifacts());
    this.signals.callback.onComplete();

    // Clear session-scoped WORKING memory on successful completion
    this.clearWorkingMemoryForSession();
  }

  fail(error: Error): void {
    this.logger.error("Session failed", { error: error.message });

    this._status = WorkspaceSessionStatus.FAILED;
    this._error = error;

    this.rememberSessionEvent("session-failed", {
      failedAt: new Date().toISOString(),
      error: error.message,
    });

    this.signals.callback.onError(error);

    // Clear session-scoped WORKING memory on failure
    this.clearWorkingMemoryForSession();
  }

  // SessionSupervisorActor Integration

  attachSessionActor(sessionActor: SessionSupervisorActor): void {
    this.sessionActor = sessionActor;
    // Set status to executing immediately when actor is attached
    this._status = WorkspaceSessionStatus.EXECUTING;

    this.logger.info("Session actor attached, status set to executing", {
      actorId: sessionActor.id,
      sessionId: this.id,
      status: this._status,
    });

    // Monitor the execution promise from the actor
    const executionPromise = sessionActor.getExecutionPromise();
    if (executionPromise) {
      this.logger.info("Monitoring session actor execution", {
        sessionId: this.id,
        actorId: sessionActor.id,
      });

      executionPromise.then(
        (result) => {
          this.logger.info("Session actor execution completed", { sessionId: this.id });
          this.complete(result);
        },
        (error: Error) => {
          this.logger.error("Session actor execution failed", {
            sessionId: this.id,
            error: error.message,
          });
          this.fail(error);
        },
      );
    } else {
      // If no execution promise yet, poll for it
      const checkForPromise = () => {
        const promise = sessionActor.getExecutionPromise();
        if (promise) {
          this.logger.info("Found execution promise, monitoring", {
            sessionId: this.id,
            actorId: sessionActor.id,
          });

          promise.then(
            (result) => this.complete(result),
            (error: Error) => this.fail(error),
          );
        } else {
          // Check again in next microtask
          queueMicrotask(checkForPromise);
        }
      };

      queueMicrotask(checkForPromise);
    }
  }

  // CoALA Memory Integration
  private rememberSessionEvent(event: string, data: Record<string, string>): void {
    this.memory.rememberWithMetadata(
      `${event}-${Date.now()}`,
      { sessionId: this.id, workspaceId: this.workspaceId || "global", event, ...data },
      {
        memoryType: "episodic",
        tags: ["session", event.replace("session-", ""), this.workspaceId || "global"],
        relevanceScore: event.includes("failed") ? 0.9 : event.includes("completed") ? 0.8 : 0.6,
        confidence: 1.0,
      },
    );
  }

  private clearWorkingMemoryForSession(): void {
    try {
      const coalaMemory = this.memory;
      const cleared = coalaMemory.clearWorkingBySession(this.id);
      this.logger.debug("Cleared working memory for session", { sessionId: this.id, cleared });
    } catch (error) {
      this.logger.warn("Failed to clear working memory for session", { error });
    }
  }

  // Debugging and Monitoring

  getCurrentState(): string {
    return this.status;
  }
}

// Backwards Compatibility Classes

export class WorkspaceSession extends Session {
  constructor(workspaceId: string, triggerSignal: IWorkspaceSignal) {
    super(
      workspaceId,
      { triggers: [triggerSignal], callback: new DefaultSignalCallback() },
      undefined, // agents
      undefined, // workflows
      undefined, // sources
    );
  }
}

class DefaultSignalCallback implements IWorkspaceSignalCallback {
  private logger: Logger;

  constructor() {
    this.logger = logger.child({ workerType: "signal-callback" });
  }

  execute(): void {
    // Default implementation
  }

  validate(): boolean {
    return true;
  }

  onSuccess(result: unknown): void {
    this.logger.info("Signal processed successfully", { result });
  }

  onError(error: Error): void {
    this.logger.error("Signal processing failed", { error: error.message });
  }

  onComplete(): void {
    this.logger.info("All signals processed");
  }
}

class FunctionCallback implements IWorkspaceSignalCallback {
  private logger: Logger;

  constructor(private fn: (result: unknown) => Promise<void>) {
    this.logger = logger.child({ workerType: "function-callback" });
  }

  execute(): void {
    // Function callback doesn't use execute
  }

  validate(): boolean {
    return true;
  }

  async onSuccess(result: unknown): Promise<void> {
    await this.fn(result);
  }

  onError(error: Error): void {
    this.logger.error("Signal processing failed", { error: error.message });
  }

  onComplete(): void {
    this.logger.info("All signals processed");
  }
}
