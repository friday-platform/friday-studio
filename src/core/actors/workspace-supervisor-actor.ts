/**
 * Workspace Supervisor Actor - Direct orchestration for workspace management
 * Migrated from WorkspaceSupervisorWorker to eliminate worker complexity
 *
 * Handles:
 * - Signal analysis and job trigger evaluation
 * - Session context creation and lifecycle management
 * - Direct SessionSupervisorActor orchestration
 * - MCP Server Registry initialization
 * - Advanced planning and caching capabilities
 */

import { type ChildLogger, logger } from "../../utils/logger.ts";
import { getWorkspaceManager } from "../workspace-manager.ts";
import { SessionSupervisorActor } from "./session-supervisor-actor.ts";
import type { IWorkspace, IWorkspaceSignal } from "../../types/core.ts";
import type { AtlasMemoryConfig } from "../memory-config.ts";
import type { WorkspaceConfig } from "../../../packages/config/src/schemas.ts";

export interface WorkspaceSupervisorConfig {
  workspaceId: string;
  workspace?: IWorkspace;
  config?: {
    workspaceSignals?: Record<string, unknown>;
    jobs?: Record<string, unknown>;
    memoryConfig?: AtlasMemoryConfig;
    workspaceTools?: { mcp?: { servers?: Record<string, any> } };
    supervisorDefaults?: any;
  };
  memoryConfig?: AtlasMemoryConfig;
  model?: string;
}

export interface SessionInfo {
  sessionId: string;
  actor: SessionSupervisorActor;
  workspaceId?: string;
  createdAt: number;
  status: "initializing" | "active" | "completed" | "failed";
}

export interface ProcessSignalResult {
  sessionId: string;
  status: "session_created" | "session_failed";
  sessionActorCreated: boolean;
  error?: string;
}

export class WorkspaceSupervisorActor {
  private workspaceId: string;
  private workspace?: IWorkspace;
  private logger: ChildLogger;
  private id: string;
  private sessions: Map<string, SessionInfo> = new Map();
  private workspaceConfig?: WorkspaceConfig;
  private config?: WorkspaceSupervisorConfig;

  constructor(workspaceId: string, id?: string) {
    this.id = id || crypto.randomUUID();
    this.workspaceId = workspaceId;

    this.logger = logger.createChildLogger({
      actorId: this.id,
      actorType: "workspace-supervisor",
      workspaceId: this.workspaceId,
    });

    this.logger.info("Workspace supervisor actor created", {
      workspaceId: this.workspaceId,
      actorId: this.id,
    });
  }

  async initialize(config: WorkspaceSupervisorConfig): Promise<void> {
    this.config = config;
    this.logger.info("Initializing workspace supervisor actor", {
      workspaceId: config.workspaceId,
      hasConfig: !!config.config,
      hasMemoryConfig: !!config.config?.memoryConfig,
    });

    // Load workspace configuration
    this.workspaceConfig = await this.loadWorkspaceConfig();

    // Validate memory configuration
    const memoryConfig = config.config?.memoryConfig || config.memoryConfig;
    if (!memoryConfig) {
      const errorMsg = "WorkspaceSupervisor requires memoryConfig";
      this.logger.error(errorMsg, {
        workspaceId: config.workspaceId,
        configKeys: Object.keys(config),
      });
      throw new Error(errorMsg);
    }

    // Store workspace if provided
    if (config.workspace) {
      this.workspace = config.workspace;
    }

    this.logger.info("Workspace supervisor actor initialized", {
      workspaceId: config.workspaceId,
      hasWorkspace: !!this.workspace,
      activeSessions: this.sessions.size,
    });
  }

  async processSignal(
    signal: IWorkspaceSignal,
    payload: Record<string, unknown>,
    sessionId: string,
    traceHeaders?: Record<string, string>,
  ): Promise<ProcessSignalResult> {
    try {
      this.logger.info("Processing signal", {
        signalId: signal.id,
        sessionId,
        workspaceId: this.workspaceId,
        payloadSize: JSON.stringify(payload).length,
      });

      // 1. Create SessionSupervisorActor immediately
      const sessionActor = new SessionSupervisorActor(
        sessionId,
        this.workspaceId,
        crypto.randomUUID(),
      );

      // Store session info
      const sessionInfo: SessionInfo = {
        sessionId,
        actor: sessionActor,
        workspaceId: this.workspaceId,
        createdAt: Date.now(),
        status: "initializing",
      };
      this.sessions.set(sessionId, sessionInfo);

      // 2. Initialize the session actor
      await sessionActor.initialize();
      sessionInfo.status = "active";

      // 3. Analyze signal and create session context (background processing)
      this.processSignalAsync(
        signal,
        payload,
        sessionId,
        sessionActor,
        traceHeaders,
      )
        .catch((error) => {
          this.logger.error("Signal processing failed", {
            sessionId,
            signalId: signal.id,
            error: error.message,
          });
          sessionInfo.status = "failed";
        });

      // 4. Return immediately - session actor is ready
      return {
        sessionId,
        status: "session_created",
        sessionActorCreated: true,
      };
    } catch (error) {
      this.logger.error("Failed to process signal", {
        signalId: signal.id,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        sessionId,
        status: "session_failed",
        sessionActorCreated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async processSignalAsync(
    signal: IWorkspaceSignal,
    payload: Record<string, unknown>,
    sessionId: string,
    sessionActor: SessionSupervisorActor,
    traceHeaders?: Record<string, string>,
  ): Promise<void> {
    try {
      // Analyze signal to determine intent
      this.logger.info("Analyzing signal", {
        sessionId,
        signalId: signal.id,
      });

      // For now, create a simple intent based on the signal
      const intent = {
        id: crypto.randomUUID(),
        signal: signal.id,
        confidence: 1.0,
        reasoning: "Direct signal mapping",
      };

      this.logger.info("Signal analysis complete", {
        sessionId,
        signalId: signal.id,
        intentId: intent.id,
      });

      // Create session context
      this.logger.info("Creating session context", { sessionId });

      // Find the job that is triggered by this signal
      let jobSpec = undefined;
      if (this.workspaceConfig?.jobs) {
        for (const [jobId, job] of Object.entries(this.workspaceConfig.jobs)) {
          if (job.triggers?.some((trigger) => trigger.signal === signal.id)) {
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

      const sessionContext = {
        sessionId,
        workspaceId: this.workspaceId,
        signal,
        payload,
        intent,
        availableAgents: this.workspace ? Object.values(this.workspace.agents) : [],
        config: this.workspaceConfig,
        jobSpec,
      };

      this.logger.info("Session context created", {
        sessionId,
        availableAgents: sessionContext.availableAgents?.length || 0,
        hasJobSpec: !!jobSpec,
      });

      // Initialize session with context
      sessionActor.initializeSession({
        sessionId,
        workspaceId: this.workspaceId,
        signal,
        payload,
        jobSpec,
        availableAgents: sessionContext.availableAgents?.map((agent: any) => agent.id) || [],
        constraints: sessionContext.constraints,
        additionalPrompts: sessionContext.additionalPrompts,
      });

      // Execute the session
      const sessionSummary = await sessionActor.executeSession();

      this.logger.info("Session execution completed", {
        sessionId,
        status: sessionSummary.status,
        totalPhases: sessionSummary.totalPhases,
        totalAgents: sessionSummary.totalAgents,
        duration: sessionSummary.duration,
      });

      // Update session status
      const sessionInfo = this.sessions.get(sessionId);
      if (sessionInfo) {
        sessionInfo.status = sessionSummary.status === "completed" ? "completed" : "failed";
      }
    } catch (error) {
      this.logger.error("Signal processing failed", {
        sessionId,
        signalId: signal.id,
        error: error instanceof Error ? error.message : String(error),
      });

      // Update session status
      const sessionInfo = this.sessions.get(sessionId);
      if (sessionInfo) {
        sessionInfo.status = "failed";
      }
    }
  }

  async getStatus(): Promise<{
    ready: boolean;
    workspaceId: string;
    sessions: number;
    activeSessions: number;
    completedSessions: number;
    failedSessions: number;
  }> {
    const sessionsByStatus = {
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

  setWorkspace(workspace: IWorkspace): void {
    this.workspace = workspace;
  }

  // Session lifecycle management
  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const sessionInfo = this.sessions.get(sessionId);
    if (sessionInfo) {
      this.logger.info("Cleaning up session", {
        sessionId,
        status: sessionInfo.status,
      });

      // Session actors don't need explicit cleanup as they're not workers
      this.sessions.delete(sessionId);
    }
  }

  async cleanup(): Promise<void> {
    this.logger.info("Cleaning up workspace supervisor actor", {
      workspaceId: this.workspaceId,
      sessions: this.sessions.size,
    });

    // Clean up all sessions
    for (const sessionId of this.sessions.keys()) {
      await this.cleanupSession(sessionId);
    }

    // Clean up supervisor

    this.workspace = undefined;
    this.workspaceConfig = undefined;
    this.config = undefined;
  }

  // Precomputed plans access for session supervisors
  getPrecomputedPlans(requestingWorkspaceId?: string): Record<string, any> {
    // TODO: Implement precomputed plans
    return {};
  }

  // Helper methods
  private async loadWorkspaceConfig(): Promise<WorkspaceConfig> {
    const workspaceManager = await getWorkspaceManager();

    if (!this.workspaceId || this.workspaceId === "global") {
      const atlasConfig = await workspaceManager.getAtlasConfig();
      if (!atlasConfig) {
        throw new Error("Global atlas.yml configuration not found");
      }
      return atlasConfig;
    } else {
      const workspaceConfig = await workspaceManager.getWorkspaceConfigBySlug(this.workspaceId);
      if (!workspaceConfig) {
        throw new Error(`Workspace configuration not found: ${this.workspaceId}`);
      }
      return workspaceConfig;
    }
  }

  // Periodic cleanup of old sessions
  performPeriodicCleanup(): void {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

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
