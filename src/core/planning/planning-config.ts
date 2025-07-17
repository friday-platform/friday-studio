/**
 * Planning configuration for Atlas validation engine
 * Defines configuration for validation planning and execution
 */

export interface ValidationPlanningConfig {
  /** Enable LLM-based validation fallback */
  enableLLMFallback: boolean;
  /** Maximum validation time in milliseconds */
  maxValidationTime: number;
  /** Confidence threshold for validation results */
  confidenceThreshold: number;
  /** Maximum number of validation retries */
  maxRetries: number;
  /** Enable detailed validation logging */
  enableDetailedLogging: boolean;
  /** LLM model to use for validation */
  llmModel?: string;
  /** Custom validation rules */
  customRules?: ValidationRule[];
}

export interface ValidationRule {
  /** Rule identifier */
  id: string;
  /** Rule description */
  description: string;
  /** Rule type */
  type: "syntax" | "semantic" | "security" | "performance";
  /** Rule severity level */
  severity: "low" | "medium" | "high" | "critical";
  /** Rule pattern or function */
  pattern?: string;
  /** Custom validation function */
  validator?: (input: unknown) => boolean;
  /** Rule metadata */
  metadata?: Record<string, unknown>;
}

export interface PlanningExecutionConfig {
  /** Enable parallel execution of planning steps */
  enableParallelExecution: boolean;
  /** Maximum concurrent planning operations */
  maxConcurrentOperations: number;
  /** Planning timeout in milliseconds */
  planningTimeout: number;
  /** Enable planning result caching */
  enableCaching: boolean;
  /** Cache TTL in milliseconds */
  cacheTTL: number;
}

/**
 * Default validation planning configuration
 */
export const DEFAULT_VALIDATION_PLANNING_CONFIG: ValidationPlanningConfig = {
  enableLLMFallback: true,
  maxValidationTime: 30000, // 30 seconds
  confidenceThreshold: 0.8,
  maxRetries: 3,
  enableDetailedLogging: false,
  llmmodel: "claude-3-7-sonnet-latest",
  customRules: [],
};

/**
 * Default planning execution configuration
 */
export const DEFAULT_PLANNING_EXECUTION_CONFIG: PlanningExecutionConfig = {
  enableParallelExecution: true,
  maxConcurrentOperations: 5,
  planningTimeout: 60000, // 1 minute
  enableCaching: true,
  cacheTTL: 300000, // 5 minutes
};

/**
 * Create a validation planning configuration with defaults
 */
export function createValidationPlanningConfig(
  overrides: Partial<ValidationPlanningConfig> = {},
): ValidationPlanningConfig {
  return {
    ...DEFAULT_VALIDATION_PLANNING_CONFIG,
    ...overrides,
  };
}

/**
 * Create a planning execution configuration with defaults
 */
export function createPlanningExecutionConfig(
  overrides: Partial<PlanningExecutionConfig> = {},
): PlanningExecutionConfig {
  return {
    ...DEFAULT_PLANNING_EXECUTION_CONFIG,
    ...overrides,
  };
}

/**
 * Validate a planning configuration
 */
export function validatePlanningConfig(config: ValidationPlanningConfig): void {
  if (config.maxValidationTime <= 0) {
    throw new Error("maxValidationTime must be positive");
  }

  if (config.confidenceThreshold < 0 || config.confidenceThreshold > 1) {
    throw new Error("confidenceThreshold must be between 0 and 1");
  }

  if (config.maxRetries < 0) {
    throw new Error("maxRetries must be non-negative");
  }

  if (config.customRules) {
    for (const rule of config.customRules) {
      if (!rule.id || !rule.description || !rule.type || !rule.severity) {
        throw new Error("Custom rules must have id, description, type, and severity");
      }
    }
  }
}
