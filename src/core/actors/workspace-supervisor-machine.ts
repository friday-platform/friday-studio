/**
 * Workspace Supervisor Machine - XState 5 implementation
 * Manages signal processing and session actor spawning with proper concurrency control
 */

import { assign, createMachine, fromPromise, raise, sendTo } from "xstate";
import { SessionSupervisorActor } from "./session-supervisor-actor.ts";
import type { IWorkspace, IWorkspaceSignal } from "../../types/core.ts";
import type { WorkspaceConfig } from "../../../packages/config/src/schemas.ts";
import type { AtlasMemoryConfig } from "../memory-config.ts";

export interface WorkspaceSupervisorContext {
  workspaceId: string;
  workspace?: IWorkspace;
  supervisor?: WorkspaceSupervisor;
  sessions: Map<string, {
    sessionId: string;
    actorRef: any; // XState ActorRef
    status: "initializing" | "active" | "completed" | "failed";
    createdAt: number;
    signal: IWorkspaceSignal;
  }>;
  config?: {
    maxConcurrentSessions?: number;
    sessionTimeout?: number;
  };
  stats: {
    totalSignalsReceived: number;
    totalSessionsCreated: number;
    activeSessionCount: number;
  };
}

export type WorkspaceSupervisorEvent =
  | {
    type: "INITIALIZE";
    config: {
      workspaceId: string;
      workspace?: IWorkspace;
      memoryConfig?: AtlasMemoryConfig;
      maxConcurrentSessions?: number;
    };
  }
  | {
    type: "PROCESS_SIGNAL";
    signal: IWorkspaceSignal;
    payload: Record<string, unknown>;
    sessionId: string;
    signalConfig?: Record<string, unknown>;
    jobs?: Record<string, unknown>;
    traceHeaders?: Record<string, string>;
  }
  | {
    type: "SESSION_STARTED";
    sessionId: string;
  }
  | {
    type: "SESSION_COMPLETED";
    sessionId: string;
    summary: any;
  }
  | {
    type: "SESSION_FAILED";
    sessionId: string;
    error: string;
  }
  | {
    type: "CLEANUP_SESSIONS";
  }
  | {
    type: "SHUTDOWN";
  };

export function createWorkspaceSupervisorMachine(
  options: {
    maxConcurrentSessions?: number;
    sessionTimeout?: number;
  } = {},
) {
  return createMachine({
    id: "workspaceSupervisor",

    types: {} as {
      context: WorkspaceSupervisorContext;
      input: {
        workspaceId: string;
        workspace?: IWorkspace;
        memoryConfig?: AtlasMemoryConfig;
      };
      events: WorkspaceSupervisorEvent;
    },

    context: ({ input }) => ({
      workspaceId: input.workspaceId,
      workspace: input.workspace,
      sessions: new Map(),
      config: {
        maxConcurrentSessions: options.maxConcurrentSessions || 100,
        sessionTimeout: options.sessionTimeout || 24 * 60 * 60 * 1000,
      },
      stats: {
        totalSignalsReceived: 0,
        totalSessionsCreated: 0,
        activeSessionCount: 0,
      },
    }),

    initial: "uninitialized",

    states: {
      uninitialized: {
        on: {
          INITIALIZE: {
            target: "initializing",
            actions: assign({
              workspace: ({ event }) => event.config.workspace,
              config: ({ event }) => ({
                maxConcurrentSessions: event.config.maxConcurrentSessions || 100,
                sessionTimeout: 24 * 60 * 60 * 1000, // 24 hours
              }),
            }),
          },
        },
      },

      initializing: {
        invoke: {
          src: fromPromise(async ({ input }) => {
            const supervisor = new WorkspaceSupervisor(input.context.workspaceId, {
              memoryConfig: input.memoryConfig,
            });

            if (input.context.workspace) {
              supervisor.setWorkspace(input.context.workspace);
            }

            await supervisor.initialize();
            return supervisor;
          }),
          input: ({ context, event }) => ({
            context,
            memoryConfig:
              (event as Extract<WorkspaceSupervisorEvent, { type: "INITIALIZE" }>).config
                .memoryConfig,
          }),
          onDone: {
            target: "ready",
            actions: assign({
              supervisor: ({ event }) => event.output,
            }),
          },
          onError: {
            target: "error",
            actions: ({ event }) => {
              console.error("Failed to initialize workspace supervisor:", event.error);
            },
          },
        },
      },

      ready: {
        on: {
          PROCESS_SIGNAL: [
            {
              // Guard: Check if we're at capacity
              guard: ({ context }) => {
                const activeCount = Array.from(context.sessions.values())
                  .filter((s) => s.status === "active" || s.status === "initializing").length;
                return activeCount >= (context.config?.maxConcurrentSessions || 100);
              },
              actions: ({ event }) => {
                console.warn(
                  `Max concurrent sessions reached, rejecting signal ${event.signal.id}`,
                );
              },
            },
            {
              // Process the signal
              actions: [
                // Update stats
                assign({
                  stats: ({ context }) => ({
                    ...context.stats,
                    totalSignalsReceived: context.stats.totalSignalsReceived + 1,
                  }),
                }),

                // Spawn session actor
                assign({
                  sessions: ({ context, event, spawn }) => {
                    const sessionActor = spawn(
                      fromPromise(async ({ input }) => {
                        // Create and run session
                        const sessionActor = new SessionSupervisorActor(
                          input.sessionId,
                          input.workspaceId,
                        );
                        await sessionActor.initialize();

                        // Analyze signal and create context
                        const intent = await input.supervisor.analyzeSignal(
                          input.signal,
                          input.payload,
                        );

                        const sessionContext = await input.supervisor.createSessionContext(
                          intent,
                          input.signal,
                          input.payload,
                          { signalConfig: input.signalConfig, jobs: input.jobs },
                        );

                        // Initialize and execute session
                        sessionActor.initializeSession({
                          sessionId: input.sessionId,
                          workspaceId: input.workspaceId,
                          signal: input.signal,
                          payload: input.payload,
                          jobSpec: sessionContext.jobSpec,
                          availableAgents: sessionContext.availableAgents?.map((a: any) => a.id) ||
                            [],
                          constraints: sessionContext.constraints,
                          additionalPrompts: sessionContext.additionalPrompts,
                        });

                        const summary = await sessionActor.executeSession();
                        return { sessionActor, summary };
                      }),
                      {
                        id: `session-${event.sessionId}`,
                        input: {
                          sessionId: event.sessionId,
                          workspaceId: context.workspaceId,
                          signal: event.signal,
                          payload: event.payload,
                          signalConfig: event.signalConfig,
                          jobs: event.jobs,
                          supervisor: context.supervisor,
                        },
                        onDone: ({ self }) => {
                          self.send({
                            type: "SESSION_COMPLETED",
                            sessionId: event.sessionId,
                            summary: self.getSnapshot().output?.summary,
                          });
                        },
                        onError: ({ self, error }) => {
                          self.send({
                            type: "SESSION_FAILED",
                            sessionId: event.sessionId,
                            error: error.message,
                          });
                        },
                      },
                    );

                    const newSessions = new Map(context.sessions);
                    newSessions.set(event.sessionId, {
                      sessionId: event.sessionId,
                      actorRef: sessionActor,
                      status: "initializing",
                      createdAt: Date.now(),
                      signal: event.signal,
                    });

                    return newSessions;
                  },
                  stats: ({ context }) => ({
                    ...context.stats,
                    totalSessionsCreated: context.stats.totalSessionsCreated + 1,
                    activeSessionCount: context.stats.activeSessionCount + 1,
                  }),
                }),
              ],
            },
          ],

          SESSION_STARTED: {
            actions: assign({
              sessions: ({ context, event }) => {
                const newSessions = new Map(context.sessions);
                const session = newSessions.get(event.sessionId);
                if (session) {
                  session.status = "active";
                }
                return newSessions;
              },
            }),
          },

          SESSION_COMPLETED: {
            actions: [
              assign({
                sessions: ({ context, event }) => {
                  const newSessions = new Map(context.sessions);
                  const session = newSessions.get(event.sessionId);
                  if (session) {
                    session.status = "completed";
                  }
                  return newSessions;
                },
                stats: ({ context }) => ({
                  ...context.stats,
                  activeSessionCount: Math.max(0, context.stats.activeSessionCount - 1),
                }),
              }),
              // Schedule cleanup after a delay
              raise({ type: "CLEANUP_SESSIONS" }, { delay: 60000 }), // 1 minute
            ],
          },

          SESSION_FAILED: {
            actions: [
              assign({
                sessions: ({ context, event }) => {
                  const newSessions = new Map(context.sessions);
                  const session = newSessions.get(event.sessionId);
                  if (session) {
                    session.status = "failed";
                  }
                  return newSessions;
                },
                stats: ({ context }) => ({
                  ...context.stats,
                  activeSessionCount: Math.max(0, context.stats.activeSessionCount - 1),
                }),
              }),
              ({ event }) => {
                console.error(`Session ${event.sessionId} failed:`, event.error);
              },
            ],
          },

          CLEANUP_SESSIONS: {
            actions: assign({
              sessions: ({ context }) => {
                const now = Date.now();
                const maxAge = context.config?.sessionTimeout || 24 * 60 * 60 * 1000;
                const newSessions = new Map();

                for (const [sessionId, session] of context.sessions) {
                  const age = now - session.createdAt;
                  const shouldKeep =
                    (session.status === "active" || session.status === "initializing") ||
                    (age < maxAge);

                  if (shouldKeep) {
                    newSessions.set(sessionId, session);
                  } else {
                    // Stop the actor if it's still running
                    session.actorRef?.stop?.();
                  }
                }

                return newSessions;
              },
            }),
          },

          SHUTDOWN: {
            target: "shutting_down",
          },
        },
      },

      shutting_down: {
        entry: [
          // Stop all session actors
          ({ context }) => {
            for (const session of context.sessions.values()) {
              session.actorRef?.stop?.();
            }
          },
          // Cleanup supervisor
          ({ context }) => {
            context.supervisor?.destroy();
          },
        ],
        always: {
          target: "terminated",
        },
      },

      error: {
        on: {
          SHUTDOWN: "shutting_down",
        },
      },

      terminated: {
        type: "final",
      },
    },
  });
}

// Example usage:
/*
import { createActor } from "xstate";

const machine = createWorkspaceSupervisorMachine({
  maxConcurrentSessions: 50,
  sessionTimeout: 24 * 60 * 60 * 1000,
});

const actor = createActor(machine, {
  input: {
    workspaceId: "my-workspace",
    workspace: myWorkspace,
    memoryConfig: myMemoryConfig,
  }
});

actor.subscribe((state) => {
  console.log("State:", state.value);
  console.log("Active sessions:", state.context.stats.activeSessionCount);
});

actor.start();

// Initialize the supervisor
actor.send({
  type: "INITIALIZE",
  config: {
    workspaceId: "my-workspace",
    memoryConfig: myMemoryConfig,
  }
});

// Process signals
actor.send({
  type: "PROCESS_SIGNAL",
  signal: mySignal,
  payload: { data: "..." },
  sessionId: crypto.randomUUID(),
});
*/
