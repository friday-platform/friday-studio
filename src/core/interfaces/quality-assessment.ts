/**
 * Structured Quality Assessment Interfaces
 *
 * Defines the interfaces for comprehensive quality assessment of agent execution results
 * to replace the primitive keyword-based detection in SessionSupervisor.
 */

export interface QualityAssessment {
  sessionSuccess: boolean;
  confidence: number; // 0-100
  overallReasoning: string;
  agentEvaluations: AgentEvaluation[];
  successCriteriaEvaluation: CriterionEvaluation[];
  qualityIssues: QualityIssue[];
  nextAction: "complete" | "retry" | "adapt" | "escalate";
  actionReasoning: string;
  executionSummary?: string; // Optional summary for logging/monitoring
}

export interface AgentEvaluation {
  agentId: string;
  individualSuccess: boolean;
  completeness: DimensionScore;
  accuracy: DimensionScore;
  format: DimensionScore;
  relevance: DimensionScore;
  outputSummary?: string; // Brief description of what the agent produced
}

export interface DimensionScore {
  score: number; // 0-100
  reasoning: string;
  issues: string[];
  evidence?: string[]; // Specific evidence supporting the score
}

export interface CriterionEvaluation {
  criterion: string;
  met: boolean;
  evidence: string;
  reasoning: string;
  confidence: number; // 0-100, confidence in this evaluation
}

export interface QualityIssue {
  severity: "critical" | "major" | "minor";
  description: string;
  affectedAgents: string[];
  recommendation: string;
  impact?: "blocking" | "degraded" | "cosmetic"; // Impact on session completion
}

// Assessment validation and parsing interfaces
export interface AssessmentValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  parsedAssessment?: QualityAssessment;
}

export interface AssessmentMetrics {
  sessionId: string;
  assessmentConfidence: number;
  agentsEvaluated: number;
  agentsExecuted: number;
  criticalIssues: number;
  majorIssues: number;
  minorIssues: number;
  overallSuccess: boolean;
  evaluationMethod: "structured_llm" | "fallback" | "advanced_reasoning";
  evaluationDuration: number; // milliseconds
  timestamp: string;
}

// Confidence calibration constants
export const CONFIDENCE_LEVELS = {
  VERY_HIGH: { min: 90, max: 100, description: "Very High Confidence" },
  HIGH: { min: 70, max: 89, description: "High Confidence" },
  MEDIUM: { min: 50, max: 69, description: "Medium Confidence" },
  LOW: { min: 30, max: 49, description: "Low Confidence" },
  VERY_LOW: { min: 0, max: 29, description: "Very Low Confidence" },
} as const;

// Quality thresholds for scoring
export const QUALITY_THRESHOLDS = {
  EXCELLENT: { min: 90, max: 100 },
  GOOD: { min: 70, max: 89 },
  ACCEPTABLE: { min: 50, max: 69 },
  POOR: { min: 30, max: 49 },
  FAILING: { min: 0, max: 29 },
} as const;

// Assessment parsing validation schema
export interface QualityAssessmentSchema {
  required_fields: string[];
  optional_fields: string[];
  field_types: Record<string, string>;
  validation_rules: Record<string, (value: unknown) => boolean>;
}

export const QUALITY_ASSESSMENT_SCHEMA: QualityAssessmentSchema = {
  required_fields: [
    "sessionSuccess",
    "confidence",
    "overallReasoning",
    "agentEvaluations",
    "successCriteriaEvaluation",
    "qualityIssues",
    "nextAction",
    "actionReasoning",
  ],
  optional_fields: [
    "executionSummary",
  ],
  field_types: {
    "sessionSuccess": "boolean",
    "confidence": "number",
    "overallReasoning": "string",
    "agentEvaluations": "array",
    "successCriteriaEvaluation": "array",
    "qualityIssues": "array",
    "nextAction": "string",
    "actionReasoning": "string",
    "executionSummary": "string",
  },
  validation_rules: {
    "confidence": (value: number) => value >= 0 && value <= 100,
    "nextAction": (value: string) => ["complete", "retry", "adapt", "escalate"].includes(value),
    "agentEvaluations": (value: unknown[]) => Array.isArray(value) && value.length > 0,
  },
};
