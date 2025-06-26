/**
 * Base execution strategy for Atlas agent orchestration
 * Provides common interface for different execution patterns
 */

import type { IWorkspaceSignal } from "../../types/core.ts";
import type { AgentMetadata, JobSpecification } from "../session-supervisor.ts";

export interface ExecutionContext {
  sessionId: string;
  workspaceId: string;
  signal: IWorkspaceSignal | Record<string, unknown>;
  payload: Record<string, unknown>;
  availableAgents: AgentMetadata[];
  jobSpec?: JobSpecification;
  constraints?: {
    timeLimit?: number;
    costLimit?: number;
  };
}

export interface ExecutionStep {
  id: string;
  type: "agent" | "condition" | "parallel" | "sequence";
  agentId?: string;
  condition?: string;
  children?: ExecutionStep[];
  config?: Record<string, unknown>;
  expectedOutputs?: string[];
}

export interface ExecutionResult {
  stepId: string;
  success: boolean;
  output: unknown;
  duration: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface StrategyExecutionResult {
  success: boolean;
  results: ExecutionResult[];
  duration: number;
  metadata: {
    strategy: string;
    stepsExecuted: number;
    totalSteps: number;
    adaptations?: number;
  };
}

export abstract class BaseExecutionStrategy {
  abstract readonly name: string;
  abstract readonly description: string;

  protected context: ExecutionContext | null = null;
  protected startTime: number = 0;

  // Initialize strategy with execution context
  initialize(context: ExecutionContext): void {
    this.context = context;
    this.startTime = Date.now();
  }

  // Execute the strategy with given steps
  abstract execute(
    steps: ExecutionStep[],
  ): StrategyExecutionResult | Promise<StrategyExecutionResult>;

  // Validate that steps are compatible with this strategy
  abstract validateSteps(steps: ExecutionStep[]): { valid: boolean; errors: string[] };

  // Get strategy-specific configuration schema
  abstract getConfigSchema(): Record<string, unknown>;

  // Helper method to create execution result
  protected createExecutionResult(
    stepId: string,
    success: boolean,
    output: unknown,
    duration: number,
    error?: string,
    metadata?: Record<string, unknown>,
  ): ExecutionResult {
    return {
      stepId,
      success,
      output,
      duration,
      error,
      metadata,
    };
  }

  // Helper method to create strategy result
  protected createStrategyResult(
    success: boolean,
    results: ExecutionResult[],
    adaptations: number = 0,
  ): StrategyExecutionResult {
    const duration = Date.now() - this.startTime;
    const totalSteps = this.countTotalSteps(results);

    return {
      success,
      results,
      duration,
      metadata: {
        strategy: this.name,
        stepsExecuted: results.length,
        totalSteps,
        adaptations,
      },
    };
  }

  // Count total steps including nested ones
  private countTotalSteps(results: ExecutionResult[]): number {
    // For now, just return results length
    // Can be overridden by strategies with nested steps
    return results.length;
  }

  // Log helper with strategy context
  protected log(message: string, level: "info" | "warn" | "error" = "info"): void {
    const prefix = `[${this.name}] ${this.context?.sessionId || "unknown"}:`;
    if (level === "error") {
      console.error(`${prefix} ${message}`);
    } else if (level === "warn") {
      console.warn(`${prefix} ${message}`);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }
}
