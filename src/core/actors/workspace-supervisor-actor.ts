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

import type { JobSpecification, WorkspaceAgentConfig } from "@atlas/config";
import type {
  ActorInitParams,
  AgentOrchestrator,
  BaseActor,
  SessionInfo as ISessionInfo,
  SessionSupervisorConfig,
  WorkspaceSupervisorConfig,
} from "@atlas/core";
import {
  ReasoningResultStatus,
  WorkspaceSessionStatus,
  type WorkspaceSessionStatusType,
} from "@atlas/core";
import { type Logger, logger } from "@atlas/logger";
import { CoALAMemoryManager } from "@atlas/memory";
import type { IWorkspaceSignal } from "../../types/core.ts";
import { type SessionContext, SessionSupervisorActor } from "./session-supervisor-actor.ts";

export interface SessionInfo {
  sessionId: string;
  actor: SessionSupervisorActor;
  workspaceId: string;
  createdAt: number;
  status: WorkspaceSessionStatusType;
}

export interface ProcessSignalResult {
  sessionId: string;
  status: "session_created" | "session_failed";
  sessionActorCreated: boolean;
  sessionActor?: SessionSupervisorActor; // Direct reference to execution engine
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
  private agentOrchestrator?: AgentOrchestrator; // Will be set by workspace runtime

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

  async initialize(params: ActorInitParams): Promise<void> {
    this.id = params.actorId;
    this.logger = logger.child({
      actorId: this.id,
      actorType: "workspace-supervisor",
      workspaceId: this.workspaceId,
    });

    this.logger.info("Workspace supervisor actor initializing", {
      workspaceId: this.workspaceId,
      actorId: this.id,
    });

    // Initialize memory systems if memory is enabled
    if (this.config.memory?.session.enabled !== false) {
      await this.initializeMemorySystems();
    }

    this.logger.info("Workspace supervisor actor initialized", {
      workspaceId: this.workspaceId,
      actorId: this.id,
      memoryEnabled: this.config.memory?.session.enabled !== false,
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

  setAgentOrchestrator(orchestrator: AgentOrchestrator): void {
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

      // Create session config with the found job and agents
      const sessionConfig: SessionSupervisorConfig = {
        agents: this.agents,
        memory: this.config.memory,
        tools: this.config.tools,
      };

      // Create session actor without config initially
      const sessionActor = new SessionSupervisorActor(
        sessionId,
        this.workspaceId,
        sessionConfig,
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
        status: WorkspaceSessionStatus.PENDING,
      };
      this.sessions.set(sessionId, sessionInfo);

      sessionActor.initialize();
      sessionInfo.status = WorkspaceSessionStatus.EXECUTING;

      // Use queueMicrotask to defer the heavy processing until after this function returns.
      // queueMicrotask() schedules a function to run asynchronously in the next microtask,
      // allowing us to return immediately with a "session_created" status while the actual
      // signal processing happens in the background. This is similar to Promise.resolve().then()
      // but more explicit about the intent to defer work.
      queueMicrotask(() => {
        try {
          this.logger.info("Analyzing signal", { sessionId, signalId: signal.id });

          // Match signal to job configuration
          let jobSpec: JobSpecification | undefined;
          if (this.config.jobs) {
            for (const [jobId, job] of Object.entries(this.config.jobs)) {
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

          if (!jobSpec) {
            this.logger.warn("No job found for signal", { signalId: signal.id, sessionId });
            sessionInfo.status = WorkspaceSessionStatus.FAILED;
            return;
          }

          // Extract agent IDs from job specification
          const availableAgents: string[] = jobSpec.execution.agents.map((agent) =>
            typeof agent === "string" ? agent : agent.id,
          );

          const sessionContext: SessionContext = {
            signal,
            payload,
            availableAgents,
            jobSpec,
            streamId: streamId, // Only use the streamId parameter - never fallback to payload
          };

          this.logger.info("Session context created", {
            sessionId,
            availableAgents: sessionContext.availableAgents?.length || 0,
            hasJobSpec: !!jobSpec,
          });

          sessionActor.initializeSession(sessionContext);

          // Start execution (this creates the execution promise)
          // We don't await here - just start it
          sessionActor.executeSession().then(
            (sessionSummary) => {
              this.logger.info("Session execution completed", {
                sessionId,
                status: sessionSummary.status,
                failureReason: sessionSummary.failureReason,
                totalPhases: sessionSummary.totalPhases,
                totalAgents: sessionSummary.totalAgents,
                duration: sessionSummary.duration,
              });

              sessionInfo.status =
                sessionSummary.status === ReasoningResultStatus.COMPLETED
                  ? WorkspaceSessionStatus.COMPLETED
                  : sessionSummary.status === ReasoningResultStatus.CANCELLED
                    ? WorkspaceSessionStatus.CANCELLED
                    : WorkspaceSessionStatus.FAILED;

              // Clean up session after completion
              this.cleanupSession(sessionId);
            },
            (error) => {
              const isCancellation =
                error instanceof Error &&
                (error.message.includes("Session cancelled") || error.message.includes("aborted"));

              if (isCancellation) {
                this.logger.info("Session execution cancelled", { sessionId, signalId: signal.id });
                sessionInfo.status = WorkspaceSessionStatus.CANCELLED;
              } else {
                this.logger.error("Session execution failed", {
                  sessionId,
                  signalId: signal.id,
                  error,
                });
                sessionInfo.status = WorkspaceSessionStatus.FAILED;
              }

              // Clean up session after failure
              this.cleanupSession(sessionId);
            },
          );
        } catch (error) {
          this.logger.error("Signal processing setup failed", {
            sessionId,
            signalId: signal.id,
            error,
          });
          sessionInfo.status = WorkspaceSessionStatus.FAILED;
        }
      });

      // Return immediately with success and include sessionActor reference
      return Promise.resolve({
        sessionId,
        status: "session_created" as const,
        sessionActorCreated: true,
        sessionActor, // Provide direct access to SessionSupervisorActor
      });
    } catch (error) {
      this.logger.error("Failed to process signal", { signalId: signal.id, sessionId, error });

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
      if (
        sessionInfo.status === WorkspaceSessionStatus.EXECUTING ||
        sessionInfo.status === WorkspaceSessionStatus.PENDING
      ) {
        sessionsByStatus.active++;
      } else if (sessionInfo.status === WorkspaceSessionStatus.COMPLETED) {
        sessionsByStatus.completed++;
      } else if (sessionInfo.status === WorkspaceSessionStatus.FAILED) {
        sessionsByStatus.failed++;
      } else if (sessionInfo.status === WorkspaceSessionStatus.CANCELLED) {
        sessionsByStatus.failed++; // Count cancelled as failed for backward compatibility
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

    return { id: session.sessionId, status: session.status, startTime: session.createdAt };
  }

  cleanupSession(sessionId: string): void {
    const sessionInfo = this.sessions.get(sessionId);
    if (!sessionInfo) return;

    this.logger.info("Cleaning up session memory objects (preserving history)", {
      sessionId,
      status: sessionInfo.status,
      hasActor: !!sessionInfo.actor,
    });

    // Clean up heavy memory objects via the session actor, but keep the session entry for history
    if (sessionInfo.actor) {
      try {
        // Only release heavy memory; do not change status or emit events
        sessionInfo.actor.releaseHeavyMemoryObjects();
      } catch (error) {
        this.logger.warn("Error during session actor shutdown", { sessionId, error: error });
      }
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
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === WorkspaceSessionStatus.EXECUTING,
    ).length;
  }

  performPeriodicCleanup(): void {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000;

    for (const [sessionId, sessionInfo] of this.sessions) {
      if (
        (sessionInfo.status === WorkspaceSessionStatus.COMPLETED ||
          sessionInfo.status === WorkspaceSessionStatus.FAILED ||
          sessionInfo.status === WorkspaceSessionStatus.CANCELLED) &&
        now - sessionInfo.createdAt > maxAge
      ) {
        this.logger.debug("Releasing heavy memory objects for old session", {
          sessionId,
          status: sessionInfo.status,
          age: now - sessionInfo.createdAt,
        });
        // Only release the actor to reduce memory; keep session record for history
        if (sessionInfo.actor) {
          try {
            // Only release heavy memory; do not change status or emit events
            sessionInfo.actor.releaseHeavyMemoryObjects();
          } catch (error) {
            this.logger.warn("Error shutting down old session actor", {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
  }

  /**
   * Initialize memory systems for the workspace
   */
  private async initializeMemorySystems(): Promise<void> {
    try {
      this.logger.info("Initializing memory systems", { workspaceId: this.workspaceId });

      // Initialize CoALA memory manager for the workspace
      const workspaceScope = {
        id: this.workspaceId,
        workspaceId: this.workspaceId,
        type: "workspace" as const,
      };

      const memoryManager = new CoALAMemoryManager(workspaceScope);

      // Ingest rules.md if present in workspace
      await this.ingestProceduralRules(memoryManager);

      this.logger.info("Memory systems initialized successfully", {
        workspaceId: this.workspaceId,
        streamingMemoryEnabled: true,
      });
    } catch (error) {
      this.logger.error("Failed to initialize memory systems", {
        workspaceId: this.workspaceId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // Don't throw - memory failure shouldn't prevent workspace startup
    }
  }

  /**
   * Ingest rules.md into procedural memory if present
   */
  private async ingestProceduralRules(memoryManager: CoALAMemoryManager): Promise<void> {
    try {
      // Try to find rules.md in workspace directory
      const workspacePath = this.config.workspacePath;
      const rulesPath = `${workspacePath}/rules.md`;

      try {
        const rulesContent = await Deno.readTextFile(rulesPath);

        if (rulesContent && rulesContent.trim().length > 0) {
          this.logger.info("Found rules.md, ingesting into procedural memory", {
            workspaceId: this.workspaceId,
            rulesPath,
            contentLength: rulesContent.length,
          });

          // Parse rules into sections
          const sections = this.parseRulesContent(rulesContent);

          // Also initialize MECMF for better procedural memory classification
          const { setupMECMF, createConversationContext, MemorySource } = await import(
            "@atlas/memory"
          );
          const workspaceScope = {
            id: this.workspaceId,
            workspaceId: this.workspaceId,
            type: "workspace" as const,
          };

          const mecmfManager = await setupMECMF(workspaceScope, {
            workspaceId: this.workspaceId,
            enableVectorSearch: false, // Procedural memory doesn't need vectors
          });

          const context = createConversationContext("workspace-init", this.workspaceId, {
            currentTask: "Loading workspace procedural rules",
          });

          // Store each section as a procedural memory entry
          for (const section of sections) {
            const key = `proc:rule:${section.slug}`;
            await memoryManager.rememberWithMetadata(
              key,
              {
                type: "procedural_rule",
                title: section.title,
                content: section.content,
                source: "rules.md",
                readOnly: "true",
                ingestionTime: Date.now().toString(),
              },
              {
                memoryType: "procedural",
                tags: ["rules", "procedural", "workspace", "read-only", section.slug],
                relevanceScore: 0.95,
                confidence: 1.0,
                source: MemorySource.SYSTEM_GENERATED,
                sourceMetadata: { workspaceId: this.workspaceId },
              },
            );

            // Also store in MECMF for enhanced retrieval during prompt construction
            const proceduralContent = `Workspace Procedural Rule - ${section.title}:\n${section.content}`;
            await mecmfManager.classifyAndStore(
              proceduralContent,
              context,
              MemorySource.SYSTEM_GENERATED, // Rules content is system-generated
              { workspaceId: this.workspaceId },
            );
          }

          this.logger.info("Rules.md ingested successfully into both CoALA and MECMF memory", {
            workspaceId: this.workspaceId,
            sectionCount: sections.length,
          });
        }
      } catch (fileError) {
        // File doesn't exist or can't be read - this is OK
        this.logger.debug("No rules.md found in workspace", {
          workspaceId: this.workspaceId,
          path: rulesPath,
          error: fileError instanceof Error ? fileError.message : String(fileError),
        });
      }
    } catch (error) {
      this.logger.warn("Failed to ingest procedural rules", {
        workspaceId: this.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Parse rules.md content into sections
   */
  private parseRulesContent(
    content: string,
  ): Array<{ slug: string; title: string; content: string }> {
    const sections: Array<{ slug: string; title: string; content: string }> = [];

    // Split by headings (# or ##)
    const lines = content.split("\n");
    let currentSection: { slug: string; title: string; content: string } | null = null;

    for (const line of lines) {
      const headingMatch = line.match(/^#{1,2}\s+(.+)$/);

      if (headingMatch) {
        // Save previous section if exists
        if (currentSection?.content.trim()) {
          sections.push(currentSection);
        }

        // Start new section
        const title = headingMatch[1]?.trim() || "";
        const slug = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");

        currentSection = { slug, title, content: "" };
      } else if (currentSection) {
        // Add content to current section
        currentSection.content += line + "\n";
      }
    }

    // Don't forget the last section
    if (currentSection?.content.trim()) {
      sections.push(currentSection);
    }

    // If no sections found, treat entire content as one section
    if (sections.length === 0 && content.trim()) {
      sections.push({ slug: "general-rules", title: "General Rules", content: content });
    }

    return sections;
  }
}
