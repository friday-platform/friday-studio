/**
 * Core DraftValidator implementation with comprehensive validation
 *
 * Provides schema validation, reference checking, conflict detection,
 * and quality assessment for workspace drafts.
 */

import { z } from "zod/v4";
import type { WorkspaceConfig } from "@atlas/config";
import { WorkspaceConfigSchema } from "@atlas/config";
import type { WorkspaceDraft } from "../workspace-draft-store.ts";
import type {
  CompletenessCheck,
  CompletenessResult,
  ConflictValidationResult,
  DraftValidator,
  FixSuggestion,
  PublishingValidationResult,
  QualityAssessment,
  ReferenceValidationResult,
  RepairPlan,
  SchemaValidationResult,
  ValidationContext,
  ValidationError,
  ValidationEvent,
  ValidationResult,
  ValidationRule,
  ValidationSuggestion,
  ValidationWarning,
} from "./types.ts";

export class AtlasDraftValidator implements DraftValidator {
  private customRules: Map<string, ValidationRule> = new Map();
  private validationEvents: ValidationEvent[] = [];
  private readonly version = "1.0.0";

  async validateDraft(context: ValidationContext): Promise<ValidationResult> {
    const startTime = Date.now();

    try {
      // Perform comprehensive validation
      const schemaResult = await this.validateSchema(context.config);
      const referenceResult = context.validateReferences
        ? await this.validateReferences(context.draft)
        : {
          valid: true,
          brokenReferences: [],
          circularDependencies: [],
          orphanedComponents: [],
          missingDependencies: [],
        };
      const conflictResult = await this.validateConflicts(context.draft);

      // Assess completeness and quality
      const completeness = this.assessCompleteness(context.draft);
      const quality = this.assessQuality(
        context.draft,
        schemaResult,
        referenceResult,
        conflictResult,
      );

      // Combine all errors and warnings
      const allErrors: ValidationError[] = [
        ...this.schemaErrorsToValidationErrors(schemaResult),
        ...this.referenceErrorsToValidationErrors(referenceResult),
        ...this.conflictErrorsToValidationErrors(conflictResult),
      ];

      const allWarnings: ValidationWarning[] = [
        ...this.generateBestPracticeWarnings(context.draft),
      ];

      // Generate suggestions
      const suggestions = await this.generateSuggestions(context.draft, allErrors, allWarnings);

      const valid = allErrors.length === 0;
      const publishable = valid && completeness.overall >= 70; // 70% completeness required

      const result: ValidationResult = {
        valid,
        errors: allErrors,
        warnings: allWarnings,
        completionScore: completeness.overall,
        publishable,
        quality,
        suggestions,
      };

      // Record validation event
      this.recordValidationEvent(
        context.draftId,
        "validate_draft",
        "success",
        Date.now() - startTime,
        allErrors.length,
        allWarnings.length,
      );

      return result;
    } catch (error) {
      this.recordValidationEvent(
        context.draftId,
        "validate_draft",
        "failure",
        Date.now() - startTime,
        1,
        0,
      );
      throw new Error(
        `Validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async validateSchema(config: Partial<WorkspaceConfig>): Promise<SchemaValidationResult> {
    try {
      // Use Zod to validate against the Atlas workspace schema
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
        const schemaErrors = error.issues.map((issue) => ({
          path: issue.path.join("."),
          expected: (issue as any).expected || "valid value",
          actual: String((issue as any).received || "invalid"),
          constraint: issue.message,
        }));

        const missingRequired = error.issues
          .filter((issue) =>
            issue.code === "invalid_type" && (issue as any).received === "undefined"
          )
          .map((issue) => issue.path.join("."));

        const invalidTypes = error.issues
          .filter((issue) =>
            issue.code === "invalid_type" && (issue as any).received !== "undefined"
          )
          .map((issue) => ({
            path: issue.path.join("."),
            expectedType: (issue as any).expected || "unknown",
            actualType: (issue as any).received || "unknown",
            value: (issue as any).input,
          }));

        const unknownProperties = error.issues
          .filter((issue) => issue.code === "unrecognized_keys")
          .flatMap((issue) => (issue as any).keys || []);

        return {
          valid: false,
          schemaErrors,
          missingRequired,
          invalidTypes,
          unknownProperties,
        };
      }

      throw error;
    }
  }

  async validateReferences(draft: WorkspaceDraft): Promise<ReferenceValidationResult> {
    const config = draft.config;
    const brokenReferences = [];
    const circularDependencies = [];
    const orphanedComponents = [];
    const missingDependencies = [];

    // Extract all component IDs
    const agentIds = new Set(Object.keys(config.agents || {}));
    const jobIds = new Set(Object.keys(config.jobs || {}));
    const signalIds = new Set(Object.keys(config.signals || {}));

    // Check job references to agents and signals
    if (config.jobs) {
      for (const [jobId, job] of Object.entries(config.jobs)) {
        // Check triggers reference valid signals
        if (job.triggers) {
          for (const trigger of job.triggers) {
            if (!signalIds.has(trigger.signal)) {
              brokenReferences.push({
                fromPath: `jobs.${jobId}.triggers`,
                fromComponent: jobId,
                toId: trigger.signal,
                referenceType: "signal",
                severity: "error" as const,
              });
            }
          }
        }

        // Check execution agents exist
        if (job.execution?.agents) {
          for (const agent of job.execution.agents) {
            const agentId = typeof agent === "string" ? agent : agent.id;
            if (!agentIds.has(agentId)) {
              brokenReferences.push({
                fromPath: `jobs.${jobId}.execution.agents`,
                fromComponent: jobId,
                toId: agentId,
                referenceType: "agent",
                severity: "error" as const,
              });
            }
          }
        }
      }
    }

    // Check for orphaned components (defined but never used)
    this.findOrphanedAgents(config, orphanedComponents);
    this.findOrphanedSignals(config, orphanedComponents);

    // Check for circular dependencies in job chains
    this.detectCircularJobDependencies(config, circularDependencies);

    // Check for missing dependencies
    this.findMissingDependencies(config, missingDependencies);

    return {
      valid: brokenReferences.length === 0 && circularDependencies.length === 0 &&
        missingDependencies.length === 0,
      brokenReferences,
      circularDependencies,
      orphanedComponents,
      missingDependencies,
    };
  }

  async validateConflicts(draft: WorkspaceDraft): Promise<ConflictValidationResult> {
    const config = draft.config;
    const namingConflicts = [];
    const resourceConflicts = [];
    const configurationConflicts = [];

    // Check for duplicate IDs across different component types
    const allIds = new Set<string>();
    const duplicateIds = new Set<string>();

    // Collect all IDs and find duplicates
    for (const componentType of ["agents", "jobs", "signals"] as const) {
      const components = config[componentType];
      if (components) {
        for (const id of Object.keys(components)) {
          if (allIds.has(id)) {
            duplicateIds.add(id);
          }
          allIds.add(id);
        }
      }
    }

    // Report naming conflicts
    for (const duplicateId of duplicateIds) {
      const conflictingPaths = [];
      for (const componentType of ["agents", "jobs", "signals"] as const) {
        if (config[componentType]?.[duplicateId]) {
          conflictingPaths.push(`${componentType}.${duplicateId}`);
        }
      }

      namingConflicts.push({
        name: duplicateId,
        conflictingPaths,
        type: "duplicate-id" as const,
        severity: "error" as const,
      });
    }

    // Check for configuration conflicts (e.g., multiple agents using same port)
    this.detectResourceConflicts(config, resourceConflicts);

    return {
      valid: namingConflicts.length === 0 && resourceConflicts.length === 0 &&
        configurationConflicts.length === 0,
      namingConflicts,
      resourceConflicts,
      configurationConflicts,
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
    const publishingWarnings = [];
    const estimatedFiles = [];
    const pathConflicts = [];

    // Check if configuration is complete enough for publishing
    if (baseValidation.completionScore < 70) {
      publishingErrors.push({
        code: "INCOMPLETE_CONFIGURATION",
        message:
          `Configuration is only ${baseValidation.completionScore}% complete. At least 70% completion required for publishing.`,
        blocker: true,
        fix: "Complete the missing required components before publishing.",
      });
    }

    // Estimate files that will be created
    estimatedFiles.push(
      { path: "workspace.yml", size: this.estimateWorkspaceYmlSize(draft.config), type: "yaml" },
      { path: ".env", size: 500, type: "env" },
      { path: "README.md", size: 1500, type: "markdown" },
      { path: ".gitignore", size: 300, type: "ignore" },
    );

    // Check workspace name validity
    if (!draft.name || draft.name.trim().length === 0) {
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
      publishingWarnings,
      estimatedFiles,
      pathConflicts,
    };
  }

  assessCompleteness(draft: WorkspaceDraft): CompletenessResult {
    const config = draft.config;
    const components: CompletenessCheck[] = [];

    // Workspace metadata
    components.push({
      component: "workspace",
      required: true,
      present: !!(config.workspace?.name && config.workspace?.description),
      quality: this.assessWorkspaceQuality(config.workspace),
      suggestions: config.workspace ? [] : ["Add workspace name and description"],
    });

    // Agents
    const hasAgents = config.agents && Object.keys(config.agents).length > 0;
    components.push({
      component: "agents",
      required: true,
      present: hasAgents,
      quality: this.assessAgentsQuality(config.agents),
      suggestions: hasAgents ? [] : ["Add at least one agent to perform tasks"],
    });

    // Jobs
    const hasJobs = !!(config.jobs && Object.keys(config.jobs).length > 0);
    components.push({
      component: "jobs",
      required: true,
      present: hasJobs,
      quality: this.assessJobsQuality(config.jobs),
      suggestions: hasJobs ? [] : ["Add jobs to define workflows"],
    });

    // Signals
    const hasSignals = !!(config.signals && Object.keys(config.signals).length > 0);
    components.push({
      component: "signals",
      required: false,
      present: hasSignals,
      quality: this.assessSignalsQuality(config.signals),
      suggestions: hasSignals ? [] : ["Consider adding signals to trigger workflows"],
    });

    // Tools
    const hasTools = !!(config.tools && Object.keys(config.tools).length > 0);
    components.push({
      component: "tools",
      required: false,
      present: hasTools,
      quality: this.assessToolsQuality(config.tools),
      suggestions: [],
    });

    // Memory
    const hasMemory = !!config.memory;
    components.push({
      component: "memory",
      required: false,
      present: hasMemory,
      quality: hasMemory ? 100 : 0,
      suggestions: hasMemory ? [] : ["Consider configuring memory for persistent context"],
    });

    // Calculate overall completeness
    const requiredComponents = components.filter((c) => c.required);
    const presentRequired = requiredComponents.filter((c) => c.present);
    const requiredCompleteness = (presentRequired.length / requiredComponents.length) * 100;

    const totalQuality = components.reduce((sum, c) => sum + (c.present ? c.quality : 0), 0) /
      components.length;

    const overall = Math.min(100, (requiredCompleteness * 0.8) + (totalQuality * 0.2));

    const criticalMissing = components
      .filter((c) => c.required && !c.present)
      .map((c) => `${c.component}`);

    const recommendedNext = components
      .filter((c) => !c.required && !c.present && c.component !== "memory")
      .map((c) => `Add ${c.component}`)
      .slice(0, 3);

    return {
      overall: Math.round(overall),
      components,
      criticalMissing,
      recommendedNext,
    };
  }

  async generateFixSuggestions(errors: ValidationError[]): Promise<FixSuggestion[]> {
    const suggestions: FixSuggestion[] = [];

    for (const error of errors) {
      if (error.fixable) {
        switch (error.code) {
          case "MISSING_REQUIRED_FIELD":
            suggestions.push({
              errorCode: error.code,
              fix: {
                operation: "add",
                path: error.path || "",
                value: this.getDefaultValue(error.path || ""),
                description: `Add default value for ${error.path}`,
              },
              confidence: 80,
              sideEffects: [],
              preview: `Add default configuration for ${error.path}`,
            });
            break;

          case "INVALID_REFERENCE":
            suggestions.push({
              errorCode: error.code,
              fix: {
                operation: "remove",
                path: error.path || "",
                value: null,
                description: `Remove invalid reference`,
              },
              confidence: 90,
              sideEffects: ["May break dependent components"],
              preview: `Remove broken reference at ${error.path}`,
            });
            break;
        }
      }
    }

    return suggestions;
  }

  async createRepairPlan(draft: WorkspaceDraft): Promise<RepairPlan> {
    const validation = await this.validateDraft({
      draftId: draft.id,
      draft,
      config: draft.config,
      validateReferences: true,
      checkBestPractices: false,
      strictMode: false,
    });

    const fixes = await this.generateFixSuggestions(validation.errors.filter((e) => e.fixable));

    return {
      fixes,
      order: fixes.map((_, index) => index), // Simple ordering for now
      totalChanges: fixes.length,
      riskLevel: fixes.some((f) => f.confidence < 70)
        ? "high"
        : fixes.some((f) => f.sideEffects.length > 0)
        ? "medium"
        : "low",
      requiresManualReview: fixes.some((f) => f.confidence < 90),
    };
  }

  // Rule management
  addCustomRule(rule: ValidationRule): void {
    this.customRules.set(rule.id, rule);
  }

  removeCustomRule(ruleId: string): void {
    this.customRules.delete(ruleId);
  }

  listAvailableRules(): ValidationRule[] {
    return Array.from(this.customRules.values());
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
        fixable: true,
      });
    }

    return errors;
  }

  private referenceErrorsToValidationErrors(result: ReferenceValidationResult): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const brokenRef of result.brokenReferences) {
      errors.push({
        code: "INVALID_REFERENCE",
        message:
          `${brokenRef.fromComponent} references non-existent ${brokenRef.referenceType} '${brokenRef.toId}'`,
        severity: brokenRef.severity,
        path: brokenRef.fromPath,
        suggestion:
          `Remove reference to '${brokenRef.toId}' or create the missing ${brokenRef.referenceType}`,
        fixable: true,
      });
    }

    for (const cycle of result.circularDependencies) {
      errors.push({
        code: "CIRCULAR_DEPENDENCY",
        message: `Circular dependency detected: ${cycle.cycle.join(" → ")}`,
        severity: cycle.severity,
        suggestion: "Break the circular dependency by removing one of the references",
        fixable: false,
      });
    }

    return errors;
  }

  private conflictErrorsToValidationErrors(result: ConflictValidationResult): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const conflict of result.namingConflicts) {
      errors.push({
        code: "NAMING_CONFLICT",
        message: `Duplicate identifier '${conflict.name}' found in: ${
          conflict.conflictingPaths.join(", ")
        }`,
        severity: conflict.severity,
        suggestion: `Rename one of the conflicting components`,
        fixable: false,
      });
    }

    return errors;
  }

  private generateBestPracticeWarnings(draft: WorkspaceDraft): ValidationWarning[] {
    const warnings: ValidationWarning[] = [];
    const config = draft.config;

    // Check for missing descriptions
    if (config.agents) {
      for (const [agentId, agent] of Object.entries(config.agents)) {
        if (!agent.description || agent.description.trim().length < 10) {
          warnings.push({
            code: "SHORT_DESCRIPTION",
            message: `Agent '${agentId}' has a very short or missing description`,
            path: `agents.${agentId}.description`,
            recommendation: "Add a clear description explaining what this agent does",
          });
        }
      }
    }

    return warnings;
  }

  private async generateSuggestions(
    _draft: WorkspaceDraft,
    errors: ValidationError[],
    _warnings: ValidationWarning[],
  ): Promise<ValidationSuggestion[]> {
    const suggestions: ValidationSuggestion[] = [];

    // Suggest fixes for common issues
    if (errors.some((e) => e.code === "MISSING_REQUIRED_FIELD")) {
      suggestions.push({
        type: "add",
        target: "required fields",
        reason: "Complete required configuration fields",
        priority: "critical",
        autoFixable: true,
      });
    }

    return suggestions;
  }

  private assessQuality(
    draft: WorkspaceDraft,
    schema: SchemaValidationResult,
    references: ReferenceValidationResult,
    conflicts: ConflictValidationResult,
  ): QualityAssessment {
    const schemaScore = schema.valid ? 100 : Math.max(0, 100 - (schema.schemaErrors.length * 10));
    const referenceScore = references.valid
      ? 100
      : Math.max(0, 100 - (references.brokenReferences.length * 15));
    const conflictScore = conflicts.valid
      ? 100
      : Math.max(0, 100 - (conflicts.namingConflicts.length * 20));
    const completeness = this.assessCompleteness(draft).overall;

    const consistency = Math.min(schemaScore, referenceScore, conflictScore);
    const bestPractices = this.assessBestPractices(draft);
    const score = Math.round((consistency + completeness + bestPractices) / 3);

    let complexity: "low" | "medium" | "high" = "low";
    const componentCount = Object.keys(draft.config.agents || {}).length +
      Object.keys(draft.config.jobs || {}).length +
      Object.keys(draft.config.signals || {}).length;
    if (componentCount > 10) complexity = "high";
    else if (componentCount > 5) complexity = "medium";

    let readiness: "incomplete" | "needs-review" | "ready" | "production-ready" = "incomplete";
    if (score >= 95) readiness = "production-ready";
    else if (score >= 85) readiness = "ready";
    else if (score >= 70) readiness = "needs-review";

    return {
      score,
      completeness,
      consistency,
      bestPractices,
      complexity,
      readiness,
    };
  }

  private assessBestPractices(draft: WorkspaceDraft): number {
    // Simple best practices assessment
    let score = 100;

    const config = draft.config;

    // Check if workspace has description
    if (!config.workspace?.description) score -= 20;

    // Check if agents have proper descriptions
    if (config.agents) {
      for (const agent of Object.values(config.agents)) {
        if (!agent.description || agent.description.length < 10) {
          score -= 5;
        }
      }
    }

    return Math.max(0, score);
  }

  private findOrphanedAgents(config: Partial<WorkspaceConfig>, orphaned: any[]): void {
    if (!config.agents || !config.jobs) return;

    const usedAgents = new Set<string>();
    for (const job of Object.values(config.jobs)) {
      if (job.execution?.agents) {
        for (const agent of job.execution.agents) {
          const agentId = typeof agent === "string" ? agent : agent.id;
          usedAgents.add(agentId);
        }
      }
    }

    for (const agentId of Object.keys(config.agents)) {
      if (!usedAgents.has(agentId)) {
        orphaned.push({
          id: agentId,
          type: "agent",
          reason: "Agent is defined but never used in any job",
        });
      }
    }
  }

  private findOrphanedSignals(config: Partial<WorkspaceConfig>, orphaned: any[]): void {
    if (!config.signals || !config.jobs) return;

    const usedSignals = new Set<string>();
    for (const job of Object.values(config.jobs)) {
      if (job.triggers) {
        for (const trigger of job.triggers) {
          usedSignals.add(trigger.signal);
        }
      }
    }

    for (const signalId of Object.keys(config.signals)) {
      if (!usedSignals.has(signalId)) {
        orphaned.push({
          id: signalId,
          type: "signal",
          reason: "Signal is defined but never used in any job trigger",
        });
      }
    }
  }

  private detectCircularJobDependencies(config: Partial<WorkspaceConfig>, cycles: any[]): void {
    if (!config.jobs) return;

    // Build dependency graph from job triggers and execution chains
    const dependencyGraph = new Map<string, Set<string>>();

    // Initialize graph nodes
    for (const jobId of Object.keys(config.jobs)) {
      dependencyGraph.set(jobId, new Set());
    }

    // Build edges from job triggers (signal → job dependencies)
    for (const [jobId, job] of Object.entries(config.jobs)) {
      if (job.triggers) {
        for (const trigger of job.triggers) {
          // Find jobs that trigger this signal
          for (const [otherJobId, otherJob] of Object.entries(config.jobs)) {
            if (otherJobId !== jobId && this.jobProducesSignal(otherJob, trigger.signal)) {
              dependencyGraph.get(jobId)?.add(otherJobId);
            }
          }
        }
      }
    }

    // Detect cycles using DFS
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const detectCycle = (jobId: string, path: string[]): void => {
      if (recursionStack.has(jobId)) {
        // Found a cycle
        const cycleStart = path.indexOf(jobId);
        const cyclePath = path.slice(cycleStart).concat([jobId]);
        cycles.push({
          cycle: cyclePath,
          type: "job-dependency" as const,
          severity: "error" as const,
        });
        return;
      }

      if (visited.has(jobId)) return;

      visited.add(jobId);
      recursionStack.add(jobId);

      const dependencies = dependencyGraph.get(jobId) || new Set();
      for (const dependency of dependencies) {
        detectCycle(dependency, [...path, jobId]);
      }

      recursionStack.delete(jobId);
    };

    // Check each job for cycles
    for (const jobId of Object.keys(config.jobs)) {
      if (!visited.has(jobId)) {
        detectCycle(jobId, []);
      }
    }
  }

  private findMissingDependencies(
    config: Partial<WorkspaceConfig>,
    missingDependencies: any[],
  ): void {
    if (!config.jobs) return;

    // Check for required tools/services based on agent types and job configurations
    const requiredTools = new Set<string>();
    const availableTools = new Set(Object.keys(config.tools?.mcp?.servers || {}));

    // Analyze agents for tool requirements
    if (config.agents) {
      for (const [_agentId, agent] of Object.entries(config.agents)) {
        // LLM agents might need MCP servers
        if (agent.type === "llm") {
          // Check if agent configuration suggests specific tools
          const purpose = (agent as any).purpose || agent.description || "";
          const systemPrompt = (agent.config as any)?.prompt || (agent as any).prompts?.system ||
            "";
          const configText = purpose + " " + systemPrompt;

          // Heuristic detection of tool requirements
          if (configText.toLowerCase().includes("weather")) {
            requiredTools.add("weather-api");
          }
          if (
            configText.toLowerCase().includes("email") ||
            configText.toLowerCase().includes("notification")
          ) {
            requiredTools.add("email-service");
          }
          if (
            configText.toLowerCase().includes("database") ||
            configText.toLowerCase().includes("sql")
          ) {
            requiredTools.add("database-adapter");
          }
          if (
            configText.toLowerCase().includes("file") ||
            configText.toLowerCase().includes("filesystem")
          ) {
            requiredTools.add("filesystem-tools");
          }
          if (
            configText.toLowerCase().includes("slack") ||
            configText.toLowerCase().includes("discord")
          ) {
            requiredTools.add("chat-integration");
          }
        }
      }
    }

    // Check for missing required tools
    for (const requiredTool of requiredTools) {
      if (!availableTools.has(requiredTool)) {
        missingDependencies.push({
          requiredBy: "agents",
          requiredId: requiredTool,
          requiredType: "tool" as const,
          context:
            `Tool '${requiredTool}' is likely needed based on agent configurations but not found in tools.mcp.servers`,
        });
      }
    }

    // Check for job chain dependencies
    for (const [jobId, job] of Object.entries(config.jobs)) {
      if (job.execution?.agents) {
        for (const agentRef of job.execution.agents) {
          const agentId = typeof agentRef === "string" ? agentRef : agentRef.id;

          // Check if previous job output is expected but no previous job exists
          const inputSource = typeof agentRef === "object"
            ? (agentRef as any).input_source
            : undefined;
          const contextSteps = typeof agentRef === "object" ? agentRef.context?.steps : undefined;
          if (inputSource === "previous" || contextSteps === "previous") {
            const jobIndex = job.execution.agents.indexOf(agentRef);
            if (jobIndex === 0) {
              missingDependencies.push({
                requiredBy: jobId,
                requiredId: "previous-job-output",
                requiredType: "job" as const,
                context:
                  `Agent '${agentId}' expects previous job output but is first in execution chain`,
              });
            }
          }
        }
      }
    }
  }

  private jobProducesSignal(job: any, signalId: string): boolean {
    // Check if a job produces/emits a specific signal
    // This is simplified - in reality, jobs might produce signals through various mechanisms

    // Check if job has output signals configuration
    if (job.outputs?.signals?.includes(signalId)) {
      return true;
    }

    // Check if job explicitly emits signals
    if (job.emits?.includes(signalId)) {
      return true;
    }

    // Check if job name suggests it produces this signal (heuristic)
    const jobName = job.name || "";
    if (jobName.includes(signalId) || signalId.includes(jobName)) {
      return true;
    }

    return false;
  }

  private detectResourceConflicts(config: Partial<WorkspaceConfig>, conflicts: any[]): void {
    if (!config.agents) return;

    // Track resource usage by component
    const portUsage = new Map<number, string[]>();
    const filePathUsage = new Map<string, string[]>();
    const environmentUsage = new Map<string, string[]>();

    // Analyze agent configurations for resource conflicts
    for (const [agentId, agent] of Object.entries(config.agents)) {
      if (agent.config) {
        // Check for port conflicts
        const port = (agent.config as any).port || (agent.config as any).server?.port;
        if (typeof port === "number") {
          if (!portUsage.has(port)) {
            portUsage.set(port, []);
          }
          portUsage.get(port)?.push(agentId);
        }

        // Check for file path conflicts
        const logFile = (agent.config as any).logFile || (agent.config as any).outputPath;
        if (typeof logFile === "string") {
          if (!filePathUsage.has(logFile)) {
            filePathUsage.set(logFile, []);
          }
          filePathUsage.get(logFile)?.push(agentId);
        }

        // Check for environment variable conflicts
        const envVars = (agent.config as any).environment || (agent.config as any).env;
        if (envVars && typeof envVars === "object") {
          for (const envVar of Object.keys(envVars)) {
            if (!environmentUsage.has(envVar)) {
              environmentUsage.set(envVar, []);
            }
            environmentUsage.get(envVar)?.push(agentId);
          }
        }
      }
    }

    // Report port conflicts
    for (const [port, agents] of portUsage.entries()) {
      if (agents.length > 1) {
        conflicts.push({
          resource: `port:${port}`,
          conflictType: "port" as const,
          conflictingComponents: agents,
          severity: "error" as const,
        });
      }
    }

    // Report file path conflicts
    for (const [filePath, agents] of filePathUsage.entries()) {
      if (agents.length > 1) {
        conflicts.push({
          resource: `file:${filePath}`,
          conflictType: "file" as const,
          conflictingComponents: agents,
          severity: "warning" as const, // Files might be shared intentionally
        });
      }
    }

    // Report critical environment variable conflicts
    const criticalEnvVars = ["PATH", "HOME", "API_KEY", "SECRET_KEY", "DATABASE_URL"];
    for (const [envVar, agents] of environmentUsage.entries()) {
      if (agents.length > 1 && criticalEnvVars.includes(envVar)) {
        conflicts.push({
          resource: `env:${envVar}`,
          conflictType: "environment" as const,
          conflictingComponents: agents,
          severity: "warning" as const,
        });
      }
    }
  }

  private assessWorkspaceQuality(workspace: any): number {
    if (!workspace) return 0;
    let quality = 0;
    if (workspace.name) quality += 50;
    if (workspace.description && workspace.description.length > 10) quality += 50;
    return quality;
  }

  private assessAgentsQuality(agents: any): number {
    if (!agents) return 0;
    const agentList = Object.values(agents);
    if (agentList.length === 0) return 0;

    let totalQuality = 0;
    for (const agent of agentList) {
      let agentQuality = 0;
      if ((agent as any).type) agentQuality += 25;
      if ((agent as any).description && (agent as any).description.length > 10) agentQuality += 25;
      if ((agent as any).config?.model) agentQuality += 25;
      if ((agent as any).config?.prompt) agentQuality += 25;
      totalQuality += agentQuality;
    }

    return totalQuality / agentList.length;
  }

  private assessJobsQuality(jobs: any): number {
    if (!jobs) return 0;
    const jobList = Object.values(jobs);
    if (jobList.length === 0) return 0;

    let totalQuality = 0;
    for (const job of jobList) {
      let jobQuality = 0;
      if ((job as any).name) jobQuality += 25;
      if ((job as any).description) jobQuality += 25;
      if ((job as any).triggers?.length > 0) jobQuality += 25;
      if ((job as any).execution?.agents?.length > 0) jobQuality += 25;
      totalQuality += jobQuality;
    }

    return totalQuality / jobList.length;
  }

  private assessSignalsQuality(signals: any): number {
    if (!signals) return 0;
    const signalList = Object.values(signals);
    if (signalList.length === 0) return 0;

    let totalQuality = 0;
    for (const signal of signalList) {
      let signalQuality = 0;
      if ((signal as any).provider) signalQuality += 50;
      if ((signal as any).description) signalQuality += 50;
      totalQuality += signalQuality;
    }

    return totalQuality / signalList.length;
  }

  private assessToolsQuality(tools: any): number {
    return tools ? 100 : 0;
  }

  private estimateWorkspaceYmlSize(config: Partial<WorkspaceConfig>): number {
    // Rough estimation based on configuration complexity
    let size = 200; // Base YAML structure

    if (config.agents) size += Object.keys(config.agents).length * 150;
    if (config.jobs) size += Object.keys(config.jobs).length * 200;
    if (config.signals) size += Object.keys(config.signals).length * 100;
    if (config.tools) size += 300;
    if (config.memory) size += 100;

    return size;
  }

  private getDefaultValue(path: string): unknown {
    // Provide sensible defaults based on path
    if (path.includes("description")) return "Auto-generated description";
    if (path.includes("name")) return "auto-generated-name";
    if (path.includes("model")) return "claude-3-5-haiku-latest";
    if (path.includes("provider")) return "anthropic";
    return null;
  }

  private recordValidationEvent(
    draftId: string,
    operation: string,
    result: "success" | "failure" | "warning",
    duration: number,
    errors: number,
    warnings: number,
  ): void {
    const event: ValidationEvent = {
      timestamp: new Date().toISOString(),
      draftId,
      operation,
      result,
      duration,
      errors,
      warnings,
      validatorVersion: this.version,
    };

    this.validationEvents.push(event);

    // Keep only last 1000 events to prevent memory bloat
    if (this.validationEvents.length > 1000) {
      this.validationEvents = this.validationEvents.slice(-1000);
    }
  }
}
