/**
 * WorkspacePlanningEngine - A Priori Execution Plan Computation
 *
 * Computes execution plans at workspace load time rather than at signal processing time.
 * This provides massive performance improvements for deterministic jobs.
 */

import { logger } from "../../utils/logger.ts";
import type { JobSpecification } from "../session-supervisor.ts";
import {
  type ExecutionStep,
  type JobCharacteristics,
  type PlanningConfig,
  PlanningConfigResolver,
  type PlanType,
  type PrecomputedPlan,
} from "./planning-config.ts";

export interface PlanningEngineConfig {
  maxCacheSize: number;
  enableAnalytics: boolean;
  persistPlans: boolean;
  planStoragePath?: string;
}

export interface PlanningAnalytics {
  totalJobs: number;
  precomputedPlans: number;
  staticPlans: number;
  strategicPlans: number;
  llmPlans: number;
  cacheHits: number;
  cacheMisses: number;
  avgPlanComputeTime: number;
}

export class WorkspacePlanningEngine {
  private planCache = new Map<string, PrecomputedPlan>();
  private configCache = new Map<string, PlanningConfig>();
  private analytics: PlanningAnalytics;
  private config: PlanningEngineConfig;

  constructor(config: Partial<PlanningEngineConfig> = {}) {
    this.config = {
      maxCacheSize: 1000,
      enableAnalytics: true,
      persistPlans: true,
      ...config,
    };

    this.analytics = {
      totalJobs: 0,
      precomputedPlans: 0,
      staticPlans: 0,
      strategicPlans: 0,
      llmPlans: 0,
      cacheHits: 0,
      cacheMisses: 0,
      avgPlanComputeTime: 0,
    };
  }

  /**
   * Precompute all execution plans at workspace load time
   */
  async precomputeAllPlans(
    jobs: Record<string, JobSpecification>,
    planningConfig: PlanningConfig,
  ): Promise<void> {
    const startTime = Date.now();
    let computedCount = 0;

    logger.info("Starting a priori execution plan computation", {
      jobCount: Object.keys(jobs).length,
      precomputationLevel: planningConfig.execution.precomputation,
    });

    for (const [jobName, jobSpec] of Object.entries(jobs)) {
      try {
        const characteristics = this.analyzeJobCharacteristics(jobSpec);
        const planType = this.determinePlanType(characteristics, planningConfig);

        this.analytics.totalJobs++;

        // Only precompute if the configuration allows it and the job is suitable
        if (this.shouldPrecompute(planType, planningConfig)) {
          const plan = this.generateStaticPlan(jobName, jobSpec, characteristics, planType);
          this.planCache.set(jobName, plan);
          computedCount++;
          this.analytics.precomputedPlans++;

          logger.debug("Precomputed execution plan", {
            jobName,
            planType,
            stepCount: plan.steps.length,
            complexity: characteristics.complexity,
          });
        } else {
          logger.debug("Job requires runtime planning", {
            jobName,
            planType,
            complexity: characteristics.complexity,
            reason: this.getRuntimePlanningReason(planType, planningConfig),
          });

          if (planType.startsWith("static")) {
            this.analytics.strategicPlans++;
          } else {
            this.analytics.llmPlans++;
          }
        }
      } catch (error) {
        logger.error("Failed to analyze job for precomputation", {
          jobName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const duration = Date.now() - startTime;
    this.analytics.avgPlanComputeTime = duration / computedCount || 0;

    logger.info("A priori planning computation complete", {
      totalJobs: this.analytics.totalJobs,
      precomputedPlans: this.analytics.precomputedPlans,
      computeTime: duration,
      avgPerPlan: this.analytics.avgPlanComputeTime,
    });
  }

  /**
   * Get execution plan (fast lookup for precomputed, fallback for runtime)
   */
  getExecutionPlan(jobName: string): PrecomputedPlan | null {
    const plan = this.planCache.get(jobName);

    if (plan) {
      this.analytics.cacheHits++;
      logger.debug("Execution plan cache hit", {
        jobName,
        planType: plan.type,
        stepCount: plan.steps.length,
      });
      return plan;
    }

    this.analytics.cacheMisses++;
    logger.debug("Execution plan cache miss", { jobName });
    return null;
  }

  /**
   * Analyze job characteristics for planning decisions
   */
  analyzeJobCharacteristics(jobSpec: JobSpecification): JobCharacteristics {
    const agents = jobSpec.execution.agents || [];
    const hasConditions = !!(jobSpec.execution as any).conditions;
    const hasStages = !!(jobSpec.execution as any).stages;

    // Simple heuristics for job analysis
    const stepCount = hasStages
      ? (jobSpec.execution as any).stages?.length || agents.length
      : agents.length;

    const complexity = this.calculateComplexity(jobSpec);
    const uncertainty = this.calculateUncertainty(jobSpec);
    const optimizationNeeded = this.calculateOptimizationNeed(jobSpec);

    return {
      complexity,
      uncertainty,
      optimization_needed: optimizationNeeded,
      time_critical:
        !!(jobSpec.error_handling?.timeout_seconds && jobSpec.error_handling.timeout_seconds < 60),
      step_count: stepCount,
      dependency_complexity: this.calculateDependencyComplexity(jobSpec),
      failure_tolerance: jobSpec.error_handling?.max_retries || 0,
      has_conditional_logic: hasConditions,
      has_dynamic_selection: this.hasDynamicAgentSelection(jobSpec),
      has_goal_decomposition: this.hasGoalDecomposition(jobSpec),
    };
  }

  /**
   * Determine the appropriate plan type for a job
   */
  determinePlanType(characteristics: JobCharacteristics, config: PlanningConfig): PlanType {
    // Check for simple static patterns first
    if (
      characteristics.complexity < config.execution.strategy_thresholds.complexity &&
      characteristics.uncertainty < config.execution.strategy_thresholds.uncertainty &&
      !characteristics.has_conditional_logic &&
      !characteristics.has_dynamic_selection
    ) {
      if (characteristics.step_count === 1) {
        return "static_sequential";
      } else if (characteristics.dependency_complexity < 0.3) {
        return "static_parallel";
      } else {
        return "static_sequential";
      }
    }

    // Complex jobs need strategy-driven execution
    if (
      characteristics.uncertainty > config.execution.strategy_thresholds.uncertainty ||
      characteristics.optimization_needed > config.execution.strategy_thresholds.optimization
    ) {
      return "mcts";
    }

    if (characteristics.has_goal_decomposition || characteristics.complexity > 0.8) {
      return "htn";
    }

    if (characteristics.has_conditional_logic) {
      return "behavior_tree";
    }

    return "llm_planning";
  }

  /**
   * Generate static execution plan for precomputable jobs
   */
  private generateStaticPlan(
    jobName: string,
    jobSpec: JobSpecification,
    characteristics: JobCharacteristics,
    planType: PlanType,
  ): PrecomputedPlan {
    const steps: ExecutionStep[] = [];

    if (jobSpec.execution.strategy === "sequential") {
      // Sequential pipeline
      jobSpec.execution.agents.forEach((agentSpec, index) => {
        steps.push({
          id: `step-${index}`,
          agentId: agentSpec.id,
          task: `Execute ${agentSpec.id} in sequence`,
          inputSource: index === 0 ? "signal" : "previous",
          dependencies: index > 0 ? [`step-${index - 1}`] : [],
          mode: agentSpec.mode,
          config: agentSpec.config,
        });
      });
    } else if (jobSpec.execution.strategy === "parallel") {
      // Parallel execution
      jobSpec.execution.agents.forEach((agentSpec, index) => {
        steps.push({
          id: `step-${index}`,
          agentId: agentSpec.id,
          task: `Execute ${agentSpec.id} in parallel`,
          inputSource: "signal",
          dependencies: [],
          mode: agentSpec.mode,
          config: agentSpec.config,
        });
      });
    } else if (jobSpec.execution.strategy === "staged" && jobSpec.execution.stages) {
      // Staged execution
      jobSpec.execution.stages.forEach((stage, stageIndex) => {
        stage.agents.forEach((agentSpec, agentIndex) => {
          const stepId = `stage-${stageIndex}-step-${agentIndex}`;
          const previousStageSteps = stageIndex > 0
            ? steps.filter((s) => s.id.startsWith(`stage-${stageIndex - 1}`)).map((s) => s.id)
            : [];

          steps.push({
            id: stepId,
            agentId: agentSpec.id,
            task: `Execute ${agentSpec.id} in stage ${stage.name}`,
            inputSource: stageIndex === 0 ? "signal" : "previous",
            dependencies: stage.strategy === "sequential" && agentIndex > 0
              ? [`stage-${stageIndex}-step-${agentIndex - 1}`]
              : previousStageSteps,
            mode: agentSpec.mode,
            config: agentSpec.config,
          });
        });
      });
    }

    return {
      id: `${jobName}-plan-${Date.now()}`,
      jobName,
      type: planType,
      createdAt: Date.now(),
      steps,
      metadata: {
        characteristics,
        estimatedDuration: this.estimateDuration(steps, characteristics),
        complexity: characteristics.complexity,
      },
    };
  }

  /**
   * Determine if a job should be precomputed based on type and configuration
   */
  private shouldPrecompute(planType: PlanType, config: PlanningConfig): boolean {
    if (config.execution.precomputation === "disabled") {
      return false;
    }

    const staticTypes: PlanType[] = ["static_sequential", "static_parallel", "static_staged"];

    switch (config.execution.precomputation) {
      case "aggressive":
        return staticTypes.includes(planType) || planType === "behavior_tree";
      case "moderate":
        return staticTypes.includes(planType);
      case "minimal":
        return planType === "static_sequential" &&
          this.planCache.get(planType as string)?.steps.length === 1;
      default:
        return false;
    }
  }

  /**
   * Helper methods for job analysis
   */
  private calculateComplexity(jobSpec: JobSpecification): number {
    let complexity = 0;

    // Base complexity from agent count
    const agentCount = jobSpec.execution.agents?.length || 0;
    complexity += Math.min(agentCount / 10, 0.5);

    // Add complexity for conditional logic
    if ((jobSpec.execution as any).conditions) {
      complexity += 0.3;
    }

    // Add complexity for error handling
    if (jobSpec.error_handling) {
      complexity += 0.2;
    }

    // Add complexity for stages
    if (jobSpec.execution.strategy === "staged") {
      complexity += 0.2;
    }

    return Math.min(complexity, 1.0);
  }

  private calculateUncertainty(jobSpec: JobSpecification): number {
    let uncertainty = 0;

    // Dynamic agent selection increases uncertainty
    if (this.hasDynamicAgentSelection(jobSpec)) {
      uncertainty += 0.4;
    }

    // Conditional logic increases uncertainty
    if ((jobSpec.execution as any).conditions) {
      uncertainty += 0.3;
    }

    // Remote agents increase uncertainty
    const hasRemoteAgents = jobSpec.execution.agents?.some((agent) =>
      (agent.config as any)?.type === "remote"
    );
    if (hasRemoteAgents) {
      uncertainty += 0.2;
    }

    return Math.min(uncertainty, 1.0);
  }

  private calculateOptimizationNeed(jobSpec: JobSpecification): number {
    let optimization = 0;

    // Resource constraints indicate optimization needs
    if (jobSpec.resources?.max_memory_mb) {
      optimization += 0.3;
    }

    if (
      jobSpec.resources?.estimated_duration_seconds &&
      jobSpec.resources.estimated_duration_seconds > 300
    ) {
      optimization += 0.3;
    }

    // Multiple success criteria suggest optimization
    if (jobSpec.success_criteria && Object.keys(jobSpec.success_criteria).length > 2) {
      optimization += 0.2;
    }

    return Math.min(optimization, 1.0);
  }

  private calculateDependencyComplexity(jobSpec: JobSpecification): number {
    if (jobSpec.execution.strategy === "parallel") {
      return 0.1;
    }
    if (jobSpec.execution.strategy === "staged") {
      return 0.6;
    }
    return 0.3; // Sequential
  }

  private hasDynamicAgentSelection(jobSpec: JobSpecification): boolean {
    // Check if any agents have dynamic selection criteria
    return jobSpec.execution.agents?.some((agent) =>
      agent.config && typeof agent.config === "object" &&
      "selection_criteria" in agent.config
    ) || false;
  }

  private hasGoalDecomposition(jobSpec: JobSpecification): boolean {
    // Check if the job involves hierarchical goal planning
    return !!(jobSpec.description?.includes("plan") ||
      jobSpec.description?.includes("goal") ||
      jobSpec.execution.strategy === "staged");
  }

  private estimateDuration(steps: ExecutionStep[], characteristics: JobCharacteristics): number {
    // Simple estimation: 2-10 seconds per step based on complexity
    const baseTimePerStep = 2000 + (characteristics.complexity * 8000);
    return steps.length * baseTimePerStep;
  }

  private getRuntimePlanningReason(planType: PlanType, config: PlanningConfig): string {
    if (config.execution.precomputation === "disabled") {
      return "precomputation_disabled";
    }
    if (planType === "llm_planning") {
      return "requires_llm_reasoning";
    }
    if (planType === "mcts") {
      return "optimization_needed";
    }
    if (planType === "htn") {
      return "goal_decomposition_needed";
    }
    return "complex_conditional_logic";
  }

  /**
   * Get precomputed execution plan for a job (fast lookup)
   */
  async getPrecomputedPlan(jobName: string): Promise<PrecomputedPlan | null> {
    const plan = this.planCache.get(jobName);

    if (plan) {
      this.analytics.cacheHits++;
      logger.debug("Precomputed plan cache hit", { jobName, planType: plan.type });
      return plan;
    } else {
      this.analytics.cacheMisses++;
      logger.debug("Precomputed plan cache miss", { jobName });
      return null;
    }
  }

  /**
   * Check if a job has a precomputed plan available
   */
  hasPrecomputedPlan(jobName: string): boolean {
    return this.planCache.has(jobName);
  }

  /**
   * Get all available precomputed plans
   */
  getAllPrecomputedPlans(): Map<string, PrecomputedPlan> {
    return new Map(this.planCache);
  }

  /**
   * Get analytics and performance metrics
   */
  getAnalytics(): PlanningAnalytics {
    return { ...this.analytics };
  }

  /**
   * Clear plan cache (useful for testing or reconfiguration)
   */
  clearCache(): void {
    this.planCache.clear();
    logger.info("Planning cache cleared");
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    hitRate: number;
    missRate: number;
  } {
    const total = this.analytics.cacheHits + this.analytics.cacheMisses;
    return {
      size: this.planCache.size,
      hitRate: total > 0 ? this.analytics.cacheHits / total : 0,
      missRate: total > 0 ? this.analytics.cacheMisses / total : 0,
    };
  }
}
