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

import { createAnthropic } from "@ai-sdk/anthropic";
import type { AtlasTools } from "@atlas/agent-sdk";
import {
  type AgentResult,
  AwaitingSupervisorDecision,
  type StreamEmitter,
  type ToolCall,
  type ToolResult,
} from "@atlas/agent-sdk";
import type { JobSpecification } from "@atlas/config";
import type {
  ActorInitParams,
  AgentExecutionConfig,
  AgentTask,
  BaseActor,
  CombinedAgentInput,
  ExecutionPlanReasoningStep,
  IAgentOrchestrator,
  SessionResult,
  SessionSupervisorConfig,
  SessionUIMessageChunk,
} from "@atlas/core";
import {
  HTTPStreamEmitter,
  ReasoningResultStatus,
  type ReasoningResultStatusType,
  SessionSupervisorStatus,
  type SessionSupervisorStatusType,
} from "@atlas/core";
import { type Logger, logger } from "@atlas/logger";
import {
  CoALAMemoryManager,
  CoALAMemoryType,
  createConversationContext,
  type MECMFMemoryManager,
  MemorySource,
  MemoryType,
  setupMECMF,
} from "@atlas/memory";
import { CoALALocalFileStorageAdapter } from "@atlas/storage";
import { generateText, stepCountIs } from "ai";
import { z } from "zod/v4";
import { stripSourceAttributionTags } from "../../../packages/core/src/prompts/source-attribution.ts";
import type { IWorkspaceArtifact, IWorkspaceSignal } from "../../types/core.ts";
import { getWorkspaceMemoryDir } from "../../utils/paths.ts";
import {
  type HallucinationAnalysis,
  HallucinationDetector,
  HallucinationPatternDetector,
} from "../services/hallucination-detector.ts";
import {
  type JeopardyValidationResult,
  JeopardyValidator,
} from "../services/jeopardy-validator.ts";
import {
  type FactSourceType,
  type SemanticFact,
  SemanticFactExtractor,
} from "../services/semantic-fact-extractor.ts";
import { getSupervisionConfig, SupervisionLevel } from "../supervision-levels.ts";

// Canonical tool metadata types are provided by @atlas/agent-sdk

// Interface for agent plan from AI tool calls
interface AgentPlanInput {
  agentId: string;
  task: string;
  inputSource: "signal" | "previous" | "combined";
  dependencies?: string[];
  phase: string;
  executionStrategy: "sequential" | "parallel";
}

// Interface for workspace supervisor methods used by session supervisor
export interface IWorkspaceSupervisorForSession {
  streamAgentResult(
    sessionId: string,
    agentId: string,
    input: unknown,
    output: unknown,
    duration: number,
    success: boolean,
    metadata?: { tokensUsed?: number; error?: string },
  ): Promise<void>;
  streamToolCall(
    sessionId: string,
    agentId: string,
    toolName: string,
    args: unknown,
  ): Promise<void>;
  streamToolResult(
    sessionId: string,
    agentId: string,
    toolName: string,
    result: unknown,
  ): Promise<void>;
  streamEpisodicEvent(
    eventType: string,
    description: string,
    entities: string[],
    outcome: string,
    confidence: number,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  memoryCoordinator?: {
    consolidateWorkingMemories(
      sessionId: string,
      options: { minAccessCount: number; minRelevance: number; markImportant: boolean },
    ): Promise<void>;
    clearWorkingMemoryBySession(sessionId: string): Promise<number>;
  };
}

export interface SessionContext {
  sessionId: string;
  workspaceId: string;
  signal: IWorkspaceSignal;
  payload: Record<string, unknown>;
  jobSpec?: JobSpecification;
  availableAgents: string[];
  constraints?: Record<string, unknown>;
  streamId?: string; // Optional streamId for streaming support
  additionalPrompts?: { planning?: string; evaluation?: string };
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
  validation?: Record<
    string,
    { confidence: number; jeopardyValidation?: JeopardyValidationResult }
  >;
}

export interface ConfidenceAnalysis {
  averageConfidence: number;
  lowConfidenceAgents: string[];
  suspiciousPatterns: string[];
  issues: string[];
}

export interface LLMValidationResult {
  valid: boolean;
  confidence: number;
  issues: string[];
  reasoning?: string;
  source?: "llm" | "validation_unavailable" | "validation_failed";
}

export class SessionSupervisorActor implements BaseActor {
  readonly type: "session" = "session";
  private sessionId: string;
  private workspaceId: string;
  private logger: Logger;
  id: string;
  private sessionContext?: SessionContext;
  private supervisionLevel: SupervisionLevel = SupervisionLevel.STANDARD;
  private status: SessionSupervisorStatusType = SessionSupervisorStatus.IDLE;
  private config?: SessionSupervisorConfig;
  private cachedPlan?: ExecutionPlan;
  private agentOrchestrator?: IAgentOrchestrator; // Agent orchestrator for MCP-based execution
  private artifacts: IWorkspaceArtifact[] = []; // Store session artifacts
  private llmProvider = createAnthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  private hallucinationDetector: HallucinationDetector;
  // Observation-only Jeopardy validator: logs results, never affects control flow
  private jeopardyValidator!: JeopardyValidator;
  private validationMap = new Map<
    string,
    { confidence: number; issues: string[]; jeopardyValidation?: JeopardyValidationResult }
  >();
  private hallucinationTermination?: { agentId: string; confidence: number; issues: string[] };
  // Track last validation details for feedback-driven retries
  private lastValidationMetaByAgent = new Map<string, { confidence: number; issues: string[] }>();
  // Track single retry attempts per agent to avoid loops
  private retryAttempts = new Map<string, number>();

  // Private state tracking for new Session integration
  private hasStarted: boolean = false;
  private isExecuting: boolean = false;
  private lastSessionSummary?: SessionSummary;
  private agentResults?: AgentResult[];
  private executionStartTime?: Date;
  private executionEndTime?: Date;
  private executionPromise?: Promise<SessionSummary>; // Store the execution promise for external monitoring
  private workspaceSupervisor?: IWorkspaceSupervisorForSession; // WorkspaceSupervisorActor - set by runtime for memory streaming
  private mecmfManager?: MECMFMemoryManager; // MECMF memory manager for prompt enhancement

  // Cancellation management
  private abortController?: AbortController;
  private activeAgentExecutions = new Map<string, AbortController>();

  // Stream management
  private baseStreamEmitter?: StreamEmitter<SessionUIMessageChunk>;
  private sessionFinishEmitted = false; // Track if session-finish was already emitted
  private streamMetrics = {
    totalEvents: 0,
    filteredEvents: 0,
    errorEvents: 0,
    agentMetrics: new Map<string, { events: number; errors: number }>(),
  };

  constructor(
    sessionId: string,
    workspaceId?: string,
    id?: string,
    config?: SessionSupervisorConfig,
  ) {
    this.id = id || crypto.randomUUID();
    this.sessionId = sessionId;
    this.workspaceId = workspaceId;
    this.config = config;

    this.logger = logger.child({
      actorId: this.id,
      component: "SessionSupervisorActor",
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
    });

    // Initialize hallucination detection system
    const supervisionConfig = getSupervisionConfig(this.supervisionLevel);

    this.hallucinationDetector = new HallucinationDetector({
      supervisionLevel: this.supervisionLevel,
      logger: this.logger.child({ component: "hallucination-detector" }),
      enableLLMValidation: supervisionConfig.postExecutionValidation,
    });

    this.logger.info("Session supervisor actor initialized");
  }

  setConfig(config: SessionSupervisorConfig): void {
    this.config = config;
    this.logger.info("Session config set", {
      sessionId: this.sessionId,
      agentCount: Object.keys(config.agents).length,
      jobName: config.job.name,
    });
  }

  setAgentOrchestrator(orchestrator: IAgentOrchestrator): void {
    this.agentOrchestrator = orchestrator;
    this.logger.info("Agent orchestrator set", { sessionId: this.sessionId });
  }

  setWorkspaceSupervisor(supervisor: IWorkspaceSupervisorForSession): void {
    this.workspaceSupervisor = supervisor;
    this.logger.info("Workspace supervisor set for memory streaming", {
      sessionId: this.sessionId,
    });
  }

  initialize(params?: ActorInitParams): void {
    if (params && "actorId" in params) {
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

    // Determine supervision level first
    this.supervisionLevel = this.getSupervisionLevel();

    // Initialize supervision services

    // Ensure detector threshold aligns with current level
    this.hallucinationDetector.setSupervisionLevel(this.supervisionLevel);

    // Initialize Jeopardy validator (observation-only)
    this.jeopardyValidator = new JeopardyValidator({
      logger: this.logger.child({ component: "jeopardy-validator", mode: "observation-only" }),
      model: "claude-3-5-haiku-latest",
      llmProvider: (model: string) => this.llmProvider(model),
    });

    this.logger.info("Session supervisor actor initialized", {
      supervisionLevel: this.supervisionLevel,
      workspaceId: this.workspaceId || "global",
      jeopardyValidation: "observation-only",
    });
  }

  /**
   * Configure supervision level for testing purposes
   * This method allows tests to set supervision level without accessing private members
   */
  public configureSupervisionLevel(level: SupervisionLevel): void {
    this.supervisionLevel = level;
    this.hallucinationDetector.setSupervisionLevel(level);
    this.logger.info("Supervision level configured", { level });
  }

  /**
   * Get agent configuration and create execution config
   * Centralizes agent configuration access
   */
  private getAgentExecutionConfig(agentId: string): AgentExecutionConfig {
    const agentConfig = this.config?.agents?.[agentId];
    if (!agentConfig) {
      this.logger.error("Agent configuration not found", {
        agentId,
        availableAgents: Object.keys(this.config?.agents || {}),
        hasConfig: !!this.config,
        hasAgents: !!this.config?.agents,
      });
      throw new Error(`Agent configuration not found: ${agentId}`);
    }

    let tools: string[] = [];
    if (agentConfig.type === "llm") {
      tools = agentConfig.config?.tools ?? [];
    } else if (agentConfig.type === "system") {
      tools = agentConfig.config?.tools ?? [];
    }

    // Always include atlas-platform for all agents to access Atlas tools
    if (!tools.includes("atlas-platform")) {
      tools = ["atlas-platform", ...tools];
    }

    return {
      agentId,
      agent: agentConfig,
      tools: tools,
      memory: this.config?.memory,
      workspaceTools: this.config?.tools,
    };
  }

  shutdown(): void {
    this.logger.info("Session supervisor actor shutting down", {
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
      streamMetrics: this.streamMetrics,
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
      this.cleanupWorkingMemory().catch((error) => {
        this.logger.warn("Failed to cleanup working memory on shutdown", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: this.sessionId,
        });
      });
    }

    // Only emit session-finish if not already emitted during normal execution
    if (!this.sessionFinishEmitted && this.baseStreamEmitter) {
      this.baseStreamEmitter.emit({
        type: "data-session-finish",
        data: {
          sessionId: this.sessionId,
          workspaceId: this.workspaceId,
          status: this.status,
          source: "shutdown",
        },
      });
      this.sessionFinishEmitted = true;
      this.logger.debug("Emitted session-finish event during shutdown", {
        sessionId: this.sessionId,
        status: this.status,
      });
    }
    this.baseStreamEmitter?.end();
    // Clear heavy memory objects to prevent leaks
    this.cleanupMemoryObjects();
  }

  /**
   * Clean up working memory for this session
   */
  private async cleanupWorkingMemory(): Promise<void> {
    if (!this.mecmfManager) {
      return;
    }

    try {
      this.logger.info("Cleaning up session working memory", {
        sessionId: this.sessionId,
        workspaceId: this.workspaceId,
      });

      // Consolidate important working memories to long-term storage
      await this.mecmfManager.consolidateWorkingMemory();

      // Note: The actual clearing of working memory would need to be implemented
      // in the MECMF manager. For now, consolidation promotes important memories.

      this.logger.info("Working memory cleanup completed", { sessionId: this.sessionId });
    } catch (error) {
      this.logger.error("Failed to cleanup working memory", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't rethrow - memory cleanup failure shouldn't break shutdown
    }
  }

  /**
   * Clean up heavy memory objects that cause leaks
   */
  private cleanupMemoryObjects(): void {
    try {
      // Clear stream metrics that accumulate over time
      this.streamMetrics.agentMetrics.clear();
      this.streamMetrics.totalEvents = 0;
      this.streamMetrics.filteredEvents = 0;
      this.streamMetrics.errorEvents = 0;

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
      this.logger.warn("Memory object cleanup failed", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Public wrapper to release heavy memory objects without changing status
   * or emitting lifecycle events. Intended for workspace-level cleanup while
   * preserving session history.
   */
  public releaseHeavyMemoryObjects(): void {
    this.cleanupMemoryObjects();
  }

  async initializeSession(context: SessionContext): Promise<void> {
    this.sessionContext = context;
    // Clear cached plan when context changes
    this.cachedPlan = undefined;

    // Initialize MECMF manager for prompt enhancement
    if (context.workspaceId) {
      try {
        const scope = {
          id: context.workspaceId,
          type: "workspace" as const,
          name: `Workspace ${context.workspaceId}`,
        };
        this.mecmfManager = await setupMECMF(scope, {
          workspaceId: context.workspaceId,
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
        });
        this.logger.info("MECMF memory manager initialized for prompt enhancement", {
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
        });
      } catch (error) {
        this.logger.warn(
          "Failed to initialize MECMF manager, continuing without prompt enhancement",
          {
            error: error instanceof Error ? error.message : String(error),
            workspaceId: context.workspaceId,
          },
        );
      }
    }

    // Initialize streaming if streamId provided
    if (context.streamId) {
      this.baseStreamEmitter = new HTTPStreamEmitter<SessionUIMessageChunk>(
        context.streamId,
        context.sessionId,
        this.logger,
      );

      // Emit session start event
      this.baseStreamEmitter.emit({
        type: "data-session-start",
        data: {
          sessionId: context.sessionId,
          signalId: context.signal.id,
          workspaceId: context.workspaceId,
        },
      });
    }

    this.logger.info("Session initialized", {
      sessionId: context.sessionId,
      workspaceId: context.workspaceId,
      signalId: context.signal.id,
      availableAgents: context.availableAgents.length,
      hasStreaming: !!context.streamId,
    });
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

    // Check for pre-computed job specs (keep existing logic)
    const jobSpecPlan = this.getCachedJobSpec();
    if (jobSpecPlan) {
      this.logger.info("Using cached execution plan from job spec", {
        planId: jobSpecPlan.id,
        phases: jobSpecPlan.phases.length,
      });
      // Cache the job spec plan too
      this.cachedPlan = jobSpecPlan;
      return jobSpecPlan;
    }

    // Check if planning should be skipped (keep existing logic)
    const skipPlanning = this.sessionContext.jobSpec?.config?.supervision?.skip_planning;
    if (skipPlanning) {
      this.logger.info("Skipping planning phase due to job configuration");
      return {
        id: crypto.randomUUID(),
        phases: [],
        reasoning: "Planning skipped by job configuration",
        strategy: "skip-planning",
        confidence: 1.0,
      };
    }

    // New implementation using generateText
    this.logger.info("Computing execution plan using AI SDK");

    // Create tools for agent execution
    const planningTools = this.createPlanningTools();

    const result: {
      text: string;
      reasoningText?: string;
      toolCalls?: ToolCall[];
      toolResults?: ToolResult[];
    } = await generateText({
      model: this.llmProvider("claude-3-7-sonnet-20250219"),
      system: this.buildExecutionPlanningPrompt(this.sessionContext),
      messages: [
        {
          role: "user",
          content: `Analyze this signal and create an execution plan: ${JSON.stringify(
            this.sessionContext.signal,
          )}`,
        },
      ],
      tools: planningTools,
      toolChoice: "auto",
      stopWhen: stepCountIs(10),
      temperature: 0.3, // Lower temperature for more consistent planning
      maxOutputTokens: 4000,
      maxRetries: 3, // Enable retries for API resilience (e.g., 529 errors)
      providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 15000 } } },
    });

    // Pass through tool calls/results from AI SDK
    const toolCalls: ToolCall[] = result.toolCalls ?? [];
    const toolResults: ToolResult[] = result.toolResults ?? [];

    const plan = this.parsePlanFromResponse(
      result.text,
      result.reasoningText,
      toolCalls,
      toolResults,
    );

    const duration = Date.now() - startTime;
    this.logger.info("Execution plan created", {
      planId: plan.id,
      duration,
      phases: plan.phases.length,
      reasoning: result.reasoningText,
      text: result.text,
      toolCalls: toolCalls,
      toolResults: toolResults,
    });

    // Cache the plan for subsequent calls
    this.cachedPlan = plan;

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
   * Get current execution progress (0-100)
   */
  getProgress(): number {
    if (!this.lastSessionSummary) return 0;

    const summary = this.lastSessionSummary;
    if (summary.status === ReasoningResultStatus.COMPLETED) return 100;
    if (summary.status === ReasoningResultStatus.FAILED) return 0;

    // Calculate progress from phases
    return Math.round((summary.completedPhases / summary.totalPhases) * 100);
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
    const artifacts: IWorkspaceArtifact[] = [];

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
          data: result as unknown as Record<string, unknown>,
          createdAt: new Date(),
          createdBy: `agent-${result.agentId}`,
        });
      });
    }

    return artifacts;
  }

  /**
   * Get detailed execution metadata
   */
  getExecutionMetadata(): {
    sessionId: string;
    workspaceId: string;
    startTime?: Date;
    endTime?: Date;
    totalPhases: number;
    completedPhases: number;
    totalAgents: number;
    executedAgents: number;
    confidence?: number;
    supervisionLevel: string;
  } {
    return {
      sessionId: this.sessionId,
      workspaceId: this.workspaceId || "global",
      startTime: this.executionStartTime,
      endTime: this.executionEndTime,
      totalPhases: this.lastSessionSummary?.totalPhases || 0,
      completedPhases: this.lastSessionSummary?.completedPhases || 0,
      totalAgents: this.lastSessionSummary?.totalAgents || 0,
      executedAgents: this.lastSessionSummary?.results?.length || 0,
      confidence: this.lastSessionSummary?.confidence,
      supervisionLevel: this.supervisionLevel,
    };
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
    this.executionStartTime = new Date();

    // Create abort controller for this session
    this.abortController = new AbortController();

    const sessionStartTime = Date.now();
    let summary: SessionSummary | undefined;

    try {
      // Create execution plan
      const plan = await this.createExecutionPlan();

      const allResults: AgentResult[] = [];
      let lastConfidenceResults: ConfidenceAnalysis | undefined;

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
          // Optional: capture confidence results for later summary
          try {
            lastConfidenceResults = await this.analyzeResultConfidence(allResults);
          } catch (error) {
            this.logger.warn("Confidence analysis failed after early stop", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          break;
        }
      }

      // Store agent results as artifact
      if (allResults.length > 0) {
        const agentResultsArtifact: IWorkspaceArtifact = {
          id: crypto.randomUUID(),
          type: "agent_results",
          data: allResults,
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
            jeopardyValidation: v.jeopardyValidation,
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
      summary = this.generateSessionSummary(allResults, plan, duration, lastConfidenceResults);

      // Update execution tracking
      this.lastSessionSummary = summary;
      this.agentResults = allResults;
      this.isExecuting = false;
      this.executionEndTime = new Date();

      // Handle memory operations based on job configuration
      await this.handleMemoryOperations(summary);

      // Perform session lifecycle memory management
      await this.performSessionMemoryLifecycle(summary);

      this.logger.info("Session execution completed", {
        sessionId: this.sessionId,
        status: summary.status,
        phases: summary.totalPhases,
        agents: summary.totalAgents,
        duration,
      });

      return summary;
    } catch (error) {
      // Create error summary if execution failed
      const duration = Date.now() - sessionStartTime;
      if (!summary) {
        const isCancellation = 
          (error instanceof Error && 
           (error.name === 'AbortError' || 
            error.message.includes('Session cancelled') ||
            error.message.includes('aborted')));
        
        summary = {
          sessionId: this.sessionId,
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
      this.executionEndTime = new Date();

      const isCancellation = 
        (error instanceof Error && 
         (error.name === 'AbortError' || 
          error.message.includes('Session cancelled') ||
          error.message.includes('aborted')));

      if (isCancellation) {
        this.logger.info("Session execution cancelled", {
          sessionId: this.sessionId,
          duration,
        });
      } else {
        this.logger.error("Session execution failed", {
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error),
          duration,
        });
      }

      throw error;
    } finally {
      // Always emit session-finish event to trigger queue rotation
      // This is critical for proper SSE stream synchronization
      if (this.baseStreamEmitter && !this.sessionFinishEmitted) {
        const finalStatus = summary?.status || 
          (this.status === SessionSupervisorStatus.CANCELLED ? ReasoningResultStatus.CANCELLED : ReasoningResultStatus.FAILED);
        const finalDuration = Date.now() - sessionStartTime;

        this.baseStreamEmitter.emit({
          type: "data-session-finish",
          data: {
            sessionId: this.sessionId,
            workspaceId: this.workspaceId,
            status: finalStatus,
            duration: finalDuration,
            source: "execution",
          },
        });

        this.sessionFinishEmitted = true;

        this.logger.debug("Emitted session-finish event for stream rotation", {
          sessionId: this.sessionId,
          streamId: this.sessionContext?.streamId,
          status: finalStatus,
          wasError: !summary || summary.status === ReasoningResultStatus.FAILED,
          source: "execution",
        });
      }
    }
  }

  private async executePhase(
    phase: ExecutionPhase,
    previousResults: AgentResult[],
  ): Promise<AgentResult[]> {
    const phaseResults: AgentResult[] = [];

    if (phase.executionStrategy === "sequential") {
      for (const agentTask of phase.agents) {
        // Combine results from previous phases + current phase agents
        const allPreviousResults = [...previousResults, ...phaseResults];
        const result = await this.executeAgent(
          agentTask,
          allPreviousResults,
          phaseResults,
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
        if (!continuePhase) return phaseResults;
      }
    } else {
      const promises = phase.agents.map((agentTask) =>
        this.executeAgent(agentTask, previousResults, phaseResults),
      );
      const parallelResults = await Promise.all(promises);
      phaseResults.push(...parallelResults);
      // Validate all parallel results immediately after execution
      const tasksById = new Map(phase.agents.map((a) => [a.agentId, a] as const));
      const baseIndex = phaseResults.length - parallelResults.length;
      for (let i = 0; i < parallelResults.length; i++) {
        const result = parallelResults[i];
        if (!result) {
          this.logger.error("Parallel agent result is undefined - terminating session", {
            phaseIndex: phase.id,
          });
          return phaseResults; // Terminate phase due to inconsistency
        }
        const agentTask = tasksById.get(result.agentId);
        if (!agentTask) {
          this.logger.error("Cannot retry parallel agent - task not found", {
            agentId: result.agentId,
            phaseIndex: phase.id,
          });
          return phaseResults; // Terminate phase due to inconsistency
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
        if (!continuePhase) return phaseResults;
      }
    }

    return phaseResults;
  }

  private async handlePostExecutionValidation(
    agentTask: AgentTask,
    currentResult: AgentResult,
    previousResults: AgentResult[],
    phaseResults: AgentResult[],
    phase: ExecutionPhase,
    context: "sequential" | "parallel",
    replaceResult: (updated: AgentResult) => void,
  ): Promise<boolean> {
    // Initial validation on current result
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

      // Retry once with feedback
      const retryResult = await this.executeAgent(
        { ...agentTask },
        [...previousResults, ...phaseResults],
        phaseResults,
      );

      // Replace the corresponding stored result(s)
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
        return false; // terminate phase
      }

      return true; // continue on successful retry
    }

    // Already retried before → terminate
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
    return false; // terminate phase
  }

  private async executeAgent(
    agentTask: AgentTask,
    previousResults: AgentResult[],
    _phaseResults: AgentResult[],
  ): Promise<AgentResult> {
    const startTime = Date.now();

    // the signal that triggers the session - payload is whatever json is in -d
    let input: unknown = this.sessionContext?.payload;

    if (agentTask.inputSource === "previous" && previousResults.length > 0) {
      const lastOutput = previousResults[previousResults.length - 1]?.output;
      // If the output is an LLM response object, extract the actual response text
      if (typeof lastOutput === "object" && lastOutput !== null && "response" in lastOutput) {
        input = lastOutput.response;
      } else {
        input = lastOutput;
      }
    } else if (agentTask.inputSource === "combined") {
      const combinedInput: CombinedAgentInput = {
        original: this.sessionContext?.payload || {},
        previous: previousResults.map((r) => ({ agentId: r.agentId, output: r.output })),
      };
      input = combinedInput;
    } else if (agentTask.dependencies?.length) {
      const lastDep = agentTask.dependencies[agentTask.dependencies.length - 1];
      const depResult = previousResults.find((r) => r.agentId === lastDep);
      if (depResult) {
        input = depResult.output;
      }
    }

    this.logger.info("Executing agent", {
      agentId: agentTask.agentId,
      task: agentTask.task,
      inputSource: agentTask.inputSource,
      reasoning: agentTask.reasoning,
    });

    // Stream agent start
    this.baseStreamEmitter?.emit({
      type: "data-agent-start",
      data: { agentId: agentTask.agentId, task: agentTask.task },
    });

    let result: AgentResult;

    if (!this.agentOrchestrator) {
      throw new Error("Agent orchestrator is not available");
    }

    // Use orchestrator if available (new MCP-based execution)
    this.logger.info("Using orchestrator for execution");
    // Ensure prompt string is available outside the try block to avoid
    // accidentally referencing the global Deno prompt() function.
    let prompt: string = "";
    try {
      // @deprecated Check if this is a system agent that expects objects
      // System agents should receive input as-is, not stringified
      const agentConfig = this.config?.agents?.[agentTask.agentId];
      const isSystemAgent = agentConfig?.type === "system";
      // System agents are referenced by ID
      const agentId = isSystemAgent ? agentConfig.agent : agentTask.agentId;

      // Extract the actual message/input to send to the agent

      /**
       * @FIXME: this is really rough code.
       */
      if (agentTask.task && agentTask.task !== "Execute job task") {
        // Use explicit task if provided
        prompt = agentTask.task;
      } else if (agentConfig?.config?.prompt && agentConfig?.type !== "system") {
        // For non-system agents, use the agent's configured prompt from workspace and append the input
        // System agents (like conversation) manage their own system prompts internally
        let inputText = "";
        let inputLabel = "";

        // Determine the input text and appropriate label based on source
        if (agentTask.inputSource === "previous" && previousResults.length > 0) {
          // For sequential execution, clearly label the previous agent's output
          inputLabel = "## Previous Agent Output to Process:\n";
          if (typeof input === "string") {
            inputText = input;
          } else if (input !== undefined && input !== null) {
            // Pretty print JSON for better readability
            inputText = JSON.stringify(input, null, 2);
          }
        } else {
          // For initial agents or signal-based input
          inputLabel = "## Input Data:\n";
          if (typeof input === "string") {
            inputText = input;
          } else if (typeof input === "object" && input !== null && "message" in input) {
            inputText = (input as { message: string }).message;
          } else if (typeof input === "object" && input !== null && "text" in input) {
            inputText = (input as { text: string }).text;
          } else if (input !== undefined && input !== null) {
            inputText = JSON.stringify(input, null, 2);
          }
        }

        // Build facts section with current context
        const facts = this.buildFactsSection();

        // Combine all sections: Facts + Input + Prompt (+ optional feedback)
        // Structure: Facts -> Input -> Agent Instructions -> Retry Feedback (if present)
        const promptSections = [];

        // Always include facts section first
        promptSections.push(facts);

        // Include input if available
        if (inputText) {
          const sanitizedInput = stripSourceAttributionTags(inputText);
          promptSections.push(inputLabel + sanitizedInput);
        }

        // Add the agent's configured prompt instructions
        promptSections.push(agentConfig.config.prompt);

        // If we are retrying due to a previous validation failure for this agent, append feedback
        const priorIssues = this.lastValidationMetaByAgent.get(agentTask.agentId);
        const retryCount = this.retryAttempts.get(agentTask.agentId) ?? 0;
        if (priorIssues && retryCount > 0) {
          const feedbackHeader = "## Validation Feedback (address in this retry):";
          const issuesList = priorIssues.issues?.length
            ? priorIssues.issues.map((i) => `- ${i}`).join("\n")
            : "- Low confidence without specific issues provided";
          const feedbackBody = `${feedbackHeader}\nConfidence: ${priorIssues.confidence.toFixed(
            2,
          )}\nIssues:\n${issuesList}`;
          promptSections.push(feedbackBody);
        }

        // Join all sections with clear separation
        prompt = promptSections.join("\n\n");

        this.logger.debug("Using agent configured prompt with facts and input", {
          agentId: agentTask.agentId,
          inputLength: inputText.length,
          factsLength: facts.length,
          combinedLength: prompt.length || 0,
          inputSource: agentTask.inputSource,
        });
      } else if (typeof input === "string") {
        // Direct string input (e.g., from previous agent)
        prompt = stripSourceAttributionTags(input);
      } else if (typeof input === "object" && input !== null && "message" in input) {
        // Extract message from signal payload safely
        const msgValue = (input as Record<string, unknown>)["message"];
        prompt = typeof msgValue === "string" ? msgValue : JSON.stringify(msgValue);
      } else if (typeof input === "object" && input !== null && "text" in input) {
        // Extract text from signal payload (common field name) safely
        const textValue = (input as Record<string, unknown>)["text"];
        prompt = typeof textValue === "string" ? textValue : JSON.stringify(textValue);
      } else {
        // Fallback to JSON representation
        prompt = JSON.stringify(input);
      }
      const agentExecutionConfig = this.getAgentExecutionConfig(agentTask.agentId);

      // Enhance prompt with MECMF memory context
      if (this.mecmfManager) {
        try {
          const enhancedPrompt = await this.mecmfManager.enhancePromptWithMemory(
            String(prompt), // Ensure prompt is a string
            {
              tokenBudget: 4000, // Reserve tokens for memory context
              contextFormat: "summary",
              includeTypes: [
                MemoryType.WORKING,
                MemoryType.EPISODIC,
                MemoryType.SEMANTIC,
                MemoryType.PROCEDURAL,
              ],
              maxMemories: 10,
            },
          );

          // Use enhanced prompt if available
          if (enhancedPrompt?.enhancedPrompt) {
            this.logger.debug("Prompt enhanced with MECMF memory context", {
              originalLength: prompt.length,
              enhancedLength: enhancedPrompt.enhancedPrompt.length,
              memoriesIncluded: enhancedPrompt.memoriesIncluded,
              tokensUsed: enhancedPrompt.tokensUsed,
              agentId: agentTask.agentId,
            });
            prompt = enhancedPrompt.enhancedPrompt;
          }
        } catch (error) {
          this.logger.warn("Failed to enhance prompt with MECMF, using original", {
            error: error instanceof Error ? error.message : String(error),
            agentId: agentTask.agentId,
          });
        }
      }

      // Create abort controller for this specific agent execution
      const agentAbort = new AbortController();
      this.activeAgentExecutions.set(agentTask.agentId, agentAbort);

      const orchestratorResult: unknown = await this.agentOrchestrator.executeAgent(
        agentId,
        prompt,
        {
          sessionId: this.sessionId,
          workspaceId: this.workspaceId || "global",
          streamId: this.sessionContext?.streamId,
          previousResults,
          agentTools: agentExecutionConfig.tools, // Pass agent-specific tools
          additionalContext: { input, reasoning: agentTask.reasoning },
          abortSignal: agentAbort.signal,
          // Pass callback for stream events
          onStreamEvent: (event) => {
            this.baseStreamEmitter?.emit(event);
          },
        },
      );

      // Extract output and preserve tool metadata from orchestrator result
      type OrchestratorExecResult = {
        output?: unknown;
        duration?: number;
        toolCalls?: ToolCall[];
        toolResults?: ToolResult[];
      };
      const isExecResult = (v: unknown): v is OrchestratorExecResult =>
        typeof v === "object" && v !== null;
      const or = isExecResult(orchestratorResult) ? orchestratorResult : {};
      result = {
        agentId: agentTask.agentId,
        task: agentTask.task,
        input,
        timestamp: new Date().toISOString(),
        output: isExecResult(orchestratorResult) ? or.output : undefined,
        duration:
          isExecResult(orchestratorResult) && typeof or.duration === "number"
            ? or.duration
            : Number((isExecResult(orchestratorResult) ? or.duration : 0) ?? 0),
        toolCalls: isExecResult(orchestratorResult) ? or.toolCalls : undefined,
        toolResults: isExecResult(orchestratorResult) ? or.toolResults : undefined,
      };

      this.baseStreamEmitter?.emit({
        type: "data-agent-finish",
        data: { agentId: agentTask.agentId, duration: Date.now() - startTime },
      });
    } catch (error) {
      // Clean up the abort controller for this agent
      this.activeAgentExecutions.delete(agentTask.agentId);

      // Check if it's an approval exception
      if (error instanceof AwaitingSupervisorDecision) {
        return await this.handleApprovalRequest(error, agentTask, startTime);
      }

      // Check if it's a cancellation
      const isCancellation = 
        (error instanceof Error && 
         (error.name === 'AbortError' || 
          error.message.includes('Session cancelled') ||
          error.message.includes('aborted')));

      if (isCancellation) {
        this.logger.info("Agent execution cancelled", {
          agentId: agentTask.agentId,
          duration: Date.now() - startTime,
        });
      } else {
        this.baseStreamEmitter?.emit({
          type: "data-agent-error",
          data: {
            agentId: agentTask.agentId,
            duration: Date.now() - startTime,
            error: error instanceof Error ? error.message : String(error),
          },
        });

        this.logger.error("Agent orchestrator execution failed", {
          agentId: agentTask.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Stream failed agent result to memory for learning
      const duration = Date.now() - startTime;
      await this.streamAgentResultToMemory(
        {
          agentId: agentTask.agentId,
          task:
            String(prompt).length > 100 ? `${String(prompt).substring(0, 97)}...` : String(prompt), // Truncate long prompts
          input,
          output: null,
          duration,
          timestamp: new Date().toISOString(),
          reasoning: agentTask.reasoning,
          toolCalls: undefined,
          toolResults: undefined,
        },
        false, // success = false
        0, // no tokens used
        error instanceof Error ? error.message : String(error),
      );

      throw error;
    }

    const duration = Date.now() - startTime;

    const agentResult: AgentResult = {
      agentId: agentTask.agentId,
      task: String(prompt), // Store the actual prompt sent to agent
      input,
      output: result.output,
      duration,
      timestamp: new Date().toISOString(),
      toolCalls: (result as { toolCalls?: ToolCall[] }).toolCalls,
      toolResults: (result as { toolResults?: ToolResult[] }).toolResults,
    };

    this.logger.info("Agent execution completed", {
      agentId: agentTask.agentId,
      duration,
      success: true,
      hasToolCalls: !!agentResult.toolCalls?.length,
    });

    // Capture working memory from agent interactions using MECMF
    if (this.mecmfManager) {
      try {
        const conversationContext = createConversationContext(
          this.sessionId,
          this.workspaceId || "global",
          { currentTask: agentTask.task, activeAgents: [agentTask.agentId] },
        );

        // Store agent prompt as working memory
        const promptMemoryId = await this.mecmfManager.classifyAndStore(
          `Agent ${agentTask.agentId} prompt: ${String(prompt)}`,
          conversationContext,
          MemorySource.SYSTEM_GENERATED, // Prompts are system-generated
          { agentId: agentTask.agentId, sessionId: this.sessionId, workspaceId: this.workspaceId },
        );

        // Store agent response as working memory
        const responseMemoryId = await this.mecmfManager.classifyAndStore(
          `Agent ${agentTask.agentId} response: ${JSON.stringify(result.output)}`,
          conversationContext,
          MemorySource.AGENT_OUTPUT, // Agent outputs
          { agentId: agentTask.agentId, sessionId: this.sessionId, workspaceId: this.workspaceId },
        );

        // Store episodic memory for the agent execution outcome
        const episodicContent =
          `Agent ${agentTask.agentId} completed task "${agentTask.task}" in ${duration}ms. ` +
          `Input type: ${typeof input}. Output type: ${typeof result.output}. ` +
          `${
            result.toolCalls?.length ? `Used ${result.toolCalls.length} tools.` : "No tools used."
          }`;

        const episodicMemoryId = await this.mecmfManager.classifyAndStore(
          episodicContent,
          conversationContext,
          MemorySource.SYSTEM_GENERATED, // Episodic summaries are system-generated
          { agentId: agentTask.agentId, sessionId: this.sessionId, workspaceId: this.workspaceId },
        );

        // Extract and store semantic facts from agent output
        if (result.output) {
          const outputText =
            typeof result.output === "string" ? result.output : JSON.stringify(result.output);

          // Extract entities using the memory classifier
          const classifier = this.mecmfManager as unknown as {
            memoryClassifier?: {
              extractKeyEntities(
                text: string,
              ): Array<{ type: string; name: string; confidence: number }>;
            };
          }; // Access internal classifier
          if (classifier.memoryClassifier) {
            const entities = classifier.memoryClassifier.extractKeyEntities(outputText);

            // Store each extracted entity as semantic memory
            for (const entity of entities) {
              const semanticContent = `Entity ${entity.type}: ${entity.name} (confidence: ${entity.confidence})`;
              await this.mecmfManager.classifyAndStore(
                semanticContent,
                conversationContext,
                MemorySource.AGENT_OUTPUT, // Entities extracted from agent output - WILL BE PII FILTERED
                {
                  agentId: agentTask.agentId,
                  sessionId: this.sessionId,
                  workspaceId: this.workspaceId,
                },
              );
            }

            if (entities.length > 0) {
              this.logger.debug("Extracted entities from agent output", {
                agentId: agentTask.agentId,
                entityCount: entities.length,
                entityTypes: [...new Set(entities.map((e) => e.type))],
              });
            }
          }
        }

        this.logger.debug("Agent interaction captured in MECMF memory", {
          agentId: agentTask.agentId,
          promptMemoryId,
          responseMemoryId,
          episodicMemoryId,
          sessionId: this.sessionId,
        });
      } catch (error) {
        this.logger.warn("Failed to capture agent interaction in MECMF memory", {
          error: error instanceof Error ? error.message : String(error),
          agentId: agentTask.agentId,
        });
      }
    }

    // Stream tool calls and results to working memory if present
    if (result.toolCalls?.length) {
      for (const { toolName, input } of result.toolCalls) {
        await this.streamToolCallToMemory(agentTask.agentId, toolName, input);
      }
    }

    if (result.toolResults?.length) {
      for (const { toolName, output: toolOutput } of result.toolResults as Array<{
        toolName: string;
        output?: unknown;
      }>) {
        await this.streamToolResultToMemory(agentTask.agentId, toolName, toolOutput);
      }
    }

    // Stream agent result to workspace memory system for automatic processing
    await this.streamAgentResultToMemory(agentResult, true);

    // Clean up the abort controller for this agent
    this.activeAgentExecutions.delete(agentTask.agentId);

    return agentResult;
  }

  private evaluateProgress(results: AgentResult[], _plan: ExecutionPlan): boolean {
    const supervisionConfig = getSupervisionConfig(this.supervisionLevel);

    if (!supervisionConfig.postExecutionValidation) {
      return true;
    }

    const hasResults = results.length > 0;
    const hasFailures = results.some((r) => !r.output);

    // Use paranoid mode to stop on any failure, otherwise continue
    // Hallucination-based stopping is handled per-agent in validateAgentResult

    if (hasFailures && this.supervisionLevel === SupervisionLevel.PARANOID) {
      return false; // Stop on any failure in paranoid mode
    }

    return hasResults;
  }

  /**
   * Validate a single agent result immediately after execution
   * This prevents dangerous actions from proceeding if hallucination is detected
   */
  private async validateAgentResult(
    result: AgentResult,
    _allResults: AgentResult[],
  ): Promise<boolean> {
    // For now, only validate if we have at least one result to analyze
    if (!result.output) {
      return true; // Continue if agent had no output
    }

    // Skip hallucination detection for conversation agents
    // They use natural language without source attribution, causing false positives
    if (result.agentId === "conversation" || result.agentId === "conversation-agent") {
      this.logger.debug("Skipping hallucination validation for conversation agent", {
        agentId: result.agentId,
        reason: "Conversation agents use natural language without source attribution",
      });
      return true;
    }

    // Run hallucination detection on just this single agent result
    const singleAgentResults: AgentResult[] = [
      {
        agentId: result.agentId,
        task: result.task,
        input: result.input,
        output: result.output,
        duration: result.duration,
        timestamp: result.timestamp,
        toolCalls: result.toolCalls,
        toolResults: result.toolResults,
      },
    ];

    try {
      const analysis: HallucinationAnalysis =
        await this.hallucinationDetector.analyzeResults(singleAgentResults);
      const effectiveAnalysis: HallucinationAnalysis = analysis;
      const confidenceThreshold = this.hallucinationDetector.getThreshold();

      this.logger.info("Single agent confidence validation", {
        agentId: result.agentId,
        confidence: analysis.averageConfidence,
        threshold: confidenceThreshold,
        issues: analysis.issues,
        issuesCount: analysis.issues.length,
      });

      // Check for immediate severe hallucinations
      const isSevere =
        analysis.averageConfidence < 0.3 ||
        HallucinationPatternDetector.containsSeverePatterns(analysis.issues);

      if (isSevere) {
        const severeIssues = HallucinationPatternDetector.getSevereIssues(analysis.issues);
        const retryCount = this.retryAttempts.get(result.agentId) ?? 0;
        // Record issues for feedback-driven retry
        this.lastValidationMetaByAgent.set(result.agentId, {
          confidence: analysis.averageConfidence,
          issues: severeIssues.length > 0 ? severeIssues : analysis.issues,
        });
        this.logger.error("SEVERE HALLUCINATION DETECTED", {
          agentId: result.agentId,
          confidence: analysis.averageConfidence,
          threshold: confidenceThreshold,
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

      // Run Jeopardy validation (observation-only): log and stream, do not affect control flow
      let jeopardyResult: JeopardyValidationResult | undefined;
      try {
        jeopardyResult = await this.jeopardyValidator.validate({
          originalTask: result.task,
          agentOutput: result.output,
          agentId: result.agentId,
        });

        if (jeopardyResult.issues.some((i) => i.severity === "critical")) {
          this.logger.warn("Jeopardy critical issues detected (observation-only)", {
            agentId: result.agentId,
            issues: jeopardyResult.issues,
            completeness: jeopardyResult.completeness,
            answersTask: jeopardyResult.answersTask,
          });
        }
        this.logger.info("Jeopardy validation completed (observation-only)", {
          agentId: result.agentId,
          isValid: jeopardyResult.isValid,
          answersTask: jeopardyResult.answersTask,
          completeness: jeopardyResult.completeness,
          confidence: jeopardyResult.confidence,
        });
      } catch (error) {
        this.logger.warn("Jeopardy validation failed (observation-only)", {
          agentId: result.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Confidence is hallucination-only; Jeopardy does not affect control flow
      const combinedConfidence = effectiveAnalysis.averageConfidence;

      // Cache validation results for later aggregation
      this.validationMap.set(result.agentId, {
        confidence: combinedConfidence,
        issues: effectiveAnalysis.issues,
        jeopardyValidation: jeopardyResult,
      });

      // For non-severe cases, still log but continue
      if (combinedConfidence < confidenceThreshold) {
        this.logger.warn("Low combined confidence detected but not severe - continuing", {
          agentId: result.agentId,
          combinedConfidence,
          hallucinationConfidence: effectiveAnalysis.averageConfidence,
          threshold: confidenceThreshold,
          issues: effectiveAnalysis.issues,
        });
      }

      // Success path → clear any previous retry state for this agent
      this.retryAttempts.delete(result.agentId);
      this.lastValidationMetaByAgent.delete(result.agentId);
      return true; // Continue execution
    } catch (error) {
      this.logger.error("Failed to validate agent result", {
        agentId: result.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      // On validation error, continue execution but log the issue
      return true;
    }
  }

  /**
   * Analyze result confidence using hallucination detection service
   * Made public for testing hallucination detection capabilities
   */
  public async analyzeResultConfidence(results: AgentResult[]): Promise<ConfidenceAnalysis> {
    // Single-pass: analyze once using the detector on provided results
    const analysis: HallucinationAnalysis =
      await this.hallucinationDetector.analyzeResults(results);

    // Cache per-agent confidence from detection methods
    for (const d of analysis.detectionMethods) {
      this.validationMap.set(d.agentId, { confidence: d.confidence, issues: d.issues });
    }

    return {
      averageConfidence: analysis.averageConfidence,
      lowConfidenceAgents: analysis.lowConfidenceAgents,
      suspiciousPatterns: analysis.suspiciousPatterns,
      issues: analysis.issues,
    };
  }

  private generateSessionSummary(
    results: AgentResult[],
    plan: ExecutionPlan,
    duration: number,
    confidenceResults?: ConfidenceAnalysis,
  ): SessionSummary {
    const hasAllResults = results.every((r) => r.output);
    let status: "completed" | "failed" | "partial";
    let failureReason: string | undefined;

    // Check for hallucination first, regardless of output presence
    const confidenceThreshold =
      this.supervisionLevel === SupervisionLevel.MINIMAL
        ? 0.2
        : this.supervisionLevel === SupervisionLevel.PARANOID
          ? 0.7
          : 0.5;

    if (this.hallucinationTermination) {
      status = ReasoningResultStatus.FAILED;
      const issuesSummary = this.hallucinationTermination.issues.slice(0, 3).join("; ");
      failureReason = `Severe hallucination detected in agent ${this.hallucinationTermination.agentId}: ${issuesSummary}`;
    } else if (confidenceResults && confidenceResults.averageConfidence < confidenceThreshold) {
      // Determine severity based on confidence level and issue types
      const isSevere =
        confidenceResults.averageConfidence < 0.3 ||
        HallucinationPatternDetector.containsSeverePatterns(confidenceResults.issues);

      status = isSevere ? ReasoningResultStatus.FAILED : ReasoningResultStatus.PARTIAL;

      // Build detailed failure reason with specific issues
      const issuesSummary =
        confidenceResults.issues.length > 0
          ? ` Issues: ${confidenceResults.issues.slice(0, 3).join("; ")}${
              confidenceResults.issues.length > 3 ? "..." : ""
            }`
          : "";

      failureReason = `Hallucination detected: confidence ${confidenceResults.averageConfidence.toFixed(
        2,
      )} below threshold ${confidenceThreshold}.${issuesSummary}`;
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
      status,
      totalPhases: plan.phases.length,
      totalAgents: results.length,
      completedPhases: results.length > 0 ? plan.phases.length : 0,
      executedAgents: results.length,
      duration,
      reasoning,
      results,
      failureReason,
      confidence: confidenceResults?.averageConfidence ?? this.computeAggregateConfidence(),
      validation: (() => {
        const map: Record<
          string,
          { confidence: number; jeopardyValidation?: JeopardyValidationResult }
        > = {};
        for (const [agentId, v] of this.validationMap.entries()) {
          map[agentId] = { confidence: v.confidence, jeopardyValidation: v.jeopardyValidation };
        }
        return Object.keys(map).length > 0 ? map : undefined;
      })(),
    };
  }

  private computeAggregateConfidence(): number | undefined {
    if (this.validationMap.size === 0) return undefined;
    let sum = 0;
    for (const v of this.validationMap.values()) sum += v.confidence;
    return sum / this.validationMap.size;
  }

  private async handleMemoryOperations(summary: SessionSummary): Promise<void> {
    const jobSpec = this.sessionContext?.jobSpec;
    const memoryConfig = jobSpec?.config?.memory;
    const memoryEnabled = memoryConfig?.enabled !== false;

    if (!memoryEnabled) {
      this.logger.info("Memory operations disabled");
      return;
    }

    // Run memory operations in parallel for better performance
    const memoryPromises: Promise<void>[] = [];

    if (memoryConfig?.fact_extraction !== false) {
      memoryPromises.push(
        this.extractAndStoreSemanticFacts(summary)
          .then(() => {
            this.logger.info("Semantic facts extracted and stored");
          })
          .catch((error) => {
            this.logger.warn("Failed to extract semantic facts", {
              error: error instanceof Error ? error.message : String(error),
            });
          }),
      );
    }

    if (memoryConfig?.summary !== false) {
      memoryPromises.push(
        this.generateWorkingMemorySummary(summary)
          .then(() => {
            this.logger.info("Working memory summary generated");
          })
          .catch((error) => {
            this.logger.warn("Failed to generate working memory summary", {
              error: error instanceof Error ? error.message : String(error),
            });
          }),
      );
    }

    // Wait for all memory operations to complete
    if (memoryPromises.length > 0) {
      await Promise.allSettled(memoryPromises);
      this.logger.info("Memory operations completed", {
        sessionId: this.sessionId,
        operationsRun: memoryPromises.length,
      });
    }
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
      default:
        return SupervisionLevel.STANDARD;
    }
  }

  // Jeopardy validation removed

  private buildExecutionPlanningPrompt(context: SessionContext): string {
    return `You are an execution planning supervisor for Atlas workspace sessions.

Your role is to analyze the incoming signal and create an execution plan using available agents.

Signal Information:
- Signal ID: ${context.signal.id}
  - Signal Provider: ${context.signal.provider?.name || "unknown"}
- Payload: ${JSON.stringify(context.payload)}

Available Agents:
${context.availableAgents.join(", ")}

${context.additionalPrompts?.planning || ""}

IMPORTANT: You MUST use the plan_agent_execution tool for each agent you want to include in the execution plan. Do not just describe the plan in text - use the tool calls to create the structured plan.

Create a comprehensive execution plan that:
1. Identifies which agents need to be called
2. Determines the order of execution (sequential or parallel)
3. Specifies what task each agent should perform
4. Considers dependencies between agents

For each agent, call the plan_agent_execution tool with:
- agentId: the agent identifier
- task: specific task description
- inputSource: "signal", "previous", or "combined"
- dependencies: array of agent IDs this depends on
- phase: meaningful phase name
- executionStrategy: "sequential" or "parallel"

Think step by step about the best approach to handle this signal, then use the tools to create the structured plan.`;
  }

  private createPlanningTools(): AtlasTools {
    return {
      plan_agent_execution: {
        description: "Plan the execution of an agent with a specific task",
        inputSchema: z.object({
          agentId: z.string().describe("The ID of the agent to execute"),
          task: z.string().describe("The task for the agent to perform"),
          inputSource: z.enum(["signal", "previous", "combined"]).describe("Source of input data"),
          dependencies: z
            .array(z.string())
            .optional()
            .describe("Agent IDs this execution depends on"),
          phase: z.string().describe("Execution phase name"),
          executionStrategy: z
            .enum(["sequential", "parallel"])
            .describe("How to execute agents in this phase"),
        }),
        execute: (params) => {
          // This tool is for planning only, not actual execution
          return { planned: true, ...params };
        },
      },
    };
  }

  private parsePlanFromResponse(
    text: string,
    reasoning: string | undefined,
    toolCalls?: ToolCall[],
    toolResults?: ToolResult[],
  ): ExecutionPlan {
    type PlanningToolInput = {
      phase?: string;
      executionStrategy?: "sequential" | "parallel";
      agentId?: string;
      task?: string;
      inputSource?: string;
      dependencies?: string[];
    };

    // Log the AI response for debugging
    this.logger.debug("AI Planning Response", {
      text: text?.substring(0, 500),
      reasoning: reasoning?.substring(0, 500),
      toolCallCount: toolCalls?.length || 0,
      toolResultCount: toolResults?.length || 0,
    });

    const planId = crypto.randomUUID();

    // Parse tool calls to extract planned agent executions
    if (toolCalls && toolCalls.length > 0) {
      this.logger.info("Processing AI tool calls for execution planning", {
        toolCallCount: toolCalls.length,
      });

      // Group tool calls by phase
      const phaseMap = new Map<string, Array<AgentPlanInput>>();

      for (const toolCall of toolCalls) {
        if (toolCall.toolName === "plan_agent_execution") {
          const input = toolCall.input as PlanningToolInput | undefined;
          const phase = input?.phase || "Default Phase";
          if (!phaseMap.has(phase)) {
            phaseMap.set(phase, []);
          }

          if (!input) {
            continue;
          }

          const agentId =
            typeof input.agentId === "string" && input.agentId.trim().length > 0
              ? input.agentId
              : "";
          const task =
            typeof input.task === "string" && input.task.trim().length > 0 ? input.task : "";
          if (!agentId || !task) {
            // Skip malformed planning entries
            continue;
          }

          const inputSource: "signal" | "previous" | "combined" =
            input.inputSource === "previous" || input.inputSource === "combined"
              ? input.inputSource
              : "signal";

          const executionStrategy: "sequential" | "parallel" =
            input.executionStrategy === "parallel" ? "parallel" : "sequential";

          const dependencies = Array.isArray(input.dependencies) ? input.dependencies : undefined;

          const normalized: AgentPlanInput = {
            agentId,
            task,
            inputSource,
            dependencies,
            phase,
            executionStrategy,
          };

          phaseMap.get(phase)!.push(normalized);
        }
      }

      // Convert phases to ExecutionPhase format`\
      const phases: ExecutionPhase[] = Array.from(phaseMap.entries()).map(
        ([phaseName, agentPlans]) => ({
          id: crypto.randomUUID(),
          name: phaseName,
          executionStrategy:
            (agentPlans as PlanningToolInput[])[0]?.executionStrategy || "sequential",
          agents: (agentPlans as PlanningToolInput[]).map((plan) => ({
            agentId: plan.agentId || "",
            task: plan.task || "",
            inputSource: plan.inputSource || "signal",
            dependencies: plan.dependencies,
            reasoning: `AI planned: ${plan.task || ""}`,
          })),
        }),
      );

      if (phases.length > 0) {
        this.logger.info("Successfully parsed AI-planned execution", {
          phases: phases.length,
          totalAgents: phases.reduce((sum, phase) => sum + phase.agents.length, 0),
        });

        return {
          id: planId,
          phases,
          reasoning: reasoning || "AI-generated execution plan with tool calls",
          strategy: "ai-planned",
          confidence: 0.9, // Higher confidence when AI used tools
          reasoningSteps: [],
        };
      }
    }

    // Fallback: parse the text response for planning
    this.logger.warn("No tool calls found - parsing text response for planning", {
      hasText: !!text,
      hasReasoning: !!reasoning,
      availableAgents: this.sessionContext?.availableAgents.length || 0,
    });

    // Try to parse agent order from the AI's text response
    const intelligentOrder = this.parseAgentOrderFromText(text);

    if (intelligentOrder && intelligentOrder.length > 0) {
      this.logger.info("Extracted intelligent agent ordering from text", {
        originalOrder: this.sessionContext?.availableAgents.join(" → "),
        intelligentOrder: intelligentOrder.join(" → "),
      });

      const phases: ExecutionPhase[] = [
        {
          id: crypto.randomUUID(),
          name: "AI-Parsed Execution",
          executionStrategy: "sequential",
          agents: intelligentOrder.map((agentId) => ({
            agentId,
            task: `Execute ${agentId} based on AI analysis`,
            inputSource: "signal" as const,
            reasoning: "Extracted from AI text response",
          })),
        },
      ];

      return {
        id: planId,
        phases,
        reasoning: text || reasoning || "AI-generated execution plan from text parsing",
        strategy: "ai-planned",
        confidence: 0.7, // Lower confidence when parsing text vs using tools
        reasoningSteps: [],
      };
    }

    // Last resort: use input order
    this.logger.warn("Could not parse intelligent order - using input order as fallback");

    const phases: ExecutionPhase[] = [
      {
        id: crypto.randomUUID(),
        name: "AI-Generated Execution",
        executionStrategy: "sequential",
        agents:
          this.sessionContext?.availableAgents.map((agentId) => ({
            agentId,
            task: "Process signal based on AI planning",
            inputSource: "signal" as const,
            reasoning: "Generated from AI planning",
          })) || [],
      },
    ];

    return {
      id: planId,
      phases,
      reasoning: reasoning || "AI-generated execution plan",
      strategy: "ai-planned",
      confidence: 0.5, // Low confidence when using input order
      reasoningSteps: [],
    };
  }

  private parseAgentOrderFromText(text: string): string[] {
    if (!text || !this.sessionContext?.availableAgents) {
      return [];
    }

    // Look for patterns like "1. **Phase: Data Extraction** - Agent: data-extractor"
    const phasePattern = /(?:Phase:|Agent:)\s*([a-zA-Z-]+)/gi;
    const matches = Array.from(text.matchAll(phasePattern));

    const extractedAgents = matches
      .map((match) => match[1])
      .filter(
        (agent): agent is string => !!agent && this.sessionContext!.availableAgents.includes(agent),
      );

    if (extractedAgents.length > 0) {
      this.logger.debug("Parsed agents from text phases", {
        extracted: extractedAgents,
        textSnippet: text.substring(0, 300),
      });
      return extractedAgents as string[];
    }

    // Alternative: Look for agent names mentioned in order
    const availableAgents = this.sessionContext.availableAgents;
    const agentPositions = availableAgents
      .map((agent) => ({ agent, position: text.toLowerCase().indexOf(agent.toLowerCase()) }))
      .filter((item) => item.position !== -1);

    // Sort by position in text to get the order the AI mentioned them
    agentPositions.sort((a, b) => a.position - b.position);

    const orderedAgents = agentPositions.map((item) => item.agent);

    if (orderedAgents.length > 0) {
      this.logger.debug("Parsed agents from text mentions", {
        ordered: orderedAgents,
        positions: agentPositions,
      });
      return orderedAgents;
    }

    return [];
  }

  private getCachedJobSpec(): ExecutionPlan | null {
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

  private async extractAndStoreSemanticFacts(summary: SessionSummary): Promise<void> {
    try {
      this.logger.info("Starting semantic fact extraction", {
        sessionId: this.sessionId,
        totalAgents: summary.totalAgents,
      });

      // Initialize MECMF manager if not already (should be set in initializeSession)
      if (!this.mecmfManager && this.workspaceId) {
        try {
          const scope = {
            id: this.workspaceId,
            type: "workspace" as const,
            name: `Workspace ${this.workspaceId}`,
          };
          this.mecmfManager = await setupMECMF(scope, {
            workspaceId: this.workspaceId,
            enableVectorSearch: true,
          });
        } catch (e) {
          this.logger.warn("MECMF manager unavailable for fact storage", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Build batches: session summary, payload, and per-agent IO
      const batches: Array<{ text: string; sourceType: FactSourceType; sourceAgentId?: string }> =
        [];

      // Session summary batch
      const summaryBlock = [
        `Status: ${summary.status}`,
        `Reasoning: ${summary.reasoning || ""}`,
        `FailureReason: ${summary.failureReason || ""}`,
        `Agents: ${summary.totalAgents}, Phases: ${summary.totalPhases}`,
      ].join("\n");
      batches.push({ text: summaryBlock, sourceType: "session_summary" });

      // Payload batch (stringify safely)
      try {
        const payloadText = this.sessionContext
          ? JSON.stringify(this.sessionContext.payload ?? {}, null, 2)
          : "{}";
        if (payloadText && payloadText !== "{}") {
          batches.push({ text: payloadText, sourceType: "payload" });
        }
      } catch {
        // ignore payload stringify issues
      }

      // Agent inputs/outputs
      for (const r of summary.results) {
        // Input batch
        if (r.input !== undefined && r.input !== null) {
          const inputText =
            typeof r.input === "string" ? r.input : JSON.stringify(r.input, null, 2);
          batches.push({ text: inputText, sourceType: "agent_input", sourceAgentId: r.agentId });
        }
        // Output batch
        if (r.output !== undefined && r.output !== null) {
          const outputText =
            typeof r.output === "string" ? r.output : JSON.stringify(r.output, null, 2);
          batches.push({ text: outputText, sourceType: "agent_output", sourceAgentId: r.agentId });
        }
      }

      // Create extractor with small model similar to JeopardyValidator
      const extractor = new SemanticFactExtractor({
        logger: this.logger.child({ component: "semantic-fact-extractor" }),
        enabled: true,
        model: "claude-3-5-haiku-latest",
        confidenceThreshold: 0.6,
        llmProvider: (model: string) => this.llmProvider(model),
        temperature: 0.1,
        maxOutputTokens: 1200,
        timeoutMs: 20000,
      });

      // Process batches in sequence to limit cost; could be parallelized if needed
      const allFacts: Array<SemanticFact> = [];
      for (const batch of batches) {
        const result = await extractor.extractFromBatch(batch);
        if (result.facts.length > 0) {
          allFacts.push(...result.facts);
        }
      }

      // Deduplicate across batches (extractor already dedups per batch)
      const seen = new Set<string>();
      const uniqueFacts = allFacts.filter((f) => {
        const key = [
          f.subject.trim().toLowerCase(),
          f.predicate.trim().toLowerCase(),
          f.object.trim().toLowerCase(),
        ].join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Store facts using MECMF
      const conversationContext = createConversationContext(
        this.sessionId,
        this.workspaceId || "global",
        {
          currentTask: "semantic_fact_extraction",
          activeAgents: summary.results.map((r) => r.agentId),
        },
      );

      let stored = 0;
      for (const fact of uniqueFacts) {
        try {
          if (this.mecmfManager) {
            await this.mecmfManager.classifyAndStore(
              JSON.stringify(fact),
              conversationContext,
              MemorySource.SYSTEM_GENERATED,
              {
                sessionId: this.sessionId,
                workspaceId: this.workspaceId,
                agentId: fact.sourceAgentId,
              },
            );
            stored++;
          } else {
            // Fallback lightweight CoALA storage for current session scope
            const workspaceId = this.workspaceId || "default";
            const memoryPath = getWorkspaceMemoryDir(workspaceId);
            const memoryAdapter = new CoALALocalFileStorageAdapter(memoryPath);
            const scope = { id: this.sessionId, workspaceId, type: "session" as const };
            const tempManager = new CoALAMemoryManager(scope, memoryAdapter, false, {
              commitDebounceDelay: 0,
            });
            await tempManager.rememberWithMetadata(
              `semantic-fact-${crypto.randomUUID()}`,
              JSON.stringify(fact),
              {
                memoryType: CoALAMemoryType.SEMANTIC,
                tags: [
                  fact.predicate,
                  fact.sourceType,
                  fact.subject.split(" ")[0],
                  fact.object.split(" ")[0],
                ].filter((t): t is string => Boolean(t)),
                relevanceScore: Math.min(0.9, Math.max(0.6, fact.confidence)),
                confidence: fact.confidence,
                associations: [this.sessionId, ...(fact.sourceAgentId ? [fact.sourceAgentId] : [])],
                source: MemorySource.SYSTEM_GENERATED,
                sourceMetadata: {
                  sessionId: this.sessionId,
                  workspaceId: this.workspaceId,
                  agentId: fact.sourceAgentId,
                },
              },
            );
            await tempManager.dispose();
            stored++;
          }
        } catch (storeError) {
          this.logger.warn("Failed to store semantic fact", {
            error: storeError instanceof Error ? storeError.message : String(storeError),
          });
        }
      }

      this.logger.info("Semantic fact extraction completed", {
        sessionId: this.sessionId,
        batches: batches.length,
        extracted: allFacts.length,
        stored,
      });
    } catch (error) {
      this.logger.error("Semantic fact extraction failed", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async generateWorkingMemorySummary(summary: SessionSummary): Promise<void> {
    try {
      this.logger.info("Generating working memory summary", {
        sessionId: this.sessionId,
        totalAgents: summary.totalAgents,
      });

      // Initialize memory manager for the workspace
      const workspaceId = this.workspaceId || "default";
      const memoryPath = getWorkspaceMemoryDir(workspaceId);
      const memoryAdapter = new CoALALocalFileStorageAdapter(memoryPath);

      const scope = { id: this.sessionId, workspaceId: workspaceId, type: "session" as const };

      const memoryManager = new CoALAMemoryManager(
        scope,
        memoryAdapter,
        false, // Don't start cognitive loop for this temporary instance
        { commitDebounceDelay: 0 }, // Immediate commits
      );

      // Create working memory summary from session results
      const summaryContent = this.buildWorkingMemorySummary(summary);

      memoryManager.rememberWithMetadata(
        `session-summary-${this.sessionId}`,
        JSON.stringify(summaryContent),
        {
          memoryType: CoALAMemoryType.WORKING,
          tags: ["session-summary", "completion", summary.status],
          relevanceScore: summary.status === "completed" ? 0.9 : 0.6,
          confidence: 0.95,
          associations: summary.results.map((r) => `agent-${r.agentId}`),
          source: MemorySource.SYSTEM_GENERATED,
          sourceMetadata: { sessionId: this.sessionId, workspaceId: this.workspaceId },
        },
      );

      // Store individual agent results as working memories
      for (const result of summary.results) {
        memoryManager.rememberWithMetadata(
          `agent-result-${result.agentId}-${this.sessionId}`,
          {
            agentId: result.agentId,
            task: result.task,
            output: JSON.stringify(result.output),
            duration: result.duration.toString(),
            reasoning: result.reasoning || "",
            toolCalls: (result.toolCalls?.length || 0).toString(),
            success: true.toString(), // Assume success if in results
          },
          {
            memoryType: CoALAMemoryType.WORKING,
            tags: ["agent-result", result.agentId, "execution"],
            relevanceScore: 0.8,
            confidence: 0.9,
            associations: [`session-summary-${this.sessionId}`],
            source: MemorySource.AGENT_OUTPUT,
            sourceMetadata: {
              agentId: result.agentId,
              sessionId: this.sessionId,
              workspaceId: this.workspaceId,
            },
          },
        );
      }

      await memoryManager.dispose(); // Ensure final commit

      this.logger.info("Working memory summary generated successfully", {
        sessionId: this.sessionId,
        agentResults: summary.results.length,
        summaryGenerated: true,
      });
    } catch (error) {
      this.logger.error("Failed to generate working memory summary", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // Don't rethrow - memory summary failure shouldn't break the session
    }
  }

  /**
   * Build a concise working memory summary from the session summary.
   * Avoids heavy nesting and keeps relevant fields for later retrieval.
   */
  private buildWorkingMemorySummary(summary: SessionSummary): Record<string, unknown> {
    return {
      sessionId: summary.sessionId,
      status: summary.status,
      totalPhases: summary.totalPhases,
      totalAgents: summary.totalAgents,
      completedPhases: summary.completedPhases,
      executedAgents: summary.executedAgents,
      durationMs: summary.duration,
      reasoning: summary.reasoning,
      // Store only essential per-agent data to keep memory light
      agentResults: summary.results.map((r) => ({
        agentId: r.agentId,
        task: r.task,
        hasOutput: r.output !== undefined && r.output !== null,
        durationMs: r.duration,
        timestamp: r.timestamp,
        toolCalls: r.toolCalls?.length || 0,
      })),
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

    // Future extensibility: Add more facts here as needed
    // Example additions could include:
    // - User timezone
    // - User locale
    // - Environment (development/staging/production)
    // - API endpoints
    // - Available resources
    // - System capabilities

    // Format the facts section
    return "## Context Facts\n" + facts.map((fact) => `- ${fact}`).join("\n");
  }

  // Sanitizer now imported from @atlas/core

  /**
   * Stream agent result to workspace memory system for automatic procedural pattern learning
   */
  private async streamAgentResultToMemory(
    agentResult: AgentResult,
    success: boolean,
    tokensUsed?: number,
    errorMessage?: string,
  ): Promise<void> {
    // Only stream if workspace supervisor with memory is available
    if (
      !this.workspaceSupervisor ||
      typeof this.workspaceSupervisor.streamAgentResult !== "function"
    ) {
      this.logger.debug("Workspace supervisor not available for memory streaming", {
        sessionId: this.sessionId,
        agentId: agentResult.agentId,
      });
      return;
    }

    try {
      await this.workspaceSupervisor.streamAgentResult(
        this.sessionId,
        agentResult.agentId,
        agentResult.input,
        agentResult.output,
        agentResult.duration,
        success,
        { tokensUsed, error: errorMessage },
      );

      this.logger.debug("Agent result streamed to workspace memory", {
        sessionId: this.sessionId,
        agentId: agentResult.agentId,
        success,
        duration: agentResult.duration,
        tokensUsed,
      });
    } catch (error) {
      this.logger.warn("Failed to stream agent result to workspace memory", {
        sessionId: this.sessionId,
        agentId: agentResult.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't rethrow - memory streaming failure shouldn't break agent execution
    }
  }

  /**
   * Perform session lifecycle memory management
   * - Consolidate important working memories to long-term storage
   * - Clear working memory for the session
   */
  private async performSessionMemoryLifecycle(summary: SessionSummary): Promise<void> {
    try {
      this.logger.info("Starting session memory lifecycle management", {
        sessionId: this.sessionId,
        status: summary.status,
      });

      // Only perform lifecycle if workspace supervisor has memory coordinator
      if (!this.workspaceSupervisor || !this.workspaceSupervisor.memoryCoordinator) {
        this.logger.debug("Memory coordinator not available for lifecycle management");
        return;
      }

      // Get the memory coordinator
      const memoryCoordinator = this.workspaceSupervisor.memoryCoordinator;

      // 1. Consolidate important working memories before clearing
      try {
        await memoryCoordinator.consolidateWorkingMemories(this.sessionId, {
          minAccessCount: 3, // Memories accessed 3+ times
          minRelevance: 0.8, // High relevance memories
          markImportant: summary.status === "completed", // Mark as important if session succeeded
        });

        this.logger.info("Working memory consolidation completed", { sessionId: this.sessionId });
      } catch (consolidationError) {
        this.logger.warn("Failed to consolidate working memories", {
          sessionId: this.sessionId,
          error:
            consolidationError instanceof Error
              ? consolidationError.message
              : String(consolidationError),
        });
      }

      // 2. Clear working memory for this session
      try {
        const clearedCount = await memoryCoordinator.clearWorkingMemoryBySession(this.sessionId);

        this.logger.info("Working memory cleared for session", {
          sessionId: this.sessionId,
          clearedCount,
        });
      } catch (clearError) {
        this.logger.warn("Failed to clear working memory", {
          sessionId: this.sessionId,
          error: clearError instanceof Error ? clearError.message : String(clearError),
        });
      }

      // 3. Store final session episodic memory
      try {
        await this.workspaceSupervisor.streamEpisodicEvent(
          "session_complete",
          `Session ${this.sessionId} completed with status: ${summary.status}`,
          [this.sessionId, ...summary.results.map((r) => r.agentId)],
          summary.status === "completed"
            ? "success"
            : summary.status === "failed"
              ? "failure"
              : "partial",
          summary.status === "completed" ? 0.9 : 0.7,
          {
            sessionId: this.sessionId,
            totalPhases: summary.totalPhases,
            totalAgents: summary.totalAgents,
            duration: summary.duration,
            reasoning: summary.reasoning,
          },
        );

        this.logger.info("Session completion episodic memory stored", {
          sessionId: this.sessionId,
        });
      } catch (episodicError) {
        this.logger.warn("Failed to store session completion episodic memory", {
          sessionId: this.sessionId,
          error: episodicError instanceof Error ? episodicError.message : String(episodicError),
        });
      }
    } catch (error) {
      this.logger.error("Session memory lifecycle management failed", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't rethrow - lifecycle management failure shouldn't break the session
    }
  }

  /**
   * Stream tool call to working memory
   */
  private async streamToolCallToMemory(
    agentId: string,
    toolName: string,
    args: unknown,
  ): Promise<void> {
    if (!this.workspaceSupervisor) {
      return;
    }

    try {
      await this.workspaceSupervisor.streamToolCall(this.sessionId, agentId, toolName, args);
    } catch (error) {
      this.logger.debug("Failed to stream tool call to memory", {
        sessionId: this.sessionId,
        agentId,
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Stream tool result to working memory
   */
  private async streamToolResultToMemory(
    agentId: string,
    toolName: string,
    result: unknown,
  ): Promise<void> {
    if (!this.workspaceSupervisor) {
      return;
    }

    try {
      await this.workspaceSupervisor.streamToolResult(this.sessionId, agentId, toolName, result);
    } catch (error) {
      this.logger.debug("Failed to stream tool result to memory", {
        sessionId: this.sessionId,
        agentId,
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    this.status = SessionSupervisorStatus.EXECUTING;

    try {
      const summary = await this.executeSession();
      const duration = Date.now() - startTime;

      // Set session supervisor status based on execution outcome
      if (summary.status === ReasoningResultStatus.COMPLETED) {
        this.status = SessionSupervisorStatus.COMPLETED;
      } else if (summary.status === ReasoningResultStatus.FAILED) {
        this.status = SessionSupervisorStatus.FAILED;
      } else {
        this.status = SessionSupervisorStatus.COMPLETED; // Partial completion still counts as completed supervisor
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
      this.status = SessionSupervisorStatus.FAILED;
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
    this.status = SessionSupervisorStatus.CANCELLED;

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
   * Get hallucination detection status
   */
  public getHallucinationReport(): { message: string } {
    return { message: "Hallucination detection active with LLM validation" };
  }

  /**
   * Get all artifacts created during session execution
   */
  getArtifacts(): IWorkspaceArtifact[] {
    return [...this.artifacts];
  }

  /**
   * Handles approval requests from agents.
   *
   * @disclaimer TEMPORARY IMPLEMENTATION - This currently auto-approves all requests.
   * Full approval handling with policies, UI integration, and human-in-the-loop
   * has been designed but not yet implemented. See tasks/supervisor-approval-handling.md
   * for the complete design.
   *
   * TODO: Implement full approval handling as specified in the design document.
   */
  private async handleApprovalRequest(
    error: AwaitingSupervisorDecision,
    agentTask: AgentTask,
    startTime: number,
  ): Promise<AgentResult> {
    const { request, approvalId, agentId } = error;

    // Log the approval request for audit trail
    this.logger.warn("Auto-approving agent request (temporary implementation)", {
      approvalId,
      agentId,
      request: request,
      sessionId: this.sessionId,
      disclaimer: "This is a temporary auto-approval. Full approval handling not yet implemented.",
    });

    // Auto-approve with clear indication this is temporary
    const decision = {
      approved: true,
      reason: "Auto-approved (temporary implementation - full approval handling pending)",
    };

    // Resume agent execution with approval
    if (!this.agentOrchestrator) {
      throw new Error("Agent orchestrator not available for approval resumption");
    }

    const orchestratorResult = await this.agentOrchestrator.resumeWithApproval(
      approvalId,
      decision,
    );

    const duration = Date.now() - startTime;

    // Return formatted result
    return {
      agentId,
      task: agentTask.task,
      input: request,
      output: orchestratorResult.output,
      duration,
      timestamp: new Date().toISOString(),
    };
  }
}
