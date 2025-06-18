/**
 * Planning Configuration Hierarchy
 *
 * Cascading configuration system for execution planning and validation
 * from atlas.yml → workspace.yml → supervisor-specific overrides
 */

export type PrecomputationLevel = "aggressive" | "moderate" | "minimal" | "disabled";
export type ValidationLevel = "aggressive" | "moderate" | "minimal" | "disabled";

export interface ExecutionPlanningConfig {
  precomputation: PrecomputationLevel;
  cache_enabled: boolean;
  cache_ttl_hours: number;
  invalidate_on_job_change: boolean;
  strategy_selection: {
    simple_jobs: "precomputed" | "behavior-tree" | "htn" | "mcts";
    complex_jobs: "behavior-tree" | "htn" | "mcts";
    optimization_jobs: "mcts" | "htn";
    planning_jobs: "htn" | "behavior-tree";
  };
  strategy_thresholds: {
    complexity: number; // 0-1, above this uses ExecutionEngine
    uncertainty: number; // 0-1, above this considers MCTS
    optimization: number; // 0-1, above this prefers MCTS
  };
}

export interface ValidationPlanningConfig {
  precomputation: ValidationLevel;
  functional_validators: boolean;
  smoke_tests: boolean;
  content_safety: boolean;
  llm_threshold: number; // 0-1, confidence threshold for LLM fallback
  llm_fallback: boolean;
  cache_enabled: boolean;
  cache_ttl_hours: number;
  fail_fast: boolean;
  external_services: {
    openai_moderation: boolean;
    perspective_api: boolean;
    deepeval_service?: string; // URL for Python DeepEval service
  };
}

export interface PlanningConfig {
  execution: ExecutionPlanningConfig;
  validation: ValidationPlanningConfig;
}

export interface SupervisorPlanningConfig {
  workspace?: Partial<PlanningConfig>;
  session?: Partial<PlanningConfig>;
  agent?: Partial<PlanningConfig>;
}

// Default configurations
export const DEFAULT_PLANNING_CONFIG: PlanningConfig = {
  execution: {
    precomputation: "moderate",
    cache_enabled: true,
    cache_ttl_hours: 24,
    invalidate_on_job_change: true,
    strategy_selection: {
      simple_jobs: "precomputed",
      complex_jobs: "behavior-tree",
      optimization_jobs: "mcts",
      planning_jobs: "htn",
    },
    strategy_thresholds: {
      complexity: 0.6,
      uncertainty: 0.5,
      optimization: 0.7,
    },
  },
  validation: {
    precomputation: "moderate",
    functional_validators: true,
    smoke_tests: true,
    content_safety: true,
    llm_threshold: 0.7,
    llm_fallback: true,
    cache_enabled: true,
    cache_ttl_hours: 1,
    fail_fast: false,
    external_services: {
      openai_moderation: false,
      perspective_api: false,
    },
  },
};

export const SUPERVISOR_DEFAULTS: SupervisorPlanningConfig = {
  workspace: {
    execution: {
      precomputation: "aggressive", // Workspace can pre-compute signal→job mappings
      cache_enabled: true,
      cache_ttl_hours: 24,
      invalidate_on_job_change: true,
      strategy_selection: {
        simple_jobs: "precomputed",
        complex_jobs: "behavior-tree",
        optimization_jobs: "mcts",
        planning_jobs: "htn",
      },
      strategy_thresholds: {
        complexity: 0.6,
        uncertainty: 0.5,
        optimization: 0.7,
      },
    },
  },
  session: {
    execution: {
      precomputation: "aggressive", // Sessions pre-compute job→agent plans
      cache_enabled: true,
      cache_ttl_hours: 24,
      invalidate_on_job_change: true,
      strategy_selection: {
        simple_jobs: "precomputed",
        complex_jobs: "behavior-tree",
        optimization_jobs: "mcts",
        planning_jobs: "htn",
      },
      strategy_thresholds: {
        complexity: 0.6,
        uncertainty: 0.5,
        optimization: 0.7,
      },
    },
    validation: {
      precomputation: "moderate", // Session-level output validation
      functional_validators: true,
      smoke_tests: true,
      content_safety: true,
      llm_threshold: 0.7,
      llm_fallback: true,
      cache_enabled: true,
      cache_ttl_hours: 1,
      fail_fast: false,
      external_services: {
        openai_moderation: false,
        perspective_api: false,
      },
    },
  },
  agent: {
    execution: {
      precomputation: "minimal", // Agent loading/env setup can be cached
      cache_enabled: true,
      cache_ttl_hours: 24,
      invalidate_on_job_change: true,
      strategy_selection: {
        simple_jobs: "precomputed",
        complex_jobs: "behavior-tree",
        optimization_jobs: "mcts",
        planning_jobs: "htn",
      },
      strategy_thresholds: {
        complexity: 0.6,
        uncertainty: 0.5,
        optimization: 0.7,
      },
    },
    validation: {
      precomputation: "aggressive", // Agent output validation is critical path
      functional_validators: true,
      smoke_tests: true,
      content_safety: true,
      llm_threshold: 0.5, // Lower threshold = more safety
      llm_fallback: true,
      cache_enabled: true,
      cache_ttl_hours: 1,
      fail_fast: true, // Stop at first validation failure
      external_services: {
        openai_moderation: false,
        perspective_api: false,
      },
    },
  },
};

/**
 * Configuration cascade resolver
 */
export class PlanningConfigResolver {
  /**
   * Resolve final configuration by cascading atlas.yml → workspace.yml → supervisor overrides
   */
  static resolveConfig(
    atlasConfig?: Partial<PlanningConfig>,
    workspaceConfig?: Partial<PlanningConfig>,
    supervisorType?: keyof SupervisorPlanningConfig,
    supervisorOverrides?: Partial<PlanningConfig>,
  ): PlanningConfig {
    // Start with defaults
    let resolved = { ...DEFAULT_PLANNING_CONFIG };

    // Apply atlas.yml overrides
    if (atlasConfig) {
      resolved = this.mergeConfigs(resolved, atlasConfig);
    }

    // Apply workspace.yml overrides
    if (workspaceConfig) {
      resolved = this.mergeConfigs(resolved, workspaceConfig);
    }

    // Apply supervisor-specific defaults
    if (supervisorType && SUPERVISOR_DEFAULTS[supervisorType]) {
      resolved = this.mergeConfigs(resolved, SUPERVISOR_DEFAULTS[supervisorType]!);
    }

    // Apply supervisor-specific overrides
    if (supervisorOverrides) {
      resolved = this.mergeConfigs(resolved, supervisorOverrides);
    }

    return resolved;
  }

  /**
   * Deep merge configuration objects
   */
  private static mergeConfigs(
    base: PlanningConfig,
    override: Partial<PlanningConfig>,
  ): PlanningConfig {
    return {
      execution: {
        ...base.execution,
        ...override.execution,
        strategy_selection: {
          ...base.execution.strategy_selection,
          ...override.execution?.strategy_selection,
        },
        strategy_thresholds: {
          ...base.execution.strategy_thresholds,
          ...override.execution?.strategy_thresholds,
        },
      },
      validation: {
        ...base.validation,
        ...override.validation,
        external_services: {
          ...base.validation.external_services,
          ...override.validation?.external_services,
        },
      },
    };
  }

  /**
   * Get effective configuration for a specific supervisor type
   */
  static getEffectiveConfig(
    supervisorType: keyof SupervisorPlanningConfig,
    atlasConfig?: Partial<PlanningConfig>,
    workspaceConfig?: Partial<PlanningConfig>,
  ): PlanningConfig {
    return this.resolveConfig(atlasConfig, workspaceConfig, supervisorType);
  }
}

/**
 * Job characteristics analysis for strategy selection
 */
export interface JobCharacteristics {
  complexity: number; // 0-1 scale
  uncertainty: number; // 0-1 scale
  optimization_needed: number; // 0-1 scale
  time_critical: boolean;
  step_count: number;
  dependency_complexity: number;
  failure_tolerance: number;
  has_conditional_logic: boolean;
  has_dynamic_selection: boolean;
  has_goal_decomposition: boolean;
}

/**
 * Plan type classification
 */
export type PlanType =
  | "static_sequential" // Simple sequential pipeline
  | "static_parallel" // Simple parallel execution
  | "static_staged" // Simple multi-stage execution
  | "behavior_tree" // Conditional logic, error handling
  | "htn" // Goal decomposition, hierarchical planning
  | "mcts" // Optimization, exploration
  | "llm_planning"; // Complex, needs full LLM reasoning

/**
 * Precomputed execution plan
 */
export interface PrecomputedPlan {
  id: string;
  jobName: string;
  type: PlanType;
  createdAt: number;
  steps: ExecutionStep[];
  metadata: {
    characteristics: JobCharacteristics;
    estimatedDuration: number;
    complexity: number;
  };
}

export interface ExecutionStep {
  id: string;
  agentId: string;
  task: string;
  inputSource: "signal" | "previous" | "combined" | "memory";
  dependencies: string[];
  mode?: string;
  config?: Record<string, any>;
  timeout?: number;
  retries?: number;
}
