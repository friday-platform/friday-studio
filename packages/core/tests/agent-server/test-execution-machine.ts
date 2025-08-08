/**
 * Test state machine without timers - enables deterministic testing by removing
 * auto-transitions that would make test timing unpredictable.
 */

import { type ActorRefFrom, assign, fromPromise, setup } from "xstate";
import {
  type AgentContext,
  type AgentSessionData,
  type AtlasAgent,
  AwaitingSupervisorDecision,
} from "@atlas/agent-sdk";
import { CoALAMemoryManager } from "@atlas/memory";
import type { Logger } from "@atlas/logger";
import type { BuildAgentContext } from "../../src/agent-server/agent-execution-manager.ts";
import type {
  AgentExecutionContext,
  AgentExecutionEvents,
  AgentExecutionMachineInput,
  PrepareContextOutput,
} from "../../src/agent-server/agent-execution-machine.ts";

// Creates agent execution state machine without timers for predictable test execution
export function createTestAgentExecutionMachine(
  loadAgentFn: (agentId: string) => Promise<AtlasAgent>,
  contextBuilder: BuildAgentContext,
  sessionMemory: CoALAMemoryManager | null,
  logger: Logger,
) {
  const machineSetup = setup({
    types: {} as {
      context: AgentExecutionContext;
      input: AgentExecutionMachineInput;
      events: AgentExecutionEvents;
      children: {
        loadAgent: "loadAgent";
        prepareContext: "prepareContext";
        executeAgent: "executeAgent";
        persistResults: "persistResults";
      };
    },

    actors: {
      loadAgent: fromPromise<AtlasAgent, { agentId: string }>(
        async ({ input }) => {
          logger.info(`Loading agent: ${input.agentId}`);
          return await loadAgentFn(input.agentId);
        },
      ),

      prepareContext: fromPromise<
        PrepareContextOutput,
        {
          agent: AtlasAgent;
          prompt: string;
          sessionData: AgentSessionData;
        }
      >(async ({ input }) => {
        const { agent, prompt, sessionData } = input;
        logger.info(
          `Preparing context for agent: ${agent.metadata.name}, session: ${sessionData.sessionId}`,
        );

        // Build context with memory, tools, and session data
        const result = await contextBuilder(
          agent,
          sessionData,
          sessionMemory,
          prompt,
        );

        return result;
      }),

      executeAgent: fromPromise<
        unknown,
        {
          agent: AtlasAgent;
          prompt: string;
          context: AgentContext;
        }
      >(async ({ input }) => {
        const { agent, prompt, context } = input;
        logger.info(`Executing agent: ${agent.metadata.name}`);

        // Execute the agent's handler
        const result = await agent.handler(prompt, context);

        return result;
      }),

      persistResults: fromPromise<
        void,
        {
          agentId: string;
          prompt: string;
          result: unknown;
          duration: number;
        }
      >(({ input }) => {
        const { agentId, prompt, result, duration } = input;

        // TODO: Implement result persistence to CoALA memory
        logger.info(`Would persist results for ${agentId}`, {
          promptLength: prompt.length,
          duration,
          hasResult: result !== undefined,
        });

        // For now, just log success
        return Promise.resolve();
      }),
    },

    guards: {
      hasExecutionParams: ({ context }) => {
        return !!(context.currentPrompt && context.sessionData);
      },
    },

    actions: {
      assignExecutionParams: assign({
        currentPrompt: ({ event }) => event.type === "EXECUTE" ? event.prompt : undefined,
        sessionData: ({ event }) => event.type === "EXECUTE" ? event.sessionData : undefined,
        startTime: () => Date.now(),
      }),

      assignLoadedAgent: assign({
        agent: ({ event }) =>
          event.type === "xstate.done.actor.loadAgent" ? event.output : undefined,
      }),

      assignPreparedContext: assign({
        preparedContext: ({ event }) =>
          event.type === "xstate.done.actor.prepareContext" ? event.output.context : undefined,
        enrichedPrompt: ({ event }) =>
          event.type === "xstate.done.actor.prepareContext"
            ? event.output.enrichedPrompt
            : undefined,
      }),

      assignExecutionResult: assign({
        result: ({ event }) =>
          event.type === "xstate.done.actor.executeAgent" ? event.output : undefined,
        endTime: () => Date.now(),
      }),

      assignError: assign({
        error: ({ event }) => {
          if ("error" in event) {
            return event.error instanceof Error ? event.error : new Error(String(event.error));
          }
          return new Error("Unknown error");
        },
      }),

      logLoading: ({ context }) => {
        logger.info(`Loading agent: ${context.agentId}`);
      },

      logPreparing: ({ context }) => {
        logger.info(`Preparing context for agent: ${context.agentId}`);
      },

      logExecuting: ({ context }) => {
        logger.info(`Executing agent: ${context.agentId}`);
      },

      logPersisting: ({ context }) => {
        logger.info(`Persisting results for agent: ${context.agentId}`);
      },

      logCompleted: ({ context }) => {
        const duration = context.endTime && context.startTime
          ? context.endTime - context.startTime
          : 0;
        logger.info(
          `Agent execution completed: ${context.agentId} (${duration}ms)`,
        );
      },

      logError: ({ context }) => {
        logger.error(`Agent execution failed: ${context.agentId}`, {
          error: context.error,
        });
      },
    },
  });

  return machineSetup.createMachine({
    id: "agentExecution",

    context: ({ input }) => ({
      agentId: input.agentId,
      timeout: input.timeout || 30000,
    }),

    initial: "idle",

    states: {
      idle: {
        on: {
          LOAD: {
            target: "loading",
          },
          EXECUTE: {
            target: "loading",
            actions: "assignExecutionParams",
          },
        },
      },

      loading: {
        entry: "logLoading",

        invoke: {
          id: "loadAgent",
          src: "loadAgent",
          input: ({ context }) => ({ agentId: context.agentId }),
          onDone: {
            target: "ready",
            actions: ["assignLoadedAgent"],
          },
          onError: {
            target: "failed",
            actions: ["assignError", "logError"],
          },
        },
      },

      ready: {
        always: [
          {
            target: "preparing",
            guard: "hasExecutionParams",
          },
        ],

        on: {
          EXECUTE: {
            target: "preparing",
            actions: "assignExecutionParams",
          },
          UNLOAD: {
            target: "idle",
          },
        },
      },

      preparing: {
        entry: "logPreparing",

        invoke: {
          id: "prepareContext",
          src: "prepareContext",
          input: ({ context }) => ({
            agent: context.agent!,
            prompt: context.currentPrompt!,
            sessionData: context.sessionData!,
          }),
          onDone: {
            target: "executing",
            actions: "assignPreparedContext",
          },
          onError: {
            target: "failed",
            actions: ["assignError", "logError"],
          },
        },

        on: {
          CANCEL: {
            target: "ready",
          },
        },
      },

      executing: {
        entry: "logExecuting",

        invoke: {
          id: "executeAgent",
          src: "executeAgent",
          input: ({ context }) => ({
            agent: context.agent!,
            prompt: context.enrichedPrompt || context.currentPrompt!,
            context: context.preparedContext!,
          }),
          onDone: {
            target: "persisting",
            actions: ["assignExecutionResult"],
          },
          onError: [
            {
              // Check if it's an approval request
              target: "awaiting",
              guard: ({ event }) => {
                return event.error instanceof AwaitingSupervisorDecision;
              },
              actions: ["assignError"],
            },
            {
              // All other errors
              target: "failed",
              actions: ["assignError", "logError"],
            },
          ],
        },

        on: {
          CANCEL: {
            target: "ready",
          },
          AWAIT_INPUT: {
            target: "awaiting",
          },
        },
      },

      awaiting: {
        // Paused for supervisor approval
        on: {
          RESUME_WITH_APPROVAL: {
            target: "executing",
            actions: assign({
              approvalDecision: ({ event }) => event.decision,
            }),
          },
          CANCEL: {
            target: "failed",
            actions: assign({
              error: () => new Error("Approval cancelled"),
            }),
          },
        },
      },

      persisting: {
        entry: "logPersisting",

        invoke: {
          id: "persistResults",
          src: "persistResults",
          input: ({ context }) => ({
            agentId: context.agentId,
            prompt: context.currentPrompt!,
            result: context.result!,
            duration: context.endTime! - context.startTime!,
          }),
          onDone: {
            target: "completed",
            actions: "logCompleted",
          },
          onError: {
            // Don't fail the whole execution if persistence fails
            target: "completed",
            actions: ({ event }) => {
              logger.error("Failed to persist results", { error: event.error });
            },
          },
        },
      },

      completed: {
        on: {
          EXECUTE: {
            target: "preparing",
            actions: "assignExecutionParams",
          },
          UNLOAD: {
            target: "idle",
          },
        },
        // Timer removed - prevents auto-transition for deterministic testing
      },

      failed: {
        entry: "logError",

        on: {
          LOAD: {
            target: "loading",
          },
          EXECUTE: {
            target: "loading",
            actions: "assignExecutionParams",
          },
          UNLOAD: {
            target: "idle",
          },
        },
      },
    },
  });
}

export type TestAgentExecutionMachine = ReturnType<typeof createTestAgentExecutionMachine>;
export type TestAgentExecutionMachineActor = ActorRefFrom<TestAgentExecutionMachine>;
