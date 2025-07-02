/**
 * Job Trigger Matcher - Direct Job-Signal Evaluation
 *
 * Elegant signal-to-job matching using declarative job triggers instead of
 * redundant signal analysis engine. Evaluates job trigger conditions directly
 * using the pluggable condition evaluation system.
 */

import { logger } from "../utils/logger.ts";
import type { IWorkspaceSignal } from "../types/core.ts";
import {
  type ConditionEvaluationResult,
  type ConditionEvaluatorConfig,
  ConditionEvaluatorRegistry,
} from "./conditions/condition-evaluator.ts";

export interface JobTrigger {
  signal: string;
  condition?: string | object;
  naturalLanguageCondition?: string;
  response?: {
    mode: "unary" | "streaming" | "interactive";
    format?: "json" | "sse" | "websocket";
    timeout?: number;
  };
}

export interface JobSpec {
  name: string;
  description?: string;
  triggers: JobTrigger[];
  execution: {
    strategy: string;
    agents: Array<{ id: string; role?: string }>;
  };
  resources?: {
    estimated_duration_seconds?: number;
    cost_limit?: number;
  };
  session_prompts?: {
    planning?: string;
    execution?: string;
    evaluation?: string;
  };
}

export interface JobMatch {
  job: JobSpec;
  trigger: JobTrigger;
  evaluationResult: ConditionEvaluationResult;
  matchedAt: number;
}

export interface JobTriggerMatcherConfig {
  condition_evaluation: ConditionEvaluatorConfig;
  min_confidence?: number;
  max_matches_per_signal?: number;
  enable_parallel_evaluation?: boolean;
}

export class JobTriggerMatcher {
  private conditionEvaluator: ConditionEvaluatorRegistry;
  private config: JobTriggerMatcherConfig;

  constructor(config?: Partial<JobTriggerMatcherConfig>) {
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
      min_confidence: 0.5,
      max_matches_per_signal: 10,
      enable_parallel_evaluation: true,
      ...config,
    };

    this.conditionEvaluator = new ConditionEvaluatorRegistry(this.config.condition_evaluation);
  }

  /**
   * Find all jobs that should be triggered by the given signal and payload
   */
  async findMatchingJobs(
    signal: IWorkspaceSignal,
    payload: any,
    jobs: Record<string, JobSpec>,
  ): Promise<JobMatch[]> {
    const startTime = Date.now();
    const matches: JobMatch[] = [];

    logger.debug("Starting job trigger evaluation", {
      signalId: signal.id,
      jobCount: Object.keys(jobs).length,
      payloadSize: JSON.stringify(payload).length,
    });

    // Collect all job-trigger pairs that match the signal
    const candidatePairs: Array<{ job: JobSpec; trigger: JobTrigger }> = [];

    for (const [jobName, jobSpec] of Object.entries(jobs)) {
      for (const trigger of jobSpec.triggers || []) {
        if (trigger.signal === signal.id) {
          candidatePairs.push({
            job: { ...jobSpec, name: jobName },
            trigger,
          });
        }
      }
    }

    logger.debug(
      `Found ${candidatePairs.length} candidate job-trigger pairs for signal: ${signal.id}`,
    );

    // Evaluate conditions for matching pairs
    if (this.config.enable_parallel_evaluation && candidatePairs.length > 1) {
      // Parallel evaluation for better performance
      const evaluationPromises = candidatePairs.map(async ({ job, trigger }) => {
        const result = await this.evaluateTriggerCondition(trigger, payload);
        return { job, trigger, result };
      });

      const evaluationResults = await Promise.all(evaluationPromises);

      for (const { job, trigger, result } of evaluationResults) {
        if (result.matches && result.confidence >= (this.config.min_confidence || 0.5)) {
          matches.push({
            job,
            trigger,
            evaluationResult: result,
            matchedAt: Date.now(),
          });
        }
      }
    } else {
      // Sequential evaluation
      for (const { job, trigger } of candidatePairs) {
        const result = await this.evaluateTriggerCondition(trigger, payload);

        if (result.matches && result.confidence >= (this.config.min_confidence || 0.5)) {
          matches.push({
            job,
            trigger,
            evaluationResult: result,
            matchedAt: Date.now(),
          });
        }
      }
    }

    // Apply max matches limit
    const limitedMatches = matches
      .sort((a, b) => b.evaluationResult.confidence - a.evaluationResult.confidence)
      .slice(0, this.config.max_matches_per_signal || 10);

    const duration = Date.now() - startTime;
    logger.info("Job trigger evaluation completed", {
      signalId: signal.id,
      candidatePairs: candidatePairs.length,
      totalMatches: matches.length,
      limitedMatches: limitedMatches.length,
      evaluationTime: duration,
      avgConfidence: matches.length > 0
        ? matches.reduce((sum, m) => sum + m.evaluationResult.confidence, 0) / matches.length
        : 0,
    });

    return limitedMatches;
  }

  /**
   * Evaluate a single trigger condition against payload
   */
  private async evaluateTriggerCondition(
    trigger: JobTrigger,
    payload: any,
  ): Promise<ConditionEvaluationResult> {
    // If no condition specified, always matches
    if (!trigger.condition) {
      return {
        matches: true,
        confidence: 1.0,
        evaluator: "no-condition",
        metadata: { trigger_type: "unconditional" },
      };
    }

    // Use the pluggable condition evaluation system
    try {
      const result = await this.conditionEvaluator.evaluate(trigger.condition, payload);

      logger.debug("Trigger condition evaluated", {
        hasCondition: !!trigger.condition,
        conditionType: typeof trigger.condition,
        matches: result.matches,
        confidence: result.confidence,
        evaluator: result.evaluator,
      });

      return {
        ...result,
        metadata: {
          ...result.metadata,
          naturalLanguageCondition: trigger.naturalLanguageCondition,
          condition_type: typeof trigger.condition,
        },
      };
    } catch (error) {
      logger.error("Error evaluating trigger condition", {
        condition: trigger.condition,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        matches: false,
        confidence: 0.0,
        evaluator: "evaluation-error",
        metadata: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  /**
   * Get the condition evaluator registry for direct access
   */
  getConditionEvaluatorRegistry(): ConditionEvaluatorRegistry {
    return this.conditionEvaluator;
  }

  /**
   * Get evaluation statistics for monitoring and debugging
   */
  getEvaluationStats(): {
    totalEvaluations: number;
    conditionEvaluatorStats: any;
  } {
    return {
      totalEvaluations: 0, // TODO: Track this in implementation
      conditionEvaluatorStats: {},
    };
  }

  /**
   * Validate job specifications for trigger consistency
   */
  validateJobTriggers(jobs: Record<string, JobSpec>): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const [jobName, jobSpec] of Object.entries(jobs)) {
      if (!jobSpec.triggers || jobSpec.triggers.length === 0) {
        warnings.push(`Job "${jobName}" has no triggers defined`);
        continue;
      }

      for (let i = 0; i < jobSpec.triggers.length; i++) {
        const trigger = jobSpec.triggers[i];

        if (!trigger.signal) {
          errors.push(`Job "${jobName}" trigger ${i} missing signal field`);
        }

        // Validate condition syntax if present
        if (trigger.condition) {
          try {
            // Basic validation - actual evaluation happens at runtime
            if (typeof trigger.condition === "string" && trigger.condition.trim() === "") {
              warnings.push(`Job "${jobName}" trigger ${i} has empty condition string`);
            }
          } catch (error) {
            errors.push(
              `Job "${jobName}" trigger ${i} has invalid condition: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        // Check for natural language condition consistency
        if (trigger.naturalLanguageCondition && !trigger.condition) {
          warnings.push(
            `Job "${jobName}" trigger ${i} has naturalLanguageCondition but no condition - ` +
              `consider converting to executable condition`,
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}
