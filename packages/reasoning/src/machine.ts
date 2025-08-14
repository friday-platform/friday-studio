/**
 * XState reasoning machine using the setup API for Think→Act→Observe loops
 */

import { type ActorRefFrom, assign, emit, fromPromise, setup } from "xstate";
import type {
  BaseReasoningContext,
  ReasoningAction,
  ReasoningCallbacks,
  ReasoningContext,
  ReasoningResult,
  ReasoningThinking,
} from "./types.ts";
import { ReasoningResultStatus, type ReasoningResultStatusType } from "@atlas/core";

// Define the output types for actors
type ThinkOutput = {
  thinking: ReasoningThinking;
  confidence: number;
};

type ExecuteActionOutput = {
  result: unknown;
  observation: string;
  duration?: number;
};

type EvaluateOutput = {
  isComplete: boolean;
};

// Define event types for the machine, including done/error events from invoked actors
type ReasoningEvents =
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "ABORT" }
  | { type: "INSPECT" }
  | { type: "PROVIDE_HINT"; hint: string }
  | { type: "xstate.done.actor.thinkActor"; output: ThinkOutput }
  | { type: "xstate.done.actor.executeActionActor"; output: ExecuteActionOutput }
  | { type: "xstate.done.actor.evaluateActor"; output: EvaluateOutput }
  | { type: "xstate.error.actor.thinkActor"; error: unknown }
  | { type: "xstate.error.actor.executeActionActor"; error: unknown }
  | { type: "xstate.error.actor.evaluateActor"; error: unknown };

export interface ReasoningMachineOptions {
  maxIterations?: number;
  supervisorId?: string;
  jobGoal?: string;
}

export function createReasoningMachine<TUserContext extends BaseReasoningContext>(
  callbacks: ReasoningCallbacks<TUserContext>,
  options: ReasoningMachineOptions = {},
) {
  const reasoningMachineSetup = setup({
    types: {
      context: {} as ReasoningContext<TUserContext>,
      input: {} as TUserContext,
      output: {} as ReasoningResult,
      events: {} as ReasoningEvents,
    },

    // Define actors
    actors: {
      think: fromPromise<
        ThinkOutput,
        { context: ReasoningContext<TUserContext> }
      >(async ({ input }) => {
        return await callbacks.think(input.context);
      }),

      executeAction: fromPromise<
        ExecuteActionOutput,
        { action: ReasoningAction; context: ReasoningContext<TUserContext> }
      >(async ({ input }) => {
        const startTime = Date.now();
        const result = await callbacks.executeAction(
          input.action,
          input.context,
        );
        const duration = Date.now() - startTime;
        return { ...result, duration };
      }),

      evaluate: fromPromise<
        EvaluateOutput,
        { context: ReasoningContext<TUserContext> }
      >(async ({ input }) => {
        if (!callbacks.evaluate) {
          throw new Error("Evaluate callback not provided");
        }
        return await callbacks.evaluate(input.context);
      }),
    },

    // Define actions
    actions: {
      assignThinkingResult: assign({
        currentStep: ({ event, context }) => {
          // Type guard to ensure we have the right event type
          if (event.type !== "xstate.done.actor.thinkActor") {
            return context.currentStep;
          }
          return {
            thinking: event.output.thinking,
            confidence: event.output.confidence,
            action: null,
            observation: "",
            timestamp: Date.now(),
            iteration: context.currentIteration + 1,
            result: undefined,
            isComplete: false,
            completion: event.output, // Store full completion object
          };
        },
        currentIteration: ({ context }) => context.currentIteration + 1,
      }),

      assignActionToStep: assign({
        currentStep: ({ context }) => {
          if (!context.currentStep) {
            return context.currentStep;
          }
          return {
            ...context.currentStep,
            action: callbacks.parseAction(context.currentStep.thinking),
          };
        },
      }),

      assignActionResult: assign({
        currentStep: ({ context, event }) => {
          if (event.type !== "xstate.done.actor.executeActionActor") {
            return context.currentStep;
          }
          if (!context.currentStep) {
            return context.currentStep;
          }
          return {
            ...context.currentStep,
            result: event.output.result,
            observation: event.output.observation,
          };
        },
      }),

      assignObservationToStep: assign({
        currentStep: ({ context }) => {
          if (!context.currentStep) {
            return {
              thinking: { text: "Reasoning complete.", toolCalls: [] },
              confidence: 1,
              action: null,
              observation: "Reasoning complete.",
              timestamp: Date.now(),
              iteration: context.currentIteration,
              result: { completed: true },
              isComplete: true,
            };
          }
          return {
            ...context.currentStep,
            observation: "Reasoning complete.",
            result: { completed: true },
          };
        },
      }),

      addStepToHistory: assign({
        steps: ({ context }) => [...context.steps, context.currentStep!],
        workingMemory: ({ context }) => {
          const memory = new Map(context.workingMemory);
          memory.set(`step_${context.steps.length}`, context.currentStep);
          // Store result in working memory
          if (context.currentStep?.result) {
            memory.set(`result_${context.steps.length}`, context.currentStep.result);
          }
          return memory;
        },
      }),

      assignThinkingError: assign({
        currentStep: ({ context }) => ({
          thinking: { text: "Error during thinking", toolCalls: [] },
          confidence: 0,
          action: null,
          observation: "Thinking failed",
          timestamp: Date.now(),
          iteration: context.currentIteration + 1,
          result: undefined,
          isComplete: true,
        }),
      }),

      assignExecutionError: assign({
        currentStep: ({ context, event }) => {
          if (event.type !== "xstate.error.actor.executeActionActor") {
            return context.currentStep;
          }
          return {
            ...context.currentStep!,
            observation: `Action execution failed: ${event.error}`,
            result: null,
          };
        },
      }),

      assignExternalHint: assign({
        workingMemory: ({ context, event }) => {
          if (event.type !== "PROVIDE_HINT") {
            return context.workingMemory;
          }
          const memory = new Map(context.workingMemory);
          memory.set("external_hint", event.hint);
          return memory;
        },
      }),

      onThinkingStart: ({ context }) => {
        callbacks.onThinkingStart?.(context.userContext);
      },

      onThinkingUpdate: ({ event }) => {
        if (event.type === "xstate.done.actor.thinkActor") {
          callbacks.onThinkingUpdate?.(event.output.thinking);
        }
      },

      onActionDetermined: ({ context }) => {
        if (!context.currentStep) {
          return;
        }
        const action = callbacks.parseAction(context.currentStep.thinking);
        if (action) {
          callbacks.onActionDetermined?.(action);
        }
      },

      onExecutionStart: ({ context }) => {
        if (context.currentStep?.action) {
          callbacks.onExecutionStart?.(context.currentStep.action);
        }
      },

      onObservation: ({ event }) => {
        if (event.type === "xstate.done.actor.executeActionActor") {
          callbacks.onObservation?.(event.output.observation);
        }
      },

      notifySupervisor: ({ context, system }) => {
        if (options.supervisorId) {
          const supervisor = system.get(options.supervisorId);
          if (supervisor) {
            supervisor.send({
              type: "REASONING_STEP_COMPLETED",
              step: context.currentStep,
              totalSteps: context.steps.length,
            });
          }
        }
      },
    },

    // Define guards
    guards: {
      isComplete: ({ context }) => {
        return context.currentStep?.action?.type === "complete";
      },

      shouldTerminate: ({ context }) => {
        // Check custom completion
        if (callbacks.isComplete?.(context)) return true;
        // Check max iterations
        if (context.currentIteration >= context.maxIterations) return true;
        return false;
      },

      hasValidAction: ({ context }) => {
        return context.currentStep !== null && context.currentStep.action !== null;
      },

      hasCompletedStep: ({ context }) => {
        // Make sure we've added the current step to steps array
        const hasCurrentStepInArray = context.steps.some(
          (step) => step.timestamp === context.currentStep?.timestamp,
        );
        return hasCurrentStepInArray && context.currentStep?.action?.type === "complete";
      },
    },
  });

  // Create the machine using the setup configuration
  return reasoningMachineSetup.createMachine({
    id: "reasoning",

    context: ({ input }) => ({
      userContext: input,
      currentStep: null,
      steps: [],
      workingMemory: new Map(),
      maxIterations: options.maxIterations || 10,
      currentIteration: 0,
      tools: input.tools,
    }),

    output: ({ context, event }) => {
      // Determine status based on final state and context
      const lastStep = context.steps[context.steps.length - 1];
      const isCompleted = context.currentStep?.isComplete === true ||
        lastStep?.action?.type === "complete" ||
        (event.type === "xstate.done.state.reasoning.evaluating" &&
          context.currentStep?.isComplete);

      const status = isCompleted ? ReasoningResultStatus.COMPLETED : ReasoningResultStatus.FAILED;
      return createReasoningResult<TUserContext>(context, status, options.jobGoal);
    },

    initial: "thinking",

    states: {
      thinking: {
        entry: [
          emit({ type: "reasoning.thinking.started" }),
          "onThinkingStart",
        ],

        invoke: {
          id: "thinkActor",
          src: "think",
          input: ({ context }) => ({ context }),
          onDone: {
            target: "evaluating",
            actions: [
              "assignThinkingResult",
              "onThinkingUpdate",
            ],
          },
          onError: {
            target: "error",
            actions: "assignThinkingError",
          },
        },
      },

      evaluating: {
        entry: [
          "assignActionToStep",
          "onActionDetermined",
          emit(({ context }) => {
            const action = context.currentStep?.action;
            return action
              ? { type: "reasoning.action.determined", action }
              : { type: "reasoning.action.none" };
          }),
        ],

        always: [
          // If action is to complete, go to observing to record the step, then complete.
          {
            target: "observing",
            guard: "isComplete",
            actions: "assignObservationToStep",
          },
          // If there's an action, execute it.
          {
            target: "executing",
            guard: ({ context }) => context.currentStep?.action !== null,
            actions: [
              emit(({ context }) => ({
                type: "reasoning.action.determined",
                action: context.currentStep!.action!,
              })),
            ],
          },
          // If there is NO action, check if the thinking step decided we are done.
          {
            target: "completed",
            guard: ({ context }) => context.currentStep?.isComplete === true,
          },
          // Check max iterations
          {
            target: "completed",
            guard: "shouldTerminate",
          },
          {
            target: "executing",
            guard: "hasValidAction",
          },
          {
            target: "stuck",
          },
        ],
      },

      executing: {
        entry: [
          emit(({ context }) =>
            context.currentStep?.action
              ? { type: "reasoning.execution.started", action: context.currentStep.action }
              : { type: "reasoning.execution.no_action" }
          ),
          "onExecutionStart",
        ],

        invoke: {
          id: "executeActionActor",
          src: "executeAction",
          input: ({ context }) => ({
            action: context.currentStep!.action!,
            context,
          }),
          onDone: {
            target: "observing",
            actions: [
              "assignActionResult",
              "onObservation",
            ],
          },
          onError: {
            target: "observing",
            actions: "assignExecutionError",
          },
        },
      },

      observing: {
        entry: [
          "addStepToHistory",
          emit(({ context }) => ({
            type: "reasoning.step.completed",
            step: context.currentStep!,
          })),
          "notifySupervisor",
        ],
        // Transition after processing the observation
        always: [
          {
            target: "completed",
            guard: "hasCompletedStep",
          },
          {
            target: "evaluatingGoal",
            guard: () => typeof callbacks.evaluate === "function",
          },
          {
            target: "thinking",
          },
        ],
      },

      evaluatingGoal: {
        invoke: {
          id: "evaluateActor",
          src: "evaluate",
          input: ({ context }) => ({ context }),
          onDone: [
            {
              target: "completed",
              guard: ({ event }) => {
                if (event.type !== "xstate.done.actor.evaluateActor") {
                  return false;
                }
                return event.output.isComplete;
              },
            },
            {
              target: "thinking",
            },
          ],
          onError: {
            target: "thinking", // Fallback to thinking on evaluation error
          },
        },
      },

      paused: {
        on: {
          RESUME: "thinking",
          INSPECT: {
            actions: [
              emit(({ context }) => ({
                type: "INSPECTION_RESULT",
                state: {
                  currentStep: context.currentStep,
                  totalSteps: context.steps.length,
                  workingMemory: Object.fromEntries(context.workingMemory),
                  currentIteration: context.currentIteration,
                },
              })),
            ],
          },
        },
      },

      stuck: {
        entry: emit({ type: "reasoning.stuck" }),
        on: {
          PROVIDE_HINT: {
            target: "thinking",
            actions: "assignExternalHint",
          },
        },
      },

      error: {
        type: "final",
      },

      completed: {
        type: "final",
        entry: emit({ type: "reasoning.completed" }),
      },
    },

    on: {
      PAUSE: ".paused",
      ABORT: ".completed",
    },
  });
}

// Export type helpers for consumers
export type ReasoningMachine<TUserContext extends BaseReasoningContext> = ReturnType<
  typeof createReasoningMachine<TUserContext>
>;

export type ReasoningMachineActor<TUserContext extends BaseReasoningContext> = ActorRefFrom<
  ReasoningMachine<TUserContext>
>;

// Helper function to create the reasoning result
function createReasoningResult<TUserContext extends BaseReasoningContext>(
  context: ReasoningContext<TUserContext>,
  status: ReasoningResultStatusType,
  jobGoal?: string,
): ReasoningResult {
  const { steps, workingMemory } = context;
  const lastStep = steps[steps.length - 1];

  // Aggregate execution details and metrics from all steps
  const initialMetrics = {
    agentCalls: 0,
    toolCalls: 0,
    totalDuration: 0,
  };

  const { agentsExecuted, toolsExecuted, metrics } = steps.reduce(
    (acc, step) => {
      if (step.action?.type === "agent_call" && step.result) {
        acc.agentsExecuted.push({
          agentId: step.action.agentId!,
          parameters: step.action.parameters,
          result: step.result,
          duration: 0, // Placeholder
        });
        acc.metrics.agentCalls++;
      } else if (step.action?.type === "tool_call" && step.result) {
        acc.toolsExecuted.push({
          toolName: step.action.toolName!,
          parameters: step.action.parameters,
          result: step.result,
          duration: 0, // Placeholder
        });
        acc.metrics.toolCalls++;
      }
      return acc;
    },
    {
      agentsExecuted: [] as any[],
      toolsExecuted: [] as any[],
      metrics: initialMetrics,
    },
  );

  const finalThinking = lastStep?.thinking;
  const finalConfidence = lastStep?.confidence ?? 0;

  return {
    status: status,
    reasoning: {
      steps: steps,
      totalIterations: context.currentIteration,
      finalThinking: typeof finalThinking === "string"
        ? finalThinking
        : finalThinking
        ? JSON.stringify(finalThinking)
        : "No final thinking.",
      confidence: finalConfidence,
    },
    execution: {
      agentsExecuted,
      toolsExecuted,
      totalDuration: metrics.totalDuration,
    },
    jobResults: {
      goal: jobGoal || "Process signal",
      achieved: status === ReasoningResultStatus.COMPLETED,
      output: lastStep?.result || lastStep?.observation || null,
      artifacts: Object.fromEntries(
        Array.from(workingMemory.entries())
          .filter(([key]) => key.startsWith("result_")),
      ),
    },
    metrics: {
      agentCalls: metrics.agentCalls,
      toolCalls: metrics.toolCalls,
    },
  };
}
