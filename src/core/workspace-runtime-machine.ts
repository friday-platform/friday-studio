/**
 * Workspace Runtime Machine - XState 5 implementation
 * Replaces worker-based supervisor management with direct actor orchestration
 */

import { ConfigLoader, MergedConfig } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { load } from "@std/dotenv";
import { exists } from "@std/fs";
import { join } from "@std/path";
import { assign, createMachine, fromPromise } from "xstate";
import type {
  AtlasConfig,
  WorkspaceAgentConfig,
  WorkspaceConfig,
} from "../../packages/config/src/schemas.ts";
import type { IWorkspace, IWorkspaceSession, IWorkspaceSignal } from "../types/core.ts";
import { logger } from "../utils/logger.ts";
import { WorkspaceSupervisorActor } from "./actors/workspace-supervisor-actor.ts";
import { AgentLoader } from "./agent-loader.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { type ISignalProvider, ProviderType } from "./providers/types.ts";
import { Session } from "./session.ts";
import type { LibraryStorageAdapter } from "./storage/library-storage-adapter.ts";

interface StreamSignalData {
  // deno-lint-ignore no-explicit-any
  runtimeSignal: any; // Runtime signal instance
  signalConfig: Record<string, unknown>;
}

export interface WorkspaceRuntimeContext {
  workspace: IWorkspace;
  config?: Record<string, unknown>;
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
  mergedConfig?: {
    atlas: AtlasConfig;
    workspace: WorkspaceConfig;
    jobs?: Record<string, unknown>;
  };
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
  | { type: "STORE_SESSION_RESULT"; sessionId: string; result: Record<string, unknown> };

export function createWorkspaceRuntimeMachine(
  options: {
    workspace: IWorkspace;
    config?: Record<string, unknown>;
    workspacePath?: string;
    libraryStorage?: LibraryStorageAdapter;
  },
) {
  return createMachine({
    id: "workspaceRuntime",

    types: {} as {
      context: WorkspaceRuntimeContext;
      events: WorkspaceRuntimeEvent;
    },

    context: {
      workspace: options.workspace,
      config: options.config,
      options: {
        workspacePath: options.workspacePath,
        libraryStorage: options.libraryStorage,
      },
      sessions: new Map(),
      activeStreamSignals: new Map(),
      isShuttingDown: false,
      stats: {
        totalSignalsProcessed: 0,
        totalSessionsCreated: 0,
        activeSessionCount: 0,
      },
    },

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
          src: fromPromise(async ({ input }) => {
            const { context } = input;

            logger.info("Initializing workspace runtime", {
              workspaceId: context.workspace.id,
              hasConfig: !!context.config,
              workspacePath: context.options.workspacePath,
            });

            // Load workspace .env file if available
            if (context.options.workspacePath) {
              try {
                // Using static imports from top of file

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
              // Using static imports from top of file
              const adapter = new FilesystemConfigAdapter();
              const configLoader = new ConfigLoader(adapter, context.options.workspacePath);
              mergedConfig = await configLoader.load();
            }

            // Load all agents (platform + user)
            const allAgents: Record<string, WorkspaceAgentConfig> = {
              ...mergedConfig.atlas.agents,
              ...mergedConfig.workspace.agents,
            };

            if (Object.keys(allAgents).length > 0) {
              // Using static import from top of file
              const loadResult = await AgentLoader.loadAgents(
                context.workspace,
                allAgents,
              );

              logger.info("Agent loading complete", {
                workspaceId: context.workspace.id,
                loaded: loadResult.loaded.length,
                failed: loadResult.failed.length,
              });
            }

            // Create WorkspaceSupervisorActor
            const supervisor = new WorkspaceSupervisorActor(
              context.workspace.id,
              crypto.randomUUID(),
            );

            // Initialize supervisor with configuration
            await supervisor.initialize({
              workspaceId: context.workspace.id,
              workspace: context.workspace,
              config: {
                workspaceSignals: mergedConfig.workspace?.signals,
                jobs: mergedConfig.jobs,
                memoryConfig: mergedConfig.atlas?.memory,
                workspaceTools: mergedConfig.workspace?.tools?.mcp?.servers
                  ? { mcp: { servers: mergedConfig.workspace.tools.mcp.servers } }
                  : undefined,
                supervisorDefaults: mergedConfig.supervisorDefaults,
              },
              memoryConfig: mergedConfig.atlas?.memory,
              model: context.options.supervisorModel || mergedConfig.supervisor?.model,
            });

            logger.info("Workspace supervisor actor initialized", {
              workspaceId: context.workspace.id,
              supervisorId: supervisor.id,
            });

            return { supervisor, mergedConfig };
          }),
          input: ({ context }) => ({ context }),
          onDone: {
            target: "initializingStreams",
            actions: assign({
              supervisor: ({ event }) => event.output.supervisor,
              mergedConfig: ({ event }) => event.output.mergedConfig,
            }),
          },
          onError: {
            target: "error",
            actions: [
              ({ event }) => {
                logger.error("Failed to initialize workspace runtime", {
                  error: event.error,
                });
              },
              assign({
                error: ({ event }) => event.error as Error,
              }),
            ],
          },
        },
      },

      initializingStreams: {
        invoke: {
          src: fromPromise(async ({ input }) => {
            const { context } = input;
            const activeStreamSignals = new Map<string, StreamSignalData>();

            // Register built-in providers
            ProviderRegistry.registerBuiltinProviders();
            const registry = ProviderRegistry.getInstance();

            logger.info("Initializing stream signals", {
              workspaceId: context.workspace.id,
              signalCount: Object.keys(context.mergedConfig?.workspace.signals || {}).length,
            });

            // Initialize stream signals
            if (context.mergedConfig?.workspace.signals) {
              for (
                const [signalId, signalConfig] of Object.entries(
                  context.mergedConfig.workspace.signals,
                )
              ) {
                if (signalConfig.provider === "stream" || signalConfig.provider === "k8s-events") {
                  try {
                    logger.info(`Initializing real-time signal: ${signalId}`, {
                      provider: signalConfig.provider,
                    });

                    // Create provider config
                    const providerConfig = {
                      id: signalId,
                      type: ProviderType.SIGNAL,
                      provider: signalConfig.provider,
                      config: signalConfig.provider === "stream"
                        ? {
                          source: signalConfig.source,
                          endpoint: signalConfig.endpoint,
                          timeout_ms: signalConfig.timeout_ms,
                          retry_config: signalConfig.retry_config,
                        }
                        : {
                          // k8s-events config
                          kubeconfig: signalConfig.kubeconfig,
                          namespace: signalConfig.namespace,
                          // ... other k8s config fields
                        },
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
                      signalConfig,
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
          input: ({ context }) => ({ context }),
          onDone: {
            target: "ready",
            actions: [
              assign({
                activeStreamSignals: ({ event }) => event.output.activeStreamSignals,
              }),
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
              ({ event }) => {
                logger.error("Stream signal initialization failed", {
                  error: event.error,
                });
              },
              assign({
                error: ({ event }) => event.error as Error,
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
              assign({
                stats: ({ context }) => ({
                  ...context.stats,
                  totalSignalsProcessed: context.stats.totalSignalsProcessed + 1,
                }),
              }),

              // Process the signal asynchronously
              assign({
                sessions: ({ context, event, spawn }) => {
                  // Spawn the signal processing as a child actor
                  spawn(
                    fromPromise(async (params) => {
                      // Add debugging to see what we're getting
                      console.log("fromPromise params:", params);

                      // Direct access to context and event from closure
                      if (!context.supervisor) {
                        throw new Error("Supervisor not initialized");
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

                      // Override session ID
                      // deno-lint-ignore no-explicit-any
                      (session as any).id = sessionId;

                      // Store session
                      context.sessions.set(sessionId, session);

                      // Process signal through supervisor
                      const result = await context.supervisor.processSignal(
                        event.signal,
                        event.payload,
                        sessionId,
                        event.traceHeaders,
                      );

                      return { sessionId, result };
                    }),
                    {
                      id: ({ event }) => `signal-${event.signal.id}-${Date.now()}`,
                      onDone: ({ self, event }) => {
                        const { sessionId, result } = event.output;

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
                      },
                      onError: ({ self, event }) => {
                        logger.error("Signal processing failed", {
                          error: event.error,
                        });

                        self.send({
                          type: "ERROR",
                          error: event.error as Error,
                        });
                      },
                    },
                  );

                  // Return the sessions map (unchanged in this case)
                  return context.sessions;
                },
              }),
            ],
          },

          SESSION_CREATED: {
            actions: assign({
              stats: ({ context }) => ({
                ...context.stats,
                totalSessionsCreated: context.stats.totalSessionsCreated + 1,
                activeSessionCount: context.stats.activeSessionCount + 1,
              }),
            }),
          },

          SESSION_COMPLETED: {
            actions: assign({
              stats: ({ context }) => ({
                ...context.stats,
                activeSessionCount: Math.max(0, context.stats.activeSessionCount - 1),
              }),
              sessions: ({ context, event }) => {
                const newSessions = new Map(context.sessions);
                newSessions.delete(event.sessionId);
                return newSessions;
              },
            }),
          },

          SESSION_FAILED: {
            actions: [
              assign({
                stats: ({ context }) => ({
                  ...context.stats,
                  activeSessionCount: Math.max(0, context.stats.activeSessionCount - 1),
                }),
                sessions: ({ context, event }) => {
                  const newSessions = new Map(context.sessions);
                  newSessions.delete(event.sessionId);
                  return newSessions;
                },
              }),
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
            actions: assign({
              isShuttingDown: () => true,
            }),
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
          src: fromPromise(async ({ input }) => {
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
                await session.cancel();
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
