/**
 * Session Supervisor Actor
 *
 * Orchestrates the execution of agent sessions within Atlas workspaces.
 * Manages the complete lifecycle of a session from planning through execution.
 *
 * Key responsibilities:
 * - Creates execution plans using multi-step reasoning or cached job specs
 * - Executes agents in sequential or parallel phases
 * - Monitors progress and applies supervision-level controls
 * - Handles memory operations for fact extraction and summaries
 */

import type { AgentResult, AtlasUIMessageChunk, StreamEmitter } from "@atlas/agent-sdk";
import type { JobSpecification, WorkspaceAgentConfig } from "@atlas/config";
import type {
  ActorInitParams,
  AgentTask,
  BaseActor,
  CombinedAgentInput,
  ExecutionPlanReasoningStep,
  IAgentOrchestrator,
  SessionResult,
  SessionSupervisorConfig,
} from "@atlas/core";
import {
  type AppendSessionEventInput,
  anthropic,
  appendSessionEvent,
  CallbackStreamEmitter,
  type CreateSessionMetadataInput,
  createSessionRecord,
  loadSessionTimeline,
  markSessionComplete,
  ReasoningResultStatus,
  type ReasoningResultStatusType,
  type SessionHistoryEvent,
  type SessionHistoryEventContext,
  type SessionHistoryTimeline,
  SessionSupervisorStatus,
  type SessionSupervisorStatusType,
  toAgentSnapshot,
  toToolCallEvent,
  toToolResultEvent,
} from "@atlas/core";
import { type Logger, logger } from "@atlas/logger";
import { initializeWorkspaceMemory, type MECMFMemoryManager } from "@atlas/memory";
import { sessionSupervisorAgent } from "@atlas/system/agents";
import { generateObject } from "ai";
import type { IWorkspaceArtifact, IWorkspaceSignal } from "../../types/core.ts";
import {
  analyzeResults as analyzeHallucinations,
  containsSeverePatterns,
  getSevereIssues,
  type HallucinationAnalysis,
  type HallucinationDetectorConfig,
} from "../services/hallucination-detector.ts";
import { getSupervisionConfig, SupervisionLevel } from "../supervision-levels.ts";
import { ExecutionPlanSchema } from "./session-supervisor-planner-schemas.ts";

export interface SessionContext {
  signal: IWorkspaceSignal;
  payload: Record<string, unknown>;
  jobSpec?: JobSpecification;
  availableAgents: string[];
  constraints?: Record<string, unknown>;
  streamId?: string; // Optional streamId for streaming support
  onStreamEvent?: (event: AtlasUIMessageChunk) => void; // Optional callback for stream events
}

// Type alias for signal with description in config
interface WorkspaceSignalWithDescription extends IWorkspaceSignal {
  config?: { description?: string };
}

// NOTE: Use AgentResult from @atlas/agent-sdk
export interface ExecutionPlan {
  id: string;
  phases: ExecutionPhase[];
  reasoning: string;
  strategy: string;
  confidence: number;
  reasoningSteps?: ExecutionPlanReasoningStep[];
}

export interface ExecutionPhase {
  id: string;
  name: string;
  executionStrategy: "sequential" | "parallel";
  agents: AgentTask[];
  reasoning?: string;
}

export interface SessionSummary {
  sessionId: string;
  workspaceId: string;
  status: ReasoningResultStatusType;
  totalPhases: number;
  totalAgents: number;
  completedPhases: number;
  executedAgents: number;
  duration: number;
  reasoning: string;
  results: AgentResult[];
  failureReason?: string;
  confidence?: number;
}

export interface ConfidenceAnalysis {
  averageConfidence: number;
  lowConfidenceAgents: string[];
  suspiciousPatterns: string[];
  issues: string[];
}

interface SessionHistoryStorageAdapter {
  createSessionRecord: typeof createSessionRecord;
  appendSessionEvent: typeof appendSessionEvent;
  markSessionComplete: typeof markSessionComplete;
  loadSessionTimeline: typeof loadSessionTimeline;
}

interface SessionSupervisorActorOptions {
  historyStorage?: SessionHistoryStorageAdapter;
}

const DefaultHistoryStorageAdapter: SessionHistoryStorageAdapter = {
  createSessionRecord,
  appendSessionEvent,
  markSessionComplete,
  loadSessionTimeline,
};

type AgentExecutionRecord = AgentResult & { executionId: string; phaseId: string };

// Custom error class to indicate we've already emitted the appropriate event
class OrchestratorHandledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorHandledError";
  }
}

export class SessionSupervisorActor implements BaseActor {
  readonly type: "session" = "session";
  private sessionId: string;
  private workspaceId: string;
  private logger: Logger;
  id: string;
  private config: SessionSupervisorConfig;
  private sessionContext?: SessionContext;
  private status: SessionSupervisorStatusType = SessionSupervisorStatus.IDLE;
  private cachedPlan?: ExecutionPlan;
  private agentOrchestrator?: IAgentOrchestrator; // Agent orchestrator for MCP-based execution
  private artifacts: IWorkspaceArtifact[] = []; // Store session artifacts
  private llmProvider = anthropic;
  private historyStorage: SessionHistoryStorageAdapter;
  private persistedArtifacts: IWorkspaceArtifact[] = [];

  // Session evaluation services
  private hallucinationDetectorConfig: HallucinationDetectorConfig;
  private validationMap = new Map<string, { confidence: number; issues: string[] }>();
  private hallucinationTermination?: { agentId: string; confidence: number; issues: string[] };
  // Track single retry attempts per agent to avoid loops
  private retryAttempts = new Map<string, number>();

  // Private state tracking for new Session integration
  private hasStarted: boolean = false;
  private isExecuting: boolean = false;
  private lastSessionSummary?: SessionSummary;
  private agentResults?: AgentResult[];
  private executionPromise?: Promise<SessionSummary>; // Store the execution promise for external monitoring

  // Cancellation management
  private abortController?: AbortController;
  private activeAgentExecutions = new Map<string, AbortController>();

  // Stream management
  private baseStreamEmitter?: StreamEmitter<AtlasUIMessageChunk>;
  private sessionFinishEmitted = false; // Track if session-finish was already emitted

  // Memory managment
  private mecmfManager?: MECMFMemoryManager; // MECMF memory manager for prompt enhancement

  constructor(
    sessionId: string,
    workspaceId: string,
    config: SessionSupervisorConfig,
    id?: string,
    options?: SessionSupervisorActorOptions,
  ) {
    this.id = id || crypto.randomUUID();
    this.config = config;
    this.sessionId = sessionId;
    this.workspaceId = workspaceId;
    this.historyStorage = options?.historyStorage ?? DefaultHistoryStorageAdapter;

    this.logger = logger.child({
      actorId: this.id,
      component: "SessionSupervisorActor",
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
    });

    // Initialize hallucination detection config
    this.hallucinationDetectorConfig = {
      logger: this.logger.child({ component: "hallucination-detector" }),
    };

    this.logger.info("Session supervisor actor initialized");
  }

  setAgentOrchestrator(orchestrator: IAgentOrchestrator): void {
    this.agentOrchestrator = orchestrator;
    this.logger.info("Agent orchestrator set", { sessionId: this.sessionId });
  }

  /**
   * Set a custom StreamEmitter for this session (used by MCP tool execution)
   * This overrides the default HTTPStreamEmitter that would be created for SSE
   */
  setStreamEmitter(emitter: StreamEmitter<AtlasUIMessageChunk>): void {
    this.baseStreamEmitter = emitter;
    this.logger.info("Custom stream emitter set", {
      sessionId: this.sessionId,
      emitterType: emitter.constructor.name,
    });
  }

  initialize(params?: ActorInitParams): void {
    if (params) {
      this.id = params.actorId;
      this.sessionId = params.parentId || this.sessionId;

      this.logger = logger.child({
        actorId: this.id,
        actorType: "session-supervisor",
        sessionId: this.sessionId,
        workspaceId: this.workspaceId,
      });
    }

    this.logger.info("Initializing session supervisor actor");

    // Initialize supervision services

    this.logger.info("Session supervisor actor initialized", {
      workspaceId: this.workspaceId || "global",
      jeopardyValidation: "observation-only",
    });
  }

  shutdown(): void {
    this.logger.info("Session supervisor actor shutting down", {
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
    });
    // Preserve final outcome if available, otherwise mark as completed
    const resultStatus = this.lastSessionSummary?.status;
    if (resultStatus === ReasoningResultStatus.FAILED) {
      this.status = SessionSupervisorStatus.FAILED;
    } else if (resultStatus === ReasoningResultStatus.CANCELLED) {
      this.status = SessionSupervisorStatus.CANCELLED;
    } else if (resultStatus === ReasoningResultStatus.COMPLETED) {
      this.status = SessionSupervisorStatus.COMPLETED;
    } else {
      // PARTIAL or undefined maps to COMPLETED for lifecycle finalization
      this.status = SessionSupervisorStatus.COMPLETED;
    }

    // Clean up MECMF working memory for this session
    if (this.mecmfManager) {
      this.logger.info("Cleaning up session working memory", {
        sessionId: this.sessionId,
        workspaceId: this.workspaceId,
      });
      this.mecmfManager
        .consolidateWorkingMemory()
        .then(() => {
          this.logger.info("Working memory cleanup completed", {
            sessionId: this.sessionId,
            workspaceId: this.workspaceId,
          });
        })
        .catch((error) => {
          this.logger.error("Failed to cleanup working memory", {
            sessionId: this.sessionId,
            workspaceId: this.workspaceId,
            error,
          });
        });
    }

    // Only emit session-finish if not already emitted during normal execution
    this.emitSessionFinish({ source: "shutdown", status: this.status });
    this.baseStreamEmitter?.end();
    // Clear heavy memory objects to prevent leaks
    this.releaseHeavyMemoryObjects();
  }

  /**
   * Clean up heavy memory objects that cause leaks
   */
  public releaseHeavyMemoryObjects(): void {
    try {
      // Clear validation map that stores per-agent confidence data
      this.validationMap.clear();

      // Clear agent results that contain full execution data
      this.agentResults = undefined;

      // Clear cached execution plan
      this.cachedPlan = undefined;

      // Clear session context
      this.sessionContext = undefined;

      this.logger.debug("Memory objects cleaned up", {
        sessionId: this.sessionId,
        clearedObjects: [
          "streamMetrics",
          "validationMap",
          "agentResults",
          "cachedPlan",
          "sessionContext",
        ],
      });
    } catch (error) {
      this.logger.warn("Memory object cleanup failed", { sessionId: this.sessionId, error: error });
    }
  }

  private async persistSessionMetadata(context: SessionContext): Promise<void> {
    const metadataInput: CreateSessionMetadataInput = {
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
      status: ReasoningResultStatus.PARTIAL,
      signal: context.signal,
      signalPayload: context.payload,
      jobSpecificationId: context.jobSpec?.name,
      availableAgents: context.availableAgents,
      streamId: context.streamId,
      artifactIds: this.artifacts.map((artifact) => artifact.id),
    };

    try {
      const result = await this.historyStorage.createSessionRecord(metadataInput);
      if (!result.ok) {
        this.logger.error("Failed to create session history record", {
          sessionId: this.sessionId,
          error: result.error,
        });
        return;
      }

      void this.persistEvent({
        type: "session-start",
        data: {
          status: result.data.status,
          message: `Session initialized for signal ${context.signal.id}`,
        },
      });
    } catch (error) {
      this.logger.error("Unexpected error persisting session metadata", {
        sessionId: this.sessionId,
        error,
      });
    }
  }

  private async persistEvent(
    event: AppendSessionEventInput["event"],
  ): Promise<SessionHistoryEvent | null> {
    try {
      const result = await this.historyStorage.appendSessionEvent({
        sessionId: this.sessionId,
        emittedBy: this.id,
        event,
      });

      if (!result.ok) {
        this.logger.error("Failed to append session history event", {
          sessionId: this.sessionId,
          eventType: event?.type,
          error: result.error,
        });
        return null;
      }

      return result.data;
    } catch (error) {
      this.logger.error("Unexpected error appending session history event", {
        sessionId: this.sessionId,
        eventType: event?.type,
        error,
      });
      return null;
    }
  }

  private recordSupervisorAction(
    action: string,
    details?: Record<string, unknown>,
    context?: SessionHistoryEventContext,
  ): void {
    void this.persistEvent({ type: "supervisor-action", context, data: { action, details } });
  }

  private transitionStatus(
    newStatus: SessionSupervisorStatusType,
    reason: string,
    details?: Record<string, unknown>,
  ): void {
    const previous = this.status;
    if (previous === newStatus) return;

    this.status = newStatus;
    this.recordSupervisorAction("status-transition", {
      ...details,
      reason,
      from: previous,
      to: newStatus,
    });
  }

  private buildPersistedArtifacts(timeline: SessionHistoryTimeline | null): void {
    if (!timeline) {
      this.persistedArtifacts = [];
      return;
    }

    const createdAt = new Date(timeline.metadata.updatedAt || timeline.metadata.createdAt);
    this.persistedArtifacts = [
      {
        id: `session-history-${this.sessionId}`,
        type: "session_history",
        data: timeline,
        createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
        createdBy: "session-history-storage",
      },
    ];
  }

  private async finalizeSessionHistory(
    summary: SessionSummary | undefined,
    status: ReasoningResultStatusType,
    durationMs: number,
  ): Promise<void> {
    void this.persistEvent({
      type: "session-finish",
      data: {
        status,
        durationMs,
        failureReason: summary?.failureReason,
        summary: summary?.reasoning,
      },
    });

    try {
      const metadataResult = await this.historyStorage.markSessionComplete(
        this.sessionId,
        status,
        new Date().toISOString(),
        { durationMs, failureReason: summary?.failureReason, summary: summary?.reasoning },
      );

      if (!metadataResult.ok) {
        this.logger.error("Failed to mark session as complete in history storage", {
          sessionId: this.sessionId,
          error: metadataResult.error,
        });
      }
    } catch (error) {
      this.logger.error("Unexpected error marking session complete in history storage", {
        sessionId: this.sessionId,
        error,
      });
    }

    try {
      const timelineResult = await this.historyStorage.loadSessionTimeline(this.sessionId);

      if (!timelineResult.ok) {
        this.logger.error("Failed to load session timeline after completion", {
          sessionId: this.sessionId,
          error: timelineResult.error,
        });
        this.buildPersistedArtifacts(null);
        return;
      }

      this.buildPersistedArtifacts(timelineResult.data ?? null);
    } catch (error) {
      this.logger.error("Unexpected error loading session timeline", {
        sessionId: this.sessionId,
        error,
      });
      this.buildPersistedArtifacts(null);
    }
  }

  /**
   * Emit a unified session-finish event exactly once, with proper metadata
   */
  private emitSessionFinish(event: {
    source: "shutdown" | "execution";
    status: ReasoningResultStatusType | SessionSupervisorStatusType;
    duration?: number;
  }): void {
    if (!this.baseStreamEmitter || this.sessionFinishEmitted) return;

    const { source, status, duration } = event;

    this.baseStreamEmitter.emit({
      type: "data-session-finish",
      data: {
        sessionId: this.sessionId,
        workspaceId: this.workspaceId,
        status,
        ...(typeof duration === "number" ? { duration } : {}),
        source,
      },
    });

    this.sessionFinishEmitted = true;

    this.logger.debug(
      source === "shutdown"
        ? "Emitted session-finish event during shutdown"
        : "Emitted session-finish event for stream rotation",
      {
        sessionId: this.sessionId,
        streamId: this.sessionContext?.streamId,
        status,
        wasError:
          source === "execution"
            ? !this.lastSessionSummary ||
              this.lastSessionSummary.status === ReasoningResultStatus.FAILED
            : undefined,
        source,
      },
    );
  }

  /** Emit standardized agent-timeout event */
  private emitAgentTimeout(agentId: string, task: string, duration: number, error: string): void {
    this.baseStreamEmitter?.emit({
      type: "data-agent-timeout",
      data: { agentId, task, duration, error },
    });
  }

  /** Emit standardized agent-error event */
  private emitAgentError(agentId: string, duration: number, error: string): void {
    this.baseStreamEmitter?.emit({ type: "data-agent-error", data: { agentId, duration, error } });
  }

  /** Determine whether an error represents a user/session cancellation */
  private isCancellationError(error: unknown): boolean {
    if (error instanceof Error) {
      if (error.name === "AbortError") return true;
      const message = error.message || "";
      return message.includes("Session cancelled") || message.includes("aborted");
    }
    if (typeof error === "string") {
      return error.includes("Session cancelled") || error.includes("aborted");
    }
    return false;
  }

  async initializeSession(context: SessionContext): Promise<void> {
    this.sessionContext = context;
    // Clear cached plan when context changes
    this.cachedPlan = undefined;

    await this.persistSessionMetadata(context);

    // Initialize MECMF manager for prompt enhancement (fire-and-forget to avoid blocking)
    if (this.workspaceId) {
      void initializeWorkspaceMemory(this.workspaceId, {
        enableVectorSearch: true,
        tokenBudgets: {
          defaultBudget: 8000,
          modelLimits: {
            "claude-3.5-sonnet": 200000,
            "claude-3-sonnet": 200000,
            "claude-3-haiku": 200000,
            "gpt-4": 128000,
          },
        },
      })
        .then((manager) => {
          this.mecmfManager = manager;
          this.logger.info("MECMF memory manager initialized for prompt enhancement", {
            workspaceId: this.workspaceId,
            sessionId: this.sessionId,
          });
        })
        .catch((error) => {
          this.logger.warn(
            "Failed to initialize MECMF manager, continuing without prompt enhancement",
            { error, workspaceId: this.workspaceId },
          );
        });
    }

    // Initialize streaming if streamId provided
    if (context.streamId && context.onStreamEvent) {
      // Check if we have a stream callback (chat mode)
      // Use callback emitter that routes to the SSE manager
      this.baseStreamEmitter = new CallbackStreamEmitter(
        context.onStreamEvent,
        () => {},
        (error) => this.logger.error("Stream error", { error }),
      );

      // Emit session start event if we have an emitter
      if (this.baseStreamEmitter) {
        this.baseStreamEmitter.emit({
          type: "data-session-start",
          data: {
            sessionId: this.sessionId,
            signalId: context.signal.id,
            workspaceId: this.workspaceId,
          },
        });
      }

      this.logger.info("Session initialized", {
        sessionId: this.sessionId,
        workspaceId: this.workspaceId,
        signalId: context.signal.id,
        availableAgents: context.availableAgents.length,
        hasStreaming: !!context.streamId,
      });
    }
  }

  async createExecutionPlan(): Promise<ExecutionPlan> {
    if (!this.sessionContext) {
      throw new Error("Session not initialized");
    }

    // Return cached plan if available
    if (this.cachedPlan) {
      this.logger.info("Using cached execution plan", {
        planId: this.cachedPlan.id,
        phases: this.cachedPlan.phases.length,
      });
      return this.cachedPlan;
    }

    const startTime = Date.now();

    // Check for job-defined execution plan
    const jobSpecPlan = this.getPlanFromJobDefinition();
    if (jobSpecPlan) {
      this.logger.info("Using execution plan from job definition", {
        planId: jobSpecPlan.id,
        phases: jobSpecPlan.phases.length,
      });
      // Cache the job spec plan too
      this.cachedPlan = jobSpecPlan;
      void this.persistEvent({
        type: "plan-created",
        data: {
          plan: jobSpecPlan,
          reasoning: jobSpecPlan.reasoning,
          strategy: jobSpecPlan.strategy,
        },
      });
      return jobSpecPlan;
    }

    // @TODO: This path should be improved in the future, extracted to separate agent and properly evaluated.
    // Session supervisor executor planner or something like this
    // Right not we are not using this path, because workspace genration is handling the planning by set uping job definition
    this.logger.info("Computing execution plan using structured output");

    // Define schemas matching the expected ExecutionPlan shape

    const planningContext = this.buildExecutionPlanningPrompt(this.sessionContext)
      // Remove tool-specific instruction since we're using structured output
      .replace(
        /IMPORTANT:[\s\S]*?Create a comprehensive execution plan that:/,
        "Create a comprehensive execution plan that:",
      );

    const { object: rawPlan } = await generateObject({
      model: this.llmProvider("claude-sonnet-4-5"),
      system: planningContext,
      messages: [
        {
          role: "user",
          content: `Analyze this signal and return a structured execution plan. Signal: ${JSON.stringify(
            this.sessionContext.signal,
          )}`,
        },
      ],
      schema: ExecutionPlanSchema,
      temperature: 0,
      maxOutputTokens: 4000,
      maxRetries: 3,
      providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 15000 } } },
    });

    // Post-process to ensure IDs and defaults
    const plan: ExecutionPlan = {
      id: rawPlan.id && rawPlan.id.trim().length > 0 ? rawPlan.id : crypto.randomUUID(),
      phases: rawPlan.phases.map((p) => ({
        id: p.id && p.id.trim().length > 0 ? p.id : crypto.randomUUID(),
        name: p.name,
        executionStrategy: p.executionStrategy,
        agents: p.agents.map((a) => ({
          agentId: a.agentId,
          task: a.task,
          inputSource: a.inputSource ?? "signal",
          dependencies: a.dependencies,
          reasoning: a.reasoning,
        })),
        reasoning: p.reasoning,
      })),
      reasoning: rawPlan.reasoning ?? "AI-generated execution plan",
      strategy: rawPlan.strategy ?? "ai-planned",
      confidence: typeof rawPlan.confidence === "number" ? rawPlan.confidence : 0.8,
      reasoningSteps: rawPlan.reasoningSteps ?? [],
    };

    const duration = Date.now() - startTime;
    this.logger.info("Execution plan created", {
      planId: plan.id,
      duration,
      phases: plan.phases.length,
      reasoning: plan.reasoning,
    });

    // Cache the plan for subsequent calls
    this.cachedPlan = plan;
    void this.persistEvent({
      type: "plan-created",
      data: { plan, reasoning: plan.reasoning, strategy: plan.strategy },
    });
    return plan;
  }

  /**
   * Get current session status
   */
  getSessionStatus(): SessionSupervisorStatusType {
    if (!this.hasStarted) return SessionSupervisorStatus.IDLE;
    if (this.isExecuting) return SessionSupervisorStatus.EXECUTING;
    if (this.status === SessionSupervisorStatus.CANCELLED) {
      return SessionSupervisorStatus.CANCELLED;
    }
    const resultStatus = this.lastSessionSummary?.status;
    if (resultStatus === ReasoningResultStatus.COMPLETED) {
      return SessionSupervisorStatus.COMPLETED;
    }
    if (resultStatus === ReasoningResultStatus.FAILED) {
      return SessionSupervisorStatus.FAILED;
    }
    if (resultStatus === ReasoningResultStatus.CANCELLED) {
      return SessionSupervisorStatus.CANCELLED;
    }
    // Map PARTIAL or undefined final result to COMPLETED for public session status
    return SessionSupervisorStatus.COMPLETED;
  }

  /**
   * Get human-readable summary
   */
  getSummary(): string {
    if (!this.lastSessionSummary) return `Session ${this.sessionId}: pending`;

    const summary = this.lastSessionSummary;
    const duration = summary.duration || 0;

    if (summary.failureReason) {
      return `Session ${this.sessionId}: ${summary.status} - ${summary.failureReason} (${duration}ms)`;
    }

    return `Session ${this.sessionId}: ${summary.status} (${summary.completedPhases}/${summary.totalPhases} phases) - ${duration}ms`;
  }

  /**
   * Get all execution artifacts including agent results
   */
  getExecutionArtifacts(): IWorkspaceArtifact[] {
    const artifacts: IWorkspaceArtifact[] = [...this.persistedArtifacts];

    // Add session summary artifact
    if (this.lastSessionSummary) {
      artifacts.push({
        id: crypto.randomUUID(),
        type: "execution_results",
        data: {
          summary: this.lastSessionSummary,
          results: this.lastSessionSummary.results,
          confidence: this.lastSessionSummary.confidence,
        },
        createdAt: new Date(),
        createdBy: "session-supervisor-actor",
      });
    }

    // Add individual agent result artifacts
    if (this.agentResults) {
      this.agentResults.forEach((result, _) => {
        artifacts.push({
          id: crypto.randomUUID(),
          type: "agent_result",
          data: result,
          createdAt: new Date(),
          createdBy: `agent-${result.agentId}`,
        });
      });
    }

    return artifacts;
  }

  getExecutionPromise(): Promise<SessionSummary> | undefined {
    return this.executionPromise;
  }

  getExecutionStatus(): string {
    // Map internal status to external status strings
    switch (this.status) {
      case SessionSupervisorStatus.IDLE:
        return "idle";
      case SessionSupervisorStatus.PLANNING:
        return "planning";
      case SessionSupervisorStatus.EXECUTING:
        return "executing";
      case SessionSupervisorStatus.COMPLETED:
        return "completed";
      case SessionSupervisorStatus.FAILED:
        return "failed";
      default:
        return "unknown";
    }
  }

  executeSession(): Promise<SessionSummary> {
    if (!this.sessionContext) {
      throw new Error("Session not initialized");
    }

    // If already executing, return the existing promise
    if (this.executionPromise) {
      return this.executionPromise;
    }

    // Create and store the execution promise
    this.executionPromise = this.doExecuteSession();
    return this.executionPromise;
  }

  private async doExecuteSession(): Promise<SessionSummary> {
    if (!this.sessionContext) {
      throw new Error("Session not initialized");
    }
    this.hasStarted = true;
    this.isExecuting = true;
    // Create abort controller for this session
    this.abortController = new AbortController();
    this.transitionStatus(SessionSupervisorStatus.PLANNING, "create-execution-plan");

    const sessionStartTime = Date.now();
    let summary: SessionSummary | undefined;

    try {
      // Create execution plan
      const plan = await this.createExecutionPlan();
      this.transitionStatus(SessionSupervisorStatus.EXECUTING, "execution-plan-ready", {
        planId: plan.id,
        phaseCount: plan.phases.length,
      });

      const allResults: AgentExecutionRecord[] = [];

      // Execute each phase
      for (const [phaseIndex, phase] of plan.phases.entries()) {
        this.logger.info("Executing phase", {
          phaseIndex: phaseIndex + 1,
          phaseName: phase.name,
          strategy: phase.executionStrategy,
          agentCount: phase.agents.length,
        });

        const phaseResults = await this.executePhase(phase, allResults);
        allResults.push(...phaseResults);

        // Stop the session immediately if severe hallucination was detected
        if (this.hallucinationTermination) {
          this.logger.error("Session terminated due to severe hallucination", {
            agentId: this.hallucinationTermination.agentId,
            confidence: this.hallucinationTermination.confidence,
            issues: this.hallucinationTermination.issues,
          });
          break;
        }

        // Evaluate progress after each phase (non-hallucination controls)
        const shouldContinue = this.evaluateProgress(allResults, plan);
        if (!shouldContinue) {
          this.logger.info("Session completion criteria met, stopping execution");
          break;
        }
      }

      // Store agent results as artifact
      if (allResults.length > 0) {
        const sanitizedResults = allResults.map(
          ({ executionId: _executionId, phaseId: _phaseId, ...rest }) => rest,
        );
        const agentResultsArtifact: IWorkspaceArtifact = {
          id: crypto.randomUUID(),
          type: "agent_results",
          data: sanitizedResults,
          createdAt: new Date(),
          createdBy: this.sessionId,
        };
        this.artifacts.push(agentResultsArtifact);

        this.logger.info("Stored agent results as artifact", {
          artifactId: agentResultsArtifact.id,
          resultCount: allResults.length,
          sessionId: this.sessionId,
        });

        // Also store validation results if available
        if (this.validationMap.size > 0) {
          const validationData = Array.from(this.validationMap.entries()).map(([agentId, v]) => ({
            agentId,
            confidence: v.confidence,
          }));

          const validationArtifact: IWorkspaceArtifact = {
            id: crypto.randomUUID(),
            type: "validation_results",
            data: validationData,
            createdAt: new Date(),
            createdBy: this.sessionId,
          };
          this.artifacts.push(validationArtifact);

          this.logger.info("Stored validation results as artifact", {
            artifactId: validationArtifact.id,
            validatedAgents: validationData.length,
            sessionId: this.sessionId,
          });
        }
      }

      // Generate session summary
      const duration = Date.now() - sessionStartTime;
      summary = this.generateSessionSummary(allResults, plan, duration);

      // Update execution tracking
      this.lastSessionSummary = summary;
      this.agentResults = allResults.map(
        ({ executionId: _executionId, phaseId: _phaseId, ...rest }) => rest,
      );
      this.isExecuting = false;

      if (this.mecmfManager && summary) {
        const capturedSummary = summary;
        void this.mecmfManager
          .extractAndStoreSemanticFacts(capturedSummary, this.logger)
          .then(() => {
            if (!capturedSummary) return;
            void this.persistEvent({
              type: "memory-update",
              data: {
                memoryType: "semantic",
                entries: [{ sessionId: capturedSummary.sessionId, status: capturedSummary.status }],
                summary: capturedSummary.reasoning,
              },
            });
          })
          .catch((error) => {
            this.logger.warn("Failed to extract and store semantic facts", {
              sessionId: this.sessionId,
              error,
            });
            this.recordSupervisorAction("memory-update-failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }

      this.logger.info("Session execution completed", {
        sessionId: this.sessionId,
        status: summary.status,
        phases: summary.totalPhases,
        agents: summary.totalAgents,
        duration,
      });
      this.transitionStatus(SessionSupervisorStatus.COMPLETED, "session-execution-complete", {
        finalStatus: summary.status,
        duration,
      });

      return summary;
    } catch (error) {
      // Create error summary if execution failed
      const duration = Date.now() - sessionStartTime;
      if (!summary) {
        const isCancellation = this.isCancellationError(error);

        summary = {
          sessionId: this.sessionId,
          workspaceId: this.workspaceId,
          status: isCancellation ? ReasoningResultStatus.CANCELLED : ReasoningResultStatus.FAILED,
          totalPhases: 0,
          totalAgents: 0,
          completedPhases: 0,
          executedAgents: 0,
          duration,
          reasoning: isCancellation ? "Session cancelled by user" : "Session failed with error",
          results: [],
          failureReason: error instanceof Error ? error.message : String(error),
        };
        this.lastSessionSummary = summary;
      }

      this.isExecuting = false;

      if (this.status === SessionSupervisorStatus.CANCELLED) {
        this.logger.info("Session execution cancelled", { sessionId: this.sessionId, duration });
        this.transitionStatus(SessionSupervisorStatus.CANCELLED, "session-cancelled", { duration });
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error("Session execution failed", {
          sessionId: this.sessionId,
          error,
          duration,
        });
        this.transitionStatus(SessionSupervisorStatus.FAILED, "session-execution-failed", {
          duration,
          error: errorMessage,
        });
      }

      // Schedule memory operations for failed session too (if summary exists)
      if (summary && this.mecmfManager) {
        const capturedSummary = summary;
        void this.mecmfManager
          .extractAndStoreSemanticFacts(capturedSummary, this.logger)
          .then(() => {
            if (!capturedSummary) return;
            void this.persistEvent({
              type: "memory-update",
              data: {
                memoryType: "semantic",
                entries: [{ sessionId: capturedSummary.sessionId, status: capturedSummary.status }],
                summary: capturedSummary.reasoning,
              },
            });
          })
          .catch((memoryError) => {
            this.logger.warn("Failed to extract and store semantic facts after failure", {
              sessionId: this.sessionId,
              error: memoryError,
            });
            this.recordSupervisorAction("memory-update-failed", {
              error: memoryError instanceof Error ? memoryError.message : String(memoryError),
            });
          });
      }

      throw error;
    } finally {
      // Always emit session-finish event to trigger queue rotation
      // This is critical for proper SSE stream synchronization
      const finalStatus =
        summary?.status ||
        (this.status === SessionSupervisorStatus.CANCELLED
          ? ReasoningResultStatus.CANCELLED
          : ReasoningResultStatus.FAILED);
      const finalDuration = Date.now() - sessionStartTime;
      this.emitSessionFinish({ source: "execution", status: finalStatus, duration: finalDuration });
      await this.finalizeSessionHistory(summary, finalStatus, finalDuration);
    }
  }

  private async executePhase(
    phase: ExecutionPhase,
    previousResults: AgentExecutionRecord[],
  ): Promise<AgentExecutionRecord[]> {
    const phaseResults: AgentExecutionRecord[] = [];
    const phaseStart = Date.now();
    let phaseStatus: ReasoningResultStatusType = ReasoningResultStatus.COMPLETED;
    let phaseIssues: string[] | undefined;
    let terminatePhase = false;

    void this.persistEvent({
      type: "phase-start",
      context: { phaseId: phase.id },
      data: {
        phaseId: phase.id,
        name: phase.name,
        executionStrategy: phase.executionStrategy,
        agents: phase.agents.map((agent) => agent.agentId),
        reasoning: phase.reasoning,
      },
    });

    if (phase.executionStrategy === "sequential") {
      for (const agentTask of phase.agents) {
        if (terminatePhase) break;
        const allPreviousResults = [...previousResults, ...phaseResults];
        const result = await this.executeAgent(
          agentTask,
          allPreviousResults,
          phaseResults,
          phase.id,
        );
        phaseResults.push(result);
        this.logger.debug("Agent result", {
          agentId: agentTask.agentId,
          task: result.task,
          output: result.output,
        });
        const continuePhase = await this.handlePostExecutionValidation(
          agentTask,
          result,
          previousResults,
          phaseResults,
          phase,
          "sequential",
          (updated) => {
            phaseResults.pop();
            phaseResults.push(updated);
          },
        );
        if (!continuePhase) {
          terminatePhase = true;
          phaseStatus = this.hallucinationTermination
            ? ReasoningResultStatus.FAILED
            : ReasoningResultStatus.PARTIAL;
          phaseIssues = this.hallucinationTermination?.issues;
        }
      }
    } else {
      const promises = phase.agents.map((agentTask) =>
        this.executeAgent(agentTask, previousResults, phaseResults, phase.id),
      );
      const parallelResults = await Promise.all(promises);
      phaseResults.push(...parallelResults);
      const tasksById = new Map(phase.agents.map((a) => [a.agentId, a] as const));
      const baseIndex = phaseResults.length - parallelResults.length;
      for (let i = 0; i < parallelResults.length; i++) {
        if (terminatePhase) break;
        const result = parallelResults[i];
        if (!result) {
          this.logger.error("Parallel agent result is undefined - terminating session", {
            phaseIndex: phase.id,
          });
          terminatePhase = true;
          phaseStatus = ReasoningResultStatus.FAILED;
          phaseIssues = ["Parallel agent result missing"];
          break;
        }
        const agentTask = tasksById.get(result.agentId);
        if (!agentTask) {
          this.logger.error("Cannot retry parallel agent - task not found", {
            agentId: result.agentId,
            phaseIndex: phase.id,
          });
          terminatePhase = true;
          phaseStatus = ReasoningResultStatus.FAILED;
          phaseIssues = [`Task not found for agent ${result.agentId}`];
          break;
        }
        const continuePhase = await this.handlePostExecutionValidation(
          agentTask,
          result,
          previousResults,
          phaseResults,
          phase,
          "parallel",
          (updated) => {
            parallelResults[i] = updated;
            phaseResults[baseIndex + i] = updated;
          },
        );
        if (!continuePhase) {
          terminatePhase = true;
          phaseStatus = this.hallucinationTermination
            ? ReasoningResultStatus.FAILED
            : ReasoningResultStatus.PARTIAL;
          phaseIssues = this.hallucinationTermination?.issues;
        }
      }
    }

    const durationMs = Date.now() - phaseStart;
    void this.persistEvent({
      type: "phase-complete",
      context: { phaseId: phase.id },
      data: { phaseId: phase.id, status: phaseStatus, durationMs, issues: phaseIssues },
    });

    return phaseResults;
  }

  private async handlePostExecutionValidation(
    agentTask: AgentTask,
    currentResult: AgentExecutionRecord,
    previousResults: AgentExecutionRecord[],
    phaseResults: AgentExecutionRecord[],
    phase: ExecutionPhase,
    context: "sequential" | "parallel",
    replaceResult: (updated: AgentExecutionRecord) => void,
  ): Promise<boolean> {
    const shouldContinueAfterAgent = await this.validateAgentResult(currentResult, [
      ...previousResults,
      ...phaseResults,
    ]);
    if (shouldContinueAfterAgent) {
      return true;
    }

    const retryCount = this.retryAttempts.get(currentResult.agentId) ?? 0;
    if (retryCount === 0) {
      this.logger.warn(
        context === "sequential"
          ? "Agent validation failed - issuing single retry with feedback"
          : "Parallel agent validation failed - issuing single retry with feedback",
        { agentId: currentResult.agentId, phaseIndex: phase.id },
      );
      this.retryAttempts.set(currentResult.agentId, 1);
      this.recordSupervisorAction("schedule-agent-retry", {
        agentId: currentResult.agentId,
        phaseId: phase.id,
        context,
      });

      const retryResult = await this.executeAgent(
        { ...agentTask },
        [...previousResults, ...phaseResults],
        phaseResults,
        phase.id,
      );

      void this.persistEvent({
        type: "agent-retry",
        context: {
          agentId: retryResult.agentId,
          executionId: retryResult.executionId,
          phaseId: phase.id,
        },
        data: {
          agentId: retryResult.agentId,
          executionId: retryResult.executionId,
          attempt: retryCount + 1,
          reason: "Validation requested retry after low confidence",
        },
      });

      replaceResult(retryResult);

      const shouldContinueAfterRetry = await this.validateAgentResult(retryResult, [
        ...previousResults,
        ...phaseResults,
      ]);
      if (!shouldContinueAfterRetry) {
        this.logger.error(
          context === "sequential"
            ? "Agent validation failed after retry - terminating session"
            : "Parallel agent validation failed after retry - terminating session",
          {
            agentId: currentResult.agentId,
            phaseIndex: phase.id,
            reason:
              context === "sequential"
                ? "Repeated hallucination detected in agent output"
                : "Repeated hallucination detected in parallel agent output",
          },
        );
        this.recordSupervisorAction("terminate-after-retry-failure", {
          agentId: currentResult.agentId,
          phaseId: phase.id,
          context,
        });
        return false;
      }

      this.recordSupervisorAction("agent-retry-success", {
        agentId: retryResult.agentId,
        phaseId: phase.id,
        attempt: retryCount + 1,
      });
      return true;
    }

    this.logger.error(
      context === "sequential"
        ? "Agent validation failed with prior retry - terminating session immediately"
        : "Parallel agent validation failed with prior retry - terminating session immediately",
      {
        agentId: currentResult.agentId,
        phaseIndex: phase.id,
        reason:
          context === "sequential"
            ? "Hallucination detected in agent output"
            : "Hallucination detected in parallel agent output",
      },
    );
    this.recordSupervisorAction("terminate-after-validation-failure", {
      agentId: currentResult.agentId,
      phaseId: phase.id,
      context,
      retries: retryCount,
    });
    return false;
  }

  private async buildAgentPrompt(
    agentTask: AgentTask,
    previousResults: AgentResult[],
    input: string,
    agentConfig: WorkspaceAgentConfig,
  ): Promise<string> {
    // Build workflow intent from session state
    const signalDescription = (this.sessionContext?.signal as WorkspaceSignalWithDescription)
      ?.config?.description;
    const jobDescription = this.sessionContext?.jobSpec?.description;
    const workflowIntent =
      [signalDescription, jobDescription].filter(Boolean).join(". ") || "Execute workflow task";

    // Get agent's system prompt with proper type handling
    let agentSystemPrompt = "";
    if (agentConfig.type === "llm") {
      agentSystemPrompt = agentConfig.config.prompt;
      agentSystemPrompt +=
        "When choosing tools, always prefer specialized tools over generic tools. Don’t try to minimize the number of tools - use as many as needed to achieve the goal.";
      agentSystemPrompt +=
        "\n When working with artifacts, never include their content in the response - refer only to their artifact IDs.";
    } else if (agentConfig.type === "atlas") {
      agentSystemPrompt = agentConfig.prompt;
    }

    // Prepare input for smart supervisor agent
    const supervisorInput = {
      workflowIntent,
      agentSystemPrompt,
      agentInputSource: (agentTask.inputSource || "signal") as "signal" | "previous" | "combined",
      signalPayload: this.sessionContext?.payload,
      previousResults: previousResults.map((r) => ({
        agentId: r.agentId,
        task: r.task,
        output: r.output,
        artifactRefs: r.artifactRefs,
      })),
      tokenBudget: {
        modelLimit: 200000, // Default model limit
        defaultBudget: 8000,
        currentUsage: this.estimateTokens(input),
      },
    };

    // Invoke smart supervisor agent - call execute method directly
    const result = await sessionSupervisorAgent.execute(supervisorInput, {
      tools: {}, // Smart agent doesn't use tools
      session: {
        sessionId: this.sessionId,
        workspaceId: this.workspaceId,
        streamId: this.sessionContext?.streamId,
      },
      env: {}, // Smart agent doesn't need env vars
      logger: this.logger,
      stream: undefined, // Smart agent is internal, doesn't need streaming
      abortSignal: this.abortController?.signal,
    });

    if (!result.ok) {
      // Smart supervisor failure is a session failure - fail fast
      throw new Error(`Smart supervisor failed to optimize context: ${result.error.reason}`);
    }

    // Build prompt from optimized context
    const sections: string[] = [];

    // Add facts section
    sections.push(this.buildFactsSection());

    // Add the optimized context from smart agent
    sections.push(result.data.optimizedContext);

    // Add agent's configured prompt instructions
    if (agentSystemPrompt) {
      sections.push("## Agent Instructions");
      sections.push(agentSystemPrompt);
    }

    // Add task description
    if (agentTask.task && agentTask.task !== "Execute job task") {
      sections.push("## Task");
      sections.push(agentTask.task);
    }

    // Add validation feedback if this is a retry
    const validationFeedback = this.buildValidationFeedback(agentTask.agentId);
    if (validationFeedback) {
      sections.push(validationFeedback);
    }

    this.logger.info("Smart supervisor optimized context", {
      agentId: agentTask.agentId,
      tokenEstimate: result.data.metadata.tokenEstimate,
      includedSignal: result.data.metadata.includedSignal,
      includedPreviousCount: result.data.metadata.includedPreviousCount,
      reasoning: result.data.reasoning,
    });

    return sections.join("\n\n");
  }

  // Token estimation helper
  private estimateTokens(text: string): number {
    // Rough estimation: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  /**
   * Resolve the identifier that should be used to fetch/execute the underlying agent implementation.
   *
   * Why this exists:
   * - Each workspace may define multiple entries that reference the same bundled/registry agent but with
   *   different prompts or configuration. Those entries are keyed by a workspace-specific alias (the
   *   `agentTask.agentId`). We want to preserve that alias for logging, streaming, and result attribution.
   * - When actually executing the agent, registry-backed and system agents must be looked up by their
   *   registry/bundled ID, which is provided as `config.agent` in the workspace configuration.
   * - LLM agents wrapped in-process are registered under their workspace alias, so we should execute them
   *   using the alias.
   *
   * Mapping rules:
   * - type "llm"    → use the workspace alias (wrapped agent registered by alias)
   * - type "atlas"  → use `config.agent` (registry/bundled ID)
   * - type "system" → use `config.agent` (system bundled ID)
   * - unknown/missing → fall back to workspace alias
   */
  private resolveRuntimeAgentId(
    workspaceAgentId: string,
    agentConfig: WorkspaceAgentConfig,
  ): string {
    const type = agentConfig.type;
    if (type === "atlas" || type === "system") {
      return agentConfig.agent ?? workspaceAgentId;
    }
    // For "llm" and any unknown/missing types, execute by the workspace alias
    return workspaceAgentId;
  }

  private async executeAgent(
    agentTask: AgentTask,
    previousResults: AgentExecutionRecord[],
    _phaseResults: AgentExecutionRecord[],
    phaseId: string,
  ): Promise<AgentExecutionRecord> {
    const startTime = Date.now();
    const executionId = crypto.randomUUID();
    const eventContext: SessionHistoryEventContext = {
      phaseId,
      agentId: agentTask.agentId,
      executionId,
    };

    // the signal that triggers the session - payload is whatever json is in -d
    logger.info("Executing agent", {
      agentId: agentTask.agentId,
      task: agentTask.task,
      inputSource: agentTask.inputSource,
    });

    const input = this.getAgentInput(agentTask, previousResults);
    let normalizedInput: unknown = input;
    try {
      normalizedInput = JSON.parse(input);
    } catch {
      normalizedInput = input;
    }

    // Stream agent start
    this.baseStreamEmitter?.emit({
      type: "data-agent-start",
      data: { agentId: agentTask.agentId, task: agentTask.task },
    });

    void this.persistEvent({
      type: "agent-start",
      context: eventContext,
      data: {
        agentId: agentTask.agentId,
        executionId,
        promptSummary: agentTask.task,
        input: normalizedInput,
      },
    });

    let intermediateResult: AgentResult;

    if (!this.agentOrchestrator) {
      throw new Error("Agent orchestrator is not available");
    }

    // Use orchestrator if available (new MCP-based execution)
    this.logger.info("Using orchestrator for execution");

    let prompt = "";
    try {
      const agentConfig = this.config.agents?.[agentTask.agentId];
      if (!agentConfig) {
        throw new Error(`Agent config not found for agent ${agentTask.agentId}`);
      }
      logger.info("Agent config", { agentConfig });
      // llm agents have ".config" when bundled agents have prompt directly in object
      const isSystemAgent = agentConfig.type === "system";
      const workspaceAgentId = agentTask.agentId;
      const runtimeAgentId = this.resolveRuntimeAgentId(workspaceAgentId, agentConfig);

      if (!isSystemAgent) {
        // For non-system agents, use the agent's configured prompt from workspace and append the input
        // System agents (like conversation) manage their own system prompts internally
        prompt = await this.buildAgentPrompt(agentTask, previousResults, input, agentConfig);
      } else {
        prompt = input;
      }

      // Create abort controller for this specific agent execution
      const agentAbort = new AbortController();
      this.activeAgentExecutions.set(agentTask.agentId, agentAbort);

      const orchestratorResult = await this.agentOrchestrator.executeAgent(runtimeAgentId, prompt, {
        sessionId: this.sessionId,
        workspaceId: this.workspaceId || "global",
        streamId: this.sessionContext?.streamId,
        additionalContext: { input, reasoning: agentTask.reasoning },
        abortSignal: agentAbort.signal,
        // Pass callback for stream events
        onStreamEvent: (event) => {
          this.baseStreamEmitter?.emit(event);
        },
      });

      if (orchestratorResult.error) {
        const errorMessage = orchestratorResult.error;
        // MCP timeout error code
        const isTimeout = errorMessage.includes("-32001");

        // Emit appropriate error event
        if (isTimeout) {
          this.emitAgentTimeout(
            agentTask.agentId,
            agentTask.task,
            orchestratorResult.duration || Date.now() - startTime,
            errorMessage,
          );
        } else {
          this.emitAgentError(
            agentTask.agentId,
            orchestratorResult.duration || Date.now() - startTime,
            errorMessage,
          );
        }
        void this.persistEvent({
          type: "agent-error",
          context: eventContext,
          data: {
            agentId: agentTask.agentId,
            executionId,
            error: errorMessage,
            retryable: isTimeout,
          },
        });
        this.recordSupervisorAction("agent-error", {
          agentId: agentTask.agentId,
          executionId,
          phaseId,
          error: errorMessage,
          timeout: isTimeout,
        });
        // Clean up abort controller before throwing
        this.activeAgentExecutions.delete(agentTask.agentId);
        // Throw custom error to trigger session failure (and indicate we've already emitted events)
        throw new OrchestratorHandledError(`Agent ${agentTask.agentId} failed: ${errorMessage}`);
      }

      intermediateResult = {
        ...orchestratorResult,
        agentId: agentTask.agentId,
        task: agentTask.task,
        input: normalizedInput,
        timestamp: orchestratorResult.timestamp ?? new Date().toISOString(),
      };

      this.baseStreamEmitter?.emit({
        type: "data-agent-finish",
        data: { agentId: agentTask.agentId, duration: Date.now() - startTime },
      });
    } catch (error) {
      // Clean up the abort controller for this agent
      this.activeAgentExecutions.delete(agentTask.agentId);

      // Check if it's a cancellation
      const isCancellation = this.isCancellationError(error);

      if (isCancellation) {
        this.logger.info("Agent execution cancelled", {
          agentId: agentTask.agentId,
          duration: Date.now() - startTime,
        });
        this.recordSupervisorAction("agent-cancelled", {
          agentId: agentTask.agentId,
          executionId,
          phaseId,
        });
      } else if (!(error instanceof OrchestratorHandledError)) {
        // Only emit agent-error if we haven't already handled this error
        this.emitAgentError(
          agentTask.agentId,
          Date.now() - startTime,
          error instanceof Error ? error.message : String(error),
        );
        void this.persistEvent({
          type: "agent-error",
          context: eventContext,
          data: {
            agentId: agentTask.agentId,
            executionId,
            error: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        });
        this.recordSupervisorAction("agent-error", {
          agentId: agentTask.agentId,
          executionId,
          phaseId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.logger.error("Agent orchestrator execution failed", {
          agentId: agentTask.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        // For OrchestratorHandledError, we've already emitted the appropriate event
        // Just log that the agent failed
        this.logger.error("Agent execution failed (orchestrator error)", {
          agentId: agentTask.agentId,
          error: error.message,
        });
      }

      throw error;
    }

    const duration = Date.now() - startTime;

    const agentResult: AgentExecutionRecord = {
      agentId: agentTask.agentId,
      task: agentTask.task, // Store the task description, not the full prompt
      input: normalizedInput,
      output: intermediateResult.output,
      reasoning: intermediateResult.reasoning,
      duration,
      timestamp: intermediateResult.timestamp ?? new Date().toISOString(),
      toolCalls: intermediateResult.toolCalls,
      toolResults: intermediateResult.toolResults,
      artifactRefs: intermediateResult.artifactRefs,
      executionId,
      phaseId,
    };

    // Validate output size
    const outputSize = this.estimateTokens(JSON.stringify(intermediateResult.output));
    if (outputSize > 10000) {
      this.logger.warn("Agent produced large output", {
        agentId: agentTask.agentId,
        tokens: outputSize,
        hint: "Consider using artifacts for large data instead of raw output",
      });
    }
    if (outputSize > 15000) {
      throw new Error(
        `Agent ${agentTask.agentId} produced excessive output (${outputSize} tokens). Use artifacts for large data.`,
      );
    }

    this.logger.info("Agent execution completed", {
      agentId: agentTask.agentId,
      duration,
      success: true,
      hasToolCalls: !!intermediateResult.toolCalls?.length,
      outputTokens: outputSize,
    });

    // Clean up the abort controller for this agent
    this.activeAgentExecutions.delete(agentTask.agentId);

    const snapshot = toAgentSnapshot({
      ...agentResult,
      promptSummary: agentTask.task,
      outputText:
        typeof agentResult.output === "string" ? (agentResult.output as string) : undefined,
      structuredOutput: typeof agentResult.output === "string" ? undefined : agentResult.output,
    });

    await this.persistEvent({
      type: "agent-output",
      context: eventContext,
      data: { agentId: agentTask.agentId, executionId, snapshot },
    });

    if (agentResult.toolCalls) {
      for (const toolCall of agentResult.toolCalls) {
        void this.persistEvent(
          toToolCallEvent(agentTask.agentId, executionId, toolCall, eventContext),
        );
      }
    }

    if (agentResult.toolResults) {
      for (const toolResult of agentResult.toolResults) {
        void this.persistEvent(
          toToolResultEvent(agentTask.agentId, executionId, toolResult, eventContext),
        );
      }
    }

    return agentResult;
  }

  private getAgentInput(agentTask: AgentTask, previousResults: AgentResult[]): string {
    let input: unknown;
    // Provide previous results to the agent if input source is previous
    if (agentTask.inputSource === "previous" && previousResults.length > 0) {
      const lastOutput = previousResults[previousResults.length - 1]?.output;

      if (typeof lastOutput === "object" && lastOutput !== null && "response" in lastOutput) {
        input = lastOutput.response;
      } else {
        input = lastOutput;
      }
    } else if (agentTask.inputSource === "combined" || agentTask.inputSource === "all") {
      const combinedInput: CombinedAgentInput = {
        original: this.sessionContext?.payload || {},
        previous: previousResults.map((r) => ({ agentId: r.agentId, output: r.output })),
      };
      input = combinedInput;
    } else if (agentTask.inputSource === "signal") {
      if (agentTask.agentId === "conversation") {
        // Extract messege from signal for conversation agent
        input = this.sessionContext?.payload?.message;
      } else {
        input = this.sessionContext?.payload;
      }
    } else {
      logger.error("Unknown input source", {
        inputSource: agentTask.inputSource,
        sessionId: this.sessionId,
        workspaceId: this.workspaceId,
      });
      throw new Error("Unknown input source");
    }

    if (typeof input === "string") {
      return input;
    }

    return JSON.stringify(input);
  }

  private evaluateProgress(results: AgentResult[], _plan: ExecutionPlan): boolean {
    const supervisionConfig = getSupervisionConfig(this.getSupervisionLevel());

    if (!supervisionConfig.postExecutionValidation) {
      return true;
    }

    const hasResults = results.length > 0;
    const hasFailures = results.some((r) => !r.output);

    // Use paranoid mode to stop on any failure, otherwise continue
    // Hallucination-based stopping is handled per-agent in validateAgentResult
    if (hasFailures && this.getSupervisionLevel() === SupervisionLevel.PARANOID) {
      return false; // Stop on any failure in paranoid mode
    }

    return hasResults;
  }

  /**
   * Validate a single agent result immediately after execution
   * This prevents dangerous actions from proceeding if hallucination is detected
   */
  private async validateAgentResult(
    result: AgentExecutionRecord,
    _allResults: AgentExecutionRecord[],
  ): Promise<boolean> {
    // For now, only validate if we have at least one result to analyze
    if (!result.output) {
      return true; // Continue if agent had no output
    }
    if (result.output === "") {
      logger.error("Agent output is empty!", {
        agentId: result.agentId,
        sessionId: this.sessionId,
        workspaceId: this.workspaceId,
      });
    }

    // Skip hallucination detection for non-llm agents
    const agentConfig = this.config?.agents?.[result.agentId];
    if (agentConfig?.type !== "llm") {
      this.logger.debug("Skipping hallucination validation for non-llm agent", {
        agentId: result.agentId,
        agentType: agentConfig?.type,
        reason: "Non-llm agents are pre-validated by evaluation tests",
      });
      return true;
    }

    // Run hallucination detection on just this single agent result
    const singleAgentResults: AgentResult[] = [result];

    try {
      const analysis: HallucinationAnalysis = await analyzeHallucinations(
        singleAgentResults,
        this.getSupervisionLevel(),
        this.hallucinationDetectorConfig,
      );

      this.logger.info("Single agent confidence validation", {
        agentId: result.agentId,
        confidence: analysis.averageConfidence,
        issues: analysis.issues,
        issuesCount: analysis.issues.length,
      });

      this.validationMap.set(result.agentId, {
        confidence: analysis.averageConfidence,
        issues: analysis.issues,
      });

      const retryCount = this.retryAttempts.get(result.agentId) ?? 0;
      const verdict: "pass" | "retry" | "fail" = (() => {
        const severe = analysis.averageConfidence < 0.3 || containsSeverePatterns(analysis.issues);
        if (!severe) return "pass";
        return retryCount > 0 ? "fail" : "retry";
      })();

      void this.persistEvent({
        type: "validation-result",
        context: {
          agentId: result.agentId,
          executionId: result.executionId,
          phaseId: result.phaseId,
        },
        data: {
          agentId: result.agentId,
          executionId: result.executionId,
          score: analysis.averageConfidence,
          verdict,
          analysis: { issues: analysis.issues },
        },
      });

      // Check for immediate severe hallucinations
      const isSevere = analysis.averageConfidence < 0.3 || containsSeverePatterns(analysis.issues);

      if (isSevere) {
        const severeIssues = getSevereIssues(analysis.issues);
        const retryCount = this.retryAttempts.get(result.agentId) ?? 0;

        this.logger.error("SEVERE HALLUCINATION DETECTED", {
          agentId: result.agentId,
          confidence: analysis.averageConfidence,
          severeIssues,
          allIssues: analysis.issues,
          retryCount,
        });

        if (retryCount > 0) {
          // Second failure → mark termination
          this.hallucinationTermination = {
            agentId: result.agentId,
            confidence: analysis.averageConfidence,
            issues: severeIssues.length > 0 ? severeIssues : analysis.issues,
          };
        }
        return false; // Signal caller to retry or terminate
      }

      // Success path → clear any previous retry state for this agent
      this.retryAttempts.delete(result.agentId);
      return true; // Continue execution
    } catch (error) {
      this.logger.error("Failed to validate agent result", {
        agentId: result.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.recordSupervisorAction("validation-error", {
        agentId: result.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      // On validation error, continue execution but log the issue
      return true;
    }
  }

  private generateSessionSummary(
    results: AgentResult[],
    plan: ExecutionPlan,
    duration: number,
  ): SessionSummary {
    const hasAllResults = results.every((r) => r.output);
    let status: "completed" | "failed" | "partial";
    let failureReason: string | undefined;

    if (this.hallucinationTermination) {
      status = ReasoningResultStatus.FAILED;
      const issuesSummary = this.hallucinationTermination.issues.slice(0, 3).join("; ");
      failureReason = `Severe hallucination detected in agent ${this.hallucinationTermination.agentId}: ${issuesSummary}`;
    } else if (hasAllResults) {
      status = ReasoningResultStatus.COMPLETED;
    } else {
      status = ReasoningResultStatus.PARTIAL;
      const failedCount = results.filter((r) => !r.output).length;
      failureReason = `${failedCount} agents failed to produce output`;
    }

    const reasoning =
      `Session executed ${results.length} agents across ${plan.phases.length} phases. ` +
      `Strategy: ${plan.strategy}, Confidence: ${plan.confidence}`;

    return {
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
      status,
      totalPhases: plan.phases.length,
      totalAgents: results.length,
      completedPhases: results.length > 0 ? plan.phases.length : 0,
      executedAgents: results.length,
      duration,
      reasoning,
      results,
      failureReason,
      confidence: this.hallucinationTermination?.confidence,
    };
  }

  private getSupervisionLevel(): SupervisionLevel {
    const jobSpec = this.sessionContext?.jobSpec;
    const levelStr = jobSpec?.config?.supervision?.level || "standard";

    switch (levelStr) {
      case "minimal":
        return SupervisionLevel.MINIMAL;
      case "detailed": // Config schema uses "detailed", maps to PARANOID
        return SupervisionLevel.PARANOID;
      case "standard":
        return SupervisionLevel.STANDARD;
    }
  }

  // Jeopardy validation removed

  private buildExecutionPlanningPrompt(context: SessionContext): string {
    return `You are an execution planning supervisor for Atlas workspace sessions.

Your role is to analyze the incoming signal and create a clear execution plan using available agents.

Signal Information:
- Signal ID: ${context.signal.id}
- Signal Provider: ${context.signal.provider?.name || "unknown"}
- Payload: ${JSON.stringify(context.payload)}

Available Agents:
${context.availableAgents.join(", ")}

Create a comprehensive execution plan that:
1. Identifies which agents need to be called
2. Determines the order of execution (sequential or parallel)
3. Specifies what task each agent should perform
4. Considers dependencies between agents

Return a well-structured plan with phases and per-agent tasks. Each phase must include a name, an executionStrategy (sequential or parallel), and a list of agents with fields: agentId, task, inputSource (signal | previous | combined), optional dependencies, and optional reasoning.`;
  }

  private getPlanFromJobDefinition(): ExecutionPlan | null {
    if (!this.sessionContext?.jobSpec) {
      return null;
    }

    const jobSpec = this.sessionContext.jobSpec;
    const planId = crypto.randomUUID();
    const agents = jobSpec.execution?.agents || [];

    const executionStrategy = jobSpec.execution?.strategy || "sequential";
    const phases: ExecutionPhase[] = [
      {
        id: crypto.randomUUID(),
        name: jobSpec.name || "Job Execution",
        executionStrategy,
        agents: agents.map((agent, index) => {
          const agentId = typeof agent === "string" ? agent : agent.id;
          const agentObj = typeof agent === "string" ? null : agent;

          return {
            agentId,
            task: agentObj?.context?.task || "Execute job task",
            inputSource: executionStrategy === "sequential" && index > 0 ? "previous" : "signal",
            dependencies: agentObj?.dependencies,
            reasoning: "Defined by job configuration",
          };
        }),
      },
    ];

    return {
      id: planId,
      phases,
      reasoning: `Executing job: ${jobSpec.name}`,
      strategy: "job-based",
      confidence: 1.0,
    };
  }

  /**
   * Build a facts section with current context information
   * This is easily extensible by adding more facts to the array
   */
  private buildFactsSection(): string {
    const now = new Date();

    // Build an array of facts - easy to extend with more facts later
    const facts: string[] = [
      `Current Date: ${now.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })}`,
      `Current Time: ${now.toLocaleTimeString("en-US", {
        hour12: true,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      })}`,
      `Timestamp: ${now.toISOString()}`,
    ];

    // Add session-specific facts if available
    if (this.sessionId) {
      facts.push(`Session ID: ${this.sessionId}`);
    }

    if (this.workspaceId) {
      facts.push(`Workspace ID: ${this.workspaceId}`);
    }

    // Add job-specific facts if available
    if (this.sessionContext?.jobSpec?.name) {
      facts.push(`Job Name: ${this.sessionContext.jobSpec.name}`);
    }

    // Format the facts section
    return `## Context Facts\n${facts.map((fact) => `- ${fact}`).join("\n")}`;
  }

  private buildValidationFeedback(agentId: string): string {
    const priorIssues = this.validationMap.get(agentId);
    const retryCount = this.retryAttempts.get(agentId) ?? 0;

    if (!priorIssues || retryCount === 0) {
      return "";
    }

    const feedbackHeader = "## Validation Feedback (address in this retry):";
    const issuesList = priorIssues.issues?.length
      ? priorIssues.issues.map((issue) => `- ${issue}`).join("\n")
      : "- Low confidence without specific issues provided";

    return `${feedbackHeader}\nConfidence: ${priorIssues.confidence.toFixed(2)}\nIssues:\n${issuesList}`;
  }

  // Placeholder for future tool execution
  // private toolExecutor(
  //   toolName: string,
  //   parameters: Record<string, unknown>,
  // ): Promise<ToolExecutorResult> {
  //   return Promise.resolve({
  //     success: true,
  //     result: `Tool ${toolName} executed with parameters: ${JSON.stringify(parameters)}`,
  //     duration: 100,
  //   });
  // }

  async execute(): Promise<SessionResult> {
    const startTime = Date.now();
    this.transitionStatus(SessionSupervisorStatus.EXECUTING, "execute-wrapper-start");

    try {
      const summary = await this.executeSession();
      const duration = Date.now() - startTime;

      // Set session supervisor status based on execution outcome
      if (summary.status === ReasoningResultStatus.COMPLETED) {
        this.transitionStatus(SessionSupervisorStatus.COMPLETED, "execute-wrapper-complete", {
          summaryStatus: summary.status,
        });
      } else if (summary.status === ReasoningResultStatus.FAILED) {
        this.transitionStatus(SessionSupervisorStatus.FAILED, "execute-wrapper-failed", {
          summaryStatus: summary.status,
        });
      } else {
        this.transitionStatus(SessionSupervisorStatus.COMPLETED, "execute-wrapper-partial", {
          summaryStatus: summary.status,
        }); // Partial completion still counts as completed supervisor
      }

      return {
        sessionId: this.sessionId,
        status: summary.status === ReasoningResultStatus.COMPLETED ? "success" : "error",
        result: {
          totalPhases: summary.totalPhases,
          totalAgents: summary.totalAgents,
          reasoning: summary.reasoning,
          results: summary.results,
          failureReason: summary.failureReason, // Include failure details
        },
        duration,
      };
    } catch (error) {
      this.transitionStatus(SessionSupervisorStatus.FAILED, "execute-wrapper-error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        sessionId: this.sessionId,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
    }
  }

  cancel(): void {
    this.logger.info("Cancelling session", { sessionId: this.sessionId });
    this.transitionStatus(SessionSupervisorStatus.CANCELLED, "session-cancel-request");

    // Emit session-cancel event
    if (this.baseStreamEmitter && !this.sessionFinishEmitted) {
      this.baseStreamEmitter.emit({
        type: "data-session-cancel",
        data: {
          sessionId: this.sessionId,
          workspaceId: this.workspaceId,
          reason: "Session cancelled by user",
        },
      });
    }

    // Cancel all active agent executions
    for (const [agentId, controller] of this.activeAgentExecutions) {
      this.logger.debug("Cancelling agent execution", { agentId, sessionId: this.sessionId });
      controller.abort();
    }

    // Clear the map after cancelling
    this.activeAgentExecutions.clear();

    // Cancel session-level operations
    this.abortController?.abort();
  }

  getStatus(): SessionSupervisorStatusType {
    return this.status;
  }

  /**
   * Get all artifacts created during session execution
   */
  getArtifacts(): IWorkspaceArtifact[] {
    return [...this.artifacts];
  }
}
