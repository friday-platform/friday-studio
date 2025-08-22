/**
 * Jeopardy Validation Service
 *
 * Validates whether an agent's output fully answers the original task
 * with completeness, accuracy, relevance, and constraint/citation compliance.
 *
 * Designed to sit alongside `hallucination-detector.ts` and use the same
 * AI SDK stack (Anthropic provider + zod structured parsing) for consistency.
 */

import { z } from "zod/v4";
import { generateObject, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { Logger } from "@atlas/logger";

// =============================
// Types
// =============================

export type ValidationIssueType =
  | "off_topic"
  | "wrong_source"
  | "format_mismatch"
  | "incomplete"
  | "incorrect";

export type ValidationSeverity = "low" | "medium" | "high" | "critical";

export interface ValidationIssue {
  type: ValidationIssueType;
  description: string;
  severity: ValidationSeverity;
  evidence?: string;
}

export interface JeopardyValidationRequest {
  originalTask: string;
  agentOutput: unknown;
  agentId: string;
}

export interface JeopardyValidationResult {
  isValid: boolean;
  confidence: number; // 0..1
  answersTask: boolean;
  completeness: number; // 0..1
  issues: ValidationIssue[];
  reasoning: string;
}

export interface JeopardyValidatorConfig {
  /** Optional explicit provider override; otherwise Anthropic is used */
  llmProvider?: (model: string) => LanguageModel;
  logger?: Logger;
  anthropicApiKey?: string;
  enabled?: boolean; // Default: true
  /** Model name for validation (fast, low-cost recommended) */
  model?: string; // Default: "claude-3-haiku-20240307"
  confidenceThreshold?: number; // Default: 0.6
  temperature?: number; // Default: 0.1
  maxOutputTokens?: number; // Default: 700
  /** Optional timeout in milliseconds for the LLM call */
  timeoutMs?: number;
}

// =============================
// Zod schemas for structured parsing
// =============================

const ValidationIssueSchema = z.object({
  type: z.enum(
    [
      "off_topic",
      "wrong_source",
      "format_mismatch",
      "incomplete",
      "incorrect",
    ] as const,
  ),
  description: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"] as const),
  evidence: z.string().optional(),
});

const JeopardyValidationResultSchema = z.object({
  // Coerce common model mistakes and provide safe fallbacks to reduce parse failures
  answersTask: z.coerce.boolean(),
  completeness: z.coerce.number().min(0).max(1).catch(0),
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
  issues: z.array(ValidationIssueSchema).default([]).catch([]),
  reasoning: z.string().default("").catch(""),
});

// =============================
// Service implementation
// =============================

export class JeopardyValidator {
  private readonly logger?: Logger;
  private readonly model: string;
  private readonly llmProvider?: (model: string) => LanguageModel;
  private readonly timeoutMs?: number;
  private readonly enabled: boolean;
  private readonly temperature: number;
  private readonly maxOutputTokens: number;
  private readonly confidenceThreshold: number;

  constructor(config: JeopardyValidatorConfig = {}) {
    this.logger = config.logger;
    this.enabled = config.enabled ?? true;
    this.model = config.model || "claude-3-haiku-20240307";
    this.timeoutMs = config.timeoutMs;
    this.temperature = config.temperature ?? 0.1;
    this.maxOutputTokens = config.maxOutputTokens ?? 700;
    this.confidenceThreshold = config.confidenceThreshold ?? 0.6;

    if (config.llmProvider) {
      this.llmProvider = config.llmProvider;
    } else {
      const anthropic = createAnthropic({
        apiKey: config.anthropicApiKey || Deno.env.get("ANTHROPIC_API_KEY"),
      });
      this.llmProvider = (model: string) => anthropic(model);
    }
  }

  /** Main entrypoint: validate that agentOutput answers originalTask and complies with constraints */
  async validate(request: JeopardyValidationRequest): Promise<JeopardyValidationResult> {
    if (!this.enabled) {
      return this.createDisabledResult(request);
    }

    if (!this.llmProvider) {
      return this.createErrorResult(request, "LLM provider not available");
    }

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildValidationPrompt(request);

    try {
      const { object } = await generateObject({
        model: this.llmProvider(this.model),
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        schema: JeopardyValidationResultSchema,
        temperature: this.temperature,
        maxOutputTokens: this.maxOutputTokens,
        ...(this.timeoutMs ? { abortSignal: AbortSignal.timeout(this.timeoutMs) } : {}),
      });
      const structured = object;

      // Emit the raw structured result at debug level
      this.logger?.debug?.("JeopardyValidator: LLM structured result", {
        agentId: request.agentId,
        answersTask: structured.answersTask,
        completeness: structured.completeness,
        confidence: structured.confidence,
        issueCount: structured.issues?.length ?? 0,
        sampleIssues: structured.issues?.slice(0, 5) ?? [],
      });

      // Derive any allowed domains directly from the task text
      const allowedSources = extractAllowedSourcesFromTask(request.originalTask);

      const taskSourceIssues = this.checkTaskSourceRestrictions(
        request.agentOutput,
        allowedSources,
      );

      const allIssues: ValidationIssue[] = [
        ...structured.issues,
        ...taskSourceIssues,
      ];

      const isValid = structured.answersTask && allIssues.every((i) => i.severity !== "critical");

      // Emit combined decision data for traceability
      this.logger?.debug?.("JeopardyValidator: Combined decision", {
        agentId: request.agentId,
        isValid,
        confidence: structured.confidence,
        completeness: structured.completeness,
        totalIssues: allIssues.length,
        criticalIssues: allIssues.filter((i) => i.severity === "critical").map((i) =>
          i.description
        ),
      });

      return {
        isValid,
        answersTask: structured.answersTask,
        completeness: structured.completeness,
        confidence: structured.confidence,
        issues: allIssues,
        reasoning: structured.reasoning,
      };
    } catch (error) {
      this.logger?.warn?.("Jeopardy validation parse failed; continuing with permissive result", {
        error: error instanceof Error ? error.message : String(error),
      });

      return this.createErrorResult(
        request,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private buildSystemPrompt(): string {
    return `You are a validation system that verifies if an AI agent's response correctly and fully answers the given task.
 Your role is to analyze whether the agent's output provides a complete, accurate, and relevant answer to the original task.
 ## Validation Criteria
 **COMPLETENESS (0.0-1.0):**
 - Does the output address ALL aspects of the original task?
 - Are all required components present?
 - Is any critical information missing?
 **ACCURACY:**
 - Is the information factually correct?
 **RELEVANCE:**
 - Does the response stay on-topic?
 - Is it focused on answering the specific task?
 - Are there unnecessary tangents or off-topic content?
 **TASK SOURCE COMPLIANCE (when specified by task):**
 - If the task restricts sources to specific domains (e.g., page.com), ensure any URLs in the output match those domains.
 - Using data from other domains should be considered a critical mismatch (wrong_source).
 ## Confidence Scoring
 **0.9-1.0**: Perfect answer - complete, accurate, relevant, compliant
 **0.7-0.8**: Good answer - minor gaps or issues
 **0.5-0.6**: Adequate answer - moderate issues but still useful
 **0.3-0.4**: Poor answer - major issues or significant gaps
 **0.0-0.2**: Inadequate answer - fails to answer task or critical issues
 ## Issue Types and Severity
 **CRITICAL**: Prevents task completion
 - Missing required information
 - Sources conflict with task restrictions (wrong_source)
 - Complete off-topic response
 **HIGH**: Significantly impacts usefulness
 - Incomplete core information
 **MEDIUM**: Noticeable but not blocking
 - Minor accuracy issues
 - Partial information gaps
 **LOW**: Minor quality issues
 - Formatting inconsistencies
 - Non-critical missing details
 Remember: This is task-answer validation. Focus ONLY on whether the output successfully fulfills the original request.

 Output format requirements (STRICT):
 - Return ONLY a JSON object with EXACTLY these properties and types:
   {
     "answersTask": boolean,
     "completeness": number (0..1),
     "confidence": number (0..1),
     "issues": [
       { "type": "off_topic" | "wrong_source" | "format_mismatch" | "incomplete" | "incorrect",
         "description": string,
         "severity": "low" | "medium" | "high" | "critical",
         "evidence"?: string }
     ],
     "reasoning": string
   }
 - Do NOT include code fences, markdown, prose, or any keys not listed above.
 - Use lower-case for enum values.
 - Ensure numbers are actual numbers, not strings.`;
  }

  private buildValidationPrompt(request: JeopardyValidationRequest): string {
    return `ORIGINAL TASK:\n${request.originalTask}\n\nAGENT OUTPUT:\n${
      safeStringify(request.agentOutput)
    }\n\nVALIDATION INSTRUCTIONS:\nAnalyze whether the output fully answers the original task. Check for:\n1. Completeness - Does it address all aspects of the task?\n2. Accuracy - Is the information correct?\n3. Relevance - Is the response on-topic and focused?\n4. Task Source Compliance (when provided by task) - If the task specifies allowed domains, any URLs in the output must match those domains; otherwise this is a critical wrong_source.\nFocus strictly on task satisfaction and output quality.\n\nCRITICAL: Respond with ONLY a JSON object that matches the required shape and types described in the system instructions; no markdown, no code fences, no extra keys.`;
  }

  // =============================
  // Constraints & citations
  // =============================

  private checkTaskSourceRestrictions(
    output: unknown,
    allowedSources?: string[],
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!allowedSources || allowedSources.length === 0) return issues;

    const text = typeof output === "string" ? output : safeStringify(output);
    const urls = text.match(/https?:\/\/[^\s)]+/gi) || [];
    if (urls.length === 0) return issues;

    for (const raw of urls) {
      try {
        // Strip common trailing punctuation that often appears in prose
        const url = raw.replace(/[),.;:!?]+$/g, "");
        const hostname = new URL(url).hostname;
        const matches = allowedSources.some((domain) =>
          hostname === domain || hostname.endsWith(`.${domain}`) || hostname.endsWith(domain)
        );
        if (!matches) {
          issues.push({
            type: "wrong_source",
            description: `URL domain not allowed by task restrictions: ${hostname}`,
            severity: "critical",
            evidence: url,
          });
        }
      } catch {
        // ignore invalid URLs for this check
      }
    }

    return issues;
  }

  // =============================
  // Helpers
  // =============================

  /** Return configured confidence threshold */
  getThreshold(): number {
    return this.confidenceThreshold;
  }

  /** Whether Jeopardy validation is enabled */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Create result when validation is disabled (fail-open) */
  private createDisabledResult(_request: JeopardyValidationRequest): JeopardyValidationResult {
    return {
      isValid: true,
      answersTask: true,
      completeness: 1,
      confidence: 0.5,
      issues: [{
        type: "incomplete",
        description: "Jeopardy validation disabled",
        severity: "low",
      }],
      reasoning: "Validation disabled by configuration.",
    };
  }

  /** Create error result when validator fails (fail-open, non-blocking) */
  private createErrorResult(
    _request: JeopardyValidationRequest,
    errorMessage: string,
  ): JeopardyValidationResult {
    return {
      isValid: true,
      answersTask: true,
      completeness: 1,
      confidence: 0.5,
      issues: [{
        type: "incomplete",
        description: `Validator unavailable or parsing failed: ${errorMessage}`,
        severity: "low",
        evidence: errorMessage,
      }],
      reasoning: "Validator call failed; defaulting to permissive result.",
    };
  }
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Extract domain-like tokens from the task text (e.g., "airbnb.com", "hotels.com")
function extractAllowedSourcesFromTask(task: string): string[] {
  const domains = (task.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) || []).map((d) =>
    d.toLowerCase()
  );
  return Array.from(new Set(domains));
}
