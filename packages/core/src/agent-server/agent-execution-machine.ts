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
 *
 * State Flow:
 *   idle → loading → ready → preparing → executing → persisting → completed
 */

import type { AgentContext, AgentPayload, AgentSessionData, AtlasAgent } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { type ActorRefFrom, assign, fromPromise, setup } from "xstate";

// === Input/Output Types for State Machine Actors ===

type LoadAgentInput = { agentId: string };
type LoadAgentOutput = AtlasAgent;

type PrepareContextInput = {
  agent: AtlasAgent;
  prompt: string;
  sessionData: AgentSessionData;
  abortSignal?: AbortSignal;
  outputSchema?: Record<string, unknown>;
};

export type PrepareContextOutput = {
  context: AgentContext;
  enrichedPrompt: string;
  releaseMCPTools: () => Promise<void>;
};

type ExecuteAgentInput = { agent: AtlasAgent; prompt: string; context: AgentContext };
type ExecuteAgentOutput = AgentPayload<unknown>;

type PersistResultsInput = { agentId: string; prompt: string; result: unknown; duration: number };
// biome-ignore lint/suspicious/noConfusingVoidType: `void` is the correct type for the state machine state.
type PersistResultsOutput = void;

// === External Dependencies ===

type BuildAgentContext = (
  agent: AtlasAgent,
  sessionData: AgentSessionData,
  prompt: string,
  overrides?: Partial<AgentContext>,
) => Promise<PrepareContextOutput>;

/** Execution context tracked by the state machine */
interface AgentExecutionContext {
  agentId: string;
  agent?: AtlasAgent;
  currentPrompt?: string;
  enrichedPrompt?: string;
  sessionData?: AgentSessionData;
  abortSignal?: AbortSignal;
  outputSchema?: Record<string, unknown>;
  preparedContext?: AgentContext;
  releaseMCPTools?: () => Promise<void>;
  result?: AgentPayload<unknown>;
  error?: Error;
  startTime?: number;
  endTime?: number;
  timeout: number;
}

/** Events that drive state transitions */
type AgentExecutionEvents =
  | { type: "LOAD" }
  | {
      type: "EXECUTE";
      prompt: string;
      sessionData: AgentSessionData;
      abortSignal?: AbortSignal;
      outputSchema?: Record<string, unknown>;
    }
  | { type: "CANCEL" }
  | { type: "TIMEOUT" }
  | { type: "UNLOAD" }
  | { type: "xstate.done.actor.loadAgent"; output: LoadAgentOutput }
  | { type: "xstate.done.actor.prepareContext"; output: PrepareContextOutput }
  | { type: "xstate.done.actor.executeAgent"; output: AgentPayload<unknown> }
  | { type: "xstate.done.actor.persistResults"; output: PersistResultsOutput }
  | { type: "xstate.error.actor.loadAgent"; error: unknown }
  | { type: "xstate.error.actor.prepareContext"; error: unknown }
  | { type: "xstate.error.actor.executeAgent"; error: unknown }
  | { type: "xstate.error.actor.persistResults"; error: unknown };

/** Initial configuration for state machine */
interface AgentExecutionMachineInput {
  agentId: string;
  timeout?: number;
}

/**
 * Creates the agent execution state machine.
 *
 * @param loadAgentFn - Function to load agent code from registry
 * @param contextBuilder - Builds execution context with tools
 * @param logger - Logger instance
 * @returns Configured XState machine
 */
export function createAgentExecutionMachine(
  loadAgentFn: (agentId: string) => Promise<AtlasAgent>,
  contextBuilder: BuildAgentContext,
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
      loadAgent: fromPromise<LoadAgentOutput, LoadAgentInput>(async ({ input }) => {
        return await loadAgentFn(input.agentId);
      }),

      prepareContext: fromPromise<PrepareContextOutput, PrepareContextInput>(async ({ input }) => {
        // Pass abortSignal and outputSchema as overrides if present
        const overrides: Partial<AgentContext> = {};
        if (input.abortSignal) overrides.abortSignal = input.abortSignal;
        if (input.outputSchema) overrides.outputSchema = input.outputSchema;
        return await contextBuilder(
          input.agent,
          input.sessionData,
          input.prompt,
          Object.keys(overrides).length > 0 ? overrides : undefined,
        );
      }),

      executeAgent: fromPromise<ExecuteAgentOutput, ExecuteAgentInput>(async ({ input }) => {
        // Execute agent and return raw result
        const result = await input.agent.execute(input.prompt, input.context);
        return result;
      }),

      persistResults: fromPromise<PersistResultsOutput, PersistResultsInput>(
        ({ input: _input }) => {
          // Memory persistence removed - TEM-3631
          // This actor is kept as a placeholder for future persistence mechanisms
          return Promise.resolve();
        },
      ),
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
        abortSignal: ({ event }) => {
          if (event.type !== "EXECUTE") {
            return undefined;
          }
          return event.abortSignal;
        },
        outputSchema: ({ event }) => {
          if (event.type !== "EXECUTE") {
            return undefined;
          }
          return event.outputSchema;
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
        releaseMCPTools: ({ event }) => {
          if (event.type !== "xstate.done.actor.prepareContext") {
            return undefined;
          }
          return event.output.releaseMCPTools;
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
        const duration =
          context.endTime && context.startTime ? context.endTime - context.startTime : 0;
        logger.info("Persisting results", { agentId: context.agentId, duration });
      },

      // XState v5 actions are synchronous — cannot await the Promise.
      // Fire-and-forget with .catch() so cleanup errors are logged instead of silently swallowed.
      releaseMCPTools: ({ context }) => {
        context.releaseMCPTools?.().catch((err: unknown) => {
          logger.warn("MCP tool cleanup failed", { error: err });
        });
      },

      logCompleted: ({ context }) => {
        const duration =
          context.endTime && context.startTime ? context.endTime - context.startTime : 0;
        logger.info("Agent completed", { agentId: context.agentId, duration });
      },

      logError: ({ context }) => {
        const isCancellation =
          context.error &&
          (context.error.message?.includes("cancelled") ||
            context.error.message?.includes("aborted"));

        if (isCancellation) {
          logger.info("Agent execution cancelled", { agentId: context.agentId });
        } else {
          logger.error("Agent error", { agentId: context.agentId, error: context.error });
        }
      },
    },

    guards: {
      isLoaded: ({ context }) => context.agent !== undefined,
      hasExecutionParams: ({ context }) =>
        context.currentPrompt !== undefined && context.sessionData !== undefined,
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
          LOAD: { target: "loading" },
          EXECUTE: { target: "loading", actions: "assignExecutionParams" },
        },
      },

      loading: {
        entry: "logLoading",

        invoke: {
          id: "loadAgent",
          src: "loadAgent",
          input: ({ context }) => ({ agentId: context.agentId }),
          onDone: { target: "ready", actions: ["assignAgent", "logLoaded"] },
          onError: { target: "failed", actions: ["assignError", "logError"] },
        },

        on: { CANCEL: { target: "idle" } },
      },

      ready: {
        always: [{ target: "preparing", guard: "hasExecutionParams" }],

        on: {
          EXECUTE: { target: "preparing", actions: "assignExecutionParams" },
          UNLOAD: { target: "idle" },
        },
      },

      preparing: {
        entry: "logPreparing",

        invoke: {
          id: "prepareContext",
          src: "prepareContext",
          input: ({ context }) => {
            if (!context.agent) {
              throw new Error("Agent not loaded");
            }
            if (!context.currentPrompt) {
              throw new Error("No prompt provided");
            }
            if (!context.sessionData) {
              throw new Error("No session data provided");
            }
            return {
              agent: context.agent,
              prompt: context.currentPrompt,
              sessionData: context.sessionData,
              abortSignal: context.abortSignal,
              outputSchema: context.outputSchema,
            };
          },
          onDone: { target: "executing", actions: "assignPreparedContext" },
          onError: { target: "failed", actions: ["assignError", "logError"] },
        },

        on: { CANCEL: { target: "ready" } },
      },

      executing: {
        entry: "logExecuting",
        exit: "releaseMCPTools",

        invoke: {
          id: "executeAgent",
          src: "executeAgent",
          input: ({ context }) => {
            if (!context.agent) {
              throw new Error("Agent not loaded");
            }
            if (!context.currentPrompt) {
              throw new Error("No prompt provided");
            }
            if (!context.preparedContext) {
              throw new Error("Context not prepared");
            }
            return {
              agent: context.agent,
              prompt: context.enrichedPrompt || context.currentPrompt,
              context: context.preparedContext,
            };
          },
          onDone: { target: "persisting", actions: ["assignExecutionResult"] },
          onError: { target: "failed", actions: ["assignError", "logError"] },
        },
        on: { CANCEL: { target: "ready" } },
      },

      persisting: {
        entry: "logPersisting",

        invoke: {
          id: "persistResults",
          src: "persistResults",
          input: ({ context }) => {
            if (!context.currentPrompt) {
              throw new Error("No prompt to persist");
            }
            if (context.result === undefined) {
              throw new Error("No result to persist");
            }
            if (context.endTime === undefined || context.startTime === undefined) {
              throw new Error("Invalid execution time");
            }
            return {
              agentId: context.agentId,
              prompt: context.currentPrompt,
              result: context.result,
              duration: context.endTime - context.startTime,
            };
          },
          onDone: { target: "completed", actions: "logCompleted" },
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
          EXECUTE: { target: "preparing", actions: "assignExecutionParams" },
          UNLOAD: { target: "idle" },
        },
      },

      failed: {
        entry: "logError",

        on: {
          LOAD: { target: "loading" },
          EXECUTE: { target: "loading", actions: "assignExecutionParams" },
          UNLOAD: { target: "idle" },
        },
      },
    },
  });
}

type AgentExecutionMachine = ReturnType<typeof createAgentExecutionMachine>;
export type AgentExecutionMachineActor = ActorRefFrom<AgentExecutionMachine>;
