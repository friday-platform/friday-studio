/**
 * Hallucination Detection Service
 *
 * Detects and prevents AI agent hallucinations through LLM validation
 * with retry logic and configurable supervision levels.
 */

import { generateObject, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod/v4";
import type { Logger } from "@atlas/logger";
import type { AgentResult } from "@atlas/agent-sdk";
import { SupervisionLevel } from "../supervision-levels.ts";

/**
 * Constants for hallucination detection patterns
 */
export const HALLUCINATION_PATTERNS = {
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
} as const;

/**
 * Helper functions for pattern detection
 */
export class HallucinationPatternDetector {
  /**
   * Check if issues contain severe hallucination patterns
   */
  static containsSeverePatterns(issues: string[]): boolean {
    return issues.some((issue) =>
      issue.includes(HALLUCINATION_PATTERNS.SEVERE.FABRICATED) ||
      issue.includes(HALLUCINATION_PATTERNS.SEVERE.IMPOSSIBLE) ||
      issue.includes(HALLUCINATION_PATTERNS.SEVERE.NO_TOOLS_BUT_CLAIMS_DATA) ||
      issue.includes(HALLUCINATION_PATTERNS.SEVERE.NO_TOOLS_EXTERNAL_ACCESS) ||
      issue.includes(HALLUCINATION_PATTERNS.SEVERE.FABRICATED_PRICING) ||
      (issue.includes(HALLUCINATION_PATTERNS.SEVERE.CLAIMED_DATA_WITHOUT_TOOLS) &&
        issue.includes(HALLUCINATION_PATTERNS.SEVERE.WITHOUT_SEARCH_TOOLS))
    );
  }

  /**
   * Extract severe issues from a list of issues
   */
  static getSevereIssues(issues: string[]): string[] {
    return issues.filter((issue) =>
      issue.includes(HALLUCINATION_PATTERNS.SEVERE.FABRICATED) ||
      issue.includes(HALLUCINATION_PATTERNS.SEVERE.IMPOSSIBLE) ||
      issue.includes(HALLUCINATION_PATTERNS.SEVERE.NO_TOOLS_BUT_CLAIMS_DATA) ||
      issue.includes(HALLUCINATION_PATTERNS.SEVERE.NO_TOOLS_EXTERNAL_ACCESS) ||
      issue.includes(HALLUCINATION_PATTERNS.SEVERE.FABRICATED_PRICING) ||
      (issue.includes(HALLUCINATION_PATTERNS.SEVERE.CLAIMED_DATA_WITHOUT_TOOLS) &&
        issue.includes(HALLUCINATION_PATTERNS.SEVERE.WITHOUT_SEARCH_TOOLS))
    );
  }
}

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
class LLMErrorClassifier {
  static classify(error: unknown): ErrorClassification {
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
      return {
        type: "network",
        isRetryable: true,
        baseDelayMs: 2000,
        maxRetries: 3,
      };
    }

    // Rate limiting
    if (
      errorString.includes("rate limit") ||
      errorString.includes("429") ||
      errorString.includes("quota exceeded")
    ) {
      return {
        type: "rate_limit",
        isRetryable: true,
        baseDelayMs: 5000,
        maxRetries: 2,
      };
    }

    // Authentication issues
    if (
      errorString.includes("unauthorized") ||
      errorString.includes("401") ||
      errorString.includes("invalid api key")
    ) {
      return {
        type: "auth",
        isRetryable: false,
        baseDelayMs: 0,
        maxRetries: 0,
      };
    }

    // Model/API specific errors
    if (
      errorString.includes("model") ||
      errorString.includes("invalid request") ||
      errorString.includes("400")
    ) {
      return {
        type: "model",
        isRetryable: false,
        baseDelayMs: 0,
        maxRetries: 0,
      };
    }

    // Default to retryable with conservative settings
    return {
      type: "unknown",
      isRetryable: true,
      baseDelayMs: 1000,
      maxRetries: 2,
    };
  }
}

/**
 * Retry mechanism with exponential backoff
 */
class RetryableOperation {
  static async execute<T>(
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

        const delayMs = classification.baseDelayMs * Math.pow(2, attempt);
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
  }
}

export interface HallucinationAnalysis {
  averageConfidence: number;
  lowConfidenceAgents: string[];
  suspiciousPatterns: string[];
  issues: string[];
  detectionMethods: DetectionMethodResult[];
}

export interface DetectionMethodResult {
  method: "llm";
  agentId: string;
  confidence: number;
  issues: string[];
}

export interface LLMValidationResult {
  valid: boolean;
  confidence: number;
  issues: string[];
  source: "llm";
}

export interface HallucinationDetectorConfig {
  supervisionLevel: SupervisionLevel;
  logger?: Logger;
  anthropicApiKey?: string;
  enableLLMValidation?: boolean; // Default: true
  retryConfig?: {
    enabled: boolean;
    maxRetries: number;
    baseDelayMs: number;
  };
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
    // Only create Anthropic client if LLM validation is enabled
    if (config.enableLLMValidation !== false) {
      const anthropic = createAnthropic({
        apiKey: config.anthropicApiKey || Deno.env.get("ANTHROPIC_API_KEY"),
      });
      this.llmProvider = (model: string) => anthropic(model);
    }
  }

  /**
   * Update supervision level dynamically to ensure threshold alignment
   */
  setSupervisionLevel(level: SupervisionLevel): void {
    this.config.supervisionLevel = level;
  }

  /**
   * Main analysis method for detecting hallucinations
   */
  async analyzeResults(results: AgentResult[]): Promise<HallucinationAnalysis> {
    const detectionResults: DetectionMethodResult[] = [];
    const allIssues: string[] = [];
    const suspiciousPatterns: string[] = [];

    // Only LLM validation now
    for (const result of results) {
      if (this.config.enableLLMValidation !== false) {
        const llmResult = await this.performLLMValidation(result);
        detectionResults.push(llmResult);
        allIssues.push(...llmResult.issues.map((issue) => `${result.agentId}: ${issue}`));

        if (llmResult.confidence < 0.5) {
          suspiciousPatterns.push(`llm:${result.agentId}`);
        }
      } else {
        // If LLM validation is disabled, add "not validated" result
        const notValidatedResult: DetectionMethodResult = {
          method: "llm",
          agentId: result.agentId,
          confidence: 0.3,
          issues: ["Wasn't validated properly", "LLM validation disabled"],
        };
        detectionResults.push(notValidatedResult);
        allIssues.push(...notValidatedResult.issues.map((issue) => `${result.agentId}: ${issue}`));
        suspiciousPatterns.push(`llm:${result.agentId}`);
      }
    }

    // Calculate final confidence scores
    const confidences = this.calculateFinalConfidences(results, detectionResults);
    const averageConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    const threshold = this.getConfidenceThreshold();

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
      const retryConfig = this.config.retryConfig?.enabled !== false
        ? { type: "unknown" as const, isRetryable: true, baseDelayMs: 1000, maxRetries: 2 }
        : { type: "unknown" as const, isRetryable: false, baseDelayMs: 0, maxRetries: 0 };

      const llmResult = await RetryableOperation.execute(
        operation,
        retryConfig,
        this.config.logger,
      );

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
        error: error instanceof Error ? error.message : String(error),
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
        messages: [{
          role: "user",
          content: this.buildValidationInput(result),
        }],
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
    return `You are detecting AI agent hallucinations by validating SOURCE ATTRIBUTION compliance.

## PRIMARY VALIDATION RULE: SOURCE ATTRIBUTION PROTOCOL

The agent MUST tag all information with source tags: [tool:{name}], [input], [context], [context:agent:{id}], [inference:{basis}], [knowledge], [generated], or [undefined].

### VALIDATION CRITERIA

**IMMEDIATE FAIL CONDITIONS (Confidence 0.0-0.2):**
1. **False tool attribution** - [tool:x] tag without matching tool call
2. **External data without tools** - Claims of current prices, web data, API responses without tool execution
3. **Baseless inference** - [inference] tag without citing basis
4. **Wrong tool for data type** - e.g., [tool:file_read] for web data
5. **Fabrication or impossibility** - Fabricated details or impossible claims (these MUST NOT score above 0.2)
6. **Critical untagged existence/identity claims** - Assertions like "does not exist", "no results", "cannot be found", or entity identity facts without [tool:x] evidence (and links/paths when applicable)

Note: Untagged factual claims are not "immediate fail" when they plausibly come from prior agents in the same session; see Context Rule below.

**VALID SOURCE PATTERNS:**
- [tool:{name}] matches actual tool calls in execution
- [input] for data from user/signal
- [context] for workspace memory or previous steps/agents
- [context:agent:{id}] when referencing a specific prior agent's output
- [inference:{basis}] with clear reasoning chain
- [knowledge] for universal facts
- [generated] for created content
- [undefined] for acknowledged uncertainty

### CONFIDENCE SCORING

Use these strict bands:
**0.9-1.0**: All claims properly tagged; [tool:x] and [context(:agent)] tags match execution/prior steps; links/paths included when available
**0.7-0.8**: Minor gaps; tool and context usage largely match; non-critical omissions only
**0.5-0.6**: Moderate issues like some untagged prior-step data or minor attribution errors; NO fabricated/impossible claims; NO external-without-tools; NO critical existence/identity claims without evidence
**0.3-0.4**: Major attribution failures or multiple missing tags; still no fabricated/impossible or external-without-tools
**0.0-0.2**: Any fabricated/impossible claim, any external-without-tools claim, false tool attribution, or critical existence/identity claims without tool-backed evidence (and links/paths when applicable)

### SPECIFIC VALIDATION CHECKS

1. **Tool Tag Validation**: Every [tool:x] MUST have corresponding tool call
2. **External Data Rule**: No external data without [tool:x] attribution
3. **Context Tag Rule**: Data derived from prior agents/steps should be tagged [context] or [context:agent:{id}]. Missing [context] is a moderate issue unless accompanied by false external or tool claims.
4. **Inference Chain**: Every [inference:x] must cite valid basis (including basis=agent:{id} when derived from a prior step)
5. **Uncertainty Handling**: Unclear data should be [undefined], not guessed
6. **Link/Path Inclusion**: When a claim is based on a URL or a file, the claim MUST include the URL or file path next to it
7. **Existence/Identity Claims**: Negative existence claims (e.g., a company "does not exist") or strong identity assertions MUST have [tool:x] evidence and, when applicable, links/paths. Otherwise classify as severe (≤ 0.2)

### PATTERN DETECTION

Look for these hallucination indicators:
- "According to" / "Based on research" without [tool:search]
- Specific numbers/dates/URLs without source tags
- [tool:x] claims when tool x was never called
- Mixed attribution without clear separation
- Assertions like "no such company", "cannot be found", "no results anywhere" without explicit [tool:x] evidence and links/paths

## RESPONSE FORMAT

**CRITICAL**: Respond with ONLY valid JSON. No explanations or markdown.

{
  "valid": boolean,
  "confidence": number,
  "issues": ["specific attribution violation"]
}

**FOCUS**: Validate source attribution compliance. Untagged claims or false attributions = low confidence.`;
  }

  /**
   * Build validation input
   */
  private buildValidationInput(result: AgentResult): string {
    const toolCount = result.toolCalls?.length || 0;

    // Extract tool call details for better analysis
    const toolDetails = (result.toolCalls as ToolCall[] | undefined)?.map((tc) => {
      const toolName = tc?.toolName || tc?.name || "unknown";
      const args = tc?.arguments || tc?.args || {};
      return `${toolName}(${Object.keys(args).length} params)`;
    }).join(", ") || "NO_TOOLS";

    // Get execution timestamp
    const executionTime = new Date(result.timestamp || Date.now()).toISOString();

    return `## SOURCE ATTRIBUTION VALIDATION

**TOOLS ACTUALLY USED:**
${
      toolCount > 0
        ? `${toolCount} tools called: ${toolDetails}`
        : `ZERO TOOLS - Agent made no external calls`
    }

**AGENT OUTPUT TO VALIDATE:**
${JSON.stringify(result.output, null, 2)}

## VALIDATION REQUIREMENTS

**Check for Source Attribution Tags:**
1. Does output contain [tool:{name}], [input], [context], [inference:{basis}], [knowledge], [generated], or [undefined] tags?
2. Do all [tool:x] tags match actual tool calls listed above?
3. Are all factual claims properly tagged, using [context] or [context:agent:{id}] when based on prior steps?
4. Are external data claims backed by appropriate tool usage? (If tools=0, external claims should be considered severe.)
5. When a claim references a URL or file, does it include the URL or file path next to the claim?
6. Do negative existence/identity claims include explicit [tool:x] evidence (and links/paths when applicable)?

**Common Attribution Violations:**
1. **Untagged claims**: Factual statements without source tags
2. **False tool claims**: [tool:x] when tool x wasn't called
3. **External data without tools**: Prices, URLs, API data claimed without tool execution
4. **Missing context tag**: Prior-step data presented without [context] or [context:agent:{id}] (moderate)
5. **Baseless inference**: [inference] without citing what it's based on
6. **Wrong tool attribution**: [tool:file_read] for web data, etc.
7. **Existence/identity assertions without evidence**: e.g., "company does not exist" without [tool:x] and links/paths

**Agent Context:**
- Agent: ${result.agentId}
- Task: ${result.task}
- Duration: ${result.duration}ms
- Execution: ${executionTime}

## MULTI-AGENT WORKFLOW NOTE
- This validation occurs in a multi-agent session.
- Treat data inherited from previous agents as [context] or [context:agent:{id}].
- Missing [context] for such data is a moderate issue; do not classify as severe unless there are false tool/external claims.

**Remember**: Validate SOURCE ATTRIBUTION compliance. Missing or false attributions = low confidence.`;
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
      const avgConfidence = llmDetections.reduce((sum, d) => sum + d.confidence, 0) /
        llmDetections.length;

      finalConfidences.push(avgConfidence);
    }

    return finalConfidences;
  }

  /**
   * Get confidence threshold based on supervision level
   */
  private getConfidenceThreshold(): number {
    switch (this.config.supervisionLevel) {
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

  /**
   * Public method to get threshold for external use
   */
  getThreshold(): number {
    return this.getConfidenceThreshold();
  }
}
