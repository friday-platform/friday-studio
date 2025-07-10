/**
 * XState reasoning machine for Think→Act→Observe loops
 */

import { assign, createMachine, emit, fromPromise, sendTo } from "xstate";
import type {
  ReasoningAction,
  ReasoningCallbacks,
  ReasoningContext,
  ReasoningResult,
  ReasoningStep,
} from "./types.ts";

export interface ReasoningMachineOptions {
  maxIterations?: number;
  supervisorId?: string;
  jobGoal?: string;
}

export function createReasoningMachine<TUserContext = any>(
  callbacks: ReasoningCallbacks<TUserContext>,
  options: ReasoningMachineOptions = {},
) {
  return createMachine({
    id: "reasoning",

    types: {} as {
      context: ReasoningContext<TUserContext>;
      input: TUserContext;
      output: ReasoningResult;
      events:
        | { type: "PAUSE" }
        | { type: "RESUME" }
        | { type: "ABORT" }
        | { type: "INSPECT" }
        | { type: "PROVIDE_HINT"; hint: string };
    },

    context: ({ input }) => ({
      userContext: input,
      currentStep: null,
      steps: [],
      workingMemory: new Map(),
      maxIterations: options.maxIterations || 10,
      currentIteration: 0,
    }),

    output: ({ context }) => {
      // Determine status based on final state and context
      const lastStep = context.steps[context.steps.length - 1];
      const isCompleted = lastStep?.action?.type === "complete" ||
        (context.currentIteration > 0 && context.steps.length > 0);
      const status = isCompleted ? "completed" : "failed";
      return createReasoningResult(context, status, options.jobGoal);
    },

    initial: "thinking",

    states: {
      thinking: {
        entry: [
          emit({ type: "reasoning.thinking.started" }),
          ({ context }) => {
            callbacks.onThinkingStart?.(context.userContext);
          },
        ],

        invoke: {
          src: fromPromise(async ({ input }) => {
            return await callbacks.think(input.context);
          }),
          input: ({ context }) => ({ context }),
          onDone: {
            target: "evaluating",
            actions: [
              assign({
                currentStep: ({ event, context }) => ({
                  thinking: event.output.thinking,
                  confidence: event.output.confidence,
                  action: null,
                  observation: "",
                  timestamp: Date.now(),
                  iteration: context.currentIteration + 1,
                  result: undefined,
                }),
                currentIteration: ({ context }) => context.currentIteration + 1,
              }),
              ({ event }) => {
                callbacks.onThinkingUpdate?.(event.output.thinking);
              },
            ],
          },
          onError: {
            target: "error",
            actions: assign({
              currentStep: ({ context }) => ({
                thinking: "Error during thinking",
                confidence: 0,
                action: null,
                observation: "Thinking failed",
                timestamp: Date.now(),
                iteration: context.currentIteration + 1,
                result: undefined,
              }),
            }),
          },
        },
      },

      evaluating: {
        entry: [
          assign({
            currentStep: ({ context }) => ({
              ...context.currentStep!,
              action: callbacks.parseAction(context.currentStep!.thinking),
            }),
          }),
          ({ context }) => {
            const action = callbacks.parseAction(context.currentStep!.thinking);
            if (action) {
              callbacks.onActionDetermined?.(action);
            }
          },
          emit(({ context }) => {
            const action = context.currentStep?.action;
            return action ? { type: "reasoning.action.determined", action } : undefined;
          }),
        ],

        always: [
          {
            target: "observing",
            guard: ({ context }) => context.currentStep?.action?.type === "complete",
            actions: assign({
              currentStep: ({ context }) => ({
                ...context.currentStep!,
                observation: "Reasoning complete.",
                result: { completed: true },
              }),
            }),
          },
          {
            target: "completed",
            guard: ({ context }) => {
              // Check custom completion
              if (callbacks.isComplete?.(context)) return true;
              // Check max iterations
              if (context.currentIteration >= context.maxIterations) return true;
              return false;
            },
          },
          {
            target: "executing",
            guard: ({ context }) => context.currentStep?.action !== null,
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
              : undefined
          ),
          ({ context }) => {
            if (context.currentStep?.action) {
              callbacks.onExecutionStart?.(context.currentStep.action);
            }
          },
        ],

        invoke: {
          src: fromPromise(async ({ input }) => {
            const startTime = Date.now();
            const result = await callbacks.executeAction(
              input.context.currentStep!.action!,
              input.context,
            );
            const duration = Date.now() - startTime;

            return { ...result, duration };
          }),
          input: ({ context }) => ({ context }),
          onDone: {
            target: "observing",
            actions: [
              assign({
                currentStep: ({ context, event }) => ({
                  ...context.currentStep!,
                  result: event.output.result,
                  observation: callbacks.formatObservation?.(event.output.result) ||
                    event.output.observation,
                }),
              }),
              ({ event }) => {
                callbacks.onObservation?.(event.output.observation);
              },
            ],
          },
          onError: {
            target: "observing",
            actions: assign({
              currentStep: ({ context, event }) => ({
                ...context.currentStep!,
                observation: `Action execution failed: ${event.error}`,
                result: null,
              }),
            }),
          },
        },
      },

      observing: {
        entry: [
          assign({
            steps: ({ context }) => {
              const newSteps = [...context.steps, context.currentStep!];
              return newSteps;
            },
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
          emit(({ context }) => ({
            type: "reasoning.step.completed",
            step: context.currentStep!,
          })),
          // Notify supervisor if configured
          ({ context, system }) => {
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
        ],
        // Transition after processing the observation
        always: [
          {
            target: "completed",
            guard: ({ context }) => {
              // Make sure we've added the current step to steps array
              const hasCurrentStepInArray = context.steps.some(
                (step) => step.timestamp === context.currentStep?.timestamp,
              );
              return hasCurrentStepInArray && context.currentStep?.action?.type === "complete";
            },
          },
        ],
        // Add a small delay to make observing state visible and ensure entry actions complete
        after: {
          50: [
            {
              target: "thinking",
            },
          ],
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
            actions: assign({
              workingMemory: ({ context, event }) => {
                const memory = new Map(context.workingMemory);
                memory.set("external_hint", event.hint);
                return memory;
              },
            }),
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

function createReasoningResult<T>(
  context: ReasoningContext<T>,
  status: "completed" | "failed" | "partial",
  jobGoal?: string,
): ReasoningResult {
  const agentsExecuted = context.steps
    .filter((step) => step.action?.type === "agent_call" && step.result)
    .map((step) => ({
      agentId: step.action!.agentId!,
      task: step.action!.parameters.task as string || "unknown",
      result: step.result,
      duration: 0, // Would need to track this
    }));

  const toolsExecuted = context.steps
    .filter((step) => step.action?.type === "tool_call" && step.result)
    .map((step) => ({
      toolName: step.action!.toolName!,
      parameters: step.action!.parameters,
      result: step.result,
      duration: 0,
    }));

  const lastStep = context.steps[context.steps.length - 1];
  const finalResult = lastStep?.result || lastStep?.observation || null;

  return {
    status,
    reasoning: {
      steps: context.steps,
      totalIterations: context.currentIteration,
      finalThinking: lastStep?.thinking || "",
      confidence: lastStep?.confidence || 0,
    },
    execution: {
      agentsExecuted,
      toolsExecuted,
      totalDuration: 0, // Would need to track start time
    },
    jobResults: {
      goal: jobGoal || "Process signal",
      achieved: status === "completed",
      output: finalResult,
      artifacts: Object.fromEntries(
        Array.from(context.workingMemory.entries())
          .filter(([key]) => key.startsWith("result_")),
      ),
    },
    metrics: {
      llmTokens: 0, // Would need to track
      llmCost: 0,
      agentCalls: agentsExecuted.length,
      toolCalls: toolsExecuted.length,
    },
  };
}
