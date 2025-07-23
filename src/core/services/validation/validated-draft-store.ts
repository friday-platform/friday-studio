/**
 * Validation-Enabled Draft Store
 *
 * Extends WorkspaceDraftStore to add automatic validation during
 * draft creation, updates, and publishing operations.
 */

import { type WorkspaceDraft, WorkspaceDraftStore } from "../workspace-draft-store.ts";
import { SimplifiedDraftValidator } from "./simplified-draft-validator.ts";
import type {
  SimplifiedValidationContext,
  SimplifiedValidationResult,
} from "./simplified-types.ts";
import type { ValidationResult } from "./types.ts";
import type { WorkspaceConfig } from "@atlas/config";

export interface ValidatedDraftResult {
  draft: WorkspaceDraft;
  validation: ValidationResult;
}

export interface ValidationOptions {
  enableValidation?: boolean;
  strictMode?: boolean;
  checkBestPractices?: boolean;
  validateReferences?: boolean;
  autoFix?: boolean;
}

export class ValidatedDraftStore extends WorkspaceDraftStore {
  private validator: SimplifiedDraftValidator;
  private defaultOptions: ValidationOptions;

  constructor(kv: Deno.Kv, options: ValidationOptions = {}) {
    super(kv);
    this.validator = new SimplifiedDraftValidator();
    this.defaultOptions = {
      enableValidation: true,
      strictMode: false,
      checkBestPractices: true,
      validateReferences: true,
      autoFix: false,
      ...options,
    };
  }

  /**
   * Create a draft with automatic validation
   */
  async createValidatedDraft(params: {
    name: string;
    description: string;
    pattern?: string;
    sessionId: string;
    conversationId?: string;
    userId: string;
    initialConfig?: Partial<WorkspaceConfig>;
    validationOptions?: ValidationOptions;
  }): Promise<ValidatedDraftResult> {
    // Create the draft first
    const draft = await this.createDraft(params);

    // Perform validation if enabled
    const options = { ...this.defaultOptions, ...params.validationOptions };
    const validation = options.enableValidation
      ? this.validateDraft(draft, options)
      : this.createNoOpValidation();

    return { draft, validation };
  }

  /**
   * Update a draft with automatic validation
   */
  async updateValidatedDraft(
    draftId: string,
    updates: Partial<WorkspaceConfig>,
    updateDescription: string,
    validationOptions?: ValidationOptions,
  ): Promise<ValidatedDraftResult> {
    // Update the draft first
    const draft = await this.updateDraft(draftId, updates, updateDescription);

    // Perform validation if enabled
    const options = { ...this.defaultOptions, ...validationOptions };
    const validation = options.enableValidation
      ? this.validateDraft(draft, options)
      : this.createNoOpValidation();

    return { draft, validation };
  }

  /**
   * Validate a draft for publishing with comprehensive checks
   */
  async validateForPublishing(
    draftId: string,
    _validationOptions?: ValidationOptions,
  ): Promise<SimplifiedValidationResult> {
    const draft = await this.getDraft(draftId);
    if (!draft) {
      throw new Error(`Draft ${draftId} not found`);
    }

    // const options = {
    //   ...this.defaultOptions,
    //   strictMode: true, // Always use strict mode for publishing
    //   checkBestPractices: true,
    //   validateReferences: true,
    //   ...validationOptions,
    // };

    return await this.validator.validateForPublishing(draft);
  }

  /**
   * Publish a draft only if it passes validation
   */
  async publishValidatedDraft(
    draftId: string,
    validationOptions?: ValidationOptions,
  ): Promise<{
    success: boolean;
    validation: SimplifiedValidationResult;
    error?: string;
  }> {
    try {
      // Validate for publishing first
      const validation = await this.validateForPublishing(draftId, validationOptions);

      if (!validation.publishable) {
        return {
          success: false,
          validation,
          error: `Draft cannot be published: ${validation.errors.length} validation errors found`,
        };
      }

      // If validation passes, proceed with publishing
      await this.publishDraft(draftId);

      return {
        success: true,
        validation,
      };
    } catch (error) {
      const noOpValidation = this.createNoOpValidation();
      return {
        success: false,
        validation: noOpValidation,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get draft with current validation status
   */
  async getDraftWithValidation(
    draftId: string,
    validationOptions?: ValidationOptions,
  ): Promise<ValidatedDraftResult | null> {
    const draft = await this.getDraft(draftId);
    if (!draft) {
      return null;
    }

    const options = { ...this.defaultOptions, ...validationOptions };
    const validation = options.enableValidation
      ? this.validateDraft(draft, options)
      : this.createNoOpValidation();

    return { draft, validation };
  }

  /**
   * Batch validate multiple drafts
   */
  async validateSessionDrafts(
    sessionId: string,
    validationOptions?: ValidationOptions,
  ): Promise<ValidatedDraftResult[]> {
    const drafts = await this.getSessionDrafts(sessionId);
    const results: ValidatedDraftResult[] = [];

    for (const draft of drafts) {
      const options = { ...this.defaultOptions, ...validationOptions };
      const validation = options.enableValidation
        ? await this.validateDraft(draft, options)
        : this.createNoOpValidation();

      results.push({ draft, validation });
    }

    return results;
  }

  /**
   * Get validation summary for conversation drafts
   */
  async getConversationValidationSummary(
    conversationId: string,
  ): Promise<{
    totalDrafts: number;
    validDrafts: number;
    publishableDrafts: number;
    avgCompletionScore: number;
    avgQualityScore: number;
    commonIssues: Array<{ issue: string; count: number }>;
  }> {
    const drafts = await this.getConversationDrafts(conversationId);
    const results = drafts.map((draft) => this.validateDraft(draft));

    const summary = {
      totalDrafts: drafts.length,
      validDrafts: results.filter((r) => r.valid).length,
      publishableDrafts: results.filter((r) => r.publishable).length,
      avgCompletionScore: results.reduce((sum, r) => sum + r.completionScore, 0) / results.length ||
        0,
      avgQualityScore: results.reduce((sum, r) => sum + r.quality.score, 0) / results.length || 0,
      commonIssues: this.analyzeCommonIssues(results),
    };

    return summary;
  }

  /**
   * Auto-fix common validation issues (simplified - no complex fixes)
   */
  async autoFixDraft(
    draftId: string,
  ): Promise<{
    success: boolean;
    fixesApplied: number;
    updatedDraft?: WorkspaceDraft;
    validation?: SimplifiedValidationResult;
    error?: string;
  }> {
    try {
      const draft = await this.getDraft(draftId);
      if (!draft) {
        throw new Error(`Draft ${draftId} not found`);
      }

      // Simplified auto-fix: only fix very basic issues
      const fixedConfig = { ...draft.config };
      let fixesApplied = 0;

      // Fix missing workspace name if empty
      if (!fixedConfig.workspace?.name || fixedConfig.workspace.name.trim() === "") {
        if (!fixedConfig.workspace) fixedConfig.workspace = {};
        fixedConfig.workspace.name = draft.name || "untitled-workspace";
        fixesApplied++;
      }

      // Fix missing workspace description if empty
      if (!fixedConfig.workspace?.description || fixedConfig.workspace.description.trim() === "") {
        if (!fixedConfig.workspace) fixedConfig.workspace = {};
        fixedConfig.workspace.description = draft.description || "Auto-generated description";
        fixesApplied++;
      }

      if (fixesApplied === 0) {
        return {
          success: true,
          fixesApplied: 0,
          updatedDraft: draft,
        };
      }

      // Update draft with fixes
      const updatedDraft = await this.updateDraft(
        draftId,
        fixedConfig,
        `Auto-fixed ${fixesApplied} basic validation issues`,
      );

      // Validate the fixed draft
      const validation = this.validateDraft(updatedDraft);

      return {
        success: true,
        fixesApplied,
        updatedDraft,
        validation,
      };
    } catch (error) {
      return {
        success: false,
        fixesApplied: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Private helper methods

  private validateDraft(
    draft: WorkspaceDraft,
    options?: ValidationOptions,
  ): ValidationResult {
    const opts = { ...this.defaultOptions, ...options };

    const context: SimplifiedValidationContext = {
      draftId: draft.id,
      draft,
      config: draft.config,
      validateReferences: opts.validateReferences || false,
      checkBestPractices: opts.checkBestPractices || false,
      strictMode: opts.strictMode || false,
    };

    return this.validator.validateDraft(context);
  }

  private createNoOpValidation(): ValidationResult {
    return {
      valid: true,
      errors: [],
      warnings: [],
      completionScore: 100,
      publishable: true,
      quality: {
        score: 100,
        completeness: 100,
        consistency: 100,
        bestPractices: 100,
        complexity: "low",
        readiness: "ready",
      },
      suggestions: [],
    };
  }

  private analyzeCommonIssues(
    results: ValidationResult[],
  ): Array<{ issue: string; count: number }> {
    const issueCount = new Map<string, number>();

    for (const result of results) {
      for (const error of result.errors) {
        const count = issueCount.get(error.code) || 0;
        issueCount.set(error.code, count + 1);
      }
    }

    return Array.from(issueCount.entries())
      .map(([issue, count]) => ({ issue, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5); // Top 5 most common issues
  }

  private setNestedProperty(obj: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split(".");
    let current: Record<string, unknown> = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    current[parts[parts.length - 1]] = value;
  }

  private deleteNestedProperty(obj: Record<string, unknown>, path: string): void {
    const parts = path.split(".");
    let current: Record<string, unknown> = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current)) {
        return; // Path doesn't exist
      }
      current = current[part] as Record<string, unknown>;
    }

    delete current[parts[parts.length - 1]];
  }
}
