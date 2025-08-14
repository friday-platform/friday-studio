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
import { CoALAMemoryManager, CoALAMemoryType, MemorySource } from "@atlas/memory";
import { assign, createActor, createMachine, fromPromise } from "xstate";
import { type Logger, logger } from "@atlas/logger";
import { globalFSMMonitor } from "./fsm/fsm-monitoring.ts";

// Response channel interfaces - moved to daemon layer
// Sessions no longer handle response channels directly

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
  constraints?: Record<string, unknown>;
  additionalPrompts?: {
    planning?: string;
    evaluation?: string;
  };
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
            const fsmLogger = logger.child({
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
          target: "#session.planningFailed",
          actions: assign({
            error: ({ event }) => event.error as Error,
          }),
        },
      },
      after: {
        20000: { // 20 second timeout for planning
          target: "#session.planningFailed",
          actions: assign({
            error: () => new Error("Planning timeout exceeded"),
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
            const fsmLogger = logger.child({
              sessionId: input.sessionId,
              workerType: "session-fsm",
            });
            fsmLogger.info(`Processing signal ${input.signal.id}`, {
              signalId: input.signal.id,
              provider: input.signal.provider?.name,
            });

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
          target: "#session.signalProcessingFailed",
          actions: assign({
            error: ({ event }) => event.error as Error,
          }),
        },
      },
      after: {
        30000: { // 30 second timeout for signal processing
          target: "#session.signalProcessingFailed",
          actions: assign({
            error: () => new Error("Signal processing timeout exceeded"),
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
          async (
            { input }: {
              input: { agents?: IWorkspaceAgent[]; sessionId: string };
            },
          ) => {
            if (!input.agents || input.agents.length === 0) {
              return [];
            }

            // Create logger for agent execution
            const fsmLogger = logger.child({
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

              try {
                // Execute the agent with a simple task message
                // In a real implementation, the task would come from the session plan
                const taskMessage = "Process the current workspace context and signals";

                fsmLogger.debug(`Invoking agent ${agent.name()} with task`, {
                  agentId: agent.id,
                  task: taskMessage.substring(0, 100),
                });

                const agentResult = await agent.invoke(taskMessage);

                fsmLogger.info(`Agent ${agent.name()} completed successfully`, {
                  agentId: agent.id,
                  resultLength: agentResult.length,
                });

                results.push({
                  agentId: agent.id,
                  agentName: agent.name(),
                  status: "completed",
                  result: agentResult,
                  completedAt: new Date().toISOString(),
                });
              } catch (error) {
                fsmLogger.error(`Agent ${agent.name()} execution failed`, {
                  agentId: agent.id,
                  error: error instanceof Error ? error.message : String(error),
                });

                results.push({
                  agentId: agent.id,
                  agentName: agent.name(),
                  status: "failed",
                  error: error instanceof Error ? error.message : String(error),
                  failedAt: new Date().toISOString(),
                });
              }
            }

            return results;
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
          target: "#session.agentExecutionFailed",
          actions: assign({
            error: ({ event }) => event.error as Error,
          }),
        },
      },
      after: {
        120000: { // 2 minute timeout for agent execution
          target: "#session.agentExecutionFailed",
          actions: assign({
            error: () => new Error("Agent execution timeout exceeded"),
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
          const fsmLogger = logger.child({
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
          target: "#session.evaluationFailed",
          actions: assign({
            error: ({ event }) => event.error as Error,
          }),
        },
      },
      after: {
        15000: { // 15 second timeout for evaluation
          target: "#session.evaluationFailed",
          actions: assign({
            error: () => new Error("Evaluation timeout exceeded"),
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
          const fsmLogger = logger.child({
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
          target: "#session.planningFailed", // Refinement errors go back to planning
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
          const fsmLogger = logger.child({
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
              const fsmLogger = logger.child({
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
    // Granular error states with retry mechanisms
    planningFailed: {
      entry: ({ context }) => {
        const fsmLogger = logger.child({
          sessionId: context.sessionId,
          workerType: "session-fsm",
        });
        fsmLogger.warn("Planning failed, attempting retry", {
          error: context.error?.message,
          currentIteration: context.currentIteration,
        });
      },
      invoke: {
        id: "retryPlanning",
        src: fromPromise(
          async ({ input }: { input: { sessionId: string; currentIteration: number } }) => {
            const fsmLogger = logger.child({
              sessionId: input.sessionId,
              workerType: "session-fsm",
            });

            // Wait before retry with exponential backoff
            const retryDelay = Math.min(1000 * Math.pow(2, input.currentIteration), 10000);
            fsmLogger.debug(`Waiting ${retryDelay}ms before planning retry`);
            await new Promise((resolve) => setTimeout(resolve, retryDelay));

            fsmLogger.info("Retrying planning after failure");
            return { retried: true };
          },
        ),
        input: ({ context }) => ({
          sessionId: context.sessionId,
          currentIteration: context.currentIteration || 0,
        }),
        onDone: {
          target: "planning",
          actions: assign({
            error: undefined, // Clear previous error
          }),
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) =>
              new Error(
                `Planning retry failed: ${
                  event.error instanceof Error ? event.error.message : String(event.error)
                }`,
              ),
          }),
        },
      },
      after: {
        30000: { // 30 second timeout
          target: "failed",
          actions: assign({
            error: () => new Error("Planning retry timeout exceeded"),
          }),
        },
      },
    },
    signalProcessingFailed: {
      entry: ({ context }) => {
        const fsmLogger = logger.child({
          sessionId: context.sessionId,
          workerType: "session-fsm",
        });
        fsmLogger.warn("Signal processing failed, attempting retry", {
          error: context.error?.message,
          signalIndex: context.currentSignalIndex,
        });
      },
      invoke: {
        id: "retrySignalProcessing",
        src: fromPromise(
          async ({ input }: { input: { sessionId: string; signalIndex: number } }) => {
            const fsmLogger = logger.child({
              sessionId: input.sessionId,
              workerType: "session-fsm",
            });

            // Wait before retry
            await new Promise((resolve) => setTimeout(resolve, 2000));
            fsmLogger.info(`Retrying signal processing for signal ${input.signalIndex}`);
            return { retried: true };
          },
        ),
        input: ({ context }) => ({
          sessionId: context.sessionId,
          signalIndex: context.currentSignalIndex,
        }),
        onDone: {
          target: "processingSignals",
          actions: assign({
            error: undefined, // Clear previous error
          }),
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) =>
              new Error(
                `Signal processing retry failed: ${
                  event.error instanceof Error ? event.error.message : String(event.error)
                }`,
              ),
          }),
        },
      },
      after: {
        15000: { // 15 second timeout
          target: "failed",
          actions: assign({
            error: () => new Error("Signal processing retry timeout exceeded"),
          }),
        },
      },
    },
    agentExecutionFailed: {
      entry: ({ context }) => {
        const fsmLogger = logger.child({
          sessionId: context.sessionId,
          workerType: "session-fsm",
        });
        fsmLogger.warn("Agent execution failed, attempting recovery", {
          error: context.error?.message,
          iteration: context.currentIteration,
        });
      },
      invoke: {
        id: "handleAgentFailure",
        src: fromPromise(async ({ input }: { input: { sessionId: string; iteration: number } }) => {
          const fsmLogger = logger.child({
            sessionId: input.sessionId,
            workerType: "session-fsm",
          });

          // Wait before retry with longer delay for agent failures
          const retryDelay = Math.min(3000 * Math.pow(1.5, input.iteration), 15000);
          fsmLogger.debug(`Waiting ${retryDelay}ms before agent execution retry`);
          await new Promise((resolve) => setTimeout(resolve, retryDelay));

          fsmLogger.info("Attempting agent execution recovery");
          return { recovered: true };
        }),
        input: ({ context }) => ({
          sessionId: context.sessionId,
          iteration: context.currentIteration || 0,
        }),
        onDone: {
          target: "executingAgents",
          actions: assign({
            error: undefined, // Clear previous error
            currentIteration: ({ context }) => (context.currentIteration || 0) + 1,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) =>
              new Error(
                `Agent execution recovery failed: ${
                  event.error instanceof Error ? event.error.message : String(event.error)
                }`,
              ),
          }),
        },
      },
      after: {
        45000: { // 45 second timeout for agent recovery
          target: "failed",
          actions: assign({
            error: () => new Error("Agent execution recovery timeout exceeded"),
          }),
        },
      },
    },
    evaluationFailed: {
      entry: ({ context }) => {
        const fsmLogger = logger.child({
          sessionId: context.sessionId,
          workerType: "session-fsm",
        });
        fsmLogger.warn("Evaluation failed, attempting simplified evaluation", {
          error: context.error?.message,
        });
      },
      invoke: {
        id: "fallbackEvaluation",
        src: fromPromise(async ({ input }: { input: { sessionId: string; artifacts: any[] } }) => {
          const fsmLogger = logger.child({
            sessionId: input.sessionId,
            workerType: "session-fsm",
          });

          // Simple fallback evaluation - just check if we have artifacts
          fsmLogger.info("Performing fallback evaluation");
          const hasResults = input.artifacts && input.artifacts.length > 0;
          return hasResults ? "complete" : "retry";
        }),
        input: ({ context }) => ({
          sessionId: context.sessionId,
          artifacts: context.artifacts,
        }),
        onDone: {
          target: "decidingNext",
          actions: assign({
            error: undefined, // Clear previous error
          }),
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) =>
              new Error(
                `Fallback evaluation failed: ${
                  event.error instanceof Error ? event.error.message : String(event.error)
                }`,
              ),
          }),
        },
      },
      after: {
        10000: { // 10 second timeout for evaluation
          target: "failed",
          actions: assign({
            error: () => new Error("Evaluation recovery timeout exceeded"),
          }),
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
        const fsmLogger = logger.child({
          sessionId: context.sessionId,
          workerType: "session-fsm",
        });
        fsmLogger.error("Session failed", {
          sessionId: context.sessionId,
          error: context.error?.message || "Unknown error",
          stack: context.error?.stack,
        });
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
  private _fsmId: string; // Unique FSM instance ID for monitoring
  protected logger: Logger;

  // Response channels now handled at daemon layer

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
    // Response config removed - handled at daemon layer
  ) {
    super({
      workspaceId,
      storageAdapter,
      enableCognitiveLoop,
    });

    // Initialize logger for this session
    this.logger = logger.child({
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

    // Generate unique FSM ID for monitoring
    this._fsmId = crypto.randomUUID().slice(0, 8);

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

    // Register FSM for monitoring
    globalFSMMonitor.registerFSM("Session", this._fsmId);

    // Subscribe to state changes for monitoring and memory
    let previousState = "created";
    let transitionStartTime = Date.now();

    this._stateMachine.subscribe((snapshot) => {
      const context = snapshot.context;
      this._progress = context.progress;
      this._artifacts = context.artifacts;
      this._startTime = context.startTime;

      // Record state transition for monitoring
      const currentState = String(snapshot.value);
      const transitionTime = Date.now() - transitionStartTime;

      globalFSMMonitor.recordStateTransition("Session", this._fsmId, {
        fromState: previousState,
        toState: currentState,
        duration: transitionTime,
        timestamp: Date.now(),
        event: "state_transition",
        success: snapshot.status !== "error",
        errorType: snapshot.status === "error" ? "session_error" : undefined,
      });

      // Update for next transition
      previousState = currentState;
      transitionStartTime = Date.now();

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
        // Clear session-scoped WORKING memory at end of session
        try {
          const cleared = coalaMemory.clearWorkingBySession(this.id);
          this.logger.debug("Cleared working memory for session", { sessionId: this.id, cleared });
        } catch (e) {
          this.logger.warn("Failed to clear working memory for session", { error: e });
        }
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
        // Always attempt to clear WORKING memory on failure as well
        try {
          const cleared = coalaMemory.clearWorkingBySession(this.id);
          this.logger.debug("Cleared working memory after failure", {
            sessionId: this.id,
            cleared,
          });
        } catch (e) {
          this.logger.warn("Failed to clear working memory after failure", { error: e });
        }
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
        const lastArtifact = context.artifacts[context.artifacts.length - 1] as any;
        if (!lastArtifact) {
          return;
        }
        this.context.add({
          source: {
            type: "signal",
            id: lastArtifact?.data?.signalId,
          },
          detail:
            `Signal from ${lastArtifact?.data?.provider?.name} processed at ${lastArtifact?.data?.processedAt}`,
        });

        // Store signal processing result in CoALA memory
        coalaMemory.rememberWithMetadata(
          `signal-processed-${lastArtifact?.data?.signalId}`,
          {
            signalId: lastArtifact?.data?.signalId,
            provider: lastArtifact?.data?.provider?.name,
            processedAt: lastArtifact?.data?.processedAt,
            sessionId: this.id,
            artifactType: lastArtifact.type,
          },
          {
            memoryType: CoALAMemoryType.EPISODIC,
            tags: ["signal", "processed", String(lastArtifact?.data?.provider?.name || "unknown")],
            relevanceScore: 0.6,
            confidence: 1.0,
          },
        );
      }
    });

    // Response channels now handled at daemon layer
    this.logger.debug("Session created without response channel", {
      sessionId: this.id,
      info: "Response channels are managed at the daemon layer",
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

    // Cleanup monitoring
    globalFSMMonitor.unregisterFSM("Session", this._fsmId);
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

  fail(error: Error): void {
    this.signals.callback.onError(error);
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

  // Response channel methods removed - handled at daemon layer
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
  private logger: Logger;

  constructor() {
    this.logger = logger.child({
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
  private logger: Logger;

  constructor(private fn: (result: any) => Promise<void>) {
    this.logger = logger.child({
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
