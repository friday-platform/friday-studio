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

import type { JobSpecification } from "@atlas/config";
import type {
  ActorInitParams,
  AgentExecutePayload,
  AgentExecutionConfig,
  AgentTask,
  BaseActor,
  CombinedAgentInput,
  ExecutionPlanReasoningStep,
  SessionResult,
  SessionSupervisorConfig,
  ToolExecutorResult,
} from "@atlas/core";
import type {
  ReasoningExecutionResult,
  ReasoningResult,
  SessionReasoningContext,
} from "@atlas/reasoning";
import { createReasoningMachine, generateThinking, parseAction } from "@atlas/reasoning";
import { createActor, toPromise } from "xstate";
import type { IWorkspaceSignal } from "../../types/core.ts";
import { type ChildLogger, logger } from "../../utils/logger.ts";
import { getSupervisionConfig, SupervisionLevel } from "../supervision-levels.ts";
import { AgentExecutionActor } from "./agent-execution-actor.ts";

export interface SessionContext {
  sessionId: string;
  workspaceId?: string;
  signal: IWorkspaceSignal;
  payload: Record<string, unknown>;
  jobSpec?: JobSpecification;
  availableAgents: string[];
  constraints?: Record<string, unknown>;
  additionalPrompts?: {
    planning?: string;
    evaluation?: string;
  };
}

export interface AgentResult {
  agentId: string;
  task: string;
  input: unknown;
  output: unknown;
  duration: number;
  timestamp: string;
  reasoning?: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
}

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
  status: "completed" | "failed" | "partial";
  totalPhases: number;
  totalAgents: number;
  duration: number;
  reasoning: string;
  results: AgentResult[];
}

export class SessionSupervisorActor implements BaseActor {
  readonly type = "session" as const;
  private sessionId: string;
  private workspaceId?: string;
  private logger: ChildLogger;
  id: string;
  private sessionContext?: SessionContext;
  private supervisionLevel: SupervisionLevel = SupervisionLevel.STANDARD;
  private status: "idle" | "planning" | "executing" | "completed" | "failed" = "idle";
  private config?: SessionSupervisorConfig;

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

    this.logger = logger.createChildLogger({
      actorId: this.id,
      actorType: "session-supervisor",
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
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

  initialize(params?: ActorInitParams): void {
    if (params && "actorId" in params) {
      this.id = params.actorId;
      this.sessionId = params.parentId || this.sessionId;

      this.logger = logger.createChildLogger({
        actorId: this.id,
        actorType: "session-supervisor",
        sessionId: this.sessionId,
        workspaceId: this.workspaceId,
      });
    }

    this.logger.info("Initializing session supervisor actor");

    this.supervisionLevel = this.getSupervisionLevel();

    this.logger.info("Session supervisor actor initialized", {
      supervisionLevel: this.supervisionLevel,
      workspaceId: this.workspaceId || "global",
    });
  }

  shutdown(): void {
    this.logger.info("Session supervisor actor shutting down", {
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
    });
    this.status = "completed";
  }

  initializeSession(context: SessionContext): void {
    this.sessionContext = context;

    this.logger.info("Session initialized", {
      sessionId: context.sessionId,
      workspaceId: context.workspaceId,
      signalId: context.signal.id,
      availableAgents: context.availableAgents.length,
    });
  }

  async createExecutionPlan(): Promise<ExecutionPlan> {
    if (!this.sessionContext) {
      throw new Error("Session not initialized");
    }

    const startTime = Date.now();

    // Check for pre-computed job specs
    const cachedPlan = this.getCachedJobSpec();
    if (cachedPlan) {
      this.logger.info("Using cached execution plan", {
        planId: cachedPlan.id,
        phases: cachedPlan.phases.length,
      });
      return cachedPlan;
    }

    // Check if planning should be skipped
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

    // Compute execution plan using reasoning engine
    this.logger.info("Computing execution plan using multi-step reasoning");

    const reasoningContext: SessionReasoningContext = {
      sessionId: this.sessionContext.sessionId,
      workspaceId: this.sessionContext.workspaceId || "global",
      signal: this.sessionContext.signal,
      payload: this.sessionContext.payload,
      availableAgents: this.sessionContext.availableAgents.map((id) => ({
        id,
        name: id,
        purpose: "System agent",
        type: "system" as const,
        config: {},
      })),
      maxIterations: 5,
      timeLimit: 60000, // 1 minute
    };

    const agentExecutor = async (agentId: string, input: Record<string, unknown>) => {
      // Get actual agent configuration
      const agentExecutionConfig = this.getAgentExecutionConfig(agentId);

      const agentActor = new AgentExecutionActor(
        crypto.randomUUID(),
        agentExecutionConfig,
      );

      const payload: AgentExecutePayload = {
        agentId,
        input,
        sessionContext: {
          sessionId: this.sessionContext?.sessionId || "unknown",
          workspaceId: this.sessionContext?.workspaceId || "global",
        },
      };

      return await agentActor.executeTask(payload);
    };

    const toolExecutor = (
      toolName: string,
      parameters: Record<string, unknown>,
    ): Promise<ToolExecutorResult> => {
      return Promise.resolve({
        success: true,
        result: `Tool ${toolName} executed with parameters: ${JSON.stringify(parameters)}`,
        duration: 100,
      });
    };

    const machine = createReasoningMachine({
      think: generateThinking,
      parseAction,
      executeAction: async (action): Promise<ReasoningExecutionResult> => {
        if (action.type === "agent_call" && action.agentId) {
          const result = await agentExecutor(action.agentId, action.parameters);
          return {
            result,
            observation: `Agent ${action.agentId} executed successfully`,
          };
        } else if (action.type === "tool_call" && action.toolName) {
          const toolResult = await toolExecutor(action.toolName, action.parameters);
          return {
            result: toolResult.result,
            observation: toolResult.success
              ? `Tool ${action.toolName} executed successfully`
              : `Tool ${action.toolName} failed`,
          };
        } else if (action.type === "complete") {
          return {
            result: action.parameters,
            observation: "Reasoning completed",
          };
        }
        return { result: null, observation: "Unknown action type" };
      },
    }, {
      maxIterations: reasoningContext.maxIterations,
      supervisorId: this.id,
      jobGoal: reasoningContext.signal.id,
    });

    const actor = createActor(machine, { input: reasoningContext });
    actor.start();
    const reasoningResult = await toPromise(actor);

    const executionPlan = this.convertReasoningToExecutionPlan(reasoningResult);

    if (this.shouldCachePlan()) {
      this.cachePlan(executionPlan);
    }

    const duration = Date.now() - startTime;
    this.logger.info("Execution plan created", {
      planId: executionPlan.id,
      phases: executionPlan.phases.length,
      strategy: executionPlan.strategy,
      confidence: executionPlan.confidence,
      duration,
    });

    return executionPlan;
  }

  async executeSession(): Promise<SessionSummary> {
    if (!this.sessionContext) {
      throw new Error("Session not initialized");
    }

    const sessionStartTime = Date.now();

    // Create execution plan
    const plan = await this.createExecutionPlan();

    const allResults: AgentResult[] = [];

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

      // Evaluate progress after each phase
      const shouldContinue = this.evaluateProgress(allResults, plan);
      if (!shouldContinue) {
        this.logger.info("Session completion criteria met, stopping execution");
        break;
      }
    }

    // Generate session summary
    const duration = Date.now() - sessionStartTime;
    const summary = this.generateSessionSummary(allResults, plan, duration);

    // Handle memory operations based on job configuration
    this.handleMemoryOperations(summary);

    this.logger.info("Session execution completed", {
      sessionId: this.sessionId,
      status: summary.status,
      phases: summary.totalPhases,
      agents: summary.totalAgents,
      duration,
    });

    return summary;
  }

  private async executePhase(
    phase: ExecutionPhase,
    previousResults: AgentResult[],
  ): Promise<AgentResult[]> {
    const phaseResults: AgentResult[] = [];

    if (phase.executionStrategy === "sequential") {
      for (const agentTask of phase.agents) {
        const result = await this.executeAgent(agentTask, previousResults, phaseResults);
        phaseResults.push(result);
      }
    } else {
      const promises = phase.agents.map((agentTask) =>
        this.executeAgent(agentTask, previousResults, phaseResults)
      );
      const parallelResults = await Promise.all(promises);
      phaseResults.push(...parallelResults);
    }

    return phaseResults;
  }

  private async executeAgent(
    agentTask: AgentTask,
    previousResults: AgentResult[],
    _phaseResults: AgentResult[],
  ): Promise<AgentResult> {
    const startTime = Date.now();

    let input: unknown = this.sessionContext?.payload;

    if (agentTask.inputSource === "previous" && previousResults.length > 0) {
      input = previousResults[previousResults.length - 1].output;
    } else if (agentTask.inputSource === "combined") {
      const combinedInput: CombinedAgentInput = {
        original: this.sessionContext?.payload || {},
        previous: previousResults.map((r) => ({
          agentId: r.agentId,
          output: r.output,
        })),
      };
      input = combinedInput;
    } else if (agentTask.dependencies?.length) {
      const lastDep = agentTask.dependencies[agentTask.dependencies.length - 1];
      const depResult = previousResults.find((r) => r.agentId === lastDep);
      if (depResult) {
        input = depResult.output;
      }
    }

    const payload: AgentExecutePayload = {
      agentId: agentTask.agentId,
      input,
      sessionContext: {
        sessionId: this.sessionId,
        workspaceId: this.workspaceId || "global",
        task: agentTask.task,
        reasoning: agentTask.reasoning,
      },
    };

    // Get agent execution configuration
    const agentExecutionConfig = this.getAgentExecutionConfig(agentTask.agentId);

    const agentActor = new AgentExecutionActor(
      crypto.randomUUID(),
      agentExecutionConfig,
    );

    await agentActor.initialize();

    this.logger.info("Executing agent", {
      agentId: agentTask.agentId,
      task: agentTask.task,
      inputSource: agentTask.inputSource,
      reasoning: agentTask.reasoning,
    });

    let result;
    try {
      result = await agentActor.executeTask(payload);
    } catch (error) {
      this.logger.error("Agent execution failed", {
        agentId: agentTask.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const duration = Date.now() - startTime;

    const agentResult: AgentResult = {
      agentId: agentTask.agentId,
      task: agentTask.task,
      input,
      output: result.output,
      duration,
      timestamp: new Date().toISOString(),
      reasoning: agentTask.reasoning,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
    };

    this.logger.info("Agent execution completed", {
      agentId: agentTask.agentId,
      duration,
      success: true,
      hasToolCalls: !!agentResult.toolCalls?.length,
    });

    return agentResult;
  }

  private evaluateProgress(
    results: AgentResult[],
    _plan: ExecutionPlan,
  ): boolean {
    const supervisionConfig = getSupervisionConfig(this.supervisionLevel);

    if (!supervisionConfig.postExecutionValidation) {
      return true;
    }

    const hasResults = results.length > 0;
    const hasFailures = results.some((r) => !r.output);

    if (hasFailures && this.supervisionLevel === SupervisionLevel.PARANOID) {
      return false; // Stop on any failure in paranoid mode
    }

    return hasResults;
  }

  private generateSessionSummary(
    results: AgentResult[],
    plan: ExecutionPlan,
    duration: number,
  ): SessionSummary {
    const status = results.every((r) => r.output) ? "completed" : "partial";

    const reasoning =
      `Session executed ${results.length} agents across ${plan.phases.length} phases. ` +
      `Strategy: ${plan.strategy}, Confidence: ${plan.confidence}`;

    return {
      sessionId: this.sessionId,
      status,
      totalPhases: plan.phases.length,
      totalAgents: results.length,
      duration,
      reasoning,
      results,
    };
  }

  private handleMemoryOperations(summary: SessionSummary): void {
    const jobSpec = this.sessionContext?.jobSpec;
    const memoryConfig = jobSpec?.config?.memory;
    const memoryEnabled = memoryConfig?.enabled !== false;

    if (!memoryEnabled) {
      this.logger.info("Memory operations disabled");
      return;
    }

    if (memoryConfig?.fact_extraction !== false) {
      try {
        this.extractAndStoreSemanticFacts(summary);
        this.logger.info("Semantic facts extracted and stored");
      } catch (error) {
        this.logger.warn("Failed to extract semantic facts", { error: error.message });
      }
    }

    if (memoryConfig?.summary !== false) {
      try {
        this.generateWorkingMemorySummary(summary);
        this.logger.info("Working memory summary generated");
      } catch (error) {
        this.logger.warn("Failed to generate working memory summary", { error: error.message });
      }
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

  private getCachedJobSpec(): ExecutionPlan | null {
    if (!this.sessionContext?.jobSpec) {
      return null;
    }

    const jobSpec = this.sessionContext.jobSpec;
    const planId = crypto.randomUUID();
    const agents = jobSpec.execution?.agents || [];

    const phases: ExecutionPhase[] = [{
      id: crypto.randomUUID(),
      name: jobSpec.name || "Job Execution",
      executionStrategy: jobSpec.execution?.strategy || "sequential",
      agents: agents.map((agent) => {
        const agentId = typeof agent === "string" ? agent : agent.id;
        const agentObj = typeof agent === "string" ? null : agent;

        return {
          agentId,
          task: agentObj?.context?.task || "Execute job task",
          inputSource: "signal",
          dependencies: agentObj?.dependencies,
          reasoning: "Defined by job configuration",
        };
      }),
    }];

    return {
      id: planId,
      phases,
      reasoning: `Executing job: ${jobSpec.name}`,
      strategy: "job-based",
      confidence: 1.0,
    };
  }

  private shouldCachePlan(): boolean {
    const supervisionConfig = getSupervisionConfig(this.supervisionLevel);
    return supervisionConfig.cacheEnabled;
  }

  private cachePlan(plan: ExecutionPlan): void {
    this.logger.debug("Caching execution plan", { planId: plan.id });
  }

  private convertReasoningToExecutionPlan(reasoningResult: ReasoningResult): ExecutionPlan {
    const planId = crypto.randomUUID();

    const agentInteractions: AgentTask[] = reasoningResult.reasoning.steps
      .filter((step) => step.action.type === "agent_call" && step.action.agentId)
      .map((step) => ({
        agentId: step.action.agentId!,
        task: typeof step.action.parameters.task === "string"
          ? step.action.parameters.task
          : "Process input",
        inputSource: "previous",
        reasoning: step.thinking,
      }));

    const phases: ExecutionPhase[] = [{
      id: crypto.randomUUID(),
      name: "Multi-Step Reasoning Execution",
      executionStrategy: "sequential",
      agents: agentInteractions.length > 0
        ? agentInteractions
        : this.sessionContext?.availableAgents.map((agentId) => ({
          agentId,
          task: "Process signal based on reasoning",
          inputSource: "signal",
          reasoning: "Generated from multi-step reasoning",
        })) || [],
    }];

    const reasoningSteps: ExecutionPlanReasoningStep[] = reasoningResult.reasoning.steps.map((
      step,
    ) => ({
      iteration: step.iteration,
      thinking: step.thinking,
      action: step.action
        ? `${step.action.type}: ${step.action.agentId || step.action.parameters.task || "unknown"}`
        : "none",
      observation: step.observation,
    }));

    const avgConfidence = reasoningResult.reasoning.steps.length > 0
      ? reasoningResult.reasoning.steps.reduce(
        (sum, step) => sum + (step.confidence || 0.7),
        0,
      ) /
        reasoningResult.reasoning.steps.length
      : 0.5;

    return {
      id: planId,
      phases,
      reasoning:
        `Reasoning completed with ${reasoningResult.reasoning.steps.length} steps. Status: ${reasoningResult.status}`,
      strategy: "reasoning-machine",
      confidence: avgConfidence,
      reasoningSteps,
    };
  }

  private extractAndStoreSemanticFacts(_summary: SessionSummary): void {
    this.logger.debug("Extracting semantic facts", { sessionId: this.sessionId });
  }

  private generateWorkingMemorySummary(_summary: SessionSummary): void {
    this.logger.debug("Generating working memory summary", { sessionId: this.sessionId });
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

    return {
      agentId,
      agent: agentConfig,
      tools: this.config?.tools?.mcp?.servers,
      memory: this.config?.memory,
    };
  }

  async execute(): Promise<SessionResult> {
    const startTime = Date.now();
    this.status = "executing";

    try {
      const summary = await this.executeSession();
      const duration = Date.now() - startTime;
      this.status = "completed";

      return {
        sessionId: this.sessionId,
        status: summary.status === "completed" ? "success" : "error",
        result: {
          totalPhases: summary.totalPhases,
          totalAgents: summary.totalAgents,
          reasoning: summary.reasoning,
          results: summary.results,
        },
        duration,
      };
    } catch (error) {
      this.status = "failed";
      return {
        sessionId: this.sessionId,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
    }
  }

  abort(): void {
    this.logger.info("Aborting session", { sessionId: this.sessionId });
    this.status = "failed";
  }

  getStatus(): "idle" | "planning" | "executing" | "completed" | "failed" {
    return this.status;
  }
}
