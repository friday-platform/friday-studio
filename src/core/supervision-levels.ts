/**
 * Supervision levels for configurable agent oversight
 * Controls the balance between safety and performance
 */

export enum SupervisionLevel {
  MINIMAL = "minimal",
  STANDARD = "standard",
  PARANOID = "paranoid",
}

interface SupervisionConfig {
  level: SupervisionLevel;
  cacheEnabled: boolean;
  parallelLLMCalls: boolean;

  // Per-level configurations
  preExecutionAnalysis: boolean;
  postExecutionValidation: boolean;
  resourceMonitoring: boolean;
  safetyChecks: boolean;

  // Timeouts and limits
  analysisTimeoutMs: number;
  validationTimeoutMs: number;
  maxConcurrentLLMCalls: number;
}

const SUPERVISION_CONFIGS: Record<SupervisionLevel, SupervisionConfig> = {
  [SupervisionLevel.MINIMAL]: {
    level: SupervisionLevel.MINIMAL,
    cacheEnabled: true,
    parallelLLMCalls: true,

    // Minimal oversight - basic safety only
    preExecutionAnalysis: false, // Skip detailed analysis
    postExecutionValidation: false, // Skip output validation
    resourceMonitoring: true, // Basic monitoring
    safetyChecks: true, // Always do safety

    analysisTimeoutMs: 5000, // 5s max
    validationTimeoutMs: 3000, // 3s max
    maxConcurrentLLMCalls: 1,
  },

  [SupervisionLevel.STANDARD]: {
    level: SupervisionLevel.STANDARD,
    cacheEnabled: true,
    parallelLLMCalls: true,

    // Standard oversight - balanced
    preExecutionAnalysis: true,
    postExecutionValidation: true,
    resourceMonitoring: true,
    safetyChecks: true,

    analysisTimeoutMs: 10000, // 10s max
    validationTimeoutMs: 8000, // 8s max
    maxConcurrentLLMCalls: 2,
  },

  [SupervisionLevel.PARANOID]: {
    level: SupervisionLevel.PARANOID,
    cacheEnabled: false, // Disable cache for max safety
    parallelLLMCalls: false, // Sequential for thoroughness

    // Maximum oversight - safety over performance
    preExecutionAnalysis: true,
    postExecutionValidation: true,
    resourceMonitoring: true,
    safetyChecks: true,

    analysisTimeoutMs: 30000, // 30s max
    validationTimeoutMs: 20000, // 20s max
    maxConcurrentLLMCalls: 1, // No parallel calls
  },
};

export function getSupervisionConfig(level: SupervisionLevel): SupervisionConfig {
  return SUPERVISION_CONFIGS[level];
}
