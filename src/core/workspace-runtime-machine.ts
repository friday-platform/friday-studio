/**
 * Workspace Runtime Machine - XState 5 implementation
 * Replaces worker-based supervisor management with direct actor orchestration
 */

import { existsSync } from "node:fs";
import process from "node:process";
import type { AtlasAgent, AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { ConfigLoader, type JobSpecification, type MergedConfig } from "@atlas/config";
import type { WorkspaceSupervisorConfig, WrappedAgentResult } from "@atlas/core";
import {
  AgentOrchestrator,
  convertLLMToAgent,
  createErrorCause,
  type GlobalMCPServerPool,
  LLMProvider,
  throwWithCause,
  WorkspaceSessionStatus,
} from "@atlas/core";
import { logger } from "@atlas/logger";
import { MCPServerRegistry } from "@atlas/mcp";
import {
  createSessionMemoryHooks,
  type SessionMemoryHooks,
  WorkspaceMemoryManager,
} from "@atlas/memory";
import { ProviderRegistry, ProviderType } from "@atlas/signals";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { load } from "@std/dotenv";
import { join } from "@std/path";
import { assign, fromPromise, setup } from "xstate";
import type { IWorkspace, IWorkspaceSession, IWorkspaceSignal } from "../types/core.ts";
import {
  type ProcessSignalResult,
  WorkspaceSupervisorActor,
} from "./actors/workspace-supervisor-actor.ts";
import { Session } from "./session.ts";
import type { LibraryStorageAdapter } from "./storage/library-storage-adapter.ts";
import type { JobDirectParams } from "./types/job.ts";

interface StreamSignalData {
  runtimeSignal: unknown; // Runtime signal instance
  signalConfig: { provider: string; [key: string]: unknown };
}

interface WorkspaceRuntimeContext {
  workspace: IWorkspace;
  config: MergedConfig;
  options: {
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
  };
  mcpServerPool?: GlobalMCPServerPool;
  daemonUrl?: string;
  supervisor?: WorkspaceSupervisorActor;
  agentOrchestrator?: AgentOrchestrator;
  memoryManager?: WorkspaceMemoryManager;
  sessionMemoryHooks?: SessionMemoryHooks;
  sessions: Map<string, IWorkspaceSession>;
  activeStreamSignals: Map<string, StreamSignalData>;
  isShuttingDown: boolean;
  error?: Error;
  stats: {
    totalSignalsProcessed: number;
    totalSessionsCreated: number;
    activeSessionCount: number;
  };
}

type WorkspaceRuntimeEvent =
  | { type: "INITIALIZE" }
  | {
      type: "PROCESS_SIGNAL";
      signal: IWorkspaceSignal;
      payload: Record<string, unknown>;
      sessionId?: string;
      streamId?: string;
      traceHeaders?: Record<string, string>;
      onStreamEvent?: (event: AtlasUIMessageChunk) => void;
    }
  | {
      type: "EXECUTE_JOB";
      sessionId: string;
      jobName: string;
      jobSpec: JobSpecification;
      params: JobDirectParams;
    }
  | { type: "SESSION_CREATED"; sessionId: string }
  | { type: "SESSION_COMPLETED"; sessionId: string; result?: Record<string, unknown> }
  | { type: "SESSION_FAILED"; sessionId: string; error: string }
  | { type: "SHUTDOWN" }
  | { type: "ERROR"; error: Error }
  | { type: "STORE_SESSION_RESULT"; sessionId: string; result: ProcessSignalResult }
  | {
      type: "xstate.done.actor.initializeWorkspace";
      output: {
        supervisor: WorkspaceSupervisorActor;
        mergedConfig: MergedConfig;
        agentOrchestrator: AgentOrchestrator;
        memoryManager?: WorkspaceMemoryManager;
        sessionMemoryHooks?: SessionMemoryHooks;
      };
    }
  | {
      type: "xstate.done.actor.initializeStreams";
      output: { activeStreamSignals: Map<string, StreamSignalData> };
    }
  | { type: "xstate.done.actor.shutdownWorkspace"; output: { shutdown: boolean } };

// Define input type for the machine
export interface WorkspaceRuntimeMachineInput {
  workspace: IWorkspace;
  config: MergedConfig;
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

// Setup the machine with proper typing
const workspaceRuntimeMachineSetup = setup({
  types: {
    context: {} as WorkspaceRuntimeContext,
    events: {} as WorkspaceRuntimeEvent,
    input: {} as WorkspaceRuntimeMachineInput,
  },
  actors: {
    initializeWorkspace: fromPromise<
      {
        supervisor: WorkspaceSupervisorActor;
        mergedConfig: MergedConfig;
        agentOrchestrator: AgentOrchestrator;
        memoryManager?: WorkspaceMemoryManager;
        sessionMemoryHooks?: SessionMemoryHooks;
      },
      { context: WorkspaceRuntimeContext }
    >(async ({ input }) => {
      const { context } = input;
      const startTime = Date.now();

      logger.info("Initializing workspace runtime", {
        workspaceId: context.workspace.id,
        hasConfig: !!context.config,
        workspacePath: context.options.workspacePath,
        timestamp: new Date().toISOString(),
      });

      // Load workspace .env file if available
      if (context.options.workspacePath) {
        try {
          const envFilePath = join(context.options.workspacePath, ".env");
          if (existsSync(envFilePath)) {
            const envVars = await load({ export: true, envPath: envFilePath });

            // CRITICAL FIX: @std/dotenv with export:true does NOT override existing env vars
            // We need to explicitly set them to override parent process values
            for (const [key, value] of Object.entries(envVars)) {
              process.env[key] = value;
            }

            logger.debug("Loaded workspace .env file", {
              workspaceId: context.workspace.id,
              envPath: envFilePath,
              envVarsCount: Object.keys(envVars).length,
            });
          }
        } catch (error) {
          const errorCause = createErrorCause(error);
          logger.debug("Could not load workspace .env file", {
            workspaceId: context.workspace.id,
            error: error,
            errorCause,
          });
        }
      }

      // Load or use provided configuration
      let mergedConfig: MergedConfig;
      const workspacePath = context.options.workspacePath || getAtlasHome();

      if (context.config) {
        mergedConfig = context.config;
        logger.debug("Using provided configuration", { workspaceId: context.workspace.id });
      } else {
        // Load configuration from disk
        logger.debug("Loading configuration from disk", { workspaceId: context.workspace.id });
        const workspacePath = context.options.workspacePath || getAtlasHome();
        const adapter = new FilesystemConfigAdapter(workspacePath);
        const configLoader = new ConfigLoader(adapter, workspacePath);
        mergedConfig = await configLoader.load();
      }

      // Create typed configuration slice for WorkspaceSupervisor
      const supervisorConfig: WorkspaceSupervisorConfig = {
        workspaceId: context.workspace.id,
        workspacePath: workspacePath,
        workspace: mergedConfig.workspace.workspace,
        signals: mergedConfig.workspace.signals || {},
        jobs: mergedConfig.workspace.jobs || {},
        memory: mergedConfig.atlas?.memory,
        tools: mergedConfig.workspace.tools,
        supervisorDefaults: mergedConfig.atlas?.supervisors,
      };

      // Register MCP servers from workspace configuration
      await registerMCPServers(mergedConfig, context.workspace.id);

      // Create WorkspaceSupervisorActor with config
      const supervisor = new WorkspaceSupervisorActor(
        context.workspace.id,
        supervisorConfig,
        crypto.randomUUID(),
      );

      // Initialize supervisor with standard params
      supervisor.initialize({ actorId: supervisor.id });

      // Set agents from the merged config
      if (mergedConfig.workspace.agents) {
        supervisor.setAgents(mergedConfig.workspace.agents);
        logger.info("Agents set on supervisor", {
          workspaceId: context.workspace.id,
          agentCount: Object.keys(mergedConfig.workspace.agents).length,
          agentIds: Object.keys(mergedConfig.workspace.agents),
        });
      }

      // Create Agent Orchestrator for MCP-based agent execution
      const agentOrchestrator = new AgentOrchestrator(
        {
          agentsServerUrl: `http://localhost:8080/agents`,
          headers: { "X-Atlas-Workspace-ID": context.workspace.id },
          mcpServerPool: context.options.mcpServerPool,
          daemonUrl: context.options.daemonUrl,
        },
        logger.child({ component: "AgentOrchestrator", workspaceId: context.workspace.id }),
      );

      // Initialize the orchestrator
      await agentOrchestrator.initialize();

      logger.info("Agent orchestrator initialized", { workspaceId: context.workspace.id });

      // Auto-wrap LLM agents from workspace config
      if (mergedConfig.workspace.agents) {
        let wrappedCount = 0;
        for (const [agentId, agentConfig] of Object.entries(mergedConfig.workspace.agents)) {
          if (agentConfig.type === "llm") {
            logger.info(`Auto-wrapping LLM agent: ${agentId}`, {
              workspaceId: context.workspace.id,
            });

            try {
              // Convert LLM config to SDK agent
              const wrappedAgent: AtlasAgent<string, WrappedAgentResult> = convertLLMToAgent(
                agentConfig,
                agentId,
                logger.child({ component: "LLMAgentWrapper", agentId }),
              );

              // Register with orchestrator for direct execution
              agentOrchestrator.registerWrappedAgent(agentId, wrappedAgent);
              wrappedCount++;

              logger.info(`Successfully wrapped and registered LLM agent: ${agentId}`, {
                workspaceId: context.workspace.id,
                agentId: wrappedAgent.metadata.id,
                domains: wrappedAgent.metadata.expertise.domains,
              });
            } catch (error) {
              const errorCause = createErrorCause(error);
              logger.error(`Failed to wrap LLM agent ${agentId}:`, {
                workspaceId: context.workspace.id,
                error: error,
                errorCause,
              });
              // Continue with other agents
            }
          }
        }

        if (wrappedCount > 0) {
          logger.info("LLM agent wrapping completed", {
            workspaceId: context.workspace.id,
            wrappedCount,
          });
        }
      }

      // Pass orchestrator to workspace supervisor
      supervisor.setAgentOrchestrator(agentOrchestrator);

      const initDuration = Date.now() - startTime;
      logger.info("Workspace supervisor actor initialized", {
        workspaceId: context.workspace.id,
        supervisorId: `supervisor-${context.workspace.id}`,
        agentsCount: Object.keys(mergedConfig.workspace.agents || {}).length,
        initDurationMs: initDuration,
        timestamp: new Date().toISOString(),
      });

      // Initialize memory manager if memory configuration is available
      let memoryManager: WorkspaceMemoryManager | undefined;
      let sessionMemoryHooks: SessionMemoryHooks | undefined;

      if (mergedConfig.workspace?.memory) {
        try {
          memoryManager = new WorkspaceMemoryManager(mergedConfig.workspace.memory);
          sessionMemoryHooks = createSessionMemoryHooks(memoryManager);

          logger.info("Memory manager initialized", {
            workspaceId: context.workspace.id,
            sessionBridge: mergedConfig.workspace.memory.sessionBridge?.enabled,
            worklog: mergedConfig.workspace.memory.worklog?.enabled,
          });
        } catch (error) {
          const errorCause = createErrorCause(error);
          logger.warn("Failed to initialize memory manager", {
            workspaceId: context.workspace.id,
            error: error,
            errorCause,
          });
        }
      }
      if (initDuration > 15000) {
        logger.warn("Workspace initialization took longer than expected", {
          workspaceId: context.workspace.id,
          initDurationMs: initDuration,
        });
      }

      return { supervisor, mergedConfig, agentOrchestrator, memoryManager, sessionMemoryHooks };
    }),
    initializeStreams: fromPromise<
      { activeStreamSignals: Map<string, StreamSignalData> },
      { context: WorkspaceRuntimeContext }
    >(async ({ input }) => {
      const { context } = input;
      const activeStreamSignals = new Map<string, StreamSignalData>();

      const registry = ProviderRegistry.getInstance();

      logger.info("Initializing stream signals", {
        workspaceId: context.workspace.id,
        signalCount: Object.keys(context.config?.workspace.signals || {}).length,
      });

      // Initialize stream signals
      if (context.config?.workspace.signals) {
        for (const [signalId, signalConfig] of Object.entries(context.config.workspace.signals)) {
          if (isStreamSignal(signalConfig)) {
            try {
              logger.info(`Initializing real-time signal: ${signalId}`, {
                provider: signalConfig.provider,
              });

              // Create provider config
              const providerConfig = {
                id: signalId,
                type: ProviderType.SIGNAL,
                provider: signalConfig.provider,
                config: signalConfig.config || {},
              };

              // Load the signal provider
              const provider = await registry.loadFromConfig(providerConfig);
              const signalProvider = provider;
              // @ts-expect-error right now the state machine is misusing config <> runtime signals.
              const signal = signalProvider.createSignal(providerConfig.config);

              // Convert to runtime signal
              const runtimeSignal = signal.toRuntimeSignal();

              // Store for later initialization
              activeStreamSignals.set(signalId, { runtimeSignal, signalConfig: signalConfig });

              logger.info(`Stream signal prepared: ${signalId}`);
            } catch (error) {
              const errorCause = createErrorCause(error);
              logger.error(`Failed to prepare stream signal: ${signalId}`, {
                error: error,
                errorCause,
              });
            }
          }
        }
      }

      return { activeStreamSignals };
    }),
    shutdownWorkspace: fromPromise<{ shutdown: boolean }, { context: WorkspaceRuntimeContext }>(
      async ({ input }) => {
        const { context } = input;

        logger.info("Shutting down workspace runtime", {
          workspaceId: context.workspace.id,
          activeSessions: context.stats.activeSessionCount,
          activeStreams: context.activeStreamSignals.size,
        });

        // First, cleanup stream signals to stop new events
        for (const [signalId, streamData] of context.activeStreamSignals) {
          try {
            logger.info(`Cleaning up stream signal: ${signalId}`);
            if (
              streamData.runtimeSignal &&
              typeof streamData.runtimeSignal === "object" &&
              "teardown" in streamData.runtimeSignal
            ) {
              // @ts-expect-error right now runtime signals are mis/untyped.
              await streamData.runtimeSignal.teardown();
            }
          } catch (error) {
            const errorCause = createErrorCause(error);
            logger.error(`Failed to cleanup stream signal: ${signalId}`, {
              error: error,
              errorCause,
            });
          }
        }

        // Clean up all sessions (cancel active ones, cleanup resources for completed ones)
        for (const [sessionId, session] of context.sessions) {
          try {
            const sessionStatus = session.status;

            if (
              sessionStatus === WorkspaceSessionStatus.COMPLETED ||
              sessionStatus === WorkspaceSessionStatus.FAILED
            ) {
              // For completed/failed sessions, only clean up resources without changing status
              logger.debug("Cleaning up completed session resources", {
                workspaceId: context.workspace.id,
                sessionId,
                status: sessionStatus,
              });
              session.cleanup();
            } else {
              // For active sessions, cancel them
              logger.debug("Cancelling active session", {
                workspaceId: context.workspace.id,
                sessionId,
                status: sessionStatus,
              });
              session.cancel();
            }
          } catch (error) {
            const errorCause = createErrorCause(error);
            logger.error(`Failed to cleanup session: ${sessionId}`, { error: error, errorCause });
          }
        }

        // Cleanup supervisor
        if (context.supervisor) {
          await context.supervisor.cleanup();
        }

        return { shutdown: true };
      },
    ),
  },
  actions: {
    updateSignalStats: assign({
      stats: ({ context }) => ({
        ...context.stats,
        totalSignalsProcessed: context.stats.totalSignalsProcessed + 1,
      }),
    }),
    updateSessionCreatedStats: assign({
      stats: ({ context }) => ({
        ...context.stats,
        totalSessionsCreated: context.stats.totalSessionsCreated + 1,
        activeSessionCount: context.stats.activeSessionCount + 1,
      }),
    }),
    onSessionCreated: ({ context, event }) => {
      if (event.type === "SESSION_CREATED" && context.sessionMemoryHooks) {
        context.sessionMemoryHooks.onStart(event.sessionId).catch((error) => {
          const errorCause = createErrorCause(error);
          logger.error("Failed to initialize session memory", {
            sessionId: event.sessionId,
            error: error,
            errorCause,
          });
        });
      }
    },
    updateSessionCompletedStats: assign({
      stats: ({ context }) => ({
        ...context.stats,
        activeSessionCount: Math.max(0, context.stats.activeSessionCount - 1),
      }),
      // Don't delete sessions when they complete - keep them for history
      // sessions: ({ context, event }) => {
      //   const newSessions = new Map(context.sessions);
      //   if ("sessionId" in event) {
      //     newSessions.delete(event.sessionId);
      //   }
      //   return newSessions;
      // },
    }),
    onSessionCompleted: ({ context, event }) => {
      if (event.type === "SESSION_COMPLETED" && context.sessionMemoryHooks) {
        context.sessionMemoryHooks.onEnd(event.sessionId).catch((error) => {
          const errorCause = createErrorCause(error);
          logger.error("Failed to finalize session memory", {
            sessionId: event.sessionId,
            error: error,
            errorCause,
          });
        });
      }
    },
    assignSupervisor: assign(({ event }) => {
      logger.info("assignSupervisor action called", {
        eventType: event.type,
        eventKeys: Object.keys(event),
      });

      if (event.type === "xstate.done.actor.initializeWorkspace") {
        logger.info("Assigning supervisor from initializeWorkspace output", {
          supervisorId: event.output.supervisor?.id,
          supervisorType: event.output.supervisor?.type,
          hasOrchestrator: !!event.output.agentOrchestrator,
        });
        return {
          supervisor: event.output.supervisor,
          agentOrchestrator: event.output.agentOrchestrator,
          memoryManager: event.output.memoryManager,
          sessionMemoryHooks: event.output.sessionMemoryHooks,
        };
      }
      logger.warn("assignSupervisor: Event type not matched", {
        actualType: event.type,
        expectedType: "xstate.done.actor.initializeWorkspace",
      });
      return {};
    }),
    assignActiveStreamSignals: assign(({ event }) => {
      if (event.type === "xstate.done.actor.initializeStreams") {
        return { activeStreamSignals: event.output.activeStreamSignals };
      }
      return {};
    }),
    setShuttingDown: assign({ isShuttingDown: () => true }),
    assignError: assign({
      error: ({ event }) => {
        if ("error" in event) {
          if (event.error instanceof Error) {
            return event.error;
          }
          return new Error(event.error);
        }
        return undefined;
      },
    }),
  },
});

// Type guard for stream signals
function isStreamSignal(
  signal: unknown,
): signal is { provider: string; config?: Record<string, unknown> } {
  return (
    typeof signal === "object" &&
    signal !== null &&
    "provider" in signal &&
    typeof signal.provider === "string" &&
    (signal.provider === "stream" || signal.provider === "k8s-events")
  );
}

// Factory function creates machine from setup
export function createWorkspaceRuntimeMachine(_input: WorkspaceRuntimeMachineInput) {
  return workspaceRuntimeMachineSetup.createMachine({
    id: "workspaceRuntime",
    context: ({ input }) => ({
      workspace: input.workspace,
      config: input.config,
      options: {
        workspacePath: input.workspacePath,
        libraryStorage: input.libraryStorage,
        mcpServerPool: input.mcpServerPool,
        daemonUrl: input.daemonUrl,
        onSessionFinished: input.onSessionFinished,
      },
      mcpServerPool: input.mcpServerPool,
      daemonUrl: input.daemonUrl,
      sessions: new Map(),
      activeStreamSignals: new Map(),
      isShuttingDown: false,
      stats: { totalSignalsProcessed: 0, totalSessionsCreated: 0, activeSessionCount: 0 },
    }),

    initial: "uninitialized",

    states: {
      uninitialized: { on: { INITIALIZE: "initializing", SHUTDOWN: "terminated" } },

      initializing: {
        invoke: {
          src: "initializeWorkspace",
          input: ({ context }) => ({ context }),
          onDone: {
            target: "initializingStreams",
            actions: [
              assign(({ event }) => {
                logger.info("Direct assignment in onDone", {
                  eventType: event.type,
                  hasOutput: !!event.output,
                  hasSupervisor: !!event.output?.supervisor,
                  supervisorId: event.output?.supervisor?.id,
                });
                return { supervisor: event.output.supervisor, config: event.output.mergedConfig };
              }),
              ({ context }) => {
                logger.info("After direct assignment - checking context", {
                  hasSupervisor: !!context.supervisor,
                  supervisorId: context.supervisor?.id,
                  workspaceId: context.workspace.id,
                });
              },
            ],
          },
          onError: {
            target: "error",
            actions: [
              ({ event }) => {
                logger.error("Failed to initialize workspace runtime", { error: event.error });
              },
              "assignError",
            ],
          },
        },
      },

      initializingStreams: {
        invoke: {
          src: "initializeStreams",
          input: ({ context }) => ({ context }),
          onDone: {
            target: "ready",
            actions: [
              "assignActiveStreamSignals",
              ({ context, self }) => {
                logger.info("Workspace ready, initializing stream connections", {
                  workspaceId: context.workspace.id,
                  activeStreams: context.activeStreamSignals.size,
                });

                // Initialize stream connections after entering ready state
                for (const [signalId, streamData] of context.activeStreamSignals) {
                  if (
                    streamData.runtimeSignal &&
                    typeof streamData.runtimeSignal === "object" &&
                    "initialize" in streamData.runtimeSignal
                  ) {
                    // @ts-expect-error right now runtime signals are mis/untyped.
                    streamData.runtimeSignal.initialize({
                      id: signalId,
                      processSignal: (signalId: string, payload: Record<string, unknown>) => {
                        // Send signal to state machine for processing
                        const signal = {
                          id: signalId,
                          provider: {
                            id: streamData.signalConfig.provider,
                            name: streamData.signalConfig.provider,
                          },
                          config: streamData.signalConfig,
                        };

                        self.send({
                          type: "PROCESS_SIGNAL",
                          // @ts-expect-error right now runtime signals are mis/untyped.
                          signal: {
                            ...signal,
                            provider: signal.provider || { id: "unknown", name: "unknown" },
                          },
                          payload,
                        });
                      },
                      workspacePath: context.options.workspacePath,
                    });
                  }
                }
              },
            ],
          },
          onError: {
            target: "ready",
            actions: [
              ({ event, context }) => {
                logger.error("Stream signal initialization failed", {
                  error:
                    event.error instanceof Error
                      ? {
                          message: event.error.message,
                          stack: event.error.stack,
                          name: event.error.name,
                        }
                      : event.error,
                  workspaceId: context.workspace.id,
                });
              },
              "assignError",
              assign({ activeStreamSignals: () => new Map() }),
            ],
          },
        },
      },

      ready: {
        on: {
          PROCESS_SIGNAL: {
            actions: [
              // Update stats
              "updateSignalStats",

              // Process the signal asynchronously
              assign({
                sessions: ({ context, event, spawn, self }) => {
                  // Spawn the signal processing as a child actor
                  const actorRef = spawn(
                    fromPromise(async () => {
                      // Direct access to context and event from closure
                      if (!context.supervisor) {
                        logger.error("Supervisor not initialized when processing signal", {
                          workspaceId: context.workspace.id,
                          signalId: event.signal.id,
                          sessionId: event.sessionId,
                          currentState: self.getSnapshot().value,
                          hasConfig: !!context.config,
                        });
                        throwWithCause(
                          `Workspace supervisor is not available. Please ensure the workspace is properly initialized.`,
                          new Error(
                            `Supervisor not initialized for workspace ${context.workspace.id}. ` +
                              `This may indicate a race condition during initialization. ` +
                              `Current state: ${self.getSnapshot().value}`,
                          ),
                        );
                      }

                      // Generate session ID
                      const sessionId = event.sessionId || crypto.randomUUID();

                      logger.info("Processing signal", {
                        signalId: event.signal.id,
                        sessionId,
                        workspaceId: context.workspace.id,
                      });

                      // Create session
                      const session = new Session(
                        context.workspace.id,
                        {
                          triggers: [event.signal],
                          callback: {
                            execute: () => {},
                            validate: () => true,
                            onSuccess: (result) => {
                              logger.info("Session completed successfully", {
                                workspaceId: context.workspace.id,
                                sessionId,
                                result,
                              });
                              // Remove session from the sessions map when it completes
                              self.send({ type: "SESSION_COMPLETED", sessionId, result });
                            },
                            onError: (error) => {
                              const isCancellation =
                                error.message &&
                                (error.message.includes("Session cancelled") ||
                                  error.message.includes("aborted"));

                              if (isCancellation) {
                                logger.info("Session cancelled", {
                                  workspaceId: context.workspace.id,
                                  sessionId,
                                });
                              } else {
                                logger.error("Session failed", {
                                  workspaceId: context.workspace.id,
                                  sessionId,
                                  error: error.message,
                                });
                              }
                              // Remove session from the sessions map when it fails
                              self.send({
                                type: "SESSION_FAILED",
                                sessionId,
                                error: error.message,
                              });
                            },
                            onComplete: () => {
                              logger.info("Session finalized", {
                                workspaceId: context.workspace.id,
                                sessionId,
                              });
                            },
                          },
                        },
                        undefined, // agents
                        undefined, // workflows
                        undefined, // sources
                        undefined, // intent
                        undefined, // storageAdapter
                        true, // enableCognitiveLoop
                      );

                      // Store session with proper ID
                      Object.defineProperty(session, "id", {
                        value: sessionId,
                        writable: false,
                        configurable: true,
                      });

                      // Store session
                      context.sessions.set(sessionId, session);

                      // Start the session to transition from "created" state
                      // Note: We don't await session.start() as it blocks until completion
                      // Instead, we just trigger the start asynchronously
                      session.start();

                      // Process signal through supervisor
                      const result = await context.supervisor.processSignal(
                        event.signal,
                        event.payload,
                        sessionId,
                        event.streamId,
                        event.onStreamEvent,
                      );

                      // CRITICAL: Attach SessionSupervisorActor to Session
                      if (result.sessionActor) {
                        session.attachSessionActor(result.sessionActor);

                        // ✅ FIX: Don't prematurely complete! Let the session machine handle execution completion
                        // The session machine's executeSession actor will complete when sessionActor.executeSession() finishes
                        logger.info("SessionSupervisorActor attached to session", {
                          sessionId: session.id,
                          actorId: result.sessionActor.id,
                          status: result.status,
                        });
                      } else {
                        session.fail(new Error(result.error || "Failed to create session actor"));
                      }

                      return { sessionId, result };
                    }),
                  );

                  // Subscribe to the actor's completion
                  actorRef.subscribe({
                    complete: () => {
                      // Actor completed successfully - the result is in the snapshot
                      const snapshot = actorRef.getSnapshot();
                      if (snapshot.status === "done" && snapshot.output) {
                        const { sessionId, result } = snapshot.output;

                        // Update stats
                        self.send({ type: "SESSION_CREATED", sessionId });

                        // Store result if available
                        if (result) {
                          self.send({ type: "STORE_SESSION_RESULT", sessionId, result });
                        }
                      }
                    },
                    error: (error: unknown) => {
                      logger.error("Signal processing failed", { error: error });

                      self.send({
                        type: "ERROR",
                        error: error instanceof Error ? error : new Error(String(error)),
                      });
                    },
                  });

                  // Return the sessions map (unchanged)
                  return context.sessions;
                },
              }),
            ],
          },

          EXECUTE_JOB: {
            actions: [
              // Update stats
              "updateSignalStats",

              // Process the job execution asynchronously
              assign({
                sessions: ({ context, event, spawn, self }) => {
                  // Spawn the job execution as a child actor
                  const actorRef = spawn(
                    fromPromise(async () => {
                      // Direct access to context and event from closure
                      if (!context.supervisor) {
                        logger.error("Supervisor not initialized when executing job", {
                          workspaceId: context.workspace.id,
                          jobName: event.jobName,
                          sessionId: event.sessionId,
                          currentState: self.getSnapshot().value,
                        });
                        throwWithCause(
                          `Workspace supervisor is not available for job execution.`,
                          new Error(
                            `Supervisor not initialized for workspace ${context.workspace.id}. ` +
                              `Current state: ${self.getSnapshot().value}`,
                          ),
                        );
                      }

                      const sessionId = event.sessionId;

                      logger.info("Executing job directly", {
                        jobName: event.jobName,
                        sessionId,
                        workspaceId: context.workspace.id,
                      });

                      // Create session - jobs don't have explicit signals, so create a synthetic one
                      // @ts-expect-error - Signal configuration is being misused here as runtime signals.
                      const syntheticSignal: IWorkspaceSignal = {
                        id: `job-${event.jobName}`,
                        provider: { id: "mcp-tool", name: "mcp-tool" },
                      };

                      const session = new Session(
                        context.workspace.id,
                        {
                          triggers: [syntheticSignal],
                          callback: {
                            execute: () => {},
                            validate: () => true,
                            onSuccess: (result) => {
                              logger.info("Job execution completed successfully", {
                                workspaceId: context.workspace.id,
                                sessionId,
                                jobName: event.jobName,
                                result,
                              });
                              self.send({ type: "SESSION_COMPLETED", sessionId, result });
                            },
                            onError: (error) => {
                              const isCancellation =
                                error.message &&
                                (error.message.includes("Session cancelled") ||
                                  error.message.includes("aborted"));

                              if (isCancellation) {
                                logger.info("Job execution cancelled", {
                                  workspaceId: context.workspace.id,
                                  sessionId,
                                  jobName: event.jobName,
                                });
                              } else {
                                logger.error("Job execution failed", {
                                  workspaceId: context.workspace.id,
                                  sessionId,
                                  jobName: event.jobName,
                                  error: error.message,
                                });
                              }
                              self.send({
                                type: "SESSION_FAILED",
                                sessionId,
                                error: error.message,
                              });
                            },
                            onComplete: () => {
                              logger.info("Job execution finalized", {
                                workspaceId: context.workspace.id,
                                sessionId,
                                jobName: event.jobName,
                              });
                            },
                          },
                        },
                        undefined, // agents
                        undefined, // workflows
                        undefined, // sources
                        undefined, // intent
                        undefined, // storageAdapter
                        true, // enableCognitiveLoop
                      );

                      // Store session with proper ID
                      Object.defineProperty(session, "id", {
                        value: sessionId,
                        writable: false,
                        configurable: true,
                      });

                      // Store session
                      context.sessions.set(sessionId, session);

                      // Start the session
                      try {
                        session.start();
                      } catch (error) {
                        const errorCause = createErrorCause(error);
                        logger.error("Job session start failed", {
                          sessionId,
                          jobName: event.jobName,
                          error: error,
                          errorCause,
                        });
                      }

                      // Use the new processJobDirectly method that accepts StreamEmitter
                      const result = await context.supervisor.processJobDirectly(
                        event.jobName,
                        event.jobSpec,
                        event.params,
                        sessionId,
                      );

                      // Attach SessionSupervisorActor to Session
                      if (result.sessionActor) {
                        session.attachSessionActor(result.sessionActor);

                        logger.info("SessionSupervisorActor attached to job session", {
                          sessionId: session.id,
                          jobName: event.jobName,
                          actorId: result.sessionActor.id,
                          status: result.status,
                        });
                      } else {
                        session.fail(new Error(result.error || "Failed to create session actor"));
                      }

                      return { sessionId, result };
                    }),
                  );

                  // Subscribe to the actor's completion
                  actorRef.subscribe({
                    complete: () => {
                      const snapshot = actorRef.getSnapshot();
                      if (snapshot.status === "done" && snapshot.output) {
                        const { sessionId, result } = snapshot.output;

                        // Update stats
                        self.send({ type: "SESSION_CREATED", sessionId });

                        // Store result if available
                        if (result) {
                          self.send({ type: "STORE_SESSION_RESULT", sessionId, result });
                        }
                      }
                    },
                    error: (error: unknown) => {
                      logger.error("Job execution failed", { error: error });

                      self.send({
                        type: "ERROR",
                        error: error instanceof Error ? error : new Error(String(error)),
                      });
                    },
                  });

                  // Return the sessions map (unchanged)
                  return context.sessions;
                },
              }),
            ],
          },

          SESSION_CREATED: { actions: "updateSessionCreatedStats" },

          SESSION_COMPLETED: {
            actions: [
              "updateSessionCompletedStats",
              ({ context, event }) => {
                const cb = context.options.onSessionFinished;
                if (cb && event.sessionId) {
                  const summary = context.sessions.get(event.sessionId)?.summarize?.();
                  Promise.resolve(
                    cb({
                      workspaceId: context.workspace.id,
                      sessionId: event.sessionId,
                      status: "completed",
                      finishedAt: new Date().toISOString(),
                      summary,
                    }),
                  ).catch(() => {});
                }
              },
            ],
          },

          SESSION_FAILED: {
            actions: [
              "updateSessionCompletedStats",
              ({ context, event }) => {
                const isCancellation =
                  event.error &&
                  (event.error.includes("Session cancelled") || event.error.includes("aborted"));

                if (isCancellation) {
                  logger.info(`Session cancelled: ${event.sessionId}`);
                } else {
                  logger.error(`Session failed: ${event.sessionId}`, { error: event.error });
                }
                const cb = context.options.onSessionFinished;
                if (cb && event.sessionId) {
                  const summary = context.sessions.get(event.sessionId)?.summarize?.();
                  Promise.resolve(
                    cb({
                      workspaceId: context.workspace.id,
                      sessionId: event.sessionId,
                      status: "failed",
                      finishedAt: new Date().toISOString(),
                      summary,
                    }),
                  ).catch(() => {});
                }
              },
            ],
          },

          STORE_SESSION_RESULT: {
            actions: ({ context, event }) => {
              // Store session results in library if available
              if (context.options.libraryStorage && event.result) {
                context.options.libraryStorage
                  .storeItem({
                    id: crypto.randomUUID(),
                    type: "session_archive",
                    source: "system",
                    name: `Session Archive - ${event.sessionId.slice(0, 8)}`,
                    description: `Complete session data and results from session ${event.sessionId}`,
                    content: JSON.stringify(
                      {
                        sessionId: event.sessionId,
                        workspaceId: context.workspace.id,
                        result: event.result,
                        timestamp: new Date().toISOString(),
                      },
                      null,
                      2,
                    ),
                    mime_type: "application/json",
                    session_id: event.sessionId,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    tags: ["session-archive", "automated"],
                    workspace_id: context.workspace.id,
                  })
                  .catch((error: unknown) => {
                    const errorCause = createErrorCause(error);
                    logger.error("Failed to store session results", {
                      sessionId: event.sessionId,
                      error: error,
                      errorCause,
                    });
                  });
              }
            },
          },

          SHUTDOWN: { target: "shuttingDown", actions: "setShuttingDown" },

          ERROR: {
            actions: ({ event }) => {
              logger.error("Runtime error", { error: event.error });
            },
          },
        },
      },

      shuttingDown: {
        invoke: {
          src: "shutdownWorkspace",
          input: ({ context }) => ({ context }),
          onDone: { target: "terminated" },
          onError: {
            target: "terminated",
            actions: ({ event }) => {
              logger.error("Shutdown failed", { error: event.error });
            },
          },
        },
        after: {
          30000: {
            target: "terminated",
            actions: () => {
              logger.warn("Shutdown timeout exceeded, forcing termination");
            },
          },
        },
      },

      error: { on: { SHUTDOWN: "shuttingDown" } },

      terminated: {
        type: "final",
        entry: ({ context }) => {
          logger.info("Workspace runtime terminated", {
            workspaceId: context.workspace.id,
            totalSignalsProcessed: context.stats.totalSignalsProcessed,
            totalSessionsCreated: context.stats.totalSessionsCreated,
          });
        },
      },
    },
  });
}

/**
 * Registers MCP servers from workspace configuration with the LLMProvider
 */
async function registerMCPServers(config: MergedConfig, workspaceId: string): Promise<void> {
  try {
    logger.info("Starting MCP server registration", {
      operation: "mcp_server_registration",
      workspaceId,
      hasAtlasConfig: !!config.atlas,
      hasWorkspaceConfig: !!config.workspace,
    });

    // Debug logging to see what config we have
    logger.debug("Config structure before MCPServerRegistry.initialize", {
      operation: "mcp_server_registration",
      workspaceId,
      configKeys: Object.keys(config),
      workspaceConfigKeys: config.workspace ? Object.keys(config.workspace) : [],
      hasWorkspaceTools: !!config.workspace?.tools,
      hasWorkspaceMcp: !!config.workspace?.tools?.mcp,
      hasWorkspaceServers: !!config.workspace?.tools?.mcp?.servers,
      workspaceServerIds: config.workspace?.tools?.mcp?.servers
        ? Object.keys(config.workspace.tools.mcp.servers)
        : [],
    });

    // Initialize MCPServerRegistry to handle merging platform and workspace configs
    // This will inject atlas-platform configuration
    // The registry now handles concurrent initialization and retries internally
    try {
      await MCPServerRegistry.initialize(
        config.atlas || undefined, // Platform config - convert null to undefined
        config.workspace, // Workspace config
      );
    } catch (error) {
      logger.error("MCPServerRegistry initialization failed", {
        operation: "mcp_server_registration",
        workspaceId,
        error: error,
      });
      // Continue without MCP servers rather than blocking workspace initialization
    }

    // Get server IDs from workspace configuration
    const workspaceServerIds = Object.keys(config.workspace.tools?.mcp?.servers || {});

    // IMPORTANT: After initialization, atlas-platform will be automatically included
    // in the merged configuration, so we need to also include it in serverIds
    const allServerIds = [...workspaceServerIds];
    if (!allServerIds.includes("atlas-platform")) {
      allServerIds.push("atlas-platform");
    }

    logger.info("Registering MCP servers for workspace", {
      operation: "mcp_server_registration",
      workspaceId,
      workspaceServerCount: workspaceServerIds.length,
      totalServerCount: allServerIds.length,
      serverIds: allServerIds,
    });

    // Get server configurations from registry (now includes atlas-platform)
    const serverConfigs = MCPServerRegistry.getServerConfigs(allServerIds);

    // Get MCPManager instance from LLMProvider
    const mcpManager = LLMProvider.getMCPManager();

    // Register each server (manager handles timeouts internally)
    const registrationPromises = serverConfigs.map(async (serverConfig) => {
      try {
        // MCPManager.registerServer already has timeout protection internally:
        // - HTTP transport: 5 second timeout
        // - Platform tools fetch: retry with exponential backoff
        // - Registers server without tool filtering if tools unavailable
        await mcpManager.registerServer(serverConfig);

        logger.info(`Successfully registered MCP server: ${serverConfig.id}`, {
          operation: "mcp_server_registration",
          workspaceId,
          serverId: serverConfig.id,
          transport: serverConfig.transport.type,
        });
      } catch (error) {
        // Only log at debug level for expected connection issues
        // The MCP manager already handles retries gracefully
        const isConnectionIssue =
          error instanceof Error &&
          (error.message.includes("timeout") ||
            error.message.includes("connection") ||
            error.message.includes("fetch platform tools"));

        if (isConnectionIssue) {
          logger.debug(`MCP server registration skipped (server unavailable): ${serverConfig.id}`, {
            operation: "mcp_server_registration",
            workspaceId,
            serverId: serverConfig.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        } else {
          // Only log actual errors at error level
          logger.error(`Failed to register MCP server: ${serverConfig.id}`, {
            operation: "mcp_server_registration",
            workspaceId,
            serverId: serverConfig.id,
            error: error,
          });
        }
        // Don't throw - continue with other servers
      }
    });

    // Wait for all registrations to complete
    await Promise.allSettled(registrationPromises);

    logger.info("MCP server registration completed for workspace", {
      operation: "mcp_server_registration",
      workspaceId,
      totalServers: serverConfigs.length,
    });
  } catch (error) {
    logger.error("Failed to register MCP servers for workspace", {
      operation: "mcp_server_registration",
      workspaceId,
      error: error,
    });
    // Don't throw - workspace should continue to initialize even if MCP registration fails
  }
}
