/**
 * Simplified DraftValidator implementation focused on essential validation
 *
 * Uses a clean 3-layer approach:
 * 1. Schema validation (Zod-based)
 * 2. Reference validation (simple lookups)
 * 3. Completeness checking (basic requirements)
 *
 * Eliminates complex heuristics, quality scoring, and over-engineering
 * in favor of fast, reliable, schema-driven validation.
 */

import { z } from "zod/v4";
import type { WorkspaceConfig } from "@atlas/config";
import { WorkspaceConfigSchema } from "@atlas/config";
import type { WorkspaceDraft } from "../workspace-draft-store.ts";
import type {
  PublishingValidationResult,
  ReferenceValidationResult,
  SchemaValidationResult,
  ValidationContext,
  ValidationError,
  ValidationResult,
  ValidationWarning,
} from "./types.ts";

export interface SimpleCompletenessResult {
  overall: number; // 0-100
  hasWorkspace: boolean;
  hasAgents: boolean;
  hasJobs: boolean;
  hasSignals: boolean;
  missing: string[];
}

export interface SimplifiedValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  completeness: SimpleCompletenessResult;
  publishable: boolean;
}

export class SimplifiedDraftValidator {
  validateDraft(context: ValidationContext): ValidationResult {
    try {
      // Layer 1: Schema validation using existing Zod schema
      const schemaResult = this.validateSchema(context.config);

      // Layer 2: Basic reference validation (only if enabled)
      const referenceResult = context.validateReferences
        ? this.validateReferences(context.config)
        : { valid: true, brokenReferences: [], errors: [] };

      // Layer 3: Simple completeness check
      const completeness = this.checkCompleteness(context.config);

      // Combine errors - prioritize enhanced errors if available
      const schemaValidationErrors =
        schemaResult.enhancedErrors && schemaResult.enhancedErrors.length > 0
          ? schemaResult.enhancedErrors
          : this.schemaErrorsToValidationErrors(schemaResult);

      const allErrors: ValidationError[] = [
        ...schemaValidationErrors,
        ...referenceResult.errors,
      ];

      // Generate basic warnings
      const allWarnings: ValidationWarning[] = [];
      if (context.checkBestPractices) {
        allWarnings.push(...this.generateBasicWarnings(context.config));
      }

      const valid = allErrors.length === 0;
      const publishable = valid && completeness.overall >= 70;

      const result: ValidationResult = {
        valid,
        errors: allErrors,
        warnings: allWarnings,
        completionScore: completeness.overall,
        publishable,
        quality: {
          score: valid ? Math.min(100, completeness.overall + 10) : completeness.overall - 20,
          completeness: completeness.overall,
          consistency: valid ? 100 : 70,
          bestPractices: 80, // Simplified scoring
          complexity: this.assessComplexity(context.config),
          readiness: publishable
            ? "ready"
            : completeness.overall > 50
            ? "needs-review"
            : "incomplete",
        },
        suggestions: [], // Simplified - no complex suggestions
      };

      return result;
    } catch (error) {
      throw new Error(
        `Simplified validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  validateSchema(config: Partial<WorkspaceConfig>): SchemaValidationResult {
    try {
      // Use the excellent existing Zod schema
      WorkspaceConfigSchema.parse(config);

      return {
        valid: true,
        schemaErrors: [],
        missingRequired: [],
        invalidTypes: [],
        unknownProperties: [],
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        // Enhanced error messages with schema-aware suggestions
        const enhancedErrors: ValidationError[] = error.issues.map((issue) =>
          this.createEnhancedValidationError(issue, config)
        );

        // Legacy format for backward compatibility
        const schemaErrors = error.issues.map((issue) => ({
          path: issue.path.join("."),
          expected: this.getExpectedFromIssue(issue),
          actual: String(this.getActualFromIssue(issue)),
          constraint: issue.message,
        }));

        const missingRequired = error.issues
          .filter((issue) =>
            issue.code === "invalid_type" &&
            "received" in issue && issue.received === "undefined"
          )
          .map((issue) => issue.path.join("."));

        const invalidTypes = error.issues
          .filter((issue) =>
            issue.code === "invalid_type" &&
            "received" in issue && issue.received !== "undefined"
          )
          .map((issue) => ({
            path: issue.path.join("."),
            expectedType: this.getExpectedFromIssue(issue),
            actualType: "received" in issue ? String(issue.received) : "unknown",
            value: "input" in issue ? issue.input : undefined,
          }));

        const unknownProperties = error.issues
          .filter((issue) => issue.code === "unrecognized_keys")
          .flatMap((issue) => "keys" in issue ? issue.keys as string[] : []);

        return {
          valid: false,
          schemaErrors,
          missingRequired,
          invalidTypes,
          unknownProperties,
          enhancedErrors, // New enhanced errors with better messages
        };
      }

      throw error;
    }
  }

  validateReferences(
    config: Partial<WorkspaceConfig>,
  ): ReferenceValidationResult & { errors: ValidationError[] } {
    const errors: ValidationError[] = [];
    const brokenReferences = [];

    // Get available IDs
    const agentIds = new Set(Object.keys(config.agents || {}));
    const signalIds = new Set(Object.keys(config.signals || {}));

    // Validate job references
    if (config.jobs) {
      for (const [jobId, job] of Object.entries(config.jobs)) {
        // Check job triggers reference existing signals
        if (job.triggers) {
          for (const trigger of job.triggers) {
            if (!signalIds.has(trigger.signal)) {
              const brokenRef = {
                fromPath: `jobs.${jobId}.triggers`,
                fromComponent: jobId,
                toId: trigger.signal,
                referenceType: "signal" as const,
                severity: "error" as const,
              };
              brokenReferences.push(brokenRef);

              // Enhanced error message with available signals
              const availableSignals = Array.from(signalIds);
              const suggestion = availableSignals.length > 0
                ? `Available signals: [${availableSignals.join(", ")}]. Did you mean one of these?`
                : "Create the signal first, then reference it here";

              errors.push({
                code: "INVALID_SIGNAL_REFERENCE",
                message: `Job '${jobId}' references non-existent signal '${trigger.signal}'`,
                severity: "error",
                path: `jobs.${jobId}.triggers`,
                suggestion,
              });
            }
          }
        }

        // Check job execution agents exist
        if (job.execution?.agents) {
          for (const agent of job.execution.agents) {
            const agentId = typeof agent === "string" ? agent : agent.id;
            if (!agentIds.has(agentId)) {
              const brokenRef = {
                fromPath: `jobs.${jobId}.execution.agents`,
                fromComponent: jobId,
                toId: agentId,
                referenceType: "agent" as const,
                severity: "error" as const,
              };
              brokenReferences.push(brokenRef);

              // Enhanced error message with available agents
              const availableAgents = Array.from(agentIds);
              const closestMatch = this.findClosestMatch(agentId, availableAgents);

              let suggestion = "Create the agent first, then reference it here";
              if (availableAgents.length > 0) {
                suggestion = `Available agents: [${availableAgents.join(", ")}]`;
                if (closestMatch) {
                  suggestion += `. Did you mean '${closestMatch}'?`;
                }
              }

              errors.push({
                code: "INVALID_AGENT_REFERENCE",
                message: `Job '${jobId}' references non-existent agent '${agentId}'`,
                severity: "error",
                path: `jobs.${jobId}.execution.agents`,
                suggestion,
              });
            }
          }
        }
      }
    }

    // Simple circular dependency check: job → signal → job
    this.detectSimpleCircularDependencies(config, errors);

    return {
      valid: errors.length === 0,
      brokenReferences,
      circularDependencies: [],
      orphanedComponents: [],
      missingDependencies: [],
      errors,
    };
  }

  checkCompleteness(config: Partial<WorkspaceConfig>): SimpleCompletenessResult {
    const hasWorkspace = !!(config.workspace?.name && config.workspace?.description);
    const hasAgents = !!(config.agents && Object.keys(config.agents).length > 0);
    const hasJobs = !!(config.jobs && Object.keys(config.jobs).length > 0);
    const hasSignals = !!(config.signals && Object.keys(config.signals).length > 0);

    const missing = [];
    if (!hasWorkspace) missing.push("workspace metadata");
    if (!hasAgents) missing.push("agents");
    if (!hasJobs) missing.push("jobs");

    // Calculate simple overall score
    let score = 0;
    if (hasWorkspace) score += 25;
    if (hasAgents) score += 35;
    if (hasJobs) score += 35;
    if (hasSignals) score += 5; // Signals are optional

    return {
      overall: Math.min(100, score),
      hasWorkspace,
      hasAgents,
      hasJobs,
      hasSignals,
      missing,
    };
  }

  async validateForPublishing(draft: WorkspaceDraft): Promise<PublishingValidationResult> {
    const baseValidation = await this.validateDraft({
      draftId: draft.id,
      draft,
      config: draft.config,
      validateReferences: true,
      checkBestPractices: true,
      strictMode: true,
    });

    const publishingErrors = [];

    // Check basic publishing requirements
    if (baseValidation.completionScore < 70) {
      publishingErrors.push({
        code: "INCOMPLETE_CONFIGURATION",
        message:
          `Configuration is ${baseValidation.completionScore}% complete. At least 70% required.`,
        blocker: true,
        fix: "Add missing required components.",
      });
    }

    if (!draft.name?.trim()) {
      publishingErrors.push({
        code: "INVALID_WORKSPACE_NAME",
        message: "Workspace name is required for publishing.",
        blocker: true,
        fix: "Set a valid workspace name.",
      });
    }

    const canPublish = publishingErrors.filter((e) => e.blocker).length === 0 &&
      baseValidation.valid;

    return {
      ...baseValidation,
      canPublish,
      publishingErrors,
      publishingWarnings: [],
      estimatedFiles: [
        { path: "workspace.yml", size: 1000, type: "yaml" },
        { path: ".env", size: 200, type: "env" },
        { path: "README.md", size: 800, type: "markdown" },
        { path: ".gitignore", size: 100, type: "ignore" },
      ],
      pathConflicts: [],
    };
  }

  // Private helper methods
  private schemaErrorsToValidationErrors(result: SchemaValidationResult): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const schemaError of result.schemaErrors) {
      errors.push({
        code: "SCHEMA_VALIDATION_ERROR",
        message: `${schemaError.path}: ${schemaError.constraint}`,
        severity: "error",
        path: schemaError.path,
        suggestion: `Expected ${schemaError.expected}, got ${schemaError.actual}`,
        fixable: false,
      });
    }

    for (const missing of result.missingRequired) {
      errors.push({
        code: "MISSING_REQUIRED_FIELD",
        message: `Required field '${missing}' is missing`,
        severity: "error",
        path: missing,
        suggestion: `Add the required field '${missing}'`,
      });
    }

    return errors;
  }

  private generateBasicWarnings(config: Partial<WorkspaceConfig>): ValidationWarning[] {
    const warnings: ValidationWarning[] = [];

    // Check for short descriptions
    if (config.agents) {
      for (const [agentId, agent] of Object.entries(config.agents)) {
        if (!agent.description || agent.description.length < 10) {
          warnings.push({
            code: "SHORT_DESCRIPTION",
            message: `Agent '${agentId}' has a short or missing description`,
            path: `agents.${agentId}.description`,
            recommendation: "Add a clear description of what this agent does",
          });
        }
      }
    }

    return warnings;
  }

  private detectSimpleCircularDependencies(
    config: Partial<WorkspaceConfig>,
    errors: ValidationError[],
  ): void {
    if (!config.jobs || !config.signals) return;

    // Simple check: find jobs that trigger signals that trigger the same job
    for (const [jobId, job] of Object.entries(config.jobs)) {
      if (!job.triggers) continue;

      for (const trigger of job.triggers) {
        const signalId = trigger.signal;

        // Find other jobs that might produce this signal (simplified heuristic)
        for (const [otherJobId, otherJob] of Object.entries(config.jobs)) {
          if (otherJobId === jobId) continue;

          // Check if the other job might trigger a signal that this job listens to
          if (otherJob.triggers?.some((t) => t.signal === signalId)) {
            // Simple circular dependency detected
            errors.push({
              code: "POTENTIAL_CIRCULAR_DEPENDENCY",
              message:
                `Potential circular dependency between jobs '${jobId}' and '${otherJobId}' via signal '${signalId}'`,
              severity: "warning",
              suggestion: "Review job execution flow to avoid infinite loops",
            });
          }
        }
      }
    }
  }

  private assessComplexity(config: Partial<WorkspaceConfig>): "low" | "medium" | "high" {
    const componentCount = Object.keys(config.agents || {}).length +
      Object.keys(config.jobs || {}).length +
      Object.keys(config.signals || {}).length;

    if (componentCount <= 3) return "low";
    if (componentCount <= 8) return "medium";
    return "high";
  }

  /**
   * Enhanced schema-aware error message generation
   */
  private createEnhancedValidationError(
    issue: z.ZodIssue,
    config: Partial<WorkspaceConfig>,
  ): ValidationError {
    const path = issue.path.join(".");
    const pathSegments = issue.path;

    // Enhanced error messages based on issue type and path context
    switch (issue.code) {
      case "unrecognized_keys":
        return this.createUnrecognizedKeysError(issue, pathSegments, config);

      case "invalid_type":
        return this.createInvalidTypeError(issue, path);

      case "invalid_literal":
        return this.createInvalidLiteralError(issue, path);

      case "invalid_enum_value":
        return this.createInvalidEnumError(issue, path);

      default:
        return {
          code: "SCHEMA_VALIDATION_ERROR",
          message: `${path}: ${issue.message}`,
          severity: "error",
          path,
          suggestion: this.generateGenericSuggestion(issue, path),
        };
    }
  }

  private createUnrecognizedKeysError(
    issue: z.ZodIssue,
    pathSegments: (string | number)[],
    config: Partial<WorkspaceConfig>,
  ): ValidationError {
    const unknownKeys = "keys" in issue ? issue.keys as string[] : [];
    const path = pathSegments.join(".");
    const availableKeys = this.getAvailableKeysForPath(pathSegments, config);

    const suggestions = unknownKeys.map((key) => {
      const closest = this.findClosestMatch(key, availableKeys);
      return closest ? `Did you mean '${closest}'?` : `Remove '${key}'`;
    }).join(" ");

    return {
      code: "UNKNOWN_PROPERTY",
      message: `Unknown ${unknownKeys.length > 1 ? "properties" : "property"} '${
        unknownKeys.join("', '")
      }' at ${path}`,
      severity: "error",
      path,
      suggestion: availableKeys.length > 0
        ? `Available keys: [${availableKeys.join(", ")}]. ${suggestions}`
        : `Remove the unknown ${unknownKeys.length > 1 ? "properties" : "property"}.`,
    };
  }

  private createInvalidTypeError(issue: z.ZodIssue, path: string): ValidationError {
    const expected = "expected" in issue ? String(issue.expected) : "unknown";
    const received = "received" in issue ? String(issue.received) : "unknown";

    let suggestion = `Expected ${expected}, got ${received}`;

    // Specific suggestions based on common errors
    if (expected === "string" && received === "number") {
      suggestion = `Convert the number to a string (wrap in quotes)`;
    } else if (expected === "object" && received === "string") {
      suggestion = `This should be an object with properties, not a string`;
    } else if (expected === "array" && received === "object") {
      suggestion = `This should be an array [...], not an object {...}`;
    }

    return {
      code: "INVALID_TYPE",
      message: `Invalid type at ${path}: expected ${expected}, received ${received}`,
      severity: "error",
      path,
      suggestion,
    };
  }

  private createInvalidLiteralError(issue: z.ZodIssue, path: string): ValidationError {
    const expected = "expected" in issue ? String(issue.expected) : "unknown";
    const received = "received" in issue ? String(issue.received) : "unknown";

    return {
      code: "INVALID_VALUE",
      message: `Invalid value at ${path}: expected '${expected}', got '${received}'`,
      severity: "error",
      path,
      suggestion: `Change '${received}' to '${expected}'`,
    };
  }

  private createInvalidEnumError(issue: z.ZodIssue, path: string): ValidationError {
    const received = "received" in issue ? String(issue.received) : "unknown";
    const options = "options" in issue
      ? (issue.options as string[]).map((o) => `'${o}'`).join(", ")
      : "see documentation";

    return {
      code: "INVALID_ENUM_VALUE",
      message: `Invalid value '${received}' at ${path}`,
      severity: "error",
      path,
      suggestion: `Valid options: [${options}]`,
    };
  }

  private getAvailableKeysForPath(
    pathSegments: (string | number)[],
    config: Partial<WorkspaceConfig>,
  ): string[] {
    // Map known schema paths to their available keys
    const pathStr = pathSegments.join(".");

    if (pathStr === "" || pathSegments.length === 0) {
      return [
        "version",
        "workspace",
        "server",
        "tools",
        "signals",
        "jobs",
        "agents",
        "memory",
        "notifications",
        "federation",
      ];
    }

    if (pathStr === "workspace") {
      return ["name", "description"];
    }

    if (pathStr === "server") {
      return ["port", "host", "cors", "auth"];
    }

    if (pathSegments[0] === "agents" && pathSegments.length === 2) {
      return ["type", "model", "purpose", "prompts", "tools", "temperature", "max_tokens"];
    }

    if (pathSegments[0] === "jobs" && pathSegments.length === 2) {
      return ["name", "description", "triggers", "execution", "config"];
    }

    if (pathSegments[0] === "signals" && pathSegments.length === 2) {
      return ["description", "provider", "schedule", "path", "method", "schema"];
    }

    if (pathStr.endsWith(".execution")) {
      return ["strategy", "agents", "timeout", "retry"];
    }

    if (pathStr.endsWith(".prompts")) {
      return ["system", "user", "assistant"];
    }

    if (pathStr.endsWith(".tools")) {
      return ["mcp"];
    }

    // Dynamic keys from actual config
    if (pathSegments[0] === "agents" && pathSegments.length === 1) {
      return Object.keys(config.agents || {});
    }

    if (pathSegments[0] === "jobs" && pathSegments.length === 1) {
      return Object.keys(config.jobs || {});
    }

    if (pathSegments[0] === "signals" && pathSegments.length === 1) {
      return Object.keys(config.signals || {});
    }

    return [];
  }

  private findClosestMatch(target: string, options: string[]): string | null {
    if (options.length === 0) return null;

    // Simple Levenshtein-based closest match
    let closest: string = options[0];
    let minDistance = this.levenshteinDistance(target.toLowerCase(), closest.toLowerCase());

    for (const option of options.slice(1)) {
      const distance = this.levenshteinDistance(target.toLowerCase(), option.toLowerCase());
      if (distance < minDistance) {
        minDistance = distance;
        closest = option;
      }
    }

    // Only suggest if it's reasonably close (within 3 edits)
    return minDistance <= 3 ? closest : null;
  }

  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = Array(b.length + 1).fill(null).map(() =>
      Array(a.length + 1).fill(0)
    );

    for (let i = 0; i <= a.length; i++) matrix[0]![i] = i;
    for (let j = 0; j <= b.length; j++) matrix[j]![0] = j;

    for (let j = 1; j <= b.length; j++) {
      for (let i = 1; i <= a.length; i++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[j]![i] = Math.min(
          matrix[j - 1]![i]! + 1, // deletion
          matrix[j]![i - 1]! + 1, // insertion
          matrix[j - 1]![i - 1]! + cost, // substitution
        );
      }
    }

    return matrix[b.length]![a.length]!;
  }

  private generateGenericSuggestion(_issue: z.ZodIssue, path: string): string {
    if (path.includes("version")) {
      return "Set version to '1.0'";
    }
    if (path.includes("workspace.name")) {
      return "Provide a non-empty workspace name";
    }
    if (path.includes("workspace.description")) {
      return "Provide a non-empty workspace description";
    }
    return "Check the schema documentation for valid values";
  }

  private getExpectedFromIssue(issue: z.ZodIssue): string {
    if ("expected" in issue) return String(issue.expected);
    return "valid value";
  }

  private getActualFromIssue(issue: z.ZodIssue): string {
    if ("received" in issue) return String(issue.received);
    return "invalid";
  }
}
