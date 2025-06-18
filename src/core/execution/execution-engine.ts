/**
 * ExecutionEngine - Central coordinator for execution strategies
 *
 * The ExecutionEngine is responsible for:
 * - Selecting the most appropriate execution strategy for a given task
 * - Managing strategy instances and configurations
 * - Providing a unified interface for execution
 * - Collecting and analyzing execution performance
 */

import {
  BaseExecutionStrategy,
  ExecutionContext,
  ExecutionStep,
  StrategyExecutionResult,
} from "./base-execution-strategy.ts";
import { BehaviorTreeStrategy } from "./strategies/behavior-tree-strategy.ts";
import {
  HierarchicalTaskNetworkStrategy,
  HTNDomain,
} from "./strategies/hierarchical-task-network-strategy.ts";
import { MonteCarloTreeSearchStrategy } from "./strategies/monte-carlo-tree-search-strategy.ts";

export interface ExecutionEngineConfig {
  defaultStrategy: ExecutionStrategyType;
  strategyConfigs: {
    [key: string]: any; // Allow dynamic strategy configs
    behaviorTree?: any;
    htn?: {
      domain?: HTNDomain;
      maxDepth?: number;
    };
    mcts?: {
      maxIterations?: number;
      explorationConstant?: number;
      timeLimit?: number;
    };
  };
  selectionCriteria: StrategySelectionCriteria;
  enablePerformanceTracking: boolean;
  adaptiveSelection: boolean;
}

export interface StrategySelectionCriteria {
  complexityThreshold: number;
  uncertaintyThreshold: number;
  optimizationThreshold: number;
  timeConstraints?: number;
}

export interface TaskCharacteristics {
  complexity: number; // 0-1 scale
  uncertainty: number; // 0-1 scale
  optimization_needed: number; // 0-1 scale
  time_critical: boolean;
  step_count: number;
  dependency_complexity: number;
  failure_tolerance: number;
}

export interface ExecutionMetrics {
  strategy: ExecutionStrategyType;
  success_rate: number;
  avg_execution_time: number;
  avg_step_success_rate: number;
  complexity_handled: number;
  last_updated: number;
}

export type ExecutionStrategyType = "behavior-tree" | "htn" | "mcts";

export class ExecutionEngine {
  private strategies: Map<ExecutionStrategyType, BaseExecutionStrategy>;
  private config: ExecutionEngineConfig;
  private performanceHistory: Map<ExecutionStrategyType, ExecutionMetrics>;
  private recentExecutions: Array<{
    characteristics: TaskCharacteristics;
    strategy: ExecutionStrategyType;
    result: StrategyExecutionResult;
    timestamp: number;
  }>;

  constructor(config: Partial<ExecutionEngineConfig> = {}) {
    this.config = {
      defaultStrategy: "behavior-tree",
      strategyConfigs: {},
      selectionCriteria: {
        complexityThreshold: 0.6,
        uncertaintyThreshold: 0.5,
        optimizationThreshold: 0.7,
      },
      enablePerformanceTracking: true,
      adaptiveSelection: true,
      ...config,
    };

    this.strategies = new Map();
    this.performanceHistory = new Map();
    this.recentExecutions = [];

    this.initializeStrategies();
    this.initializePerformanceTracking();
  }

  /**
   * Main execution method - automatically selects and executes the best strategy
   */
  async execute(
    steps: ExecutionStep[],
    hints?: Partial<TaskCharacteristics>,
  ): Promise<StrategyExecutionResult> {
    const characteristics = this.analyzeTaskCharacteristics(steps, hints);
    const selectedStrategy = this.selectStrategy(characteristics);

    const strategy = this.strategies.get(selectedStrategy);
    if (!strategy) {
      throw new Error(`Strategy ${selectedStrategy} not found`);
    }

    const startTime = Date.now();
    let result: StrategyExecutionResult;

    try {
      result = await strategy.execute(steps);

      // Add strategy selection info to metadata
      result.metadata = {
        ...result.metadata,
        selectedStrategy,
        characteristics,
        selectionReason: this.getSelectionReason(selectedStrategy, characteristics),
      } as any; // Extend the base metadata type
    } catch (error) {
      result = {
        success: false,
        results: [],
        duration: Date.now() - startTime,
        metadata: {
          strategy: selectedStrategy,
          stepsExecuted: 0,
          totalSteps: steps.length,
          error: error instanceof Error ? error.message : String(error),
          selectedStrategy,
          characteristics,
        } as any,
      };
    }

    // Track performance
    if (this.config.enablePerformanceTracking) {
      this.recordExecution(characteristics, selectedStrategy, result);
    }

    return result;
  }

  /**
   * Execute with specific strategy (bypass automatic selection)
   */
  async executeWithStrategy(
    steps: ExecutionStep[],
    strategyType: ExecutionStrategyType,
  ): Promise<StrategyExecutionResult> {
    const strategy = this.strategies.get(strategyType);
    if (!strategy) {
      throw new Error(`Strategy ${strategyType} not found`);
    }

    const result = await strategy.execute(steps);
    result.metadata = {
      ...result.metadata,
      selectedStrategy: strategyType,
      selectionMethod: "manual",
    } as any;

    return result;
  }

  /**
   * Get strategy recommendation without executing
   */
  recommendStrategy(steps: ExecutionStep[], hints?: Partial<TaskCharacteristics>): {
    strategy: ExecutionStrategyType;
    confidence: number;
    reasoning: string;
    alternatives: Array<{ strategy: ExecutionStrategyType; score: number }>;
  } {
    const characteristics = this.analyzeTaskCharacteristics(steps, hints);
    const scores = this.calculateStrategyScores(characteristics);

    const sortedStrategies = Object.entries(scores)
      .sort(([, a], [, b]) => b - a) as Array<[ExecutionStrategyType, number]>;

    const [bestStrategy, bestScore] = sortedStrategies[0];

    return {
      strategy: bestStrategy,
      confidence: bestScore,
      reasoning: this.getSelectionReason(bestStrategy, characteristics),
      alternatives: sortedStrategies.slice(1).map(([strategy, score]) => ({ strategy, score })),
    };
  }

  /**
   * Get performance statistics
   */
  getPerformanceStats(): Map<ExecutionStrategyType, ExecutionMetrics> {
    return new Map(this.performanceHistory);
  }

  /**
   * Update strategy configuration
   */
  updateStrategyConfig(strategy: ExecutionStrategyType, config: any): void {
    this.config.strategyConfigs[strategy] = { ...this.config.strategyConfigs[strategy], ...config };
    this.reinitializeStrategy(strategy);
  }

  private initializeStrategies(): void {
    // Initialize Behavior Tree Strategy
    this.strategies.set("behavior-tree", new BehaviorTreeStrategy());

    // Initialize HTN Strategy
    const htnConfig = this.config.strategyConfigs.htn || {};
    const htnDomain = htnConfig.domain ||
      HierarchicalTaskNetworkStrategy.createAgentWorkflowDomain();
    this.strategies.set(
      "htn",
      new HierarchicalTaskNetworkStrategy(htnDomain, {}, htnConfig.maxDepth),
    );

    // Initialize MCTS Strategy
    const mctsConfig = this.config.strategyConfigs.mcts || {};
    this.strategies.set("mcts", new MonteCarloTreeSearchStrategy(mctsConfig));
  }

  private reinitializeStrategy(strategyType: ExecutionStrategyType): void {
    switch (strategyType) {
      case "behavior-tree":
        this.strategies.set("behavior-tree", new BehaviorTreeStrategy());
        break;
      case "htn":
        const htnConfig = this.config.strategyConfigs.htn || {};
        const htnDomain = htnConfig.domain ||
          HierarchicalTaskNetworkStrategy.createAgentWorkflowDomain();
        this.strategies.set(
          "htn",
          new HierarchicalTaskNetworkStrategy(htnDomain, {}, htnConfig.maxDepth),
        );
        break;
      case "mcts":
        const mctsConfig = this.config.strategyConfigs.mcts || {};
        this.strategies.set("mcts", new MonteCarloTreeSearchStrategy(mctsConfig));
        break;
    }
  }

  private initializePerformanceTracking(): void {
    const strategies: ExecutionStrategyType[] = ["behavior-tree", "htn", "mcts"];

    for (const strategy of strategies) {
      this.performanceHistory.set(strategy, {
        strategy,
        success_rate: 0.8, // Default assumption
        avg_execution_time: 1000,
        avg_step_success_rate: 0.85,
        complexity_handled: 0.5,
        last_updated: Date.now(),
      });
    }
  }

  private analyzeTaskCharacteristics(
    steps: ExecutionStep[],
    hints?: Partial<TaskCharacteristics>,
  ): TaskCharacteristics {
    const stepCount = steps.length;

    // Calculate complexity based on step count, dependencies, and variety
    const agentVariety = new Set(steps.map((s) => s.agentId)).size;
    const complexity = Math.min(1, (stepCount * 0.1) + (agentVariety * 0.15));

    // Calculate uncertainty based on step types and expected failure rates
    const uncertainty = this.calculateUncertainty(steps);

    // Calculate optimization need based on step count and potential alternatives
    const optimization_needed = stepCount > 5 ? Math.min(1, stepCount * 0.08) : 0;

    // Detect time criticality
    const time_critical = steps.some((step) =>
      (step as any).timeout !== undefined && (step as any).timeout < 10000
    );

    // Calculate dependency complexity
    const dependency_complexity = this.calculateDependencyComplexity(steps);

    // Calculate failure tolerance
    const failure_tolerance = this.calculateFailureTolerance(steps);

    return {
      complexity,
      uncertainty,
      optimization_needed,
      time_critical,
      step_count: stepCount,
      dependency_complexity,
      failure_tolerance,
      ...hints, // Override with provided hints
    };
  }

  private calculateUncertainty(steps: ExecutionStep[]): number {
    // Higher uncertainty for:
    // - External agent calls
    // - Complex configurations
    // - New/untested agent combinations

    let uncertaintyScore = 0;

    for (const step of steps) {
      // External agents add uncertainty
      if (step.agentId && (step.agentId.includes("remote") || step.agentId.includes("external"))) {
        uncertaintyScore += 0.2;
      }

      // Complex configurations add uncertainty
      if (step.config && typeof step.config === "object") {
        const configComplexity = JSON.stringify(step.config).length;
        uncertaintyScore += Math.min(0.1, configComplexity / 1000);
      }

      // First-time agent combinations add uncertainty
      // (This would use historical data in a real implementation)
      uncertaintyScore += 0.05;
    }

    return Math.min(1, uncertaintyScore / steps.length);
  }

  private calculateDependencyComplexity(steps: ExecutionStep[]): number {
    // Analyze dependencies between steps
    // Check for children and nested structures
    let complexity = 0;

    for (const step of steps) {
      // Check for nested children (indicates dependency structure)
      if (step.children && step.children.length > 0) {
        complexity += 0.3;
      }

      // Check for conditions (indicates branching dependencies)
      if (step.condition) {
        complexity += 0.2;
      }

      // Complex configurations suggest dependencies
      if (step.config && Object.keys(step.config).length > 3) {
        complexity += 0.1;
      }
    }

    return Math.min(1, complexity);
  }

  private calculateFailureTolerance(steps: ExecutionStep[]): number {
    // Higher tolerance = more resilient to failures
    let tolerance = 0.5; // Base tolerance

    // Steps with retry logic or resilience configs increase tolerance
    for (const step of steps) {
      if (step.config?.retries !== undefined) {
        tolerance += 0.1;
      }

      // Critical steps reduce tolerance
      if (step.agentId && step.agentId.includes("critical")) {
        tolerance -= 0.2;
      }

      // Parallel steps increase tolerance
      if (step.type === "parallel") {
        tolerance += 0.15;
      }
    }

    return Math.max(0, Math.min(1, tolerance));
  }

  private selectStrategy(characteristics: TaskCharacteristics): ExecutionStrategyType {
    if (this.config.adaptiveSelection) {
      return this.adaptiveStrategySelection(characteristics);
    } else {
      return this.ruleBasedStrategySelection(characteristics);
    }
  }

  private ruleBasedStrategySelection(characteristics: TaskCharacteristics): ExecutionStrategyType {
    const criteria = this.config.selectionCriteria;

    // High complexity with clear structure -> HTN
    if (
      characteristics.complexity > criteria.complexityThreshold &&
      characteristics.dependency_complexity > 0.5
    ) {
      return "htn";
    }

    // High uncertainty or optimization needs -> MCTS
    if (
      characteristics.uncertainty > criteria.uncertaintyThreshold ||
      characteristics.optimization_needed > criteria.optimizationThreshold
    ) {
      return "mcts";
    }

    // Default to behavior trees for structured, predictable workflows
    return "behavior-tree";
  }

  private adaptiveStrategySelection(characteristics: TaskCharacteristics): ExecutionStrategyType {
    const scores = this.calculateStrategyScores(characteristics);

    // Select strategy with highest score
    return Object.entries(scores)
      .reduce(
        (best, [strategy, score]) =>
          score > scores[best] ? strategy as ExecutionStrategyType : best,
        "behavior-tree" as ExecutionStrategyType,
      );
  }

  private calculateStrategyScores(
    characteristics: TaskCharacteristics,
  ): Record<ExecutionStrategyType, number> {
    const scores: Record<ExecutionStrategyType, number> = {
      "behavior-tree": 0,
      "htn": 0,
      "mcts": 0,
    };

    // Behavior Tree scoring
    scores["behavior-tree"] = 0.7; // Base score (good general-purpose)
    scores["behavior-tree"] += characteristics.step_count < 5 ? 0.2 : -0.1;
    scores["behavior-tree"] += characteristics.uncertainty < 0.3 ? 0.2 : -0.1;
    scores["behavior-tree"] += characteristics.time_critical ? 0.1 : 0;

    // HTN scoring
    scores["htn"] = 0.5; // Base score
    scores["htn"] += characteristics.complexity * 0.4;
    scores["htn"] += characteristics.dependency_complexity * 0.3;
    scores["htn"] += characteristics.step_count > 7 ? 0.2 : 0;

    // MCTS scoring
    scores["mcts"] = 0.4; // Base score
    scores["mcts"] += characteristics.uncertainty * 0.4;
    scores["mcts"] += characteristics.optimization_needed * 0.4;
    scores["mcts"] += characteristics.failure_tolerance * 0.2;
    scores["mcts"] -= characteristics.time_critical ? 0.3 : 0; // MCTS is slower

    // Apply performance history if available
    if (this.config.adaptiveSelection) {
      for (const [strategy, metrics] of this.performanceHistory.entries()) {
        scores[strategy] *= 0.7 + metrics.success_rate * 0.3;
      }
    }

    return scores;
  }

  private getSelectionReason(
    strategy: ExecutionStrategyType,
    characteristics: TaskCharacteristics,
  ): string {
    switch (strategy) {
      case "behavior-tree":
        return `Selected Behavior Tree for structured execution (complexity: ${
          characteristics.complexity.toFixed(2)
        }, steps: ${characteristics.step_count})`;
      case "htn":
        return `Selected HTN for complex goal decomposition (complexity: ${
          characteristics.complexity.toFixed(2)
        }, dependencies: ${characteristics.dependency_complexity.toFixed(2)})`;
      case "mcts":
        return `Selected MCTS for optimization exploration (uncertainty: ${
          characteristics.uncertainty.toFixed(2)
        }, optimization need: ${characteristics.optimization_needed.toFixed(2)})`;
      default:
        return `Selected ${strategy} (default selection)`;
    }
  }

  private recordExecution(
    characteristics: TaskCharacteristics,
    strategy: ExecutionStrategyType,
    result: StrategyExecutionResult,
  ): void {
    // Record recent execution
    this.recentExecutions.push({
      characteristics,
      strategy,
      result,
      timestamp: Date.now(),
    });

    // Keep only recent executions (last 100)
    if (this.recentExecutions.length > 100) {
      this.recentExecutions = this.recentExecutions.slice(-100);
    }

    // Update performance metrics
    this.updatePerformanceMetrics(strategy, result, characteristics);
  }

  private updatePerformanceMetrics(
    strategy: ExecutionStrategyType,
    result: StrategyExecutionResult,
    characteristics: TaskCharacteristics,
  ): void {
    const current = this.performanceHistory.get(strategy);
    if (!current) return;

    const executions = this.recentExecutions.filter((e) => e.strategy === strategy);
    if (executions.length === 0) return;

    // Calculate updated metrics
    const successRate = executions.filter((e) => e.result.success).length / executions.length;
    const avgExecutionTime = executions.reduce((sum, e) => sum + e.result.executionTime, 0) /
      executions.length;
    const avgStepSuccessRate = this.calculateAvgStepSuccessRate(executions);
    const maxComplexityHandled = Math.max(...executions.map((e) => e.characteristics.complexity));

    // Update with exponential moving average
    const alpha = 0.3; // Learning rate
    current.success_rate = alpha * successRate + (1 - alpha) * current.success_rate;
    current.avg_execution_time = alpha * avgExecutionTime +
      (1 - alpha) * current.avg_execution_time;
    current.avg_step_success_rate = alpha * avgStepSuccessRate +
      (1 - alpha) * current.avg_step_success_rate;
    current.complexity_handled = Math.max(current.complexity_handled, maxComplexityHandled);
    current.last_updated = Date.now();
  }

  private calculateAvgStepSuccessRate(executions: typeof this.recentExecutions): number {
    let totalSteps = 0;
    let successfulSteps = 0;

    for (const execution of executions) {
      totalSteps += execution.result.results.length;
      successfulSteps += execution.result.results.filter((r) => r.success).length;
    }

    return totalSteps > 0 ? successfulSteps / totalSteps : 0;
  }

  /**
   * Export configuration and performance data
   */
  exportState(): {
    config: ExecutionEngineConfig;
    performance: Record<string, ExecutionMetrics>;
    recentExecutions: number;
  } {
    return {
      config: this.config,
      performance: Object.fromEntries(this.performanceHistory),
      recentExecutions: this.recentExecutions.length,
    };
  }

  /**
   * Import configuration and performance data
   */
  importState(state: {
    config?: Partial<ExecutionEngineConfig>;
    performance?: Record<string, ExecutionMetrics>;
  }): void {
    if (state.config) {
      this.config = { ...this.config, ...state.config };
      this.initializeStrategies(); // Reinitialize with new config
    }

    if (state.performance) {
      for (const [strategy, metrics] of Object.entries(state.performance)) {
        this.performanceHistory.set(strategy as ExecutionStrategyType, metrics);
      }
    }
  }
}
