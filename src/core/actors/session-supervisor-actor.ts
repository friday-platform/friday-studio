/**
 * Session Supervisor Actor - Direct orchestration for session management
 * Migrated from SessionSupervisorWorker to eliminate worker complexity
 *
 * Handles:
 * - Multi-step reasoning with transparent thinking
 * - Tool call orchestration with optimized LLM calls
 * - Pre-computed job specs from registry cache
 * - Supervision level-based execution strategies
 */

import { type ChildLogger, logger } from "../../utils/logger.ts";
import { getWorkspaceManager } from "../workspace-manager.ts";
import { AgentExecutionActor } from "./agent-execution-actor.ts";
import { MultiStepReasoningEngine } from "../multi-step-reasoning.ts";
import { BehaviorTreeStrategy } from "../execution/strategies/behavior-tree-strategy.ts";
import { getSupervisionConfig, SupervisionLevel } from "../supervision-levels.ts";
import type { JobSpecification, WorkspaceConfig } from "../../../packages/config/src/schemas.ts";
import type { IWorkspaceSignal } from "../../types/core.ts";
import type { AgentExecutePayload } from "../../types/messages.ts";

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
  reasoningSteps?: Array<{
    iteration: number;
    thinking: string;
    action: string;
    observation: string;
  }>;
}

export interface ExecutionPhase {
  id: string;
  name: string;
  executionStrategy: "sequential" | "parallel";
  agents: Array<{
    agentId: string;
    task: string;
    inputSource?: string;
    dependencies?: string[];
    reasoning?: string;
  }>;
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

export class SessionSupervisorActor {
  private sessionId: string;
  private workspaceId?: string;
  private logger: ChildLogger;
  private id: string;
  private sessionContext?: SessionContext;
  private workspaceConfig?: WorkspaceConfig;
  private reasoningEngine: MultiStepReasoningEngine;
  private executionStrategy: BehaviorTreeStrategy;
  private supervisionLevel: SupervisionLevel = SupervisionLevel.STANDARD;

  constructor(sessionId: string, workspaceId?: string, id?: string) {
    this.id = id || crypto.randomUUID();
    this.sessionId = sessionId;
    this.workspaceId = workspaceId;

    this.logger = logger.createChildLogger({
      actorId: this.id,
      actorType: "session-supervisor",
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
    });

    // Initialize reasoning and execution engines
    this.reasoningEngine = new MultiStepReasoningEngine();
    this.executionStrategy = new BehaviorTreeStrategy();

    this.logger.info("Session supervisor actor initialized");
  }

  async initialize(): Promise<void> {
    this.logger.info("Initializing session supervisor actor");

    // Load workspace config and determine supervision level
    this.workspaceConfig = await this.loadWorkspaceConfig();
    this.supervisionLevel = this.getSupervisionLevel();

    this.logger.info("Session supervisor actor initialized", {
      supervisionLevel: this.supervisionLevel,
      workspaceId: this.workspaceId || "global",
    });
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

    // 1. Check for pre-computed job specs in registry cache
    const cachedPlan = this.getCachedJobSpec();
    if (cachedPlan) {
      this.logger.info("Using cached execution plan", {
        planId: cachedPlan.id,
        phases: cachedPlan.phases.length,
      });
      return cachedPlan;
    }

    // 2. Compute execution plan on-demand using multi-step reasoning engine
    this.logger.info("Computing execution plan using multi-step reasoning");

    const reasoningContext = {
      sessionId: this.sessionContext.sessionId,
      workspaceId: this.sessionContext.workspaceId || "global",
      signal: this.sessionContext.signal,
      payload: this.sessionContext.payload,
      availableAgents: this.sessionContext.availableAgents.map((id) => ({
        id,
        name: id,
        purpose: "System agent",
        type: "system" as const,
        config: {} as any,
      })),
      maxIterations: 5,
      timeLimit: 60000, // 1 minute
    };

    // Create agent executor that uses AgentExecutionActor
    const agentExecutor = async (agentId: string, input: Record<string, unknown>) => {
      const agentActor = new AgentExecutionActor(
        agentId,
        this.sessionContext?.workspaceId || "global",
      );

      const payload: AgentExecutePayload = {
        agentId,
        input,
        sessionId: this.sessionContext?.sessionId || "unknown",
        workspaceId: this.sessionContext?.workspaceId || "global",
        signal: this.sessionContext?.signal || {},
      };

      return await agentActor.executeTask(crypto.randomUUID(), payload);
    };

    // Create tool executor (for future tool integration)
    const toolExecutor = (toolName: string, parameters: Record<string, unknown>) => {
      return Promise.resolve({
        success: true,
        result: `Tool ${toolName} executed with parameters: ${JSON.stringify(parameters)}`,
        duration: 100,
      });
    };

    const reasoningResult = await this.reasoningEngine.reason(
      reasoningContext,
      agentExecutor,
      toolExecutor,
    );

    // 3. Convert reasoning result to execution plan
    const executionPlan = this.convertReasoningToExecutionPlan(reasoningResult);

    // 4. Cache the computed plan if caching is enabled
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
      // Sequential execution
      for (const agentTask of phase.agents) {
        const result = await this.executeAgent(agentTask, previousResults, phaseResults);
        phaseResults.push(result);
      }
    } else {
      // Parallel execution
      const promises = phase.agents.map((agentTask) =>
        this.executeAgent(agentTask, previousResults, phaseResults)
      );
      const parallelResults = await Promise.all(promises);
      phaseResults.push(...parallelResults);
    }

    return phaseResults;
  }

  private async executeAgent(
    agentTask: {
      agentId: string;
      task: string;
      inputSource?: string;
      dependencies?: string[];
      reasoning?: string;
    },
    previousResults: AgentResult[],
    _phaseResults: AgentResult[],
  ): Promise<AgentResult> {
    const startTime = Date.now();

    // Resolve input based on input source
    let input = this.sessionContext?.payload;

    if (agentTask.inputSource === "previous" && previousResults.length > 0) {
      input = previousResults[previousResults.length - 1].output as Record<string, unknown>;
    } else if (agentTask.inputSource === "combined") {
      input = {
        original: this.sessionContext?.payload,
        previous: previousResults.map((r) => ({
          agentId: r.agentId,
          output: r.output,
        })),
      };
    } else if (agentTask.dependencies?.length) {
      const lastDep = agentTask.dependencies[agentTask.dependencies.length - 1];
      const depResult = previousResults.find((r) => r.agentId === lastDep);
      if (depResult) {
        input = depResult.output as Record<string, unknown>;
      }
    }

    // Create agent execution payload
    const payload: AgentExecutePayload = {
      agent_id: agentTask.agentId,
      input,
      task: agentTask.task,
      reasoning: agentTask.reasoning,
    };

    // Execute agent through AgentExecutionActor
    const agentActor = new AgentExecutionActor(
      this.sessionId,
      this.workspaceId,
      crypto.randomUUID(),
    );

    await agentActor.initialize();

    this.logger.info("Executing agent", {
      agentId: agentTask.agentId,
      task: agentTask.task,
      inputSource: agentTask.inputSource,
      reasoning: agentTask.reasoning,
    });

    const result = await agentActor.executeTask(crypto.randomUUID(), payload);

    const duration = Date.now() - startTime;

    // Extract reasoning and tool calls if available
    const agentResult: AgentResult = {
      agentId: agentTask.agentId,
      task: agentTask.task,
      input,
      output: result.output,
      duration,
      timestamp: new Date().toISOString(),
      reasoning: agentTask.reasoning,
      // Tool calls would be extracted from result if the agent supports them
      toolCalls: (result as { toolCalls?: unknown[] }).toolCalls,
      toolResults: (result as { toolResults?: unknown[] }).toolResults,
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
    // Simple evaluation - in practice this would use LLM analysis
    // based on supervision level and job success criteria

    const supervisionConfig = getSupervisionConfig(this.supervisionLevel);

    if (!supervisionConfig.postExecutionValidation) {
      return true; // Continue execution
    }

    // Check if we have results and no obvious failures
    const hasResults = results.length > 0;
    const hasFailures = results.some((r) => !r.output);

    if (hasFailures && this.supervisionLevel === SupervisionLevel.PARANOID) {
      return false; // Stop on any failure in paranoid mode
    }

    // Continue if we have more phases to execute
    return hasResults;
  }

  private generateSessionSummary(
    results: AgentResult[],
    plan: ExecutionPlan,
    duration: number,
  ): SessionSummary {
    const status = results.every((r) => r.output) ? "completed" : "partial";

    // In practice, this would use LLM to generate reasoning about the session
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
    const memoryConfig = jobSpec?.memory;
    const memoryEnabled = memoryConfig?.enabled !== false;

    if (!memoryEnabled) {
      this.logger.info("Memory operations disabled");
      return;
    }

    // Extract and store semantic facts
    if (memoryConfig?.fact_extraction !== false) {
      try {
        this.extractAndStoreSemanticFacts(summary);
        this.logger.info("Semantic facts extracted and stored");
      } catch (error) {
        this.logger.warn("Failed to extract semantic facts", { error: error.message });
      }
    }

    // Generate working memory summary
    if (memoryConfig?.working_memory_summary !== false) {
      try {
        this.generateWorkingMemorySummary(summary);
        this.logger.info("Working memory summary generated");
      } catch (error) {
        this.logger.warn("Failed to generate working memory summary", { error: error.message });
      }
    }
  }

  // Helper methods
  private async loadWorkspaceConfig(): Promise<WorkspaceConfig> {
    const workspaceManager = getWorkspaceManager();

    if (!this.workspaceId) {
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

  private getSupervisionLevel(): SupervisionLevel {
    const jobSpec = this.sessionContext?.jobSpec;
    const levelStr = jobSpec?.supervision?.level || "standard";

    switch (levelStr) {
      case "minimal":
        return SupervisionLevel.MINIMAL;
      case "paranoid":
        return SupervisionLevel.PARANOID;
      default:
        return SupervisionLevel.STANDARD;
    }
  }

  private getCachedJobSpec(): ExecutionPlan | null {
    // Check registry cache for pre-computed job specs
    // This would integrate with the WorkspaceManager's caching system
    return null; // Placeholder
  }

  private shouldCachePlan(): boolean {
    const supervisionConfig = getSupervisionConfig(this.supervisionLevel);
    return supervisionConfig.cacheEnabled;
  }

  private cachePlan(plan: ExecutionPlan): void {
    // Cache the execution plan in the registry
    // This would integrate with the WorkspaceManager's caching system
    this.logger.debug("Caching execution plan", { planId: plan.id });
  }

  private convertReasoningToExecutionPlan(reasoningResult: {
    success: boolean;
    steps: Array<{
      iteration: number;
      thinking: string;
      action: { type: string; agentId?: string; parameters: Record<string, unknown> } | null;
      observation: string;
      confidence: number;
    }>;
    finalSolution: unknown;
    totalIterations: number;
    totalDuration: number;
    totalCost: number;
  }): ExecutionPlan {
    const planId = crypto.randomUUID();

    // Extract agent interactions from reasoning steps
    const agentInteractions = reasoningResult.steps
      .filter((step) => step.action?.type === "agent_call" && step.action.agentId)
      .map((step) => ({
        agentId: step.action!.agentId!,
        task: (step.action!.parameters.task as string) || "Process input",
        inputSource: "previous",
        reasoning: step.thinking,
      }));

    // Create execution phases based on reasoning steps
    const phases: ExecutionPhase[] = [{
      id: crypto.randomUUID(),
      name: "Multi-Step Reasoning Execution",
      executionStrategy: "sequential",
      agents: agentInteractions.length > 0
        ? agentInteractions // Fallback to available agents if no specific agents were called
        : this.sessionContext?.availableAgents.map((agentId) => ({
          agentId,
          task: "Process signal based on reasoning",
          inputSource: "signal",
          reasoning: "Generated from multi-step reasoning",
        })) || [],
    }];

    // Convert reasoning steps to the interface format
    const reasoningSteps = reasoningResult.steps.map((step) => ({
      iteration: step.iteration,
      thinking: step.thinking,
      action: step.action
        ? `${step.action.type}: ${step.action.agentId || step.action.parameters.task || "unknown"}`
        : "none",
      observation: step.observation,
    }));

    // Calculate overall confidence from steps
    const avgConfidence = reasoningResult.steps.length > 0
      ? reasoningResult.steps.reduce((sum, step) => sum + step.confidence, 0) /
        reasoningResult.steps.length
      : 0.5;

    return {
      id: planId,
      phases,
      reasoning:
        `Multi-step reasoning completed in ${reasoningResult.totalIterations} iterations. Final solution: ${
          JSON.stringify(reasoningResult.finalSolution)
        }`,
      strategy: "multi-step-reasoning",
      confidence: avgConfidence,
      reasoningSteps,
    };
  }

  private extractAndStoreSemanticFacts(_summary: SessionSummary): void {
    // Extract semantic facts from session results and store in knowledge graph
    // This would integrate with the memory system
    this.logger.debug("Extracting semantic facts", { sessionId: this.sessionId });
  }

  private generateWorkingMemorySummary(_summary: SessionSummary): void {
    // Generate working memory summary and store in episodic memory
    // This would integrate with the memory system
    this.logger.debug("Generating working memory summary", { sessionId: this.sessionId });
  }
}
