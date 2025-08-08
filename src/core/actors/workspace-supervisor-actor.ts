/**
 * Workspace Supervisor Actor
 *
 * Orchestrates workspace-level operations by managing sessions and processing signals.
 * Acts as the primary coordinator between incoming signals and session execution.
 *
 * Key responsibilities:
 * - Signal processing and job matching
 * - Session lifecycle management
 * - Resource allocation and cleanup
 */

import type {
  ActorInitParams,
  BaseActor,
  SessionInfo as ISessionInfo,
  SessionSupervisorConfig,
  WorkspaceSupervisorConfig,
} from "@atlas/core";
import type { IWorkspaceSignal } from "../../types/core.ts";
import type { JobSpecification, WorkspaceAgentConfig } from "@atlas/config";
import { type Logger, logger } from "@atlas/logger";
import { type SessionContext, SessionSupervisorActor } from "./session-supervisor-actor.ts";

export interface SessionInfo {
  sessionId: string;
  actor: SessionSupervisorActor;
  workspaceId: string;
  createdAt: number;
  status: "initializing" | "active" | "completed" | "failed";
}

export interface ProcessSignalResult {
  sessionId: string;
  status: "session_created" | "session_failed";
  sessionActorCreated: boolean;
  error?: string;
}

export class WorkspaceSupervisorActor implements BaseActor {
  readonly type = "workspace" as const;
  private workspaceId: string;
  private logger: Logger;
  id: string;
  private sessions: Map<string, SessionInfo> = new Map();
  private config: WorkspaceSupervisorConfig;
  private agents: Record<string, WorkspaceAgentConfig> = {};
  private agentOrchestrator?: any; // Will be set by workspace runtime

  constructor(workspaceId: string, config: WorkspaceSupervisorConfig, id?: string) {
    this.id = id || crypto.randomUUID();
    this.workspaceId = workspaceId;
    this.config = config;

    this.logger = logger.child({
      actorId: this.id,
      actorType: "workspace-supervisor",
      workspaceId: this.workspaceId,
    });

    this.logger.info("Workspace supervisor actor created", {
      workspaceId: this.workspaceId,
      actorId: this.id,
    });
  }

  initialize(params: ActorInitParams): void {
    this.id = params.actorId;
    this.logger = logger.child({
      actorId: this.id,
      actorType: "workspace-supervisor",
      workspaceId: this.workspaceId,
    });

    this.logger.info("Workspace supervisor actor initialized", {
      workspaceId: this.workspaceId,
      actorId: this.id,
    });
  }

  setAgents(agents: Record<string, WorkspaceAgentConfig>): void {
    this.agents = agents;
    this.logger.info("Agents set for workspace supervisor", {
      workspaceId: this.workspaceId,
      agentCount: Object.keys(agents).length,
      agentIds: Object.keys(agents),
    });
  }

  setAgentOrchestrator(orchestrator: any): void {
    this.agentOrchestrator = orchestrator;
    this.logger.info("Agent orchestrator set for workspace supervisor", {
      workspaceId: this.workspaceId,
    });
  }

  processSignal(
    signal: IWorkspaceSignal,
    payload: Record<string, unknown>,
    sessionId: string,
    streamId?: string,
  ): Promise<ProcessSignalResult> {
    try {
      this.logger.info("Processing signal", {
        signalId: signal.id,
        sessionId,
        workspaceId: this.workspaceId,
        payloadSize: JSON.stringify(payload).length,
      });

      // Create session actor without config initially
      const sessionActor = new SessionSupervisorActor(
        sessionId,
        this.workspaceId,
        crypto.randomUUID(),
      );

      // Pass orchestrator to session supervisor if available
      if (this.agentOrchestrator) {
        sessionActor.setAgentOrchestrator(this.agentOrchestrator);
      }

      const sessionInfo: SessionInfo = {
        sessionId,
        actor: sessionActor,
        workspaceId: this.workspaceId,
        createdAt: Date.now(),
        status: "initializing",
      };
      this.sessions.set(sessionId, sessionInfo);

      sessionActor.initialize();
      sessionInfo.status = "active";

      // Use queueMicrotask to defer the heavy processing until after this function returns.
      // queueMicrotask() schedules a function to run asynchronously in the next microtask,
      // allowing us to return immediately with a "session_created" status while the actual
      // signal processing happens in the background. This is similar to Promise.resolve().then()
      // but more explicit about the intent to defer work.
      queueMicrotask(async () => {
        try {
          this.logger.info("Analyzing signal", {
            sessionId,
            signalId: signal.id,
          });

          // Match signal to job configuration
          let jobSpec: JobSpecification | undefined = undefined;
          if (this.config.jobs) {
            for (const [jobId, job] of Object.entries(this.config.jobs)) {
              if (job.triggers.some((trigger) => trigger.signal === signal.id)) {
                jobSpec = job;
                this.logger.info("Found matching job for signal", {
                  signalId: signal.id,
                  jobId,
                  jobName: job.name,
                });
                break;
              }
            }
          }

          if (!jobSpec) {
            this.logger.warn("No job found for signal", {
              signalId: signal.id,
              sessionId,
            });
            sessionInfo.status = "failed";
            return;
          }

          // Create session config with the found job and agents
          const sessionConfig: SessionSupervisorConfig = {
            job: jobSpec,
            agents: this.agents,
            memory: this.config.memory,
            tools: this.config.tools,
          };

          // Pass config to session actor
          sessionActor.setConfig(sessionConfig);

          // Extract agent IDs from job specification
          const availableAgents: string[] = jobSpec.execution.agents.map((agent) =>
            typeof agent === "string" ? agent : agent.id
          );

          const sessionContext: SessionContext = {
            sessionId,
            workspaceId: this.workspaceId,
            signal,
            payload,
            availableAgents,
            jobSpec,
            streamId: streamId || (payload.streamId as string | undefined), // Use streamId parameter first, fallback to payload
          };

          this.logger.info("Session context created", {
            sessionId,
            availableAgents: sessionContext.availableAgents?.length || 0,
            hasJobSpec: !!jobSpec,
          });

          sessionActor.initializeSession(sessionContext);

          const sessionSummary = await sessionActor.executeSession();

          this.logger.info("Session execution completed", {
            sessionId,
            status: sessionSummary.status,
            totalPhases: sessionSummary.totalPhases,
            totalAgents: sessionSummary.totalAgents,
            duration: sessionSummary.duration,
          });

          sessionInfo.status = sessionSummary.status === "completed" ? "completed" : "failed";
        } catch (error) {
          this.logger.error("Signal processing failed", {
            sessionId,
            signalId: signal.id,
            error: error instanceof Error ? error.message : String(error),
          });
          sessionInfo.status = "failed";
        }
      });

      // Return immediately with success
      return Promise.resolve({
        sessionId,
        status: "session_created" as const,
        sessionActorCreated: true,
      });
    } catch (error) {
      this.logger.error("Failed to process signal", {
        signalId: signal.id,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });

      return Promise.resolve({
        sessionId,
        status: "session_failed" as const,
        sessionActorCreated: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getStatus(): {
    ready: boolean;
    workspaceId: string;
    sessions: number;
    activeSessions: number;
    completedSessions: number;
    failedSessions: number;
  } {
    const sessionsByStatus: { active: number; completed: number; failed: number } = {
      active: 0,
      completed: 0,
      failed: 0,
    };

    for (const sessionInfo of this.sessions.values()) {
      if (sessionInfo.status === "active" || sessionInfo.status === "initializing") {
        sessionsByStatus.active++;
      } else if (sessionInfo.status === "completed") {
        sessionsByStatus.completed++;
      } else if (sessionInfo.status === "failed") {
        sessionsByStatus.failed++;
      }
    }

    return {
      ready: true,
      workspaceId: this.workspaceId,
      sessions: this.sessions.size,
      activeSessions: sessionsByStatus.active,
      completedSessions: sessionsByStatus.completed,
      failedSessions: sessionsByStatus.failed,
    };
  }

  getSession(sessionId: string): ISessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    return {
      id: session.sessionId,
      status: session.status,
      startTime: session.createdAt,
    };
  }

  cleanupSession(sessionId: string): void {
    const sessionInfo = this.sessions.get(sessionId);
    if (sessionInfo) {
      this.logger.info("Cleaning up session", {
        sessionId,
        status: sessionInfo.status,
      });

      this.sessions.delete(sessionId);
    }
  }

  cleanup(): void {
    this.logger.info("Cleaning up workspace supervisor actor", {
      workspaceId: this.workspaceId,
      sessions: this.sessions.size,
    });

    for (const sessionId of this.sessions.keys()) {
      this.cleanupSession(sessionId);
    }
  }

  shutdown(): void {
    this.cleanup();
  }

  getActiveSessionCount(): number {
    return Array.from(this.sessions.values()).filter((s) => s.status === "active").length;
  }

  performPeriodicCleanup(): void {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000;

    for (const [sessionId, sessionInfo] of this.sessions) {
      if (
        (sessionInfo.status === "completed" || sessionInfo.status === "failed") &&
        now - sessionInfo.createdAt > maxAge
      ) {
        this.logger.debug("Cleaning up old session", {
          sessionId,
          status: sessionInfo.status,
          age: now - sessionInfo.createdAt,
        });
        this.sessions.delete(sessionId);
      }
    }
  }
}
