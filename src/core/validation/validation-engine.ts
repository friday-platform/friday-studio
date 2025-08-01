/**
 * Atlas Validation Engine - Hybrid Validation Architecture
 *
 * Combines Zod structural validation with custom functional validators and smoke tests.
 * Provides fast validation pipeline with optional LLM fallback for complex validation needs.
 */

import { z } from "zod/v4";
import { logger } from "@atlas/logger";
import type { ValidationPlanningConfig } from "../planning/planning-config.ts";

// Base validation result interface
export interface ValidationResult {
  isValid: boolean;
  confidence: number;
  score: number;
  issues: ValidationIssue[];
  recommendations: string[];
  metadata: {
    validatorUsed: string;
    duration: number;
    stage: "structural" | "functional" | "smoke" | "llm";
    cached: boolean;
  };
}

export interface ValidationIssue {
  type: "security" | "quality" | "format" | "completeness" | "safety";
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  suggestion?: string;
  field?: string;
}

// Validator interfaces
export interface StructuralValidator {
  name: string;
  schema: z.ZodSchema;
  enabled: boolean;
}

export interface FunctionalValidator {
  name: string;
  pattern: string | RegExp;
  enabled: boolean;
  check: (
    input: any,
    output: any,
    context: ValidationContext,
  ) => ValidationResult | Promise<ValidationResult>;
}

export interface SmokeTest {
  name: string;
  enabled: boolean;
  test: (
    input: any,
    output: any,
    context: ValidationContext,
  ) => SmokeTestResult | Promise<SmokeTestResult>;
}

export interface SmokeTestResult {
  confidence: number;
  needsLLMAnalysis: boolean;
  flags: string[];
  score: number;
  issues: ValidationIssue[];
}

export interface ExternalValidator {
  name: string;
  endpoint?: string;
  enabled: boolean;
  validate: (text: string, context: ValidationContext) => Promise<ValidationResult>;
}

export interface ValidationContext {
  agentId: string;
  sessionId: string;
  workspaceId: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

// Cache for validation results
interface ValidationCacheEntry {
  result: ValidationResult;
  timestamp: number;
  inputHash: string;
}

export class ValidationEngine {
  private structuralValidators = new Map<string, StructuralValidator>();
  private functionalValidators = new Map<string, FunctionalValidator[]>();
  private smokeTests = new Map<string, SmokeTest[]>();
  private externalValidators = new Map<string, ExternalValidator>();
  private cache = new Map<string, ValidationCacheEntry>();
  private config: ValidationPlanningConfig;

  constructor(config: ValidationPlanningConfig) {
    this.config = config;
    this.initializeDefaultValidators();
  }

  /**
   * Main validation pipeline entry point
   */
  async validate(
    agentId: string,
    input: any,
    output: any,
    context: ValidationContext,
  ): Promise<ValidationResult> {
    const startTime = Date.now();
    const cacheKey = this.generateCacheKey(agentId, input, output);

    // Check cache first
    if (this.config.cache_enabled) {
      const cached = this.getCachedResult(cacheKey);
      if (cached) {
        logger.debug("Validation cache hit", { agentId, cacheKey });
        return {
          ...cached,
          metadata: { ...cached.metadata, cached: true },
        };
      }
    }

    try {
      // 1. Structural validation (Zod schemas) - ~1ms
      const structuralResult = await this.runStructuralValidation(agentId, output);
      if (!structuralResult.isValid) {
        const result = this.finalizeResult(structuralResult, startTime, "structural", false);
        this.cacheResult(cacheKey, result);
        return result;
      }

      // 2. Functional validation (custom validators) - ~10-50ms
      if (this.config.functional_validators) {
        const functionalResult = await this.runFunctionalValidators(
          agentId,
          input,
          output,
          context,
        );
        if (!functionalResult.isValid) {
          const result = this.finalizeResult(functionalResult, startTime, "functional", false);
          this.cacheResult(cacheKey, result);
          return result;
        }
      }

      // 3. Smoke tests (heuristics) - ~10-50ms
      if (this.config.smoke_tests) {
        const smokeResult = await this.runSmokeTests(agentId, input, output, context);

        // If confidence is high enough, we're done
        if (smokeResult.confidence >= this.config.llm_threshold) {
          const result = this.smokeResultToValidationResult(smokeResult, startTime, "smoke", false);
          this.cacheResult(cacheKey, result);
          return result;
        }

        // If fail_fast is enabled and smoke tests found critical issues
        if (this.config.fail_fast && smokeResult.issues.some((i) => i.severity === "critical")) {
          const result = this.smokeResultToValidationResult(smokeResult, startTime, "smoke", false);
          this.cacheResult(cacheKey, result);
          return result;
        }
      }

      // 4. Content safety validation (external services)
      if (this.config.content_safety) {
        const safetyResult = await this.runContentSafetyValidation(output, context);
        if (!safetyResult.isValid) {
          const result = this.finalizeResult(safetyResult, startTime, "functional", false);
          this.cacheResult(cacheKey, result);
          return result;
        }
      }

      // 5. LLM validation (expensive fallback) - ~2-10s
      if (this.config.llm_fallback && this.config.precomputation !== "disabled") {
        const llmResult = await this.runLLMValidation(agentId, input, output, context);
        const result = this.finalizeResult(llmResult, startTime, "llm", false);
        this.cacheResult(cacheKey, result);
        return result;
      }

      // 6. Accept with lower confidence if no LLM fallback
      const acceptResult: ValidationResult = {
        isValid: true,
        confidence: 0.6, // Lower confidence without LLM validation
        score: 0.6,
        issues: [],
        recommendations: ["Consider enabling LLM validation for higher confidence"],
        metadata: {
          validatorUsed: "smoke_tests_only",
          duration: Date.now() - startTime,
          stage: "smoke",
          cached: false,
        },
      };

      this.cacheResult(cacheKey, acceptResult);
      return acceptResult;
    } catch (error) {
      logger.error("Validation pipeline error", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        isValid: false,
        confidence: 0,
        score: 0,
        issues: [{
          type: "quality",
          severity: "high",
          description: "Validation pipeline failed",
          suggestion: "Check validation configuration and retry",
        }],
        recommendations: ["Investigate validation pipeline error"],
        metadata: {
          validatorUsed: "error_fallback",
          duration: Date.now() - startTime,
          stage: "structural",
          cached: false,
        },
      };
    }
  }

  /**
   * Register custom validators for specific agents or patterns
   */
  registerStructuralValidator(agentPattern: string, validator: StructuralValidator): void {
    this.structuralValidators.set(agentPattern, validator);
    logger.debug("Registered structural validator", { agentPattern, name: validator.name });
  }

  registerFunctionalValidator(agentPattern: string, validator: FunctionalValidator): void {
    const existing = this.functionalValidators.get(agentPattern) || [];
    existing.push(validator);
    this.functionalValidators.set(agentPattern, existing);
    logger.debug("Registered functional validator", { agentPattern, name: validator.name });
  }

  registerSmokeTest(agentPattern: string, test: SmokeTest): void {
    const existing = this.smokeTests.get(agentPattern) || [];
    existing.push(test);
    this.smokeTests.set(agentPattern, existing);
    logger.debug("Registered smoke test", { agentPattern, name: test.name });
  }

  registerExternalValidator(name: string, validator: ExternalValidator): void {
    this.externalValidators.set(name, validator);
    logger.debug("Registered external validator", { name });
  }

  /**
   * Initialize default validators for common patterns
   */
  private initializeDefaultValidators(): void {
    // Default structural validators
    this.registerStructuralValidator("*", {
      name: "basic-output",
      schema: z.union([
        z.string().min(1),
        z.object({}).passthrough(),
        z.array(z.any()),
      ]),
      enabled: true,
    });

    // Default functional validators
    this.registerFunctionalValidator("*", {
      name: "output-completeness",
      pattern: ".*",
      enabled: true,
      check: this.checkOutputCompleteness.bind(this),
    });

    this.registerFunctionalValidator("*", {
      name: "basic-safety",
      pattern: ".*",
      enabled: true,
      check: this.checkBasicSafety.bind(this),
    });

    // Default smoke tests
    this.registerSmokeTest("*", {
      name: "length-ratio",
      enabled: true,
      test: this.testLengthRatio.bind(this),
    });

    this.registerSmokeTest("*", {
      name: "repetition-detection",
      enabled: true,
      test: this.testRepetitionDetection.bind(this),
    });

    this.registerSmokeTest("*", {
      name: "coherence-basic",
      enabled: true,
      test: this.testBasicCoherence.bind(this),
    });
  }

  /**
   * Validation pipeline stages
   */
  private async runStructuralValidation(agentId: string, output: any): Promise<ValidationResult> {
    const validator = this.getStructuralValidator(agentId);
    if (!validator || !validator.enabled) {
      return this.createValidResult("structural_skipped");
    }

    try {
      validator.schema.parse(output);
      return this.createValidResult("structural_zod");
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          isValid: false,
          confidence: 0,
          score: 0,
          issues: error.issues.map((issue) => ({
            type: "format",
            severity: "high",
            description: `Schema validation failed: ${issue.message}`,
            field: issue.path.join("."),
            suggestion: "Ensure output matches expected schema",
          })),
          recommendations: ["Check agent output format", "Verify schema requirements"],
          metadata: {
            validatorUsed: "structural_zod",
            duration: 0,
            stage: "structural",
            cached: false,
          },
        };
      }
      throw error;
    }
  }

  private async runFunctionalValidators(
    agentId: string,
    input: any,
    output: any,
    context: ValidationContext,
  ): Promise<ValidationResult> {
    const validators = this.getFunctionalValidators(agentId);

    for (const validator of validators) {
      if (!validator.enabled) continue;

      if (!this.matchesPattern(agentId, validator.pattern)) continue;

      const result = await validator.check(input, output, context);
      if (!result.isValid) {
        return result;
      }
    }

    return this.createValidResult("functional_passed");
  }

  private async runSmokeTests(
    agentId: string,
    input: any,
    output: any,
    context: ValidationContext,
  ): Promise<SmokeTestResult> {
    const tests = this.getSmokeTests(agentId);
    let overallConfidence = 1.0;
    let allIssues: ValidationIssue[] = [];
    let allFlags: string[] = [];
    let needsLLM = false;

    for (const test of tests) {
      if (!test.enabled) continue;

      const result = await test.test(input, output, context);
      overallConfidence = Math.min(overallConfidence, result.confidence);
      allIssues = allIssues.concat(result.issues);
      allFlags = allFlags.concat(result.flags);
      needsLLM = needsLLM || result.needsLLMAnalysis;
    }

    return {
      confidence: overallConfidence,
      needsLLMAnalysis: needsLLM || overallConfidence < this.config.llm_threshold,
      flags: [...new Set(allFlags)],
      score: overallConfidence,
      issues: allIssues,
    };
  }

  private async runContentSafetyValidation(
    output: any,
    context: ValidationContext,
  ): Promise<ValidationResult> {
    const text = typeof output === "string" ? output : JSON.stringify(output);
    const issues: ValidationIssue[] = [];

    // Simple content safety checks (can be extended with external APIs)
    const problematicPatterns = [
      { pattern: /\b(password|secret|key|token)\s*[:=]\s*\S+/i, type: "security" as const },
      { pattern: /\b\d{16}\b/, type: "security" as const }, // Credit card numbers
      { pattern: /\b\d{3}-\d{2}-\d{4}\b/, type: "security" as const }, // SSN
    ];

    for (const { pattern, type } of problematicPatterns) {
      if (pattern.test(text)) {
        issues.push({
          type,
          severity: "critical",
          description: "Potentially sensitive information detected",
          suggestion: "Remove or redact sensitive data",
        });
      }
    }

    return {
      isValid: issues.length === 0,
      confidence: issues.length === 0 ? 0.9 : 0.1,
      score: issues.length === 0 ? 0.9 : 0.1,
      issues,
      recommendations: issues.length > 0 ? ["Review output for sensitive information"] : [],
      metadata: {
        validatorUsed: "content_safety",
        duration: 0,
        stage: "functional",
        cached: false,
      },
    };
  }

  private async runLLMValidation(
    agentId: string,
    input: any,
    output: any,
    context: ValidationContext,
  ): Promise<ValidationResult> {
    // Placeholder for LLM validation - would integrate with actual LLM service
    logger.debug("LLM validation requested but not implemented", { agentId });

    return {
      isValid: true,
      confidence: 0.8,
      score: 0.8,
      issues: [],
      recommendations: ["LLM validation not yet implemented"],
      metadata: {
        validatorUsed: "llm_placeholder",
        duration: 0,
        stage: "llm",
        cached: false,
      },
    };
  }

  /**
   * Default validator implementations
   */
  private async checkOutputCompleteness(
    input: any,
    output: any,
    context: ValidationContext,
  ): Promise<ValidationResult> {
    const isEmpty = !output ||
      (typeof output === "string" && output.trim().length === 0) ||
      (typeof output === "object" && Object.keys(output).length === 0);

    return {
      isValid: !isEmpty,
      confidence: isEmpty ? 0 : 0.9,
      score: isEmpty ? 0 : 0.9,
      issues: isEmpty
        ? [{
          type: "completeness",
          severity: "high",
          description: "Output appears to be empty or incomplete",
          suggestion: "Ensure agent produces meaningful output",
        }]
        : [],
      recommendations: [],
      metadata: {
        validatorUsed: "output_completeness",
        duration: 0,
        stage: "functional",
        cached: false,
      },
    };
  }

  private async checkBasicSafety(
    input: any,
    output: any,
    context: ValidationContext,
  ): Promise<ValidationResult> {
    const text = typeof output === "string" ? output : JSON.stringify(output);
    const issues: ValidationIssue[] = [];

    // Basic safety patterns
    if (text.includes("ERROR") || text.includes("Exception")) {
      issues.push({
        type: "quality",
        severity: "medium",
        description: "Output contains error indicators",
        suggestion: "Check agent execution for errors",
      });
    }

    return {
      isValid: issues.length === 0,
      confidence: issues.length === 0 ? 0.8 : 0.4,
      score: issues.length === 0 ? 0.8 : 0.4,
      issues,
      recommendations: [],
      metadata: {
        validatorUsed: "basic_safety",
        duration: 0,
        stage: "functional",
        cached: false,
      },
    };
  }

  /**
   * Default smoke test implementations
   */
  private async testLengthRatio(
    input: any,
    output: any,
    context: ValidationContext,
  ): Promise<SmokeTestResult> {
    const inputLength = typeof input === "string" ? input.length : JSON.stringify(input).length;
    const outputLength = typeof output === "string" ? output.length : JSON.stringify(output).length;

    const ratio = outputLength / (inputLength || 1);

    // Suspicious if output is way too short or excessively long
    const confidence = ratio < 0.1 || ratio > 20 ? 0.3 : 0.8;
    const needsLLM = confidence < 0.5;

    return {
      confidence,
      needsLLMAnalysis: needsLLM,
      flags: ratio < 0.1 ? ["too_short"] : ratio > 20 ? ["too_long"] : [],
      score: confidence,
      issues: confidence < 0.5
        ? [{
          type: "quality",
          severity: "medium",
          description: `Output length ratio (${ratio.toFixed(2)}) seems unusual`,
          suggestion: "Review output length relative to input",
        }]
        : [],
    };
  }

  private async testRepetitionDetection(
    input: any,
    output: any,
    context: ValidationContext,
  ): Promise<SmokeTestResult> {
    const text = typeof output === "string" ? output : JSON.stringify(output);

    // Simple repetition detection
    const words = text.toLowerCase().split(/\s+/);
    const wordCounts = new Map<string, number>();

    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }

    const maxRepetition = Math.max(...wordCounts.values());
    const totalWords = words.length;
    const repetitionRatio = maxRepetition / totalWords;

    const confidence = repetitionRatio > 0.3 ? 0.2 : 0.9;

    return {
      confidence,
      needsLLMAnalysis: confidence < 0.5,
      flags: repetitionRatio > 0.3 ? ["excessive_repetition"] : [],
      score: confidence,
      issues: confidence < 0.5
        ? [{
          type: "quality",
          severity: "medium",
          description: "Excessive word repetition detected",
          suggestion: "Check for agent getting stuck in loops",
        }]
        : [],
    };
  }

  private async testBasicCoherence(
    input: any,
    output: any,
    context: ValidationContext,
  ): Promise<SmokeTestResult> {
    const text = typeof output === "string" ? output : JSON.stringify(output);

    // Basic coherence heuristics
    let confidence = 0.8;
    const flags: string[] = [];
    const issues: ValidationIssue[] = [];

    // Check for all caps (might indicate shouting/broken output)
    if (text.length > 20 && text === text.toUpperCase()) {
      confidence = 0.3;
      flags.push("all_caps");
      issues.push({
        type: "quality",
        severity: "low",
        description: "Output is entirely in uppercase",
        suggestion: "Check output formatting",
      });
    }

    // Check for reasonable sentence structure
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    if (sentences.length === 0 && text.length > 10) {
      confidence = Math.min(confidence, 0.4);
      flags.push("no_sentences");
      issues.push({
        type: "quality",
        severity: "medium",
        description: "Output lacks proper sentence structure",
        suggestion: "Review output formatting and coherence",
      });
    }

    return {
      confidence,
      needsLLMAnalysis: confidence < 0.6,
      flags,
      score: confidence,
      issues,
    };
  }

  /**
   * Helper methods
   */
  private getStructuralValidator(agentId: string): StructuralValidator | null {
    return this.structuralValidators.get(agentId) || this.structuralValidators.get("*") || null;
  }

  private getFunctionalValidators(agentId: string): FunctionalValidator[] {
    const specific = this.functionalValidators.get(agentId) || [];
    const general = this.functionalValidators.get("*") || [];
    return [...specific, ...general];
  }

  private getSmokeTests(agentId: string): SmokeTest[] {
    const specific = this.smokeTests.get(agentId) || [];
    const general = this.smokeTests.get("*") || [];
    return [...specific, ...general];
  }

  private matchesPattern(agentId: string, pattern: string | RegExp): boolean {
    if (pattern === "*" || pattern === ".*") return true;
    if (typeof pattern === "string") {
      return agentId.includes(pattern);
    }
    return pattern.test(agentId);
  }

  private createValidResult(validatorUsed: string): ValidationResult {
    return {
      isValid: true,
      confidence: 0.9,
      score: 0.9,
      issues: [],
      recommendations: [],
      metadata: {
        validatorUsed,
        duration: 0,
        stage: "functional",
        cached: false,
      },
    };
  }

  private smokeResultToValidationResult(
    smoke: SmokeTestResult,
    startTime: number,
    stage: string,
    cached: boolean,
  ): ValidationResult {
    return {
      isValid: smoke.confidence >= 0.5,
      confidence: smoke.confidence,
      score: smoke.score,
      issues: smoke.issues,
      recommendations: smoke.needsLLMAnalysis
        ? ["Consider LLM validation for higher confidence"]
        : [],
      metadata: {
        validatorUsed: "smoke_tests",
        duration: Date.now() - startTime,
        stage: stage as any,
        cached,
      },
    };
  }

  private finalizeResult(
    result: ValidationResult,
    startTime: number,
    stage: string,
    cached: boolean,
  ): ValidationResult {
    return {
      ...result,
      metadata: {
        ...result.metadata,
        duration: Date.now() - startTime,
        stage: stage as any,
        cached,
      },
    };
  }

  private generateCacheKey(agentId: string, input: any, output: any): string {
    const data = JSON.stringify({ agentId, input, output });
    return btoa(data).substring(0, 32);
  }

  private getCachedResult(cacheKey: string): ValidationResult | null {
    const entry = this.cache.get(cacheKey);
    if (!entry) return null;

    const ageMs = Date.now() - entry.timestamp;
    const maxAgeMs = this.config.cache_ttl_hours * 60 * 60 * 1000;

    if (ageMs > maxAgeMs) {
      this.cache.delete(cacheKey);
      return null;
    }

    return entry.result;
  }

  private cacheResult(cacheKey: string, result: ValidationResult): void {
    if (!this.config.cache_enabled) return;

    this.cache.set(cacheKey, {
      result,
      timestamp: Date.now(),
      inputHash: cacheKey,
    });

    // Simple cache cleanup - remove oldest entries if cache is too large
    if (this.cache.size > 1000) {
      const entries = Array.from(this.cache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

      // Remove oldest 20% of entries
      const toRemove = Math.floor(entries.length * 0.2);
      for (let i = 0; i < toRemove; i++) {
        this.cache.delete(entries[i][0]);
      }
    }
  }

  /**
   * Get validation statistics
   */
  getStats(): {
    cacheSize: number;
    validatorsRegistered: number;
    smokeTestsRegistered: number;
    externalValidatorsRegistered: number;
  } {
    return {
      cacheSize: this.cache.size,
      validatorsRegistered: this.functionalValidators.size,
      smokeTestsRegistered: this.smokeTests.size,
      externalValidatorsRegistered: this.externalValidators.size,
    };
  }
}
