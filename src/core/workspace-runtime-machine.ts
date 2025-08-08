/**
 * Workspace Runtime Machine - XState 5 implementation
 * Replaces worker-based supervisor management with direct actor orchestration
 */

import { ConfigLoader, MergedConfig } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { load } from "@std/dotenv";
import { exists } from "@std/fs";
import { join } from "@std/path";
import { assign, fromPromise, setup } from "xstate";
import type { IWorkspace, IWorkspaceSession, IWorkspaceSignal } from "../types/core.ts";
import type { WorkspaceSupervisorConfig } from "@atlas/core";
import { logger } from "@atlas/logger";
import {
  ProcessSignalResult,
  WorkspaceSupervisorActor,
} from "./actors/workspace-supervisor-actor.ts";
import { type ISignalProvider, ProviderRegistry, ProviderType } from "@atlas/signals";
import { Session } from "./session.ts";
import { LLMProvider } from "@atlas/core";
import { MCPServerRegistry } from "@atlas/mcp";
import type { LibraryStorageAdapter } from "./storage/library-storage-adapter.ts";

interface StreamSignalData {
  runtimeSignal: any; // Runtime signal instance
  signalConfig: Record<string, unknown>;
}

export interface WorkspaceRuntimeContext {
  workspace: IWorkspace;
  config: MergedConfig;
  options: {
    lazy?: boolean;
    supervisorModel?: string;
    workspacePath?: string;
    libraryStorage?: LibraryStorageAdapter;
  };
  supervisor?: WorkspaceSupervisorActor;
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

export type WorkspaceRuntimeEvent =
  | { type: "INITIALIZE" }
  | {
    type: "PROCESS_SIGNAL";
    signal: IWorkspaceSignal;
    payload: Record<string, unknown>;
    sessionId?: string;
    traceHeaders?: Record<string, string>;
  }
  | { type: "SESSION_CREATED"; sessionId: string }
  | { type: "SESSION_COMPLETED"; sessionId: string; result?: Record<string, unknown> }
  | { type: "SESSION_FAILED"; sessionId: string; error: string }
  | { type: "SHUTDOWN" }
  | { type: "ERROR"; error: Error }
  | { type: "STORE_SESSION_RESULT"; sessionId: string; result: ProcessSignalResult }
  | {
    type: "xstate.done.actor.initializeWorkspace";
    output: { supervisor: WorkspaceSupervisorActor; mergedConfig: MergedConfig };
  }
  | {
    type: "xstate.done.actor.initializeStreams";
    output: { activeStreamSignals: Map<string, StreamSignalData> };
  }
  | {
    type: "xstate.done.actor.shutdownWorkspace";
    output: { shutdown: boolean };
  };

// Define input type for the machine
export interface WorkspaceRuntimeMachineInput {
  workspace: IWorkspace;
  config: MergedConfig;
  workspacePath?: string;
  libraryStorage?: LibraryStorageAdapter;
}

// Setup the machine with proper typing
export const workspaceRuntimeMachineSetup = setup({
  types: {
    context: {} as WorkspaceRuntimeContext,
    events: {} as WorkspaceRuntimeEvent,
    input: {} as WorkspaceRuntimeMachineInput,
  },
  actors: {
    initializeWorkspace: fromPromise<
      { supervisor: WorkspaceSupervisorActor; mergedConfig: MergedConfig },
      { context: WorkspaceRuntimeContext }
    >(async ({ input }) => {
      const { context } = input;

      logger.info("Initializing workspace runtime", {
        workspaceId: context.workspace.id,
        hasConfig: !!context.config,
        workspacePath: context.options.workspacePath,
      });

      // Load workspace .env file if available
      if (context.options.workspacePath) {
        try {
          const envFilePath = join(context.options.workspacePath, ".env");
          if (await exists(envFilePath)) {
            await load({ export: true, envPath: envFilePath });
            logger.debug("Loaded workspace .env file", {
              workspaceId: context.workspace.id,
              envPath: envFilePath,
            });
          }
        } catch (error) {
          logger.debug("Could not load workspace .env file", {
            workspaceId: context.workspace.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Load or use provided configuration
      let mergedConfig: MergedConfig;
      if (context.config) {
        mergedConfig = context.config;
        logger.debug("Using provided configuration", {
          workspaceId: context.workspace.id,
        });
      } else {
        // Load configuration from disk
        logger.debug("Loading configuration from disk", {
          workspaceId: context.workspace.id,
        });
        const workspacePath = context.options.workspacePath || Deno.cwd();
        const adapter = new FilesystemConfigAdapter(workspacePath);
        const configLoader = new ConfigLoader(adapter, workspacePath);
        mergedConfig = await configLoader.load();
      }

      // Create typed configuration slice for WorkspaceSupervisor
      const supervisorConfig: WorkspaceSupervisorConfig = {
        workspaceId: context.workspace.id,
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
      supervisor.initialize({
        actorId: supervisor.id,
      });

      // Set agents from the merged config
      if (mergedConfig.workspace.agents) {
        supervisor.setAgents(mergedConfig.workspace.agents);
        logger.info("Agents set on supervisor", {
          workspaceId: context.workspace.id,
          agentCount: Object.keys(mergedConfig.workspace.agents).length,
          agentIds: Object.keys(mergedConfig.workspace.agents),
        });
      }

      logger.info("Workspace supervisor actor initialized", {
        workspaceId: context.workspace.id,
        supervisorId: "supervisor-" + context.workspace.id,
        agentsCount: Object.keys(mergedConfig.workspace.agents || {}).length,
      });

      return { supervisor, mergedConfig };
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
        for (
          const [signalId, signalConfig] of Object.entries(
            context.config.workspace.signals,
          )
        ) {
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
                config: (signalConfig as { config?: Record<string, unknown> }).config || {},
              };

              // Load the signal provider
              const provider = await registry.loadFromConfig(providerConfig);
              const signalProvider = provider as ISignalProvider;
              const signal = signalProvider.createSignal(providerConfig.config);

              // Convert to runtime signal
              const runtimeSignal = signal.toRuntimeSignal();

              // Store for later initialization
              activeStreamSignals.set(signalId, {
                runtimeSignal,
                signalConfig: signalConfig as Record<string, unknown>,
              });

              logger.info(`Stream signal prepared: ${signalId}`);
            } catch (error) {
              logger.error(`Failed to prepare stream signal: ${signalId}`, {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      }

      return { activeStreamSignals };
    }),
    shutdownWorkspace: fromPromise<
      { shutdown: boolean },
      { context: WorkspaceRuntimeContext }
    >(async ({ input }) => {
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
          await streamData.runtimeSignal.teardown();
        } catch (error) {
          logger.error(`Failed to cleanup stream signal: ${signalId}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Cancel all active sessions
      for (const [sessionId, session] of context.sessions) {
        try {
          logger.debug("Cancelling session", {
            workspaceId: context.workspace.id,
            sessionId,
          });
          session.cancel();
        } catch (error) {
          logger.error(`Failed to cancel session: ${sessionId}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Cleanup supervisor
      if (context.supervisor) {
        await context.supervisor.cleanup();
      }

      return { shutdown: true };
    }),
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
    updateSessionCompletedStats: assign({
      stats: ({ context }) => ({
        ...context.stats,
        activeSessionCount: Math.max(0, context.stats.activeSessionCount - 1),
      }),
      sessions: ({ context, event }) => {
        const newSessions = new Map(context.sessions);
        if ("sessionId" in event) {
          newSessions.delete(event.sessionId);
        }
        return newSessions;
      },
    }),
    assignSupervisor: assign(({ event }) => {
      logger.info("assignSupervisor action called", {
        eventType: event.type,
        eventKeys: Object.keys(event),
        hasOutput: !!(event as any).output,
        hasSupervisor: !!((event as any).output?.supervisor),
      });

      if (event.type === "xstate.done.actor.initializeWorkspace") {
        logger.info("Assigning supervisor from initializeWorkspace output", {
          supervisorId: event.output.supervisor?.id,
          supervisorType: event.output.supervisor?.type,
        });
        return {
          supervisor: event.output.supervisor,
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
        return {
          activeStreamSignals: event.output.activeStreamSignals,
        };
      }
      return {};
    }),
    setShuttingDown: assign({
      isShuttingDown: () => true,
    }),
    assignError: assign({
      error: ({ event }) => {
        if ("error" in event) {
          return event.error as Error;
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
  return typeof signal === "object" &&
    signal !== null &&
    "provider" in signal &&
    typeof (signal as { provider?: unknown }).provider === "string" &&
    ((signal as { provider?: string }).provider === "stream" ||
      (signal as { provider?: string }).provider === "k8s-events");
}

// Export the machine type
export type WorkspaceRuntimeMachine = typeof workspaceRuntimeMachineSetup;

// Factory function creates machine from setup
export function createWorkspaceRuntimeMachine(
  _input: WorkspaceRuntimeMachineInput,
) {
  return workspaceRuntimeMachineSetup.createMachine({
    id: "workspaceRuntime",
    context: ({ input }) => ({
      workspace: input.workspace,
      config: input.config,
      options: {
        workspacePath: input.workspacePath,
        libraryStorage: input.libraryStorage,
      },
      sessions: new Map(),
      activeStreamSignals: new Map(),
      isShuttingDown: false,
      stats: {
        totalSignalsProcessed: 0,
        totalSessionsCreated: 0,
        activeSessionCount: 0,
      },
    }),

    initial: "uninitialized",

    states: {
      uninitialized: {
        on: {
          INITIALIZE: "initializing",
          SHUTDOWN: "terminated",
        },
      },

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
                return {
                  supervisor: event.output.supervisor,
                  config: event.output.mergedConfig,
                };
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
                logger.error("Failed to initialize workspace runtime", {
                  error: event.error,
                });
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
                        signal: signal as IWorkspaceSignal,
                        payload,
                      });
                    },
                  }).catch((error: unknown) => {
                    logger.error(`Failed to initialize stream signal: ${signalId}`, {
                      error: error instanceof Error ? error.message : String(error),
                    });
                  });
                }
              },
            ],
          },
          onError: {
            target: "ready",
            actions: [
              ({ event, context }) => {
                logger.error("Stream signal initialization failed", {
                  error: event.error instanceof Error
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
              assign({
                activeStreamSignals: () => new Map(),
              }),
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
                        throw new Error(
                          `Supervisor not initialized for workspace ${context.workspace.id}. ` +
                            `This may indicate a race condition during initialization. ` +
                            `Current state: ${self.getSnapshot().value}`,
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
                          // deno-lint-ignore require-await
                          callback: async (result) => {
                            logger.info("Session completed", {
                              workspaceId: context.workspace.id,
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
                      session.start().catch((error) => {
                        logger.error("Session start failed", {
                          sessionId,
                          error: error instanceof Error ? error.message : String(error),
                        });
                      });

                      // Process signal through supervisor
                      const result = await context.supervisor.processSignal(
                        event.signal,
                        event.payload,
                        sessionId,
                      );

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
                        self.send({
                          type: "SESSION_CREATED",
                          sessionId,
                        });

                        // Store result if available
                        if (result) {
                          self.send({
                            type: "STORE_SESSION_RESULT",
                            sessionId,
                            result,
                          });
                        }
                      }
                    },
                    error: (error: unknown) => {
                      logger.error("Signal processing failed", {
                        error: error instanceof Error ? error.message : String(error),
                      });

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

          SESSION_CREATED: {
            actions: "updateSessionCreatedStats",
          },

          SESSION_COMPLETED: {
            actions: "updateSessionCompletedStats",
          },

          SESSION_FAILED: {
            actions: [
              "updateSessionCompletedStats",
              ({ event }) => {
                logger.error(`Session failed: ${event.sessionId}`, {
                  error: event.error,
                });
              },
            ],
          },

          STORE_SESSION_RESULT: {
            actions: ({ context, event }) => {
              // Store session results in library if available
              if (context.options.libraryStorage && event.result) {
                context.options.libraryStorage.storeItem({
                  id: crypto.randomUUID(),
                  type: "session_archive",
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
                  metadata: {
                    format: "json",
                    source: "system",
                    session_id: event.sessionId,
                  },
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  tags: ["session-archive", "automated"],
                  workspace_id: context.workspace.id,
                }).catch((error: unknown) => {
                  logger.error("Failed to store session results", {
                    sessionId: event.sessionId,
                    error: error instanceof Error ? error.message : String(error),
                  });
                });
              }
            },
          },

          SHUTDOWN: {
            target: "shuttingDown",
            actions: "setShuttingDown",
          },

          ERROR: {
            actions: ({ event }) => {
              logger.error("Runtime error", {
                error: event.error,
              });
            },
          },
        },
      },

      shuttingDown: {
        invoke: {
          src: "shutdownWorkspace",
          input: ({ context }) => ({ context }),
          onDone: {
            target: "terminated",
          },
          onError: {
            target: "terminated",
            actions: ({ event }) => {
              logger.error("Shutdown failed", {
                error: event.error,
              });
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

      error: {
        on: {
          SHUTDOWN: "shuttingDown",
        },
      },

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
    await MCPServerRegistry.initialize(
      config.atlas || undefined, // Platform config - convert null to undefined
      config.workspace, // Workspace config
    );

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

    // Register each server
    const registrationPromises = serverConfigs.map(async (serverConfig) => {
      try {
        await mcpManager.registerServer(serverConfig);
        logger.info(`Successfully registered MCP server: ${serverConfig.id}`, {
          operation: "mcp_server_registration",
          workspaceId,
          serverId: serverConfig.id,
          transport: serverConfig.transport.type,
        });
      } catch (error) {
        logger.error(`Failed to register MCP server: ${serverConfig.id}`, {
          operation: "mcp_server_registration",
          workspaceId,
          serverId: serverConfig.id,
          error: error instanceof Error ? error.message : String(error),
        });
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
      error: error instanceof Error ? error.message : String(error),
    });
    // Don't throw - workspace should continue to initialize even if MCP registration fails
  }
}
