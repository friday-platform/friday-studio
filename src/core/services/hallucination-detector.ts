/**
 * Hallucination Detection Service
 *
 * Detects and prevents AI agent hallucinations through LLM validation
 * with retry logic and configurable supervision levels.
 */

import type { AgentResult } from "@atlas/agent-sdk";
import { anthropic } from "@atlas/core";
import type { Logger } from "@atlas/logger";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { SupervisionLevel } from "../supervision-levels.ts";

/**
 * Constants for hallucination detection patterns
 */
const HALLUCINATION_PATTERNS = {
  // Severe patterns that should immediately stop execution
  SEVERE: {
    FABRICATED: "fabricated",
    IMPOSSIBLE: "impossible",
    NO_TOOLS_BUT_CLAIMS_DATA: "No tools used but claims extensive search results",
    NO_TOOLS_EXTERNAL_ACCESS: "Claims external data access without tools",
    FABRICATED_PRICING: "Fabricated specific pricing details",
    CLAIMED_DATA_WITHOUT_TOOLS: "Claimed data from", // Used with "without search tools"
    WITHOUT_SEARCH_TOOLS: "without search tools",
  },
  // Moderate patterns that are concerning but not immediately blocking
  MODERATE: {
    EXTERNAL_DATA_CLAIMS: "External data claims without matching tools",
    SPECIFIC_CLAIMS: "Specific email address provided",
    DETAILED_ANALYSIS: "Detailed gym market analysis claims",
    SESSION_ID_GENERATION: "Specific session ID generation",
    EMAIL_PROMISES: "Promises of email report",
  },
};

/**
 * Helper functions for pattern detection
 */
export const HallucinationPatternDetector = {
  /**
   * Check if issues contain severe hallucination patterns
   */
  containsSeverePatterns(issues: string[]): boolean {
    return issues.some(
      (issue) =>
        issue.includes(HALLUCINATION_PATTERNS.SEVERE.FABRICATED) ||
        issue.includes(HALLUCINATION_PATTERNS.SEVERE.IMPOSSIBLE) ||
        issue.includes(HALLUCINATION_PATTERNS.SEVERE.NO_TOOLS_BUT_CLAIMS_DATA) ||
        issue.includes(HALLUCINATION_PATTERNS.SEVERE.NO_TOOLS_EXTERNAL_ACCESS) ||
        issue.includes(HALLUCINATION_PATTERNS.SEVERE.FABRICATED_PRICING) ||
        (issue.includes(HALLUCINATION_PATTERNS.SEVERE.CLAIMED_DATA_WITHOUT_TOOLS) &&
          issue.includes(HALLUCINATION_PATTERNS.SEVERE.WITHOUT_SEARCH_TOOLS)),
    );
  },

  /**
   * Extract severe issues from a list of issues
   */
  getSevereIssues(issues: string[]): string[] {
    return issues.filter(
      (issue) =>
        issue.includes(HALLUCINATION_PATTERNS.SEVERE.FABRICATED) ||
        issue.includes(HALLUCINATION_PATTERNS.SEVERE.IMPOSSIBLE) ||
        issue.includes(HALLUCINATION_PATTERNS.SEVERE.NO_TOOLS_BUT_CLAIMS_DATA) ||
        issue.includes(HALLUCINATION_PATTERNS.SEVERE.NO_TOOLS_EXTERNAL_ACCESS) ||
        issue.includes(HALLUCINATION_PATTERNS.SEVERE.FABRICATED_PRICING) ||
        (issue.includes(HALLUCINATION_PATTERNS.SEVERE.CLAIMED_DATA_WITHOUT_TOOLS) &&
          issue.includes(HALLUCINATION_PATTERNS.SEVERE.WITHOUT_SEARCH_TOOLS)),
    );
  },
} as const;

/**
 * Error classification for LLM validation failures
 */
interface ErrorClassification {
  type: "network" | "rate_limit" | "auth" | "model" | "timeout" | "unknown";
  isRetryable: boolean;
  baseDelayMs: number;
  maxRetries: number;
}

/**
 * Classifies errors to determine retry strategy
 */
const LLMErrorClassifier = {
  classify(error: unknown): ErrorClassification {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorString = errorMessage.toLowerCase();

    // Network/connectivity errors
    if (
      errorString.includes("network") ||
      errorString.includes("connection") ||
      errorString.includes("timeout") ||
      errorString.includes("econnreset") ||
      errorString.includes("enotfound")
    ) {
      return { type: "network", isRetryable: true, baseDelayMs: 2000, maxRetries: 3 };
    }

    // Rate limiting
    if (
      errorString.includes("rate limit") ||
      errorString.includes("429") ||
      errorString.includes("quota exceeded")
    ) {
      return { type: "rate_limit", isRetryable: true, baseDelayMs: 5000, maxRetries: 2 };
    }

    // Authentication issues
    if (
      errorString.includes("unauthorized") ||
      errorString.includes("401") ||
      errorString.includes("invalid api key")
    ) {
      return { type: "auth", isRetryable: false, baseDelayMs: 0, maxRetries: 0 };
    }

    // Model/API specific errors
    if (
      errorString.includes("model") ||
      errorString.includes("invalid request") ||
      errorString.includes("400")
    ) {
      return { type: "model", isRetryable: false, baseDelayMs: 0, maxRetries: 0 };
    }

    // Default to retryable with conservative settings
    return { type: "unknown", isRetryable: true, baseDelayMs: 1000, maxRetries: 2 };
  },
} as const;

/**
 * Retry mechanism with exponential backoff
 */
const RetryableOperation = {
  async execute<T>(
    operation: () => Promise<T>,
    classification: ErrorClassification,
    logger?: Logger,
  ): Promise<T> {
    if (!classification.isRetryable) {
      return await operation();
    }

    let lastError: unknown;

    for (let attempt = 0; attempt <= classification.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        if (attempt === classification.maxRetries) {
          logger?.warn("All retry attempts exhausted", {
            attempts: attempt + 1,
            errorType: classification.type,
            finalError: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        const delayMs = classification.baseDelayMs * 2 ** attempt;
        logger?.debug("Retrying operation after delay", {
          attempt: attempt + 1,
          delayMs,
          errorType: classification.type,
          error: error instanceof Error ? error.message : String(error),
        });

        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError;
  },
} as const;

export interface HallucinationAnalysis {
  averageConfidence: number;
  lowConfidenceAgents: string[];
  suspiciousPatterns: string[];
  issues: string[];
  detectionMethods: DetectionMethodResult[];
}

interface DetectionMethodResult {
  method: "llm";
  agentId: string;
  confidence: number;
  issues: string[];
}

interface LLMValidationResult {
  valid: boolean;
  confidence: number;
  issues: string[];
  source: "llm";
}

interface HallucinationDetectorConfig {
  logger?: Logger;
  retryConfig?: { enabled: boolean; maxRetries: number; baseDelayMs: number };
}

/**
 * Hallucination Detector
 *
 * Detects AI hallucinations using LLM validation with retry logic
 * for improved reliability against service instability.
 */
export interface ToolCall {
  toolName?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  args?: Record<string, unknown>;
}

export class HallucinationDetector {
  private config: HallucinationDetectorConfig;
  private llmProvider?: (model: string) => LanguageModel;

  constructor(config: HallucinationDetectorConfig) {
    this.config = config;
    this.llmProvider = (model: string) => anthropic(model);
  }

  /**
   * Main analysis method for detecting hallucinations
   */
  async analyzeResults(
    results: AgentResult[],
    supervisionLevel: SupervisionLevel,
  ): Promise<HallucinationAnalysis> {
    const detectionResults: DetectionMethodResult[] = [];
    const allIssues: string[] = [];
    const suspiciousPatterns: string[] = [];

    // Only LLM validation now
    for (const result of results) {
      const llmResult = await this.performLLMValidation(result);
      detectionResults.push(llmResult);
      allIssues.push(...llmResult.issues.map((issue) => `${result.agentId}: ${issue}`));

      if (llmResult.confidence < 0.5) {
        suspiciousPatterns.push(`llm:${result.agentId}`);
      }
    }

    // Calculate final confidence scores
    const confidences = this.calculateFinalConfidences(results, detectionResults);
    const averageConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    const threshold = this.getThreshold(supervisionLevel);

    const lowConfidenceAgents = results
      .map((result, index) => ({ result, confidence: confidences[index] || 0.5 }))
      .filter(({ confidence }) => confidence < threshold)
      .map(({ result }) => result.agentId);

    return {
      averageConfidence,
      lowConfidenceAgents,
      suspiciousPatterns,
      issues: allIssues,
      detectionMethods: detectionResults,
    };
  }

  /**
   * Perform LLM validation with retry logic and error handling
   */
  private async performLLMValidation(result: AgentResult): Promise<DetectionMethodResult> {
    const operation = async (): Promise<LLMValidationResult> => {
      return await this.validateWithLLM(result);
    };

    try {
      const retryConfig: ErrorClassification =
        this.config.retryConfig?.enabled !== false
          ? { type: "unknown", isRetryable: true, baseDelayMs: 1000, maxRetries: 2 }
          : { type: "unknown", isRetryable: false, baseDelayMs: 0, maxRetries: 0 };

      const llmResult = await RetryableOperation.execute(
        operation,
        retryConfig,
        this.config.logger,
      );

      // Emit result snapshot for diagnostics
      this.config.logger?.debug("HallucinationDetector: LLM validation result", {
        agentId: result.agentId,
        confidence: llmResult.confidence,
        issues: llmResult.issues,
        valid: llmResult.valid,
      });

      return {
        method: "llm",
        agentId: result.agentId,
        confidence: llmResult.confidence,
        issues: llmResult.issues,
      };
    } catch (error) {
      const classification = LLMErrorClassifier.classify(error);

      this.config.logger?.warn("LLM validation failed after retries", {
        agentId: result.agentId,
        errorType: classification.type,
        isRetryable: classification.isRetryable,
        error,
      });

      // Simple fallback - just add to issues and mark as not validated
      return {
        method: "llm",
        agentId: result.agentId,
        confidence: 0.3, // Conservative fallback
        issues: [
          "Wasn't validated properly",
          `LLM validation failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  /**
   * LLM validation with robust parsing
   */
  private async validateWithLLM(result: AgentResult): Promise<LLMValidationResult> {
    // If LLM provider is not available, return a default "not validated" result
    if (!this.llmProvider) {
      return {
        valid: false,
        confidence: 0.3,
        issues: ["LLM validation disabled - not validated"],
        source: "llm",
      };
    }

    const ValidationSchema = z.object({
      valid: z.boolean(),
      confidence: z.number().min(0).max(1),
      issues: z.array(z.string()),
    });

    try {
      const { object } = await generateObject({
        model: this.llmProvider("claude-3-5-haiku-latest"),
        system: this.buildValidationPrompt(),
        messages: [{ role: "user", content: this.buildValidationInput(result) }],
        schema: ValidationSchema,
        temperature: 0.05,
        maxOutputTokens: 1000,
      });

      return {
        valid: object.valid,
        confidence: object.confidence,
        issues: object.issues,
        source: "llm",
      };
    } catch (error) {
      throw new Error(
        `LLM validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Build LLM validation system prompt
   */
  private buildValidationPrompt(): string {
    return `You are detecting AI agent hallucinations by validating simplified SOURCE ATTRIBUTION compliance.

## PRIMARY VALIDATION RULE: SOURCE ATTRIBUTION

The agent MUST attribute information using ONLY these tags:
- [tool:{name}] — data obtained by executing a tool in THIS step
- [input] — information provided in the job input (input precedence: if a fact/URL is present in input, tag [input] and keep the input URL)
- [inference:input] — conclusion/summary based solely on input
- [inference:tool:{name}] — conclusion/summary based solely on outputs from a tool executed in THIS step (requires matching tool call)
- [generated] — created content (templates/formatting/non-factual)
- [undefined] — source cannot be determined

Note: [input] and [inference:input] DO NOT require any tool evidence, even when referencing external data that is included in the job input. If the output is clearly a summary/paraphrase of the provided input and no tools were called, treat it as valid (prefer [inference:input]) even if explicit tags are missing.

For strict JSON outputs, close the JSON and include a single trailing line starting with "Attribution:" that contains the required tags (e.g., Attribution: [input] or Attribution: [tool:targeted_research] (https://example.com)).

### IMMEDIATE FAIL CONDITIONS (Confidence 0.0-0.2)
1. [tool:{name}] tag without matching tool call in this step
2. External/web/API claims that are not present in the job input and without executing a tool
3. Any [inference:*] other than [inference:input] or [inference:tool:{name}] (the latter requires matching tool call)
4. Fabricated or impossible claims
5. Critical existence/identity claims without [tool:{name}] evidence and links/paths when applicable, unless directly quoted from input and tagged [input]

### SPECIFIC VALIDATION CHECKS
1. Every [tool:{name}] MUST match an actual tool call in this step
2. External data is allowed if it appears in the job input (treat as [input]); otherwise, it requires [tool:{name}] attribution
3. Claims derived from job input are tagged [input] or summarized as [inference:input]; keep input URLs next to [input] when available
4. [inference] is ONLY allowed as [inference:input] or [inference:tool:{name}] (tool form requires matching tool call)
5. Include URL/file path inline next to the tag when available
6. Negative existence/identity claims require [tool:{name}] evidence and links/paths

### PATTERN DETECTION
- "According to" / "Based on research" without a [tool:{name}] or [input] tag
- Specific numbers/dates/URLs without attribution
- [tool:{name}] claims when no tool was called
- Use of [inference] other than [inference:input] or [inference:tool:{name}]

### SCORING GUIDELINES
- Input-only summary with strong alignment to provided input, no tools used: valid=true, confidence 0.7-0.95. If tags are missing, subtract at most 0.05-0.15.
- Mixed content with minor untagged facts that still appear in input: valid=true, confidence 0.55-0.8 with issues.
- External claims not in input and without tools: valid=false, confidence 0.05-0.3.

## RESPONSE FORMAT
Respond with ONLY valid JSON.
{
  "valid": boolean,
  "confidence": number,
  "issues": ["specific attribution violation"]
}`;
  }

  /**
   * Build validation input
   */
  private buildValidationInput(result: AgentResult): string {
    // Use top-level toolCalls extracted at AgentResult level
    const topLevel = Array.isArray(result.toolCalls) ? result.toolCalls || [] : [];

    const normalized = topLevel;

    const toolCount = normalized.length;
    const toolDetails =
      toolCount > 0
        ? normalized
            .map((tc) => {
              const name = tc.toolName || "unknown";
              const argObj = tc.input;
              const argKeys = argObj && typeof argObj === "object" ? Object.keys(argObj) : [];
              return `${name}(${argKeys.length} params)`;
            })
            .join(", ")
        : "NO_TOOLS";

    // Summarize tool results for provenance (e.g., targeted_research results saved to library)
    const topLevelResults = Array.isArray(result.toolResults) ? result.toolResults || [] : [];

    const toolResultsSummary: string[] = [];
    const detectedLibraryItemIds: string[] = [];

    for (const tr of topLevelResults) {
      try {
        const text = typeof tr === "string" ? tr : JSON.stringify(tr);
        // Detect library item IDs embedded in tool responses
        const idMatches = text.match(/"itemId"\s*:\s*"([^"]+)"/g) || [];
        for (const m of idMatches) {
          const id = m.replace(/.*:\s*"/, "").replace(/"$/, "");
          if (id && !detectedLibraryItemIds.includes(id)) detectedLibraryItemIds.push(id);
        }
        // Keep a compact summary line for each tool result
        const compact = text.length > 200 ? `${text.slice(0, 200)}…` : text;
        toolResultsSummary.push(compact);
      } catch {
        // ignore non-serializable entries
      }
    }

    // Get execution timestamp
    const executionTime = new Date(result.timestamp || Date.now()).toISOString();

    // Detect URLs present in output
    const outputText = (() => {
      try {
        return typeof result.output === "string" ? result.output : JSON.stringify(result.output);
      } catch {
        return String(result.output);
      }
    })();
    const detectedUrls = (outputText.match(/https?:\/\/[^\s)]+/gi) || []).map((u) =>
      u.replace(/[),.;:!?]+$/g, ""),
    );

    return `## SOURCE ATTRIBUTION VALIDATION

**TOOLS ACTUALLY USED:**
${
  toolCount > 0
    ? `${toolCount} tools called: ${toolDetails}`
    : `ZERO TOOLS - Agent made no external calls`
}

**TOOL RESULTS SUMMARY (for provenance):**
- Total results: ${topLevelResults.length}
- Library itemIds: ${detectedLibraryItemIds.length > 0 ? detectedLibraryItemIds.join(", ") : "none"}
- Sample results (truncated):
${toolResultsSummary
  .slice(0, 3)
  .map((l, i) => `  ${i + 1}. ${l}`)
  .join("\n")}

**AGENT OUTPUT TO VALIDATE:**
${JSON.stringify(result.output, null, 2)}

**DETECTED SOURCES IN OUTPUT (URLs):**
${detectedUrls.length > 0 ? detectedUrls.join("\n") : "none"}

## VALIDATION REQUIREMENTS

**Check for Source Attribution:**
1. Output must use ONLY: [tool:{name}], [input], [inference:input], [generated], [undefined]. For strict JSON, add a trailing "Attribution:" line with tags.
2. Every [tool:{name}] tag must match an actual tool call listed above.
3. Input-derived facts may be tagged [input] or summarized as [inference:input]; keep input URLs next to [input] when available.
4. External/web/API claims are allowed if they appear in the job input; otherwise they require tool usage and [tool:{name}] attribution.
5. Include URL/file path inline next to the tag when available.
6. Negative existence/identity claims require [tool:{name}] evidence (and links/paths when applicable), unless directly quoted from input and tagged [input].

**Common Attribution Violations:**
1. **Untagged claims**: factual statements without source tags
2. **False tool claims**: [tool:{name}] when that tool wasn't called
3. **External data without tools or input**: prices, URLs, API data claimed without tool execution and not present in input
4. **Invalid inference**: any [inference:*] other than [inference:input]
5. **Missing attribution signature**: strict JSON responses without a trailing "Attribution:" line
6. **Existence/identity assertions without evidence**: e.g., "company does not exist" without [tool:{name}] and links/paths, unless directly quoted from input and tagged [input]

**Execution:** ${executionTime} | Agent: ${result.agentId} | Task duration: ${result.duration}ms`;
  }

  // JSON parsing helpers removed due to structured output usage

  /**
   * Calculate final confidence scores for all results
   */
  private calculateFinalConfidences(
    results: AgentResult[],
    detectionResults: DetectionMethodResult[],
  ): number[] {
    const finalConfidences: number[] = [];

    for (const result of results) {
      const agentDetections = detectionResults.filter((d) => d.agentId === result.agentId);

      if (agentDetections.length === 0) {
        finalConfidences.push(0.5); // Neutral default
        continue;
      }

      // Use LLM detection results for final confidence calculation
      const llmDetections = agentDetections.filter((d) => d.method === "llm");

      if (llmDetections.length === 0) {
        finalConfidences.push(0.5); // Neutral default if no LLM results
        continue;
      }

      // Average confidence from LLM detection methods
      const avgConfidence =
        llmDetections.reduce((sum, d) => sum + d.confidence, 0) / llmDetections.length;

      finalConfidences.push(avgConfidence);
    }

    return finalConfidences;
  }

  /**
   * Get confidence threshold based on supervision level
   */
  private getThreshold(supervisionLevel: SupervisionLevel): number {
    switch (supervisionLevel) {
      case SupervisionLevel.MINIMAL:
        return 0.3;
      case SupervisionLevel.STANDARD:
        return 0.5;
      case SupervisionLevel.PARANOID:
        return 0.7;
      default:
        return 0.5;
    }
  }
}
