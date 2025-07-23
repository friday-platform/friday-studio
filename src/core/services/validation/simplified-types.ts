/**
 * Simplified validation types for the new schema-based validation approach
 *
 * Focuses on essential validation results while eliminating the complexity
 * of the original validation system.
 */

import type { WorkspaceConfig } from "@atlas/config";
import type { WorkspaceDraft } from "../workspace-draft-store.ts";

// Core validation types (simplified)
export type ValidationSeverity = "error" | "warning" | "info";

export interface ValidationError {
  code: string;
  message: string;
  severity: ValidationSeverity;
  path?: string;
  suggestion?: string;
  fixable: boolean;
}

export interface ValidationWarning {
  code: string;
  message: string;
  path?: string;
  recommendation?: string;
}

// Simplified validation context
export interface SimplifiedValidationContext {
  draftId: string;
  draft: WorkspaceDraft;
  config: Partial<WorkspaceConfig>;
  validateReferences: boolean;
  checkBestPractices: boolean;
  strictMode: boolean;
}

// Simplified completeness result
export interface SimpleCompletenessResult {
  overall: number; // 0-100
  hasWorkspace: boolean;
  hasAgents: boolean;
  hasJobs: boolean;
  hasSignals: boolean;
  missing: string[];
  level: "incomplete" | "draft" | "review" | "ready" | "production";
}

// Simplified quality assessment
export interface SimpleQualityAssessment {
  score: number; // 0-100
  completeness: number;
  consistency: number;
  complexity: "low" | "medium" | "high";
  readiness: "incomplete" | "needs-review" | "ready" | "production-ready";
}

// Main validation result (simplified)
export interface SimplifiedValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  completeness: SimpleCompletenessResult;
  quality: SimpleQualityAssessment;
  publishable: boolean;
}

// Schema validation result (reuse existing)
export interface SchemaValidationResult {
  valid: boolean;
  schemaErrors: SchemaError[];
  missingRequired: string[];
  invalidTypes: TypeValidationError[];
  unknownProperties: string[];
}

export interface SchemaError {
  path: string;
  expected: string;
  actual: string;
  constraint: string;
}

export interface TypeValidationError {
  path: string;
  expectedType: string;
  actualType: string;
  value: unknown;
}

// Reference validation (simplified)
export interface SimpleReferenceResult {
  valid: boolean;
  brokenReferences: BrokenReference[];
  errors: ValidationError[];
}

export interface BrokenReference {
  fromPath: string;
  fromComponent: string;
  toId: string;
  referenceType: "agent" | "signal" | "job";
  severity: ValidationSeverity;
}

// Publishing validation (simplified)
export interface SimplePublishingResult extends SimplifiedValidationResult {
  canPublish: boolean;
  publishingErrors: PublishingError[];
  estimatedFiles: EstimatedFile[];
}

export interface PublishingError {
  code: string;
  message: string;
  blocker: boolean;
  fix?: string;
}

export interface EstimatedFile {
  path: string;
  size: number;
  type: "yaml" | "env" | "markdown" | "ignore";
}

// Quick validation for common issues
export interface QuickValidationResult {
  critical: string[];
  warnings: string[];
  suggestions: string[];
  score: number; // 0-100
  canProceed: boolean;
}

// Completeness level validation
export type CompletenessLevel = "draft" | "review" | "ready" | "production";

export interface CompletenessLevelResult {
  level: CompletenessLevel;
  valid: boolean;
  missing: string[];
  requirements: {
    requiredFields: string[];
    minAgents?: number;
    minJobs?: number;
    minSignals?: number;
    minScore: number;
  };
}

// Main simplified validator interface
export interface SimplifiedDraftValidator {
  // Core validation methods
  validateDraft(context: SimplifiedValidationContext): Promise<SimplifiedValidationResult>;
  validateSchema(config: Partial<WorkspaceConfig>): Promise<SchemaValidationResult>;
  validateReferences(config: Partial<WorkspaceConfig>): SimpleReferenceResult;
  checkCompleteness(config: Partial<WorkspaceConfig>): SimpleCompletenessResult;

  // Publishing validation
  validateForPublishing(draft: WorkspaceDraft): Promise<SimplePublishingResult>;

  // Quick validation utilities
  quickValidate(config: Partial<WorkspaceConfig>): QuickValidationResult;
  validateCompletenessLevel(
    config: Partial<WorkspaceConfig>,
    level: CompletenessLevel,
  ): CompletenessLevelResult;
}

// Validation event (simplified)
export interface ValidationEvent {
  timestamp: string;
  draftId: string;
  operation: string;
  result: "success" | "failure";
  duration: number;
  errorCount: number;
  warningCount: number;
}

// Validation metrics (simplified)
export interface ValidationMetrics {
  totalValidations: number;
  successRate: number;
  averageDuration: number;
  commonErrors: Array<{ code: string; count: number; percentage: number }>;
  completenessDistribution: Record<CompletenessLevel, number>;
}

// Configuration readiness levels with clear criteria
export const ReadinessLevels = {
  incomplete: {
    description: "Missing critical components",
    minScore: 0,
    requirements: [],
  },
  draft: {
    description: "Basic structure in place",
    minScore: 30,
    requirements: ["workspace.name"],
  },
  review: {
    description: "Ready for review",
    minScore: 50,
    requirements: ["workspace.name", "workspace.description", "at least 1 agent"],
  },
  ready: {
    description: "Ready for testing",
    minScore: 70,
    requirements: ["workspace.name", "workspace.description", "at least 1 agent", "at least 1 job"],
  },
  production: {
    description: "Production ready",
    minScore: 90,
    requirements: [
      "workspace.name",
      "workspace.description",
      "at least 1 agent",
      "at least 1 job",
      "at least 1 signal",
      "proper error handling",
    ],
  },
} as const;

// Validation rule categories (simplified)
export type ValidationCategory =
  | "schema" // Zod schema validation
  | "references" // Cross-reference validation
  | "completeness" // Required components
  | "best-practices" // Recommendations
  | "publishing"; // Publishing readiness

// Common validation error codes (simplified set)
export const ValidationErrorCodes = {
  // Schema errors
  SCHEMA_VALIDATION_ERROR: "SCHEMA_VALIDATION_ERROR",
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
  INVALID_TYPE: "INVALID_TYPE",
  UNKNOWN_PROPERTY: "UNKNOWN_PROPERTY",

  // Reference errors
  INVALID_AGENT_REFERENCE: "INVALID_AGENT_REFERENCE",
  INVALID_SIGNAL_REFERENCE: "INVALID_SIGNAL_REFERENCE",
  POTENTIAL_CIRCULAR_DEPENDENCY: "POTENTIAL_CIRCULAR_DEPENDENCY",

  // Completeness errors
  MISSING_WORKSPACE_NAME: "MISSING_WORKSPACE_NAME",
  MISSING_AGENTS: "MISSING_AGENTS",
  MISSING_JOBS: "MISSING_JOBS",

  // Publishing errors
  INCOMPLETE_CONFIGURATION: "INCOMPLETE_CONFIGURATION",
  INVALID_WORKSPACE_NAME: "INVALID_WORKSPACE_NAME",

  // Warning codes
  SHORT_DESCRIPTION: "SHORT_DESCRIPTION",
  MISSING_SIGNALS: "MISSING_SIGNALS",
  NO_TOOLS_CONFIGURED: "NO_TOOLS_CONFIGURED",
} as const;

export type ValidationErrorCode = keyof typeof ValidationErrorCodes;
