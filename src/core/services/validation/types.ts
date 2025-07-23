/**
 * Core validation types for Atlas workspace draft validation system
 *
 * Provides comprehensive validation infrastructure for:
 * - Schema validation against Atlas workspace configuration
 * - Reference validation for agent/job/signal relationships
 * - Conflict detection for naming and circular dependencies
 * - Quality assessment and completeness scoring
 */

import type { WorkspaceConfig } from "@atlas/config";
import type { WorkspaceDraft } from "../workspace-draft-store.ts";

export type ValidationSeverity = "error" | "warning" | "info";

export interface ValidationError {
  code: string;
  message: string;
  severity: ValidationSeverity;
  path?: string; // JSONPath to the problematic configuration
  suggestion?: string;
}

export interface ValidationWarning {
  code: string;
  message: string;
  path?: string;
  recommendation?: string;
}

export interface ValidationContext {
  draftId: string;
  draft: WorkspaceDraft;
  config: Partial<WorkspaceConfig>;
  validateReferences: boolean;
  checkBestPractices: boolean;
  strictMode: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  completionScore: number; // 0-100% how complete the configuration is
  publishable: boolean; // Whether safe to publish
  quality: QualityAssessment;
  suggestions: ValidationSuggestion[];
}

export interface QualityAssessment {
  score: number; // 0-100 overall quality score
  completeness: number; // 0-100 how complete
  consistency: number; // 0-100 internal consistency
  bestPractices: number; // 0-100 follows best practices
  complexity: "low" | "medium" | "high";
  readiness: "incomplete" | "needs-review" | "ready" | "production-ready";
}

export interface ValidationSuggestion {
  type: "add" | "modify" | "remove" | "refactor";
  target: string; // What to change
  reason: string; // Why change it
  priority: "low" | "medium" | "high" | "critical";
  autoFixable: boolean;
  fix?: AutoFix;
}

export interface AutoFix {
  operation: string;
  path: string;
  value: unknown;
  description: string;
}

// Schema-specific validation results
export interface SchemaValidationResult {
  valid: boolean;
  schemaErrors: SchemaError[];
  missingRequired: string[];
  invalidTypes: TypeValidationError[];
  unknownProperties: string[];
  enhancedErrors?: ValidationError[]; // New enhanced errors with better messages
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

// Reference validation results
export interface ReferenceValidationResult {
  valid: boolean;
  brokenReferences: BrokenReference[];
  circularDependencies: CircularDependency[];
  orphanedComponents: OrphanedComponent[];
  missingDependencies: MissingDependency[];
}

export interface BrokenReference {
  fromPath: string;
  fromComponent: string;
  toId: string;
  referenceType: "agent" | "job" | "signal" | "tool";
  severity: ValidationSeverity;
}

export interface CircularDependency {
  cycle: string[];
  type: "job-dependency" | "agent-reference" | "signal-trigger";
  severity: ValidationSeverity;
}

export interface OrphanedComponent {
  id: string;
  type: "agent" | "job" | "signal" | "tool";
  reason: string;
}

export interface MissingDependency {
  requiredBy: string;
  requiredId: string;
  requiredType: "agent" | "job" | "signal" | "tool";
  context: string;
}

// Conflict detection results
export interface ConflictValidationResult {
  valid: boolean;
  namingConflicts: NamingConflict[];
  resourceConflicts: ResourceConflict[];
  configurationConflicts: ConfigurationConflict[];
}

export interface NamingConflict {
  name: string;
  conflictingPaths: string[];
  type: "duplicate-id" | "reserved-name" | "invalid-chars";
  severity: ValidationSeverity;
}

export interface ResourceConflict {
  resource: string;
  conflictType: "port" | "file" | "environment" | "permission";
  conflictingComponents: string[];
  severity: ValidationSeverity;
}

export interface ConfigurationConflict {
  setting: string;
  conflictingValues: Array<{ component: string; value: unknown; path: string }>;
  resolution: string;
  severity: ValidationSeverity;
}

// Publishing validation results
export interface PublishingValidationResult extends ValidationResult {
  canPublish: boolean;
  publishingErrors: PublishingError[];
  publishingWarnings: PublishingWarning[];
  estimatedFiles: EstimatedFile[];
  pathConflicts: PathConflict[];
}

export interface PublishingError {
  code: string;
  message: string;
  blocker: boolean; // Whether this prevents publishing
  component?: string;
  fix?: string;
}

export interface PublishingWarning {
  code: string;
  message: string;
  recommendation?: string;
  impact: "low" | "medium" | "high";
}

export interface EstimatedFile {
  path: string;
  size: number;
  type: "yaml" | "env" | "markdown" | "ignore";
  preview?: string; // First few lines
}

export interface PathConflict {
  path: string;
  conflictType: "existing-file" | "permission-denied" | "invalid-path";
  resolution: "overwrite" | "rename" | "skip" | "error";
}

// Validation rule definitions
export interface ValidationRule {
  id: string;
  name: string;
  description: string;
  category: "schema" | "references" | "conflicts" | "best-practices" | "security";
  severity: ValidationSeverity;
  enabled: boolean;
  validate: (context: ValidationContext) => Promise<ValidationError[]>;
}

export interface ValidationRuleSet {
  name: string;
  description: string;
  rules: ValidationRule[];
  strictMode: boolean;
}

// Configuration completeness assessment
export interface CompletenessCheck {
  component: "workspace" | "agents" | "jobs" | "signals" | "tools" | "memory";
  required: boolean;
  present: boolean;
  quality: number; // 0-100 quality of what's present
  suggestions: string[];
}

export interface CompletenessResult {
  overall: number; // 0-100 overall completeness
  components: CompletenessCheck[];
  criticalMissing: string[]; // Things that must be added
  recommendedNext: string[]; // Suggested next steps
}

// Fix suggestions and auto-repair
export interface FixSuggestion {
  errorCode: string;
  fix: AutoFix;
  confidence: number; // 0-100 confidence this fix is correct
  sideEffects: string[]; // Potential side effects
  preview: string; // Human-readable description of what will change
}

export interface RepairPlan {
  fixes: FixSuggestion[];
  order: number[]; // Index order to apply fixes
  totalChanges: number;
  riskLevel: "low" | "medium" | "high";
  requiresManualReview: boolean;
}

// Validation event types for monitoring
export interface ValidationEvent {
  timestamp: string;
  draftId: string;
  operation: string;
  result: "success" | "failure" | "warning";
  duration: number; // milliseconds
  errors: number;
  warnings: number;
  validatorVersion: string;
}

// Main validator interface
export interface DraftValidator {
  validateDraft(context: ValidationContext): Promise<ValidationResult>;
  validateSchema(config: Partial<WorkspaceConfig>): Promise<SchemaValidationResult>;
  validateReferences(draft: WorkspaceDraft): Promise<ReferenceValidationResult>;
  validateConflicts(draft: WorkspaceDraft): Promise<ConflictValidationResult>;
  validateForPublishing(draft: WorkspaceDraft): Promise<PublishingValidationResult>;

  assessCompleteness(draft: WorkspaceDraft): CompletenessResult;
  generateFixSuggestions(errors: ValidationError[]): Promise<FixSuggestion[]>;
  createRepairPlan(draft: WorkspaceDraft): Promise<RepairPlan>;

  addCustomRule(rule: ValidationRule): void;
  removeCustomRule(ruleId: string): void;
  listAvailableRules(): ValidationRule[];
}
