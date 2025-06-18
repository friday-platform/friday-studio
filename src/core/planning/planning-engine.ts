import { join } from "@std/path";
import { exists } from "@std/fs";
import { logger } from "../../utils/logger.ts";
import { ReasoningEngine, type ReasoningEngineConfig } from "../reasoning/reasoning-engine.ts";
import { PatternMatcher, type PlanningContext } from "../performance/pattern-matcher.ts";
import type { ReasoningContext } from "../reasoning/base-reasoning.ts";

export interface PlanningEngineConfig {
  cacheDir?: string;
  enableCaching?: boolean;
  enablePatternMatching?: boolean;
  reasoningConfig?: ReasoningEngineConfig;
}

export interface PlanningTask {
  id: string;
  description: string;
  context: any;
  agentType: "workspace" | "session" | "agent" | "custom";
  complexity?: number;
  requiresToolUse?: boolean;
  qualityCritical?: boolean;
}

export interface PlanningResult {
  plan: any;
  reasoning: string;
  confidence: number;
  method: string;
  duration: number;
  cost: number;
  cached: boolean;
}

export class PlanningEngine {
  private reasoningEngine: ReasoningEngine;
  private patternMatcher?: PatternMatcher;
  private config: PlanningEngineConfig;
  private logger = logger;

  constructor(config: PlanningEngineConfig = {}) {
    this.config = {
      enableCaching: true,
      enablePatternMatching: true,
      ...config,
    };

    // Initialize reasoning engine
    this.reasoningEngine = new ReasoningEngine(config.reasoningConfig);

    // Initialize pattern matcher if enabled and cache dir provided
    if (config.enablePatternMatching && config.cacheDir) {
      this.patternMatcher = new PatternMatcher(config.cacheDir);
    }
  }

  async generatePlan(task: PlanningTask): Promise<PlanningResult> {
    const startTime = Date.now();

    // Step 1: Try pattern matching for fast path
    if (this.patternMatcher && this.config.enablePatternMatching) {
      const planningContext: PlanningContext = {
        task: task.description,
        agentType: task.agentType,
        complexity: task.complexity || this.estimateComplexity(task),
        requiresToolUse: task.requiresToolUse || this.detectToolUse(task),
        qualityCritical: task.qualityCritical || this.detectQualityCritical(task),
      };

      const fastResult = await this.patternMatcher.tryFastPath(planningContext);
      if (fastResult) {
        return {
          plan: fastResult,
          reasoning: "Retrieved from pattern cache",
          confidence: 0.9,
          method: "pattern-match",
          duration: Date.now() - startTime,
          cost: 0,
          cached: true,
        };
      }
    }

    // Step 2: Use reasoning engine for planning
    const reasoningContext: ReasoningContext = {
      task: `Create a plan for: ${task.description}`,
      context: JSON.stringify(task.context),
      complexity: task.complexity || this.estimateComplexity(task),
      requiresToolUse: task.requiresToolUse || this.detectToolUse(task),
      qualityCritical: task.qualityCritical || this.detectQualityCritical(task),
      agentType: task.agentType,
    };

    const reasoningResult = await this.reasoningEngine.reason(reasoningContext);

    // Step 3: Cache the result if pattern matching is enabled
    if (this.patternMatcher && this.config.enablePatternMatching) {
      await this.patternMatcher.cachePattern({
        task: task.description,
        agentType: task.agentType,
        complexity: reasoningContext.complexity,
        requiresToolUse: reasoningContext.requiresToolUse,
        qualityCritical: reasoningContext.qualityCritical,
      }, reasoningResult.solution);
    }

    return {
      plan: reasoningResult.solution,
      reasoning: reasoningResult.reasoning,
      confidence: reasoningResult.confidence,
      method: reasoningResult.method,
      duration: Date.now() - startTime,
      cost: reasoningResult.cost,
      cached: false,
    };
  }

  async invalidateCache(pattern?: string): Promise<void> {
    if (this.patternMatcher) {
      // For now, we don't have a specific invalidation method
      // In a full implementation, this would clear specific patterns
      this.logger.info("Cache invalidation requested", { pattern });
    }
  }

  private estimateComplexity(task: PlanningTask): number {
    let complexity = 0.3; // Base complexity

    // Analyze description length
    if (task.description.length > 200) complexity += 0.2;
    if (task.description.length > 500) complexity += 0.2;

    // Look for complexity indicators
    const complexityIndicators = [
      "multiple",
      "complex",
      "advanced",
      "sophisticated",
      "comprehensive",
      "detailed",
      "extensive",
    ];

    const description = task.description.toLowerCase();
    for (const indicator of complexityIndicators) {
      if (description.includes(indicator)) {
        complexity += 0.1;
      }
    }

    // Agent type affects complexity
    if (task.agentType === "workspace") complexity += 0.2;
    else if (task.agentType === "session") complexity += 0.1;

    return Math.min(1.0, complexity);
  }

  private detectToolUse(task: PlanningTask): boolean {
    const toolIndicators = [
      "tool",
      "api",
      "file",
      "execute",
      "run",
      "call",
      "search",
      "query",
      "fetch",
      "download",
      "upload",
    ];

    const description = task.description.toLowerCase();
    return toolIndicators.some((indicator) => description.includes(indicator));
  }

  private detectQualityCritical(task: PlanningTask): boolean {
    const qualityIndicators = [
      "security",
      "critical",
      "production",
      "important",
      "sensitive",
      "validate",
      "verify",
      "audit",
    ];

    const description = task.description.toLowerCase();
    return qualityIndicators.some((indicator) => description.includes(indicator));
  }

  getReasoningEngine(): ReasoningEngine {
    return this.reasoningEngine;
  }
}
