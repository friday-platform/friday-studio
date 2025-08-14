/**
 * Agent Execution State Machine
 *
 * Defines the lifecycle states and transitions for agent execution in Atlas.
 * This is a pure XState machine definition that models how agents move through
 * their execution phases.
 *
 * Architecture:
 *   Session Supervisor
 *       ↓ (executes agents via)
 *   Agent Execution Manager
 *       ↓ (creates/manages)
 *   Agent Execution Machines (XState actors) <- YOU ARE HERE
 *       ↓ (when approval needed)
 *   Approval Queue Manager (stores suspended states)
 *
 * State Flow:
 *   idle → loading → ready → preparing → executing → persisting → completed
 *                                  ↓           ↓
 *                              awaiting ← (approval needed)
 */

import { type ActorRefFrom, assign, fromPromise, setup } from "xstate";
import {
  type AgentContext,
  type AgentSessionData,
  type AtlasAgent,
  AwaitingSupervisorDecision,
} from "@atlas/agent-sdk";
import { CoALAMemoryManager, CoALAMemoryType } from "@atlas/memory";
import type { Logger } from "@atlas/logger";
import type { CollectableStreamEmitter } from "../streaming/stream-emitters.ts";

// === Input/Output Types for State Machine Actors ===

type LoadAgentInput = { agentId: string };
type LoadAgentOutput = AtlasAgent;

type PrepareContextInput = {
  agent: AtlasAgent;
  prompt: string;
  sessionData: AgentSessionData;
};

export type PrepareContextOutput = {
  context: AgentContext;
  enrichedPrompt: string;
};

type ExecuteAgentInput = {
  agent: AtlasAgent;
  prompt: string;
  context: AgentContext;
};
type ExecuteAgentOutput = unknown;

type PersistResultsInput = {
  agentId: string;
  prompt: string;
  result: unknown;
  duration: number;
};
type PersistResultsOutput = void;

// === External Dependencies ===

type BuildAgentContext = (
  agent: AtlasAgent,
  sessionData: AgentSessionData,
  sessionMemory: CoALAMemoryManager | null,
  prompt: string,
  overrides?: Partial<AgentContext>,
) => Promise<PrepareContextOutput>;

/** Approval decision from supervisor */
export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  modifiedAction?: string;
  conditions?: string[];
}

/** Execution context tracked by the state machine */
export interface AgentExecutionContext {
  agentId: string;
  agent?: AtlasAgent;
  currentPrompt?: string;
  enrichedPrompt?: string;
  sessionData?: AgentSessionData;
  preparedContext?: AgentContext;
  result?: unknown;
  error?: Error;
  startTime?: number;
  endTime?: number;
  timeout: number;
  approvalDecision?: ApprovalDecision;
}

/** Events that drive state transitions */
export type AgentExecutionEvents =
  | { type: "LOAD" }
  | { type: "EXECUTE"; prompt: string; sessionData: AgentSessionData }
  | { type: "CANCEL" }
  | { type: "TIMEOUT" }
  | { type: "UNLOAD" }
  | { type: "RESUME_WITH_APPROVAL"; approvalId: string; decision: ApprovalDecision }
  | { type: "xstate.done.actor.loadAgent"; output: LoadAgentOutput }
  | { type: "xstate.done.actor.prepareContext"; output: PrepareContextOutput }
  | { type: "xstate.done.actor.executeAgent"; output: unknown }
  | { type: "xstate.done.actor.persistResults"; output: PersistResultsOutput }
  | { type: "xstate.error.actor.loadAgent"; error: unknown }
  | { type: "xstate.error.actor.prepareContext"; error: unknown }
  | { type: "xstate.error.actor.executeAgent"; error: unknown }
  | { type: "xstate.error.actor.persistResults"; error: unknown };

/** Initial configuration for state machine */
export interface AgentExecutionMachineInput {
  agentId: string;
  timeout?: number;
}

/**
 * Creates the agent execution state machine.
 *
 * @param loadAgentFn - Function to load agent code from registry
 * @param contextBuilder - Builds execution context with memory and tools
 * @param sessionMemory - CoALA memory manager (can be null)
 * @returns Configured XState machine
 */
export function createAgentExecutionMachine(
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
      loadAgent: fromPromise<LoadAgentOutput, LoadAgentInput>(
        async ({ input }) => {
          return await loadAgentFn(input.agentId);
        },
      ),

      prepareContext: fromPromise<PrepareContextOutput, PrepareContextInput>(
        async ({ input }) => {
          return await contextBuilder(
            input.agent,
            input.sessionData,
            sessionMemory,
            input.prompt,
          );
        },
      ),

      executeAgent: fromPromise<ExecuteAgentOutput, ExecuteAgentInput>(
        async ({ input }) => {
          // Execute agent and return raw result
          const result = await input.agent.execute(input.prompt, input.context);

          // Check if we used a CollectingStreamEmitter and include events
          if (input.context.stream && "getCollectedEvents" in input.context.stream) {
            const collectedEvents = (input.context.stream as CollectableStreamEmitter)
              .getCollectedEvents();
            if (collectedEvents && collectedEvents.length > 0) {
              // Include stream events in the result metadata
              return {
                result,
                metadata: {
                  streamEvents: collectedEvents,
                },
              };
            }
          }

          return result;
        },
      ),

      persistResults: fromPromise<PersistResultsOutput, PersistResultsInput>(({ input }) => {
        try {
          const coala = sessionMemory;
          if (!coala) {
            logger.debug("No session memory available; skipping episodic persistence");
            return Promise.resolve();
          }

          const eventId = `epi:${Date.now()}:${input.agentId}`;
          coala.rememberWithMetadata(
            eventId,
            {
              eventType: "agent_execution",
              agentId: input.agentId,
              prompt: input.prompt,
              output: input.result,
              duration: input.duration,
              timestamp: Date.now(),
            },
            // Using CoALAMemoryType enum for type safety
            {
              memoryType: CoALAMemoryType.EPISODIC,
              tags: ["agent_execution", "episodic", input.agentId],
              relevanceScore: Math.min(1, Math.max(0.3, input.duration / 5000)),
              confidence: 0.9,
            },
          );
        } catch (e) {
          logger.error("Failed to persist episodic result", { error: e });
        }
        return Promise.resolve();
      }),
    },

    actions: {
      assignAgent: assign({
        agent: ({ event }) => {
          if (event.type !== "xstate.done.actor.loadAgent") {
            return undefined;
          }
          return event.output;
        },
      }),

      assignExecutionParams: assign({
        currentPrompt: ({ event }) => {
          if (event.type !== "EXECUTE") {
            return undefined;
          }
          return event.prompt;
        },
        sessionData: ({ event }) => {
          if (event.type !== "EXECUTE") {
            return undefined;
          }
          return event.sessionData;
        },
        startTime: () => Date.now(),
      }),

      assignPreparedContext: assign({
        preparedContext: ({ event }) => {
          if (event.type !== "xstate.done.actor.prepareContext") {
            return undefined;
          }
          return event.output.context;
        },
        enrichedPrompt: ({ event }) => {
          if (event.type !== "xstate.done.actor.prepareContext") {
            return undefined;
          }
          return event.output.enrichedPrompt;
        },
      }),

      assignExecutionResult: assign({
        result: ({ event }) => {
          if (event.type !== "xstate.done.actor.executeAgent") {
            return undefined;
          }
          return event.output;
        },
        endTime: () => Date.now(),
      }),

      assignError: assign({
        error: ({ event }) => {
          if (
            event.type === "xstate.error.actor.loadAgent" ||
            event.type === "xstate.error.actor.prepareContext" ||
            event.type === "xstate.error.actor.executeAgent" ||
            event.type === "xstate.error.actor.persistResults"
          ) {
            return event.error instanceof Error ? event.error : new Error(String(event.error));
          }
          return undefined;
        },
      }),

      logLoading: ({ context }) => {
        logger.info("Loading agent", { agentId: context.agentId });
      },

      logLoaded: ({ context }) => {
        logger.info("Agent loaded", { agentId: context.agentId });
      },

      logPreparing: ({ context }) => {
        logger.info("Preparing context", {
          agentId: context.agentId,
          prompt: context.currentPrompt,
        });
      },

      logExecuting: ({ context }) => {
        logger.info("Executing agent", { agentId: context.agentId });
      },

      logPersisting: ({ context }) => {
        const duration = context.endTime && context.startTime
          ? context.endTime - context.startTime
          : 0;
        logger.info("Persisting results", {
          agentId: context.agentId,
          duration,
        });
      },

      logCompleted: ({ context }) => {
        const duration = context.endTime && context.startTime
          ? context.endTime - context.startTime
          : 0;
        logger.info("Agent completed", {
          agentId: context.agentId,
          duration,
        });
      },

      logError: ({ context }) => {
        logger.error("Agent error", {
          agentId: context.agentId,
          error: context.error,
        });
      },
    },

    guards: {
      isLoaded: ({ context }) => context.agent !== undefined,
      hasExecutionParams: ({ context }) =>
        context.currentPrompt !== undefined &&
        context.sessionData !== undefined,
    },
  });

  return machineSetup.createMachine({
    id: "agentExecution",

    context: ({ input }) => ({
      agentId: input.agentId,
      timeout: input.timeout || 300000, // 5 minutes default
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
            actions: ["assignAgent", "logLoaded"],
          },
          onError: {
            target: "failed",
            actions: ["assignError", "logError"],
          },
        },

        on: {
          CANCEL: {
            target: "idle",
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

        // TODO: Re-enable timeout once we figure out how to apply it only to execution
        // after: {
        //   [({ context }) => context.timeout]: {
        //     target: "failed",
        //     actions: assign({
        //       error: () => new Error("Agent execution timeout"),
        //     }),
        //   },
        // },

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

export type AgentExecutionMachine = ReturnType<typeof createAgentExecutionMachine>;
export type AgentExecutionMachineActor = ActorRefFrom<AgentExecutionMachine>;
