/**
 * Signal Analysis Engine - Precomputed Signal Analysis Patterns
 *
 * Eliminates expensive LLM calls for deterministic signal analysis by precomputing
 * signal-to-job mappings and intent patterns at workspace load time.
 */

import { logger } from "../utils/logger.ts";
import type { IWorkspaceSignal } from "../types/core.ts";
import type { SessionIntent } from "./session.ts";
import {
  type ConditionEvaluationResult,
  type ConditionEvaluatorConfig,
  ConditionEvaluatorRegistry,
} from "./conditions/condition-evaluator.ts";

export interface PrecomputedSignalPattern {
  signalId: string;
  jobName: string;
  intentTemplate: SessionIntentTemplate;
  condition?: string | object; // Raw condition (string or JSONLogic)
  metadata: {
    precomputed: true;
    createdAt: number;
    complexity: "static" | "conditional";
  };
}

export interface SessionIntentTemplate {
  id: string;
  goals: string[];
  constraints: {
    timeLimit: number;
    costLimit?: number;
  };
  suggestedAgents: string[];
  executionHints: {
    strategy: "iterative" | "deterministic" | "exploratory";
    parallelism: boolean;
    maxIterations: number;
  };
  userPrompt?: string;
}

export interface SignalAnalysisResult {
  intent: SessionIntent;
  jobName?: string;
  analysisMethod: "precomputed" | "pattern_match" | "llm_fallback";
  computeTime: number;
}

export interface SignalAnalysisConfig {
  condition_evaluation: ConditionEvaluatorConfig;
  global_patterns?: PrecomputedSignalPattern[];
  defaults: {
    timeLimit: number;
    costLimit: number;
    maxIterations: number;
    fallbackAgent: string;
  };
}

export class SignalAnalysisEngine {
  private patterns = new Map<string, PrecomputedSignalPattern[]>();
  private globalPatterns: PrecomputedSignalPattern[] = [];
  private conditionEvaluator: ConditionEvaluatorRegistry;
  private config: SignalAnalysisConfig;

  constructor(config?: Partial<SignalAnalysisConfig>) {
    this.config = {
      condition_evaluation: {
        evaluators: {
          jsonlogic: { enabled: true, priority: 100 },
          simple_expression: { enabled: true, priority: 50 },
          exact_match: { enabled: true, priority: 10 },
        },
        fallback_strategy: "allow",
        require_match_confidence: 0.5,
      },
      defaults: {
        timeLimit: 300000, // 5 minutes
        costLimit: 100,
        maxIterations: 3,
        fallbackAgent: "local-assistant",
      },
      ...config,
    };

    this.conditionEvaluator = new ConditionEvaluatorRegistry(this.config.condition_evaluation);
    this.initializeGlobalPatterns();
  }

  /**
   * Precompute signal analysis patterns at workspace load time
   */
  async precomputeSignalPatterns(
    signals: Record<string, any>,
    jobs: Record<string, any>,
    availableAgents: string[],
  ): Promise<void> {
    const startTime = Date.now();
    let computedCount = 0;

    logger.info("Starting signal analysis pattern precomputation", {
      signalCount: Object.keys(signals).length,
      jobCount: Object.keys(jobs).length,
      agentCount: availableAgents.length,
    });

    // Clear existing patterns
    this.patterns.clear();

    // Process each signal and find its associated jobs
    for (const [signalId, signalConfig] of Object.entries(signals)) {
      const signalPatterns: PrecomputedSignalPattern[] = [];

      // Find jobs that are triggered by this signal
      for (const [jobName, jobSpec] of Object.entries(jobs)) {
        const triggers = (jobSpec as any).triggers;
        if (triggers) {
          for (const trigger of triggers) {
            if (trigger.signal === signalId) {
              const pattern = this.createPrecomputedPattern(
                signalId,
                jobName,
                jobSpec as any,
                trigger,
                availableAgents,
              );
              signalPatterns.push(pattern);
              computedCount++;

              logger.debug("Precomputed signal pattern", {
                signalId,
                jobName,
                hasCondition: !!trigger.condition,
                complexity: pattern.metadata.complexity,
              });
            }
          }
        }
      }

      if (signalPatterns.length > 0) {
        this.patterns.set(signalId, signalPatterns);
        logger.debug(`Precomputed ${signalPatterns.length} patterns for signal: ${signalId}`);
      }
    }

    const duration = Date.now() - startTime;
    logger.info("Signal analysis pattern precomputation complete", {
      totalPatterns: computedCount,
      signalsWithPatterns: this.patterns.size,
      computeTime: duration,
      avgPerPattern: computedCount > 0 ? duration / computedCount : 0,
    });
  }

  /**
   * Analyze signal using precomputed patterns (zero LLM calls for deterministic signals)
   */
  async analyzeSignal(
    signal: IWorkspaceSignal,
    payload: any,
    workspaceId: string,
  ): Promise<SignalAnalysisResult> {
    const startTime = Date.now();

    logger.debug("Starting precomputed signal analysis", {
      signalId: signal.id,
      payloadSize: JSON.stringify(payload).length,
    });

    // Step 1: Check for exact signal patterns (fastest path)
    const signalPatterns = this.patterns.get(signal.id);
    if (signalPatterns && signalPatterns.length > 0) {
      logger.debug(`Found ${signalPatterns.length} precomputed patterns for signal: ${signal.id}`);

      // Evaluate patterns in order until one matches
      for (const pattern of signalPatterns) {
        const evaluationResult = await this.evaluatePattern(pattern, payload);
        if (evaluationResult.matches) {
          const intent = this.createIntentFromPattern(pattern, signal, payload, workspaceId);
          const computeTime = Date.now() - startTime;

          logger.debug("Signal analysis completed using precomputed pattern", {
            signalId: signal.id,
            jobName: pattern.jobName,
            computeTime,
            analysisMethod: "precomputed",
            complexity: pattern.metadata.complexity,
            conditionEvaluator: evaluationResult.evaluator,
            confidence: evaluationResult.confidence,
          });

          return {
            intent,
            jobName: pattern.jobName,
            analysisMethod: "precomputed",
            computeTime,
          };
        }
      }

      logger.debug("No precomputed patterns matched, checking global patterns", {
        signalId: signal.id,
        patternsEvaluated: signalPatterns.length,
      });
    }

    // Step 2: Check global patterns for common signal types
    for (const pattern of this.globalPatterns) {
      const evaluationResult = await this.evaluateGlobalPattern(pattern, signal, payload);
      if (evaluationResult.matches) {
        const intent = this.createIntentFromPattern(pattern, signal, payload, workspaceId);
        const computeTime = Date.now() - startTime;

        logger.debug("Signal analysis completed using global pattern", {
          signalId: signal.id,
          patternName: pattern.jobName,
          computeTime,
          analysisMethod: "pattern_match",
          conditionEvaluator: evaluationResult.evaluator,
          confidence: evaluationResult.confidence,
        });

        return {
          intent,
          analysisMethod: "pattern_match",
          computeTime,
        };
      }
    }

    // Step 3: No patterns matched - signal requires LLM analysis
    const computeTime = Date.now() - startTime;
    logger.debug("No precomputed patterns available, requires LLM analysis", {
      signalId: signal.id,
      computeTime,
      patternsChecked: (signalPatterns?.length || 0) + this.globalPatterns.length,
    });

    // Return minimal intent that indicates LLM analysis is needed
    const fallbackIntent = this.createFallbackIntent(signal, payload, workspaceId);
    return {
      intent: fallbackIntent,
      analysisMethod: "llm_fallback",
      computeTime,
    };
  }

  /**
   * Check if signal has precomputed patterns available
   */
  hasPrecomputedPatterns(signalId: string): boolean {
    return this.patterns.has(signalId) && this.patterns.get(signalId)!.length > 0;
  }

  /**
   * Get analysis coverage statistics
   */
  getAnalyticsCoverage(): {
    signalsWithPatterns: number;
    totalPatterns: number;
    staticPatterns: number;
    conditionalPatterns: number;
  } {
    let totalPatterns = 0;
    let staticPatterns = 0;
    let conditionalPatterns = 0;

    for (const patterns of this.patterns.values()) {
      totalPatterns += patterns.length;
      for (const pattern of patterns) {
        if (pattern.metadata.complexity === "static") {
          staticPatterns++;
        } else {
          conditionalPatterns++;
        }
      }
    }

    return {
      signalsWithPatterns: this.patterns.size,
      totalPatterns,
      staticPatterns,
      conditionalPatterns,
    };
  }

  /**
   * Create precomputed pattern from job specification
   */
  private createPrecomputedPattern(
    signalId: string,
    jobName: string,
    jobSpec: any,
    trigger: any,
    availableAgents: string[],
  ): PrecomputedSignalPattern {
    // Extract agent IDs from job specification
    const jobAgentIds = this.extractAgentIdsFromJob(jobSpec);
    const suggestedAgents = jobAgentIds.length > 0
      ? jobAgentIds.filter((id) => availableAgents.includes(id))
      : availableAgents;

    // Create intent template based on job specification
    const intentTemplate: SessionIntentTemplate = {
      id: `template-${signalId}-${jobName}`,
      goals: [
        `Execute job: ${jobName}`,
        jobSpec.description || `Process ${signalId} signal`,
      ],
      constraints: {
        timeLimit: jobSpec.resources?.estimated_duration_seconds
          ? jobSpec.resources.estimated_duration_seconds * 1000
          : this.config.defaults.timeLimit,
        costLimit: this.config.defaults.costLimit,
      },
      suggestedAgents,
      executionHints: {
        strategy: this.mapJobStrategyToExecutionHint(jobSpec.execution?.strategy),
        parallelism: jobSpec.execution?.strategy === "parallel",
        maxIterations: this.config.defaults.maxIterations,
      },
      userPrompt: jobSpec.session_prompts?.planning || "",
    };

    // Determine complexity based on trigger conditions
    const complexity: "static" | "conditional" = trigger.condition ? "conditional" : "static";

    return {
      signalId,
      jobName,
      intentTemplate,
      condition: trigger.condition, // Store raw condition
      metadata: {
        precomputed: true,
        createdAt: Date.now(),
        complexity,
      },
    };
  }

  /**
   * Extract agent IDs from job specification
   */
  private extractAgentIdsFromJob(jobSpec: any): string[] {
    const agentIds: string[] = [];

    if (jobSpec.execution?.agents) {
      agentIds.push(...jobSpec.execution.agents.map((agent: any) => agent.id));
    }

    if (jobSpec.execution?.stages) {
      for (const stage of jobSpec.execution.stages) {
        agentIds.push(...stage.agents.map((agent: any) => agent.id));
      }
    }

    return agentIds;
  }

  /**
   * Map job execution strategy to session execution hint
   */
  private mapJobStrategyToExecutionHint(
    strategy?: string,
  ): "iterative" | "deterministic" | "exploratory" {
    switch (strategy) {
      case "sequential":
        return "deterministic";
      case "parallel":
        return "deterministic"; // Use deterministic for parallel execution
      case "staged":
        return "iterative";
      case "conditional":
        return "exploratory";
      default:
        return "deterministic";
    }
  }

  /**
   * Evaluate if a precomputed pattern matches the payload using pluggable evaluators
   */
  private async evaluatePattern(
    pattern: PrecomputedSignalPattern,
    payload: any,
  ): Promise<ConditionEvaluationResult> {
    if (pattern.metadata.complexity === "static") {
      // Static patterns always match
      return {
        matches: true,
        confidence: 1.0,
        evaluator: "static-pattern",
      };
    }

    // Conditional patterns need evaluation using the condition evaluator registry
    if (pattern.condition) {
      return await this.conditionEvaluator.evaluate(pattern.condition, payload);
    }

    // No condition means it matches
    return {
      matches: true,
      confidence: 1.0,
      evaluator: "no-condition",
    };
  }

  /**
   * Evaluate global patterns against signal and payload using pluggable evaluators
   */
  private async evaluateGlobalPattern(
    pattern: PrecomputedSignalPattern,
    signal: IWorkspaceSignal,
    payload: any,
  ): Promise<ConditionEvaluationResult> {
    // Global patterns can have conditions too
    if (pattern.condition) {
      return await this.conditionEvaluator.evaluate(pattern.condition, payload);
    }

    // Fallback: check for generic message pattern
    if (pattern.signalId === "generic-message" && (payload as any)?.message) {
      return {
        matches: true,
        confidence: 0.7,
        evaluator: "global-message-pattern",
      };
    }

    return {
      matches: false,
      confidence: 0.0,
      evaluator: "global-pattern-mismatch",
    };
  }

  /**
   * Create session intent from precomputed pattern
   */
  private createIntentFromPattern(
    pattern: PrecomputedSignalPattern,
    signal: IWorkspaceSignal,
    payload: any,
    workspaceId: string,
  ): SessionIntent {
    const template = pattern.intentTemplate;

    return {
      id: crypto.randomUUID(),
      signal: {
        type: signal.id,
        data: payload,
        metadata: {
          provider: signal.provider.name,
          timestamp: new Date().toISOString(),
          precomputedPattern: pattern.jobName,
        },
      },
      goals: template.goals,
      constraints: template.constraints,
      suggestedAgents: template.suggestedAgents,
      executionHints: template.executionHints,
      userPrompt: template.userPrompt || "",
    };
  }

  /**
   * Create fallback intent for signals without precomputed patterns
   */
  private createFallbackIntent(
    signal: IWorkspaceSignal,
    payload: any,
    workspaceId: string,
  ): SessionIntent {
    return {
      id: crypto.randomUUID(),
      signal: {
        type: signal.id,
        data: payload,
        metadata: {
          provider: signal.provider.name,
          timestamp: new Date().toISOString(),
          requiresLLMAnalysis: true,
        },
      },
      goals: [
        `Process ${signal.id} signal from ${signal.provider.name}`,
        "Determine appropriate actions based on signal data",
      ],
      constraints: {
        timeLimit: this.config.defaults.timeLimit,
        costLimit: this.config.defaults.costLimit,
      },
      suggestedAgents: [this.config.defaults.fallbackAgent], // Use configured fallback
      executionHints: {
        strategy: "exploratory",
        parallelism: false,
        maxIterations: this.config.defaults.maxIterations,
      },
      userPrompt: "",
    };
  }

  /**
   * Initialize global patterns for common signal types from configuration
   */
  private initializeGlobalPatterns(): void {
    // Use configured global patterns if provided
    if (this.config.global_patterns) {
      this.globalPatterns = [...this.config.global_patterns];
    } else {
      // Default global patterns if none configured
      this.globalPatterns.push({
        signalId: "generic-message",
        jobName: "process-message",
        intentTemplate: {
          id: "global-message-template",
          goals: ["Process incoming message"],
          constraints: {
            timeLimit: this.config.defaults.timeLimit,
            costLimit: this.config.defaults.costLimit,
          },
          suggestedAgents: [this.config.defaults.fallbackAgent],
          executionHints: {
            strategy: "deterministic",
            parallelism: false,
            maxIterations: this.config.defaults.maxIterations,
          },
        },
        condition: { "var": "message" }, // JSONLogic: check if message exists
        metadata: {
          precomputed: true,
          createdAt: Date.now(),
          complexity: "conditional",
        },
      });
    }

    logger.debug(`Initialized ${this.globalPatterns.length} global signal patterns`);
  }
}
