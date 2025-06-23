import type {
  IWorkspaceAgent,
  IWorkspaceArtifact,
  IWorkspaceSession,
  IWorkspaceSignal,
  IWorkspaceSignalCallback,
  IWorkspaceSource,
  IWorkspaceWorkflow,
} from "../types/core.ts";
import { AtlasScope } from "./scope.ts";
import { CoALAMemoryManager, CoALAMemoryType } from "./memory/coala-memory.ts";
import { assign, createActor, createMachine, fromPromise } from "xstate";
import { type ChildLogger, logger } from "../utils/logger.ts";

// Session Intent types
export interface SessionIntent {
  id: string;
  signal: {
    type: string;
    data: any;
    metadata?: Record<string, any>;
  };
  goals: string[];
  constraints?: {
    timeLimit?: number;
    costLimit?: number;
    requiredApprovals?: string[];
  };
  suggestedAgents?: string[];
  executionHints?: {
    strategy?: "exploratory" | "deterministic" | "iterative";
    parallelism?: boolean;
    maxIterations?: number;
  };
  successCriteria?: {
    type: "all" | "any" | "custom";
    conditions: Array<{
      description: string;
      evaluator?: (result: any) => boolean;
    }>;
  };
  userPrompt?: string;
}

export interface SessionPlan {
  intentId: string;
  phases: Array<{
    id: string;
    name: string;
    agents: Array<{
      agentId: string;
      task: string;
      dependencies?: string[];
      expectedOutputs?: string[];
    }>;
    executionStrategy: "sequential" | "parallel";
    successCriteria?: string;
  }>;
  estimatedDuration?: number;
  reasoning?: string;
}

// Session state machine types
type SessionContext = {
  sessionId: string;
  intent?: SessionIntent;
  plan?: SessionPlan;
  signals: IWorkspaceSignal[];
  currentSignalIndex: number;
  artifacts: IWorkspaceArtifact[];
  agents?: IWorkspaceAgent[];
  workflows?: IWorkspaceWorkflow[];
  sources?: IWorkspaceSource[];
  error?: Error;
  startTime?: Date;
  progress: number;
  currentIteration?: number;
  maxIterations?: number;
};

type SessionEvent =
  | { type: "START" }
  | { type: "INTENT_CREATED"; intent: SessionIntent }
  | { type: "PLAN_CREATED"; plan: SessionPlan }
  | { type: "SIGNAL_PROCESSED"; artifact: IWorkspaceArtifact }
  | { type: "AGENTS_EXECUTED"; results: any[] }
  | {
    type: "EVALUATION_COMPLETE";
    decision: "complete" | "refine" | "retry" | "escalate";
  }
  | { type: "REFINEMENT_COMPLETE"; refinedPlan: SessionPlan }
  | { type: "RESULTS_COLLECTED" }
  | { type: "ERROR"; error: Error }
  | { type: "CANCEL" };

// Create the session state machine
const sessionMachine = createMachine({
  id: "session",
  types: {} as {
    context: SessionContext;
    events: SessionEvent;
    input: SessionContext;
  },
  initial: "created",
  context: ({ input }: { input: SessionContext }) => ({
    sessionId: input.sessionId,
    signals: input.signals,
    currentSignalIndex: 0,
    artifacts: [],
    agents: input.agents,
    workflows: input.workflows,
    sources: input.sources,
    progress: 0,
  }),
  states: {
    created: {
      on: {
        START: {
          target: "planning",
          actions: assign({
            startTime: () => new Date(),
            currentIteration: 0,
          }),
        },
      },
    },
    planning: {
      entry: assign({
        progress: 10,
      }),
      invoke: {
        id: "createPlan",
        src: fromPromise(
          (
            { input }: { input: { intent?: SessionIntent; sessionId: string } },
          ) => {
            // Create logger with session context for FSM operations
            const fsmLogger = logger.createChildLogger({
              sessionId: input.sessionId,
              workerType: "session-fsm",
            });
            fsmLogger.debug("Creating execution plan from intent");
            // In a real implementation, this would use the supervisor to create a plan
            // For now, return a simple plan
            const plan: SessionPlan = {
              intentId: input.intent?.id || "default",
              phases: [{
                id: "phase1",
                name: "Process signals and execute agents",
                agents: [],
                executionStrategy: "sequential",
              }],
              reasoning: "Default execution plan",
            };
            return Promise.resolve(plan);
          },
        ),
        input: ({ context }) => ({
          intent: context.intent,
          sessionId: context.sessionId,
        }),
        onDone: {
          target: "processingSignals",
          actions: assign({
            plan: ({ event }) => event.output,
          }),
        },
        onError: {
          target: "#session.failed",
          actions: assign({
            error: ({ event }) => event.error as Error,
          }),
        },
      },
    },
    processingSignals: {
      entry: assign({
        progress: ({ context }) => 20 + (context.currentSignalIndex / context.signals.length) * 30,
      }),
      invoke: {
        id: "processSignal",
        src: fromPromise(
          async (
            { input }: {
              input: { signal: IWorkspaceSignal; sessionId: string };
            },
          ) => {
            // Create logger for signal processing
            const fsmLogger = logger.createChildLogger({
              sessionId: input.sessionId,
              workerType: "session-fsm",
            });
            fsmLogger.info(`Processing signal ${input.signal.id}`, {
              signalId: input.signal.id,
              provider: input.signal.provider?.name,
            });
            await input.signal.trigger();

            const artifact: IWorkspaceArtifact = {
              id: crypto.randomUUID(),
              type: "signal_result",
              data: {
                signalId: input.signal.id,
                provider: input.signal.provider,
                processedAt: new Date(),
              },
              createdAt: new Date(),
              createdBy: input.sessionId,
            };

            return artifact;
          },
        ),
        input: ({ context }) => ({
          signal: context.signals[context.currentSignalIndex],
          sessionId: context.sessionId,
        }),
        onDone: {
          actions: [
            assign({
              artifacts: (
                { context, event },
              ) => [...context.artifacts, event.output],
              currentSignalIndex: ({ context }) => context.currentSignalIndex + 1,
            }),
          ],
          target: "checkSignals",
        },
        onError: {
          target: "#session.failed",
          actions: assign({
            error: ({ event }) => event.error as Error,
          }),
        },
      },
    },
    checkSignals: {
      always: [
        {
          target: "executingAgents",
          guard: ({ context }) => context.currentSignalIndex >= context.signals.length,
        },
        {
          target: "processingSignals",
        },
      ],
    },
    executingAgents: {
      entry: assign({
        progress: 50,
      }),
      invoke: {
        id: "executeAgents",
        src: fromPromise(
          (
            { input }: {
              input: { agents?: IWorkspaceAgent[]; sessionId: string };
            },
          ) => {
            if (!input.agents || input.agents.length === 0) {
              return Promise.resolve([]);
            }

            // Create logger for agent execution
            const fsmLogger = logger.createChildLogger({
              sessionId: input.sessionId,
              workerType: "session-fsm",
            });
            fsmLogger.info(`Executing ${input.agents.length} agents`, {
              agentCount: input.agents.length,
            });
            const results = [];

            for (const agent of input.agents) {
              fsmLogger.debug(`Running agent ${agent.name()}`, {
                agentId: agent.id,
                agentName: agent.name(),
              });
              // Agent execution would happen here
              results.push({ agentId: agent.id, status: "completed" });
            }

            return Promise.resolve(results);
          },
        ),
        input: ({ context }) => ({
          agents: context.agents,
          sessionId: context.sessionId,
        }),
        onDone: {
          target: "evaluating",
          actions: assign({
            progress: 60,
            artifacts: ({ context, event }) => [
              ...context.artifacts,
              {
                id: crypto.randomUUID(),
                type: "agent_results",
                data: event.output,
                createdAt: new Date(),
                createdBy: context.sessionId,
              },
            ],
          }),
        },
        onError: {
          target: "#session.failed",
          actions: assign({
            error: ({ event }) => event.error as Error,
          }),
        },
      },
    },
    evaluating: {
      entry: assign({
        progress: 70,
      }),
      invoke: {
        id: "evaluateResults",
        src: fromPromise(({ input }: {
          input: {
            artifacts: IWorkspaceArtifact[];
            intent?: SessionIntent;
            currentIteration?: number;
            sessionId: string;
          };
        }) => {
          // Create logger for result evaluation
          const fsmLogger = logger.createChildLogger({
            sessionId: input.sessionId,
            workerType: "session-fsm",
          });
          fsmLogger.debug(`Evaluating results`, {
            iteration: input.currentIteration || 0,
            artifactCount: input.artifacts.length,
          });

          // In a real implementation, supervisor would evaluate against success criteria
          // For now, simple logic
          const maxIterations = input.intent?.executionHints?.maxIterations ||
            3;
          const currentIteration = input.currentIteration || 0;

          if (currentIteration >= maxIterations - 1) {
            return Promise.resolve("complete");
          }

          // Simulate evaluation logic
          const hasAllResults = input.artifacts.length > 0;
          if (hasAllResults) {
            return Promise.resolve("complete");
          } else {
            return Promise.resolve("refine");
          }
        }),
        input: ({ context }) => ({
          artifacts: context.artifacts,
          intent: context.intent,
          currentIteration: context.currentIteration,
          sessionId: context.sessionId,
        }),
        onDone: {
          actions: assign({
            currentIteration: ({ context }) => (context.currentIteration || 0) + 1,
            artifacts: ({ context, event }) => [
              ...context.artifacts,
              {
                id: crypto.randomUUID(),
                type: "evaluation_decision",
                data: event.output,
                createdAt: new Date(),
                createdBy: context.sessionId,
              },
            ],
          }),
          target: "decidingNext",
        },
        onError: {
          target: "#session.failed",
          actions: assign({
            error: ({ event }) => event.error as Error,
          }),
        },
      },
    },
    decidingNext: {
      always: [
        {
          target: "summarizing",
          guard: ({ context }) => {
            const lastResult = context.artifacts[context.artifacts.length - 1];
            return lastResult?.data === "complete";
          },
        },
        {
          target: "refining",
          guard: ({ context }) => {
            const lastResult = context.artifacts[context.artifacts.length - 1];
            return lastResult?.data === "refine";
          },
        },
        {
          target: "executingAgents",
          guard: ({ context }) => {
            const lastResult = context.artifacts[context.artifacts.length - 1];
            return lastResult?.data === "retry";
          },
        },
        {
          target: "failed",
          guard: ({ context }) => {
            const lastResult = context.artifacts[context.artifacts.length - 1];
            return lastResult?.data === "escalate";
          },
        },
      ],
    },
    refining: {
      entry: assign({
        progress: 80,
      }),
      invoke: {
        id: "refinePlan",
        src: fromPromise(({ input }: {
          input: {
            plan?: SessionPlan;
            artifacts: IWorkspaceArtifact[];
            sessionId: string;
          };
        }) => {
          // Create logger for plan refinement
          const fsmLogger = logger.createChildLogger({
            sessionId: input.sessionId,
            workerType: "session-fsm",
          });
          fsmLogger.debug("Refining execution plan based on evaluation", {
            artifactCount: input.artifacts.length,
          });

          // In a real implementation, supervisor would refine the plan
          // For now, return the same plan with a modification note
          const refinedPlan: SessionPlan = {
            ...(input.plan || {
              intentId: "refined",
              phases: [],
              reasoning: "Refined plan",
            }),
            reasoning: `${input.plan?.reasoning || ""} - Refined based on iteration results`,
          };

          return Promise.resolve(refinedPlan);
        }),
        input: ({ context }) => ({
          plan: context.plan,
          artifacts: context.artifacts,
          sessionId: context.sessionId,
        }),
        onDone: {
          target: "executingAgents",
          actions: assign({
            plan: ({ event }) => event.output,
          }),
        },
        onError: {
          target: "#session.failed",
          actions: assign({
            error: ({ event }) => event.error as Error,
          }),
        },
      },
    },
    summarizing: {
      entry: assign({
        progress: 95,
      }),
      invoke: {
        id: "generateWorkingMemorySummary",
        src: fromPromise(({ input }: {
          input: {
            sessionId: string;
            artifacts: IWorkspaceArtifact[];
          };
        }) => {
          // Create logger for summarization
          const fsmLogger = logger.createChildLogger({
            sessionId: input.sessionId,
            workerType: "session-fsm",
          });
          fsmLogger.debug("Generating working memory summary for episodic storage", {
            artifactCount: input.artifacts.length,
          });

          // Note: In a real implementation, this would need access to the SessionSupervisor
          // to call generateWorkingMemorySummary(). For now, we'll just log the intention.
          // The actual summarization is handled in the SessionSupervisorWorker.
          fsmLogger.info("Working memory summarization step completed");

          return Promise.resolve({ summarized: true });
        }),
        input: ({ context }) => ({
          sessionId: context.sessionId,
          artifacts: context.artifacts,
        }),
        onDone: {
          target: "completed",
          actions: assign({
            // Store summarization result in context if needed
            artifacts: ({ context, event }) => [
              ...context.artifacts,
              {
                id: crypto.randomUUID(),
                type: "session_summary",
                data: event.output,
                createdAt: new Date(),
                createdBy: "session-fsm",
              },
            ],
          }),
        },
        onError: {
          // Continue to completion even if summarization fails
          target: "completed",
          actions: [
            assign({
              error: ({ event }) => event.error as Error,
            }),
            ({ context, event }) => {
              const fsmLogger = logger.createChildLogger({
                sessionId: context.sessionId,
                workerType: "session-fsm",
              });
              fsmLogger.warn("Working memory summarization failed, proceeding to completion", {
                error: event.error,
              });
            },
          ],
        },
      },
    },
    completed: {
      type: "final",
      entry: assign({
        progress: 100,
      }),
    },
    failed: {
      type: "final",
      entry: ({ context }) => {
        console.error(`[Session ${context.sessionId}] Failed:`, context.error);
      },
    },
  },
  on: {
    CANCEL: {
      target: ".failed",
      actions: assign({
        error: () => new Error("Session cancelled"),
      }),
    },
    ERROR: {
      target: ".failed",
      actions: assign({
        error: ({ event }) => event.error,
      }),
    },
  },
});

export class Session extends AtlasScope implements IWorkspaceSession {
  public signals: {
    triggers: IWorkspaceSignal[];
    callback: IWorkspaceSignalCallback;
  };
  public agents?: IWorkspaceAgent[];
  public workflows?: IWorkspaceWorkflow[];
  public sources?: IWorkspaceSource[];
  public intent?: SessionIntent;

  private _progress: number = 0;
  private _isRunning: boolean = false;
  private _artifacts: IWorkspaceArtifact[] = [];
  private _startTime?: Date;
  private _stateMachine: ReturnType<typeof createActor<typeof sessionMachine>>;
  protected logger: ChildLogger;

  constructor(
    workspaceId: string,
    signals: {
      triggers: IWorkspaceSignal[];
      callback: IWorkspaceSignalCallback | ((result: any) => Promise<void>);
    },
    agents?: IWorkspaceAgent[],
    workflows?: IWorkspaceWorkflow[],
    sources?: IWorkspaceSource[],
    intent?: SessionIntent,
    storageAdapter?:
      | import("../types/core.ts").ITempestMemoryStorageAdapter
      | import("../types/core.ts").ICoALAMemoryStorageAdapter,
    enableCognitiveLoop: boolean = true,
  ) {
    super(workspaceId, undefined, storageAdapter, enableCognitiveLoop);

    // Initialize logger for this session
    this.logger = logger.createChildLogger({
      sessionId: this.id,
      workerType: "session",
    });

    this.signals = {
      triggers: signals.triggers,
      callback: typeof signals.callback === "function"
        ? new FunctionCallback(signals.callback)
        : signals.callback,
    };

    this.agents = agents;
    this.workflows = workflows;
    this.sources = sources;
    this.intent = intent;

    // Store session initialization in CoALA memory
    const coalaMemory = this.memory as CoALAMemoryManager;
    coalaMemory.rememberWithMetadata(
      "session-initialization",
      {
        workspaceId,
        signalCount: signals.triggers.length,
        agentCount: agents?.length || 0,
        workflowCount: workflows?.length || 0,
        sourceCount: sources?.length || 0,
        intent: intent?.id,
        strategy: intent?.executionHints?.strategy,
      },
      {
        memoryType: CoALAMemoryType.CONTEXTUAL,
        tags: ["session", "initialization", "metadata"],
        relevanceScore: 1.0,
        confidence: 1.0,
      },
    );

    // Initialize the state machine
    this._stateMachine = createActor(sessionMachine, {
      input: {
        sessionId: this.id,
        intent: intent,
        signals: signals.triggers,
        currentSignalIndex: 0,
        artifacts: [],
        agents: agents,
        workflows: workflows,
        sources: sources,
        progress: 0,
        currentIteration: 0,
        maxIterations: intent?.executionHints?.maxIterations || 3,
      },
    });

    // Subscribe to state changes
    this._stateMachine.subscribe((snapshot) => {
      const context = snapshot.context;
      this._progress = context.progress;
      this._artifacts = context.artifacts;
      this._startTime = context.startTime;

      // Handle state transitions and store in CoALA memory
      const coalaMemory = this.memory as CoALAMemoryManager;

      if (snapshot.matches("completed")) {
        this._isRunning = false;
        // Remember successful completion
        coalaMemory.rememberWithMetadata(
          `session-completed-${Date.now()}`,
          {
            sessionId: this.id,
            duration: this._startTime ? Date.now() - this._startTime.getTime() : 0,
            artifactCount: this._artifacts.length,
            finalProgress: this._progress,
          },
          {
            memoryType: CoALAMemoryType.EPISODIC,
            tags: ["session", "completion", "success"],
            relevanceScore: 0.8,
            confidence: 1.0,
          },
        );
        this.signals.callback.onSuccess(this._artifacts);
        this.signals.callback.onComplete();
      } else if (snapshot.matches("failed")) {
        this._isRunning = false;
        // Remember failure for learning
        coalaMemory.rememberWithMetadata(
          `session-failed-${Date.now()}`,
          {
            sessionId: this.id,
            error: context.error?.message,
            progress: this._progress,
            artifacts: this._artifacts.length,
          },
          {
            memoryType: CoALAMemoryType.EPISODIC,
            tags: ["session", "failure", "error"],
            relevanceScore: 0.9, // Failures are highly relevant for learning
            confidence: 1.0,
          },
        );
        this.signals.callback.onError(
          context.error || new Error("Session failed"),
        );
      } else if (
        snapshot.matches("processingSignals") ||
        snapshot.matches("executingAgents")
      ) {
        this._isRunning = true;
      }

      // Add context to session for each processed signal and store in CoALA memory
      if (
        snapshot.matches("processingSignals") && context.artifacts.length > 0
      ) {
        const lastArtifact = context.artifacts[context.artifacts.length - 1];
        this.context.add({
          source: {
            type: "signal",
            id: lastArtifact.data.signalId,
          },
          detail:
            `Signal from ${lastArtifact.data.provider.name} processed at ${lastArtifact.data.processedAt}`,
        });

        // Store signal processing result in CoALA memory
        coalaMemory.rememberWithMetadata(
          `signal-processed-${lastArtifact.data.signalId}`,
          {
            signalId: lastArtifact.data.signalId,
            provider: lastArtifact.data.provider.name,
            processedAt: lastArtifact.data.processedAt,
            sessionId: this.id,
            artifactType: lastArtifact.type,
          },
          {
            memoryType: CoALAMemoryType.EPISODIC,
            tags: ["signal", "processed", lastArtifact.data.provider.name],
            relevanceScore: 0.6,
            confidence: 1.0,
          },
        );
      }
    });

    // Start the state machine
    this._stateMachine.start();
  }

  async start(): Promise<void> {
    this.logger.info(`Starting session with ${this.signals.triggers.length} signals`, {
      signalCount: this.signals.triggers.length,
    });

    // Send START event to the state machine
    this._stateMachine.send({ type: "START" });

    // Wait for the state machine to reach a final state
    await new Promise<void>((resolve) => {
      const subscription = this._stateMachine.subscribe((snapshot) => {
        if (snapshot.status === "done") {
          subscription.unsubscribe();
          resolve();
        }
      });
    });
  }

  cancel(): void {
    this.logger.info("Cancelling session");

    // Send CANCEL event to the state machine
    this._stateMachine.send({ type: "CANCEL" });

    // Cancel any running agents
    if (this.agents) {
      for (const agent of this.agents) {
        this.logger.debug(`Stopping agent ${agent.name()}`, { agentName: agent.name() });
      }
    }
  }

  progress(): number {
    return Math.round(this._progress);
  }

  summarize(): string {
    const duration = this._startTime ? Date.now() - this._startTime.getTime() : 0;
    const status = this._isRunning ? "running" : this._progress === 100 ? "completed" : "cancelled";

    return `Session ${this.id}: ${status} (${this.progress()}%) - ${this.signals.triggers.length} signals, ${this._artifacts.length} artifacts, ${duration}ms`;
  }

  getArtifacts(): IWorkspaceArtifact[] {
    return [...this._artifacts];
  }

  get status(): string {
    const snapshot = this._stateMachine.getSnapshot();

    if (snapshot.matches("created")) return "pending";
    if (
      snapshot.matches("starting") || snapshot.matches("processingSignals") ||
      snapshot.matches("executingAgents") ||
      snapshot.matches("collectingResults")
    ) {
      return "running";
    }
    if (snapshot.matches("completed")) return "completed";
    if (snapshot.matches("failed")) {
      return snapshot.context.error?.message === "Session cancelled" ? "cancelled" : "failed";
    }

    return "pending";
  }

  complete(result: any): void {
    this._progress = 100;
    this._isRunning = false;
    this.signals.callback.onSuccess(result);
    this.signals.callback.onComplete();
  }

  updateProgress(step: string, data: any): void {
    const snapshot = this._stateMachine.getSnapshot();
    const state = snapshot.value;
    this.logger.debug(`State: ${state}, Progress: ${step}`, {
      state,
      step,
      data,
    });

    // Log detailed state machine information
    this.logger.trace("Current state machine context", {
      state: state,
      progress: snapshot.context.progress,
      signalsProcessed: snapshot.context.currentSignalIndex,
      totalSignals: snapshot.context.signals.length,
      artifactsGenerated: snapshot.context.artifacts.length,
    });
  }

  // Add a method to get the current state for debugging
  getCurrentState(): string {
    return String(this._stateMachine.getSnapshot().value);
  }

  // Add a method to get state machine context for monitoring
  getStateMachineContext(): SessionContext {
    return this._stateMachine.getSnapshot().context;
  }
}

// For backwards compatibility
export class WorkspaceSession extends Session {
  constructor(workspaceId: string, triggerSignal: IWorkspaceSignal) {
    super(
      workspaceId,
      {
        triggers: [triggerSignal],
        callback: new DefaultSignalCallback(),
      },
      undefined, // agents
      undefined, // workflows
      undefined, // sources
    );
  }
}

class DefaultSignalCallback implements IWorkspaceSignalCallback {
  private logger: ChildLogger;

  constructor() {
    this.logger = logger.createChildLogger({
      workerType: "signal-callback",
    });
  }

  execute(): void {
    // Default implementation
  }

  validate(): boolean {
    return true;
  }

  onSuccess(result: any): void {
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
  private logger: ChildLogger;

  constructor(private fn: (result: any) => Promise<void>) {
    this.logger = logger.createChildLogger({
      workerType: "function-callback",
    });
  }

  execute(): void {
    // Function callback doesn't use execute
  }

  validate(): boolean {
    return true;
  }

  async onSuccess(result: any): Promise<void> {
    await this.fn(result);
  }

  onError(error: Error): void {
    this.logger.error("Signal processing failed", { error: error.message });
  }

  onComplete(): void {
    this.logger.info("All signals processed");
  }
}
